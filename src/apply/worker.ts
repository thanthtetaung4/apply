import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  BrowserError,
  type BrowserSession,
  type FieldValue,
  type FormField,
  type FormSchema,
} from '../browser/types'
import type { LlmGateway } from '../llm/gateway'
import { answerField } from '../llm/tasks'
import type { Profile } from '../profile'
import type { Job } from '../shared/job'
import { valuesMatch } from '../verify/compare'
import { fileNameOf, mapField, pickOption, type FieldSource } from './fields'
import type { BlockKind, Recipe } from './recipes'

export type ApplyStatus = 'submitted' | 'submitted_unconfirmed' | 'ready_to_submit' | 'needs_human'
export type VerifyResult = 'pass' | 'warn' | 'fail' | 'n/a'

export interface FieldRecord {
  step: number
  id: string
  label: string
  type: string
  required: boolean
  intended: FieldValue | null
  actual?: FieldValue
  source: FieldSource | 'skipped'
  status: 'ok' | 'mismatch' | 'skipped' | 'unresolved'
  note?: string
}

export interface ApplyOutcome {
  status: ApplyStatus
  reason?: string
  blockKind?:
    | BlockKind
    | 'unknown_question'
    | 'verification_failed'
    | 'validation'
    | 'stuck'
    | 'too_many_steps'
    | 'fill_failed'
  verify: VerifyResult
  steps: number
  fields: FieldRecord[]
  unknownQuestions: string[]
  screenshots: string[]
  finalUrl: string
  confirmationText?: string
  durationMs: number
}

export interface ApplyContext {
  job: Job
  profile: Profile
  recipe: Recipe
  resumePath: string
  gateway: LlmGateway
  /** What to do at the last step. `manual` never reaches the worker. */
  policy: 'auto' | 'review'
  /** Fill everything but never submit. Used for shadow runs. */
  dryRun?: boolean
  /** Where step screenshots are written. */
  artifactsDir?: string
  maxSteps?: number
  onUnansweredQuestion?: (question: string) => void
}

const worse = (a: VerifyResult, b: VerifyResult): VerifyResult => {
  const rank: Record<VerifyResult, number> = { 'n/a': 0, pass: 1, warn: 2, fail: 3 }
  return rank[b] > rank[a] ? b : a
}

/**
 * Drive one application from the first page to the last step. Code decides every click. The model
 * is asked only for a required question that no rule or saved answer covers.
 */
export async function runApply(session: BrowserSession, ctx: ApplyContext): Promise<ApplyOutcome> {
  const started = Date.now()
  const { job, recipe } = ctx
  const fields: FieldRecord[] = []
  const screenshots: string[] = []
  const unknownQuestions: string[] = []
  let verify: VerifyResult = 'n/a'
  let steps = 0
  let opens = 0

  const shot = async (name: string) => {
    if (!ctx.artifactsDir) return
    try {
      await mkdir(ctx.artifactsDir, { recursive: true })
      await writeFile(join(ctx.artifactsDir, name), await session.screenshot())
      screenshots.push(name)
    } catch {
      // A failed screenshot must never fail the application.
    }
  }

  const done = async (
    status: ApplyStatus,
    extra: Partial<ApplyOutcome> = {},
  ): Promise<ApplyOutcome> => ({
    status,
    verify,
    steps,
    fields,
    unknownQuestions,
    screenshots,
    finalUrl: await session.url(),
    durationMs: Date.now() - started,
    ...extra,
  })

  const park = async (blockKind: ApplyOutcome['blockKind'], reason: string) => {
    await shot(`parked-${steps || 0}.png`)
    return done('needs_human', { blockKind, reason })
  }

  await session.open(job.applyUrl)

  for (let guard = 0; guard < (ctx.maxSteps ?? 15); guard++) {
    let schema = await session.formSchema()

    // Dismiss cookie banners and similar overlays that would cover buttons.
    const overlay = schema.actions.find((a) => ctx.recipe.overlayPattern.test(a.label))
    if (overlay) {
      await session.click(overlay.id).catch(() => undefined)
      schema = await session.formSchema()
    }

    const snap = await session.snapshot()
    const block = recipe.detectBlock(snap, schema)
    if (block) return park(block.kind, block.message)

    const submitAction = () => schema.actions.find((a) => a.kind === 'submit')
    let reviewOnly = false

    if (schema.fields.length === 0) {
      // A review page has no inputs, only a submit button, after at least one filled step.
      if (steps > 0 && submitAction()) {
        reviewOnly = true
      } else {
        const open = schema.actions.find((a) => a.kind === 'open')
        if (open && opens++ < 3) {
          await session.click(open.id)
          continue
        }
        return park('no_form', 'No application form was found on the page.')
      }
    }

    if (!reviewOnly) {
      steps++
      const stepNo = steps

      // 1. Uploads first. Some sites parse the resume and overwrite other fields afterwards.
      let uploaded = false
      for (const f of schema.fields.filter((x) => x.type === 'file')) {
        const m = mapField(f, ctx)
        if (m.kind === 'fill' && typeof m.value === 'string') {
          if (String(f.value ?? '') !== fileNameOf(m.value)) {
            await session.upload(f.id, m.value)
            uploaded = true
          }
        }
      }
      if (uploaded) schema = await session.formSchema()

      // 2. Decide a value for every other field.
      const plan: { field: FormField; value: FieldValue; source: FieldSource }[] = []
      const unresolved: FormField[] = []
      for (const f of schema.fields) {
        if (f.disabled) continue
        const m = mapField(f, ctx)
        if (m.kind === 'fill') {
          plan.push({ field: f, value: m.value, source: m.source })
        } else if (m.kind === 'unresolved') {
          if (f.required) unresolved.push(f)
          else
            fields.push({
              step: stepNo,
              id: f.id,
              label: f.label,
              type: f.type,
              required: false,
              intended: null,
              source: 'skipped',
              status: 'skipped',
            })
        } else {
          fields.push({
            step: stepNo,
            id: f.id,
            label: f.label,
            type: f.type,
            required: f.required,
            intended: null,
            source: 'skipped',
            status: 'skipped',
            note: m.reason,
          })
        }
      }

      // 3. Ask the model about required questions nothing else covers.
      const stillUnknown: FormField[] = []
      for (const f of unresolved) {
        const res = await answerField(
          ctx.gateway,
          {
            question: f.label,
            type: f.type,
            options: f.options,
            required: f.required,
            job: { title: job.title, company: job.company },
            facts: {
              summary: ctx.profile.contact.summary,
              skills: ctx.profile.skills.map((g) => ({ category: g.category, skills: g.skills })),
              experience: ctx.profile.experience.map((e) => ({
                role: e.role,
                company: e.company,
                start: e.start,
                end: e.end,
              })),
            },
          },
          { jobId: job.id },
        )
        const value = res.answer
          ? f.options
            ? pickOption(f.options, res.answer)
            : res.answer
          : null
        if (value) plan.push({ field: f, value, source: 'model' })
        else stillUnknown.push(f)
      }
      if (stillUnknown.length > 0) {
        for (const f of stillUnknown) {
          unknownQuestions.push(f.label)
          ctx.onUnansweredQuestion?.(f.label)
          fields.push({
            step: stepNo,
            id: f.id,
            label: f.label,
            type: f.type,
            required: true,
            intended: null,
            source: 'skipped',
            status: 'unresolved',
          })
        }
        return park('unknown_question', `Needs an answer for: ${unknownQuestions.join(' | ')}`)
      }

      // 4. Fill.
      for (const p of plan) {
        if (valuesMatch(p.field.type, p.value, p.field.value)) continue
        try {
          await session.fill(p.field.id, p.value)
        } catch (err) {
          if (err instanceof BrowserError) {
            return park('fill_failed', `Could not fill "${p.field.label}": ${err.message}`)
          }
          throw err
        }
      }

      // 5. Read back and compare. Retry mismatches once.
      let actual = await session.readValues()
      let bad = plan.filter((p) => !valuesMatch(p.field.type, p.value, actual[p.field.id]))
      if (bad.length > 0) {
        for (const p of bad) await session.fill(p.field.id, p.value).catch(() => undefined)
        actual = await session.readValues()
        bad = plan.filter((p) => !valuesMatch(p.field.type, p.value, actual[p.field.id]))
      }
      let stepVerify: VerifyResult = 'pass'
      for (const p of plan) {
        const ok = !bad.includes(p)
        if (!ok) stepVerify = worse(stepVerify, p.field.required ? 'fail' : 'warn')
        fields.push({
          step: stepNo,
          id: p.field.id,
          label: p.field.label,
          type: p.field.type,
          required: p.field.required,
          intended: p.value,
          actual: actual[p.field.id],
          source: p.source,
          status: ok ? 'ok' : 'mismatch',
        })
      }
      // Required fields that stayed empty (for example a file the site rejected) also fail.
      for (const f of schema.fields.filter((x) => x.type === 'file' && x.required)) {
        const v = actual[f.id]
        if (!v) {
          stepVerify = 'fail'
          fields.push({
            step: stepNo,
            id: f.id,
            label: f.label,
            type: f.type,
            required: true,
            intended: ctx.resumePath,
            actual: v,
            source: 'rule',
            status: 'mismatch',
            note: 'no file attached',
          })
        } else {
          fields.push({
            step: stepNo,
            id: f.id,
            label: f.label,
            type: f.type,
            required: true,
            intended: ctx.resumePath,
            actual: v,
            source: 'rule',
            status: 'ok',
          })
        }
      }
      verify = worse(verify, stepVerify)
      await shot(`step-${stepNo}.png`)

      if (stepVerify === 'fail') {
        const first = bad.find((p) => p.field.required)
        return park(
          'verification_failed',
          first
            ? `"${first.field.label}" did not keep the value that was entered.`
            : 'A required field is empty after filling.',
        )
      }
    } else {
      await shot(`step-review.png`)
    }

    // 6. Move on or finish.
    const nextAction = schema.actions.find((a) => a.kind === 'next')
    const submit = submitAction()

    if (nextAction && !submit) {
      const res = await session.next()
      if (!res.advanced) {
        return res.errors.length > 0
          ? park('validation', `The site rejected this step: ${res.errors.join(' | ')}`)
          : park('stuck', 'The step did not advance after clicking next.')
      }
      continue
    }
    if (!submit) return park('stuck', 'No next or submit button was found.')

    // Last step.
    if (ctx.dryRun) return done('ready_to_submit', { reason: 'dry run, not submitted' })
    if (ctx.policy === 'review')
      return done('ready_to_submit', { reason: 'submit policy is review' })
    if (verify !== 'pass' && verify !== 'n/a') {
      return done('ready_to_submit', { reason: 'verification had warnings, not auto submitting' })
    }

    const res = await session.submit()
    const after = await session.snapshot()
    await shot('confirmation.png')
    if (recipe.isConfirmation(after)) {
      return done('submitted', { confirmationText: after.headings[0] ?? after.text.slice(0, 120) })
    }
    if (res.errors.length > 0)
      return park('validation', `The site rejected the submission: ${res.errors.join(' | ')}`)
    return done('submitted_unconfirmed', { reason: 'no confirmation page was recognised' })
  }
  return park('too_many_steps', 'The form has more steps than expected.')
}

export type { FormSchema }
