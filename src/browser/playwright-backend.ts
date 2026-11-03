import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from 'playwright-core'
import { resolveChromium } from './chromium'
import { extractScript } from './extract-script'
import {
  BrowserError,
  type ActionKind,
  type BrowserBackend,
  type BrowserSession,
  type FieldValue,
  type FormAction,
  type FormField,
  type FormSchema,
  type LaunchOptions,
  type PageSnapshot,
  type StepResult,
} from './types'

interface Extracted {
  fields: FormField[]
  actions: { id: string; label: string }[]
  errors: string[]
  stepText: string
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function classifyAction(label: string, hasFields: boolean): ActionKind {
  const l = label.toLowerCase().trim()
  if (/^(back|previous|prev)\b/.test(l)) return 'back'
  if (/\bsubmit\b|\bsend application\b|\bfinish\b|\bcomplete application\b/.test(l)) return 'submit'
  if (/\b(save (and|&) continue|next|continue|proceed|review)\b/.test(l)) return 'next'
  if (/\beasy apply\b|\bapply (now|here|today)\b.*\b(company|employer)/.test(l)) return 'open'
  if (/\bapply\b/.test(l)) return hasFields ? 'submit' : 'open'
  return 'other'
}

export interface PlaywrightBackendOptions {
  /** Block images, fonts and media. Lower memory and faster loads. */
  lean?: boolean
  executablePath?: string
  actionTimeoutMs?: number
}

export class PlaywrightBackend implements BrowserBackend {
  private browsers = new Map<boolean, Promise<Browser>>()

  constructor(
    readonly name = 'playwright-chromium',
    private readonly options: PlaywrightBackendOptions = {},
  ) {}

  private browser(headless: boolean): Promise<Browser> {
    let p = this.browsers.get(headless)
    if (!p) {
      p = chromium
        .launch({ executablePath: this.options.executablePath ?? resolveChromium(), headless })
        .catch((err) => {
          this.browsers.delete(headless)
          throw new BrowserError(`Could not launch Chromium: ${(err as Error).message}`, 'launch')
        })
      this.browsers.set(headless, p)
    }
    return p
  }

  async launch(options: LaunchOptions): Promise<BrowserSession> {
    const browser = await this.browser(options.headless)
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      locale: 'en-SG',
      timezoneId: 'Asia/Singapore',
      storageState:
        options.storageStatePath && existsSync(options.storageStatePath)
          ? options.storageStatePath
          : undefined,
    })
    context.setDefaultTimeout(this.options.actionTimeoutMs ?? 8000)
    if (this.options.lean) {
      await context.route('**/*', (route) =>
        ['image', 'font', 'media'].includes(route.request().resourceType())
          ? route.abort()
          : route.continue(),
      )
    }
    const page = await context.newPage()
    page.on('dialog', (d) => void d.dismiss().catch(() => undefined))
    return new PlaywrightSession(this.name, context, page)
  }

  async dispose(): Promise<void> {
    const all = [...this.browsers.values()]
    this.browsers.clear()
    await Promise.allSettled(all.map(async (p) => (await p).close()))
  }
}

class PlaywrightSession implements BrowserSession {
  private fieldFrames = new Map<string, Frame>()
  private fieldMeta = new Map<string, FormField>()
  private actionFrames = new Map<string, Frame>()

  constructor(
    readonly backend: string,
    private readonly context: BrowserContext,
    private readonly page: Page,
  ) {}

  async open(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: 'domcontentloaded' })
    await this.settle()
  }

  async url(): Promise<string> {
    return this.page.url()
  }

  async content(): Promise<string> {
    return this.page.content()
  }

  async snapshot(): Promise<PageSnapshot> {
    const data = await this.retry(() =>
      this.page.evaluate(() => ({
        text: (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 4000),
        headings: Array.from(document.querySelectorAll('h1,h2,h3'))
          .map((h) => (h.textContent ?? '').replace(/\s+/g, ' ').trim())
          .filter(Boolean)
          .slice(0, 12),
      })),
    )
    return { url: this.page.url(), title: await this.page.title(), ...data }
  }

  async formSchema(): Promise<FormSchema> {
    const fields: FormField[] = []
    const rawActions: { id: string; label: string; frame: Frame }[] = []
    const errors: string[] = []
    let stepText = ''
    this.fieldFrames.clear()
    this.fieldMeta.clear()
    this.actionFrames.clear()

    const frames = this.page.frames()
    for (const [i, frame] of frames.entries()) {
      if (i > 0 && (frame.url() === 'about:blank' || frame.isDetached())) continue
      let result: Extracted
      try {
        result = await this.retry(() =>
          frame.evaluate<Extracted>(extractScript(i === 0 ? '' : `f${i}`)),
        )
      } catch {
        continue
      }
      for (const f of result.fields) {
        fields.push(f)
        this.fieldFrames.set(f.id, frame)
        this.fieldMeta.set(f.id, f)
      }
      for (const a of result.actions) rawActions.push({ ...a, frame })
      errors.push(...result.errors)
      stepText ||= result.stepText
    }

    const actions: FormAction[] = rawActions.map((a) => {
      this.actionFrames.set(a.id, a.frame)
      return { id: a.id, label: a.label, kind: classifyAction(a.label, fields.length > 0) }
    })

    const m = /(\d+)\s*(?:of|\/)\s*(\d+)/i.exec(stepText)
    return {
      url: this.page.url(),
      title: await this.page.title(),
      step: m ? { index: Number(m[1]), total: Number(m[2]) } : undefined,
      fields,
      actions,
    }
  }

  private meta(fieldId: string): { field: FormField; frame: Frame } {
    const field = this.fieldMeta.get(fieldId)
    const frame = this.fieldFrames.get(fieldId)
    if (!field || !frame) {
      throw new BrowserError(
        `No field "${fieldId}" on the current page. Call formSchema() first.`,
        'no_such_field',
      )
    }
    return { field, frame }
  }

  async fill(fieldId: string, value: FieldValue): Promise<void> {
    const { field, frame } = this.meta(fieldId)
    const loc = frame.locator(`[data-aa="${fieldId}"]`)
    const text = Array.isArray(value) ? value.join(', ') : String(value)

    switch (field.type) {
      case 'select': {
        const options = field.options ?? []
        const want = text.trim().toLowerCase()
        const hit =
          options.find((o) => o.toLowerCase() === want) ??
          options.find((o) => o.toLowerCase().includes(want) || want.includes(o.toLowerCase()))
        if (!hit)
          throw new BrowserError(`"${text}" is not an option of "${field.label}"`, 'no_such_field')
        await loc.first().selectOption({ label: hit })
        break
      }
      case 'radio': {
        const options = field.options ?? []
        const want = text.trim().toLowerCase()
        const idx =
          options.findIndex((o) => o.toLowerCase() === want) >= 0
            ? options.findIndex((o) => o.toLowerCase() === want)
            : options.findIndex((o) => o.toLowerCase().includes(want))
        if (idx < 0)
          throw new BrowserError(`"${text}" is not an option of "${field.label}"`, 'no_such_field')
        await loc.nth(idx).check({ force: true })
        break
      }
      case 'checkbox': {
        if (field.options) {
          const wanted = (Array.isArray(value) ? value : [text]).map((v) => v.toLowerCase())
          for (const [i, o] of field.options.entries()) {
            await loc.nth(i).setChecked(wanted.includes(o.toLowerCase()), { force: true })
          }
        } else {
          await loc
            .first()
            .setChecked(value === true || /^(true|yes|1)$/i.test(text), { force: true })
        }
        break
      }
      case 'file':
        throw new BrowserError(`Use upload() for file field "${field.label}"`, 'no_such_field')
      default: {
        await loc.first().fill(text)
        if (field.hint === 'combobox') {
          const option = frame
            .getByRole('option', {
              name: new RegExp(text.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
            })
            .first()
          if (await option.isVisible({ timeout: 1500 }).catch(() => false)) await option.click()
        }
      }
    }
  }

  async upload(fieldId: string, filePath: string): Promise<void> {
    const { frame } = this.meta(fieldId)
    await frame.locator(`[data-aa="${fieldId}"]`).first().setInputFiles(filePath)
    await sleep(120) // let upload handlers (resume parsing prefill) run
  }

  async click(actionId: string): Promise<StepResult> {
    const frame = this.actionFrames.get(actionId)
    if (!frame)
      throw new BrowserError(`No action "${actionId}" on the current page`, 'no_such_action')
    const before = await this.fingerprint()
    await frame.locator(`[data-aa-action="${actionId}"]`).first().click()
    return this.afterClick(before)
  }

  async next(): Promise<StepResult> {
    return this.clickKind('next')
  }

  async submit(): Promise<StepResult> {
    return this.clickKind('submit')
  }

  private async clickKind(kind: ActionKind): Promise<StepResult> {
    const schema = await this.formSchema()
    const action = schema.actions.find((a) => a.kind === kind)
    if (!action) throw new BrowserError(`No "${kind}" action on ${schema.url}`, 'no_such_action')
    return this.click(action.id)
  }

  async readValues(): Promise<Record<string, FieldValue | undefined>> {
    const schema = await this.formSchema()
    return Object.fromEntries(schema.fields.map((f) => [f.id, f.value]))
  }

  async screenshot(): Promise<Buffer> {
    return this.page.screenshot({ fullPage: true, type: 'png' })
  }

  async saveState(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    await this.context.storageState({ path })
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => undefined)
  }

  // --- helpers ---------------------------------------------------------------------------

  private async fingerprint(): Promise<string> {
    const fields: string[] = []
    for (const frame of this.page.frames()) {
      if (frame.isDetached()) continue
      const ids = await frame
        .evaluate(() =>
          Array.from(document.querySelectorAll('[data-aa]')).map((e) => e.getAttribute('data-aa')),
        )
        .catch(() => [] as (string | null)[])
      fields.push(...ids.map(String))
    }
    return `${this.page.url()}|${[...new Set(fields)].join(',')}`
  }

  /** After a click: wait for navigation, a new step, or visible errors (up to about 2.5 seconds). */
  private async afterClick(before: string): Promise<StepResult> {
    await this.page.waitForLoadState('domcontentloaded').catch(() => undefined)
    let schema = await this.formSchema()
    const key = (s: FormSchema) => `${s.url}|${s.fields.map((f) => f.id).join(',')}`
    for (let i = 0; i < 25; i++) {
      const changed = key(schema) !== before
      const errors = await this.visibleErrors()
      if (changed || errors.length > 0) break
      await sleep(100)
      schema = await this.formSchema()
    }
    // Let the page finish rendering the new step before the caller reads it.
    await sleep(60)
    schema = await this.formSchema()
    return { advanced: key(schema) !== before, errors: await this.visibleErrors() }
  }

  private async visibleErrors(): Promise<string[]> {
    const out: string[] = []
    for (const frame of this.page.frames()) {
      if (frame.isDetached()) continue
      const e = await frame
        .evaluate(() =>
          Array.from(
            document.querySelectorAll(
              '[role=alert], .error, .field-error, .error-message, .errors li',
            ),
          )
            .filter((el) => {
              const r = el.getBoundingClientRect()
              return r.width > 0 && r.height > 0
            })
            .map((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim())
            .filter(Boolean)
            .slice(0, 8),
        )
        .catch(() => [] as string[])
      out.push(...e)
    }
    return out
  }

  private async settle(): Promise<void> {
    await this.page.waitForLoadState('load', { timeout: 5000 }).catch(() => undefined)
  }

  private async retry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
    let last: unknown
    for (let i = 0; i < tries; i++) {
      try {
        return await fn()
      } catch (err) {
        last = err
        await sleep(150) // a navigation may have destroyed the execution context
      }
    }
    throw last
  }
}
