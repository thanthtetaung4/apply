import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pickRecipe, siteTypeOf, sessionKeyFor } from './apply/recipes'
import { runApply, type ApplyOutcome } from './apply/worker'
import type { BoardLogger } from './board/types'
import { BOARD_STATUSES } from './board/types'
import type { BackendRegistry } from './browser/registry'
import type { BrowserSession } from './browser/types'
import type { LlmGateway } from './llm/gateway'
import { decidePolicy } from './metrics/gate'
import { retryJob } from './retry'
import type { Profile } from './profile'
import { BackendRouter } from './router'
import type { UserSettings } from './settings'
import { classifyError } from './shared/errors'
import type { Job } from './shared/job'
import { redact } from './shared/redact'
import type { JobStatus, SiteType } from './shared/status'
import type { Stores } from './store'
import { ResumeRenderer, tailorResume } from './tailor'

export interface OrchestratorDeps {
  settings: UserSettings
  stores: Stores
  profile: Profile
  gateway: LlmGateway
  registry: BackendRegistry
  renderer: ResumeRenderer
  board?: BoardLogger
  /** Local scratch folder. Resumes are copied here so the browser can upload them. */
  workDir: string
  log?: (line: string) => void
  /** Checked between jobs. Return true to stop the run cleanly (for example a cancelled task). */
  shouldStop?: () => boolean | Promise<boolean>
  /** Upper limit for parallel browser contexts, whatever the user asked for. */
  maxWorkers?: number
  /** Injected for tests and the demo. */
  sleep?: (ms: number) => Promise<void>
  random?: () => number
  rephrase?: boolean
}

export interface RunSummary {
  tailored: number
  processed: number
  deferred: number
  byStatus: Record<string, number>
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Runs the pipeline: tailor resumes, then apply with a pool of workers, one browser context per job. */
export class Orchestrator {
  private lastFinished = new Map<SiteType, number>()
  private stopRequested = false

  constructor(private readonly d: OrchestratorDeps) {}

  private get jobs() {
    return this.d.stores.jobs
  }

  private say(line: string) {
    this.d.log?.(line)
  }

  /** Ask the run to stop after the jobs now in progress. */
  stop(): void {
    this.stopRequested = true
  }

  private async stopping(): Promise<boolean> {
    return this.stopRequested || (await this.d.shouldStop?.()) === true
  }

  async retry(jobId: string): Promise<void> {
    await retryJob(this.jobs, jobId)
  }

  async tailorQueued(): Promise<number> {
    let n = 0
    for (const job of await this.jobs.listByStatus('queued')) {
      if (await this.stopping()) break
      await this.jobs.setStatus(job.id, 'tailoring')
      try {
        const res = await tailorResume(job, {
          profile: this.d.profile,
          gateway: this.d.gateway,
          renderer: this.d.renderer,
          outDir: join(this.d.workDir, 'resumes'),
          rephrase: this.d.rephrase,
        })
        const pdf = await readFile(res.pdfPath)
        const artifactId = await this.d.stores.artifacts.put({
          jobId: job.id,
          kind: 'resume_pdf',
          name: res.fileName,
          contentType: 'application/pdf',
          data: pdf,
        })
        await this.d.stores.artifacts.put({
          jobId: job.id,
          kind: 'tailor',
          name: 'tailor.json',
          contentType: 'application/json',
          data: await readFile(join(dirname(res.pdfPath), 'tailor.json')),
        })
        await this.jobs.addUsage(job.id, res.tokensIn, res.tokensOut, res.costUsd)
        await this.jobs.setStatus(job.id, 'ready', { resumeArtifactId: artifactId, reason: null })
        await this.jobs.addEvent(job.id, 'tailored', {
          pages: res.pages,
          fallback: res.usedFallback,
          warnings: res.warnings.length,
        })
        this.say(
          `tailored  ${job.company} | ${job.title}  (${res.pages} page, ${res.requirements.skills.length} skills matched)`,
        )
        n++
      } catch (err) {
        await this.jobs.setStatus(job.id, 'failed', {
          reason: `Resume tailoring failed: ${redact((err as Error).message)}`,
          blockKind: 'error',
        })
        await this.logBoard(job.id)
      }
    }
    return n
  }

  /** Tailor everything queued, then apply to everything ready. */
  /**
   * `approveJobIds` are jobs you reviewed and want submitted now. They are applied even when the site's
   * policy is review or the gate has not been earned, because a person approved them.
   */
  async run(
    options: { limit?: number; jobIds?: string[]; approveJobIds?: string[] } = {},
  ): Promise<RunSummary> {
    this.stopRequested = false
    const tailored = await this.tailorQueued()
    let ready = await this.jobs.listByStatus('ready')
    const approve = new Set(options.approveJobIds ?? [])
    if (options.jobIds || approve.size > 0) {
      const only = new Set([...(options.jobIds ?? []), ...approve])
      ready = ready.filter((j) => only.has(j.id))
    }
    const queue = ready.slice(0, options.limit ?? 1000)
    let processed = 0
    let deferred = 0

    const worker = async () => {
      for (;;) {
        if (await this.stopping()) return
        const job = queue.shift()
        if (!job) return
        const result = await this.processJob(job.id, { approved: approve.has(job.id) })
        if (result === 'deferred') deferred++
        else processed++
      }
    }
    const n = Math.min(this.d.settings.workers, this.d.maxWorkers ?? 4)
    await Promise.all(Array.from({ length: n }, worker))

    const byStatus: Record<string, number> = {}
    for (const c of await this.jobs.counts()) byStatus[c.status] = (byStatus[c.status] ?? 0) + c.n
    return { tailored, processed, deferred, byStatus }
  }

  /** Make sure the tailored resume exists as a local file the browser can upload. */
  private async localResume(jobId: string, artifactId: string): Promise<string> {
    const art = await this.d.stores.artifacts.get(artifactId)
    if (!art) throw new Error(`Resume artifact ${artifactId} is missing`)
    const path = join(this.d.workDir, 'resumes', jobId, art.name)
    if (!existsSync(path)) {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, art.data)
    }
    return path
  }

  async processJob(
    jobId: string,
    opts: { approved?: boolean } = {},
  ): Promise<'done' | 'deferred' | 'skipped'> {
    const { settings } = this.d
    const job = await this.jobs.getJob(jobId)
    const app = await this.jobs.getApplication(jobId)
    if (!job || !app) throw new Error(`Unknown job ${jobId}`)
    if (app.status === 'submitted' || app.status === 'submitted_unconfirmed') return 'skipped'
    if (!app.resumeArtifactId) throw new Error(`Job ${jobId} has no tailored resume yet`)

    const siteType = siteTypeOf(job)
    const site = settings.sites[siteType]
    const recipe = pickRecipe(job)

    if (site.submit === 'manual') {
      await this.jobs.setStatus(jobId, 'needs_human', {
        reason: `Submit policy is manual for ${siteType}. Apply by hand: ${job.applyUrl}`,
        blockKind: 'manual_policy',
      })
      await this.logBoard(jobId)
      return 'done'
    }
    if ((await this.jobs.startedTodayFor(siteType)) >= site.dailyCap) {
      await this.jobs.addEvent(jobId, 'deferred', { reason: 'daily cap', siteType })
      this.say(
        `deferred  ${job.company} | ${job.title}  (daily cap of ${site.dailyCap} for ${siteType})`,
      )
      return 'deferred'
    }

    await this.pace(siteType)

    const decision = decidePolicy(await this.jobs.siteStats(siteType), settings, siteType)
    const policy = opts.approved || decision.effective === 'auto' ? 'auto' : 'review'
    if (decision.reason && !opts.approved) {
      await this.jobs.addEvent(jobId, 'policy_downgraded', { siteType, reason: decision.reason })
    }
    if (opts.approved) await this.jobs.addEvent(jobId, 'approved_by_user', { siteType })

    const resumePath = await this.localResume(jobId, app.resumeArtifactId)
    const attempts = app.attempts + 1
    await this.jobs.setStatus(jobId, 'filling', { startedAt: new Date(), attempts })
    const route = new BackendRouter(this.d.registry, settings).route(siteType, jobId)
    const t0 = Date.now()

    let outcome: ApplyOutcome | undefined
    let usedBackend = route.primary
    let lastError: unknown
    for (const name of [route.primary, route.fallback].filter(Boolean) as string[]) {
      usedBackend = name
      try {
        outcome = await this.attempt(name, job, recipe, resumePath, policy, route.headless)
        break
      } catch (err) {
        lastError = err
        await this.jobs.addEvent(jobId, 'backend_error', {
          backend: name,
          error: redact((err as Error).message).slice(0, 200),
        })
        this.say(
          `backend   ${name} failed for ${job.company}: ${redact((err as Error).message).slice(0, 100)}`,
        )
        if (classifyError(err) === 'fatal' && name === route.primary && !route.fallback) break
      }
    }

    const finishedAt = new Date()
    if (!outcome) {
      const reason = `Error: ${redact((lastError as Error)?.message ?? 'unknown').slice(0, 300)}`
      const retriable = classifyError(lastError) === 'transient' && attempts < settings.maxAttempts
      await this.jobs.setStatus(jobId, retriable ? 'ready' : 'failed', {
        reason,
        blockKind: retriable ? null : 'error',
        finishedAt,
        backend: usedBackend,
        attempts,
      })
      if (!retriable) await this.logBoard(jobId)
      this.say(
        `${retriable ? 'retry    ' : 'failed   '} ${job.company} | ${job.title}  ${reason.slice(0, 90)}`,
      )
      return 'done'
    }

    await this.saveRecord(job, outcome, usedBackend)
    const status: JobStatus = outcome.status
    await this.jobs.setStatus(jobId, status, {
      reason: outcome.reason ?? null,
      blockKind: status === 'needs_human' ? (outcome.blockKind ?? 'other') : null,
      finishedAt,
      backend: usedBackend,
    })
    for (const q of outcome.unknownQuestions) await this.jobs.recordUnanswered(q)
    await this.jobs.recordMetric({
      jobId,
      siteType,
      backend: usedBackend,
      durationMs: Date.now() - t0,
      steps: outcome.steps,
      fieldsTotal: outcome.fields.filter((f) => f.status === 'ok' || f.status === 'mismatch')
        .length,
      fieldsRule: outcome.fields.filter((f) => f.source === 'rule' && f.status === 'ok').length,
      fieldsBank: outcome.fields.filter((f) => f.source === 'bank' && f.status === 'ok').length,
      fieldsModel: outcome.fields.filter((f) => f.source === 'model' && f.status === 'ok').length,
      verify: outcome.verify,
      outcome: outcome.status,
    })
    this.lastFinished.set(siteType, Date.now())
    this.say(
      `${status.padEnd(15)} ${job.company} | ${job.title}  [${siteType}, ${usedBackend}, ${outcome.steps} steps, verify ${outcome.verify}]${outcome.reason ? '  ' + outcome.reason.slice(0, 80) : ''}`,
    )

    await this.logBoard(jobId)
    await this.shadow(job, recipe, resumePath, route.shadow, route.headless, outcome)
    return 'done'
  }

  private async attempt(
    backend: string,
    job: Job,
    recipe: ReturnType<typeof pickRecipe>,
    resumePath: string,
    policy: 'auto' | 'review',
    headless: boolean,
  ): Promise<ApplyOutcome> {
    const { registry, stores } = this.d
    const key = sessionKeyFor(recipe.siteType, job.applyUrl)
    const saved = key ? await stores.sessions.get(key) : undefined
    let session: BrowserSession | undefined
    try {
      session = await registry.launch(backend, { headless, storageState: saved })
      const outcome = await runApply(session, {
        job,
        profile: this.d.profile,
        recipe,
        resumePath,
        gateway: this.d.gateway,
        policy,
        saveScreenshot: (name, png) =>
          stores.artifacts
            .put({ jobId: job.id, kind: 'screenshot', name, contentType: 'image/png', data: png })
            .then(() => undefined),
        onUnansweredQuestion: (q) => void this.jobs.recordUnanswered(q),
      })
      // Keep a saved sign in fresh, because sites rotate cookies while you use them. Never create one
      // from nothing: an empty cookie jar would look like a connected account.
      if (key && saved && outcome.blockKind !== 'login_required') {
        await stores.sessions.put(key, await session.exportState()).catch(() => undefined)
      }
      // The saved sign in no longer works. Mark it once so the app asks the user to reconnect,
      // instead of every job on this site failing on its own.
      if (key && saved && outcome.blockKind === 'login_required') {
        await stores.sessions.markExpired?.(key).catch(() => undefined)
      }
      return outcome
    } finally {
      await session?.close()
    }
  }

  /** Run another backend on the same job without submitting, then record how the fields differ. */
  private async shadow(
    job: Job,
    recipe: ReturnType<typeof pickRecipe>,
    resumePath: string,
    backend: string | undefined,
    headless: boolean,
    primary: ApplyOutcome,
  ): Promise<void> {
    if (!backend) return
    const t0 = Date.now()
    let session: BrowserSession | undefined
    try {
      session = await this.d.registry.launch(backend, { headless })
      const shadow = await runApply(session, {
        job,
        profile: this.d.profile,
        recipe,
        resumePath,
        gateway: this.d.gateway,
        policy: 'review',
        dryRun: true,
      })
      const key = (f: { step: number; id: string }) => `${f.step}:${f.id}`
      const mine = new Map(
        primary.fields.filter((f) => f.status !== 'skipped').map((f) => [key(f), f]),
      )
      const theirs = new Map(
        shadow.fields.filter((f) => f.status !== 'skipped').map((f) => [key(f), f]),
      )
      const diffs: { field: string; primary: unknown; shadow: unknown }[] = []
      for (const [k, f] of mine) {
        const o = theirs.get(k)
        if (!o) diffs.push({ field: f.label, primary: f.actual ?? null, shadow: 'missing' })
        else if (JSON.stringify(o.actual) !== JSON.stringify(f.actual))
          diffs.push({ field: f.label, primary: f.actual ?? null, shadow: o.actual ?? null })
      }
      if (shadow.status === 'needs_human') {
        diffs.push({
          field: '(run)',
          primary: primary.status,
          shadow: `${shadow.status}: ${shadow.reason ?? ''}`,
        })
      }
      await this.jobs.recordShadow({
        jobId: job.id,
        backend,
        ok: true,
        compared: mine.size,
        diffs,
        durationMs: Date.now() - t0,
      })
      this.say(`shadow    ${backend}: ${mine.size} fields compared, ${diffs.length} differences`)
    } catch (err) {
      await this.jobs.recordShadow({
        jobId: job.id,
        backend,
        ok: false,
        error: redact((err as Error).message).slice(0, 200),
        compared: 0,
        diffs: [],
        durationMs: Date.now() - t0,
      })
      this.say(`shadow    ${backend} could not run: ${redact((err as Error).message).slice(0, 80)}`)
    } finally {
      await session?.close()
    }
  }

  private async saveRecord(job: Job, outcome: ApplyOutcome, backend: string): Promise<void> {
    const record = {
      job: {
        id: job.id,
        company: job.company,
        title: job.title,
        source: job.source,
        applyUrl: job.applyUrl,
        applyTarget: job.applyTarget,
      },
      backend,
      outcome,
    }
    await this.d.stores.artifacts.put({
      jobId: job.id,
      kind: 'record',
      name: 'record.json',
      contentType: 'application/json',
      data: Buffer.from(JSON.stringify(record, null, 2)),
    })
  }

  private async logBoard(jobId: string): Promise<void> {
    const { board } = this.d
    if (!board) return
    const job = await this.jobs.getJob(jobId)
    const app = await this.jobs.getApplication(jobId)
    if (!job || !app || !BOARD_STATUSES.includes(app.status)) return
    const resume = app.resumeArtifactId
      ? await this.d.stores.artifacts.get(app.resumeArtifactId)
      : undefined
    try {
      await board.log({
        job,
        status: app.status,
        reason: app.error ?? undefined,
        resumeFile: resume?.name,
      })
    } catch (err) {
      await this.jobs.addEvent(jobId, 'board_error', {
        error: redact((err as Error).message).slice(0, 200),
      })
    }
  }

  /** Random pause between two jobs on the same site type. */
  private async pace(siteType: SiteType): Promise<void> {
    const { minDelayMs, maxDelayMs } = this.d.settings.pacing
    if (maxDelayMs <= 0) return
    const last = this.lastFinished.get(siteType)
    if (last === undefined) return
    const want =
      minDelayMs + (this.d.random ?? Math.random)() * Math.max(0, maxDelayMs - minDelayMs)
    const wait = want - (Date.now() - last)
    if (wait > 0) await (this.d.sleep ?? defaultSleep)(wait)
  }
}
