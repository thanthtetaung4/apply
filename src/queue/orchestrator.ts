import { join } from 'node:path'
import { writeFile, mkdir } from 'node:fs/promises'
import { BackendRegistry } from '../browser/registry'
import type { BrowserSession } from '../browser/types'
import { pickRecipe, siteTypeOf } from '../apply/recipes'
import { runApply, type ApplyOutcome } from '../apply/worker'
import type { BoardLogger } from '../board/types'
import { BOARD_STATUSES } from '../board/types'
import type { AppConfig } from '../config/schema'
import type { Db } from '../db'
import type { LlmGateway } from '../llm/gateway'
import { decidePolicy } from '../metrics/gate'
import type { Profile } from '../profile'
import { BackendRouter } from '../router'
import { classifyError } from '../shared/errors'
import { redact } from '../shared/redact'
import type { Job } from '../shared/job'
import type { JobStatus, SiteType } from '../shared/status'
import { ResumeRenderer, tailorResume } from '../tailor'
import { JobRepo } from './repo'

export interface OrchestratorDeps {
  config: AppConfig
  db: Db
  repo: JobRepo
  profile: Profile
  gateway: LlmGateway
  registry: BackendRegistry
  renderer: ResumeRenderer
  board?: BoardLogger
  log?: (line: string) => void
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
  private stopping = false

  constructor(private readonly d: OrchestratorDeps) {}

  private say(line: string) {
    this.d.log?.(line)
  }

  /** Ask the run to stop after the jobs now in progress. */
  stop(): void {
    this.stopping = true
  }

  retry(jobId: string): void {
    const app = this.d.repo.getApplication(jobId)
    if (!app) throw new Error(`Unknown job ${jobId}`)
    if (app.status === 'submitted') throw new Error('That application was already submitted')
    this.d.repo.setStatus(jobId, app.resume_path ? 'ready' : 'queued', {
      reason: null,
      attempts: 0,
    })
  }

  async tailorQueued(): Promise<number> {
    const { repo, config } = this.d
    let n = 0
    for (const job of repo.listByStatus('queued')) {
      if (this.stopping) break
      repo.setStatus(job.id, 'tailoring')
      try {
        const res = await tailorResume(job, {
          profile: this.d.profile,
          gateway: this.d.gateway,
          renderer: this.d.renderer,
          outDir: join(config.outputDir, 'resumes'),
          rephrase: this.d.rephrase,
        })
        repo.addUsage(job.id, res.tokensIn, res.tokensOut, res.costUsd)
        repo.setStatus(job.id, 'ready', { resumePath: res.pdfPath, reason: null })
        repo.addEvent(job.id, 'tailored', {
          pages: res.pages,
          fallback: res.usedFallback,
          warnings: res.warnings.length,
        })
        this.say(
          `tailored  ${job.company} | ${job.title}  (${res.pages} page, ${res.requirements.skills.length} skills matched)`,
        )
        n++
      } catch (err) {
        repo.setStatus(job.id, 'failed', {
          reason: `Resume tailoring failed: ${redact((err as Error).message)}`,
        })
        await this.logBoard(job.id)
      }
    }
    return n
  }

  /** Tailor everything queued, then apply to everything ready. */
  async run(options: { limit?: number } = {}): Promise<RunSummary> {
    this.stopping = false
    const tailored = await this.tailorQueued()
    const ready = this.d.repo.listByStatus('ready').slice(0, options.limit ?? 1000)
    const queue = [...ready]
    let processed = 0
    let deferred = 0

    const worker = async () => {
      for (;;) {
        if (this.stopping) return
        const job = queue.shift()
        if (!job) return
        const result = await this.processJob(job.id)
        if (result === 'deferred') deferred++
        else processed++
      }
    }
    await Promise.all(Array.from({ length: this.d.config.workers }, worker))

    const byStatus: Record<string, number> = {}
    for (const c of this.d.repo.counts()) byStatus[c.status] = (byStatus[c.status] ?? 0) + c.n
    return { tailored, processed, deferred, byStatus }
  }

  async processJob(jobId: string): Promise<'done' | 'deferred' | 'skipped'> {
    const { repo, config } = this.d
    const job = repo.getJob(jobId)
    const app = repo.getApplication(jobId)
    if (!job || !app) throw new Error(`Unknown job ${jobId}`)
    if (app.status === 'submitted' || app.status === 'submitted_unconfirmed') return 'skipped'
    if (!app.resume_path) throw new Error(`Job ${jobId} has no tailored resume yet`)

    const siteType = siteTypeOf(job)
    const site = config.sites[siteType]
    const recipe = pickRecipe(job)

    if (site.submit === 'manual') {
      repo.setStatus(jobId, 'needs_human', {
        reason: `Submit policy is manual for ${siteType}. Apply by hand: ${job.applyUrl}`,
      })
      await this.logBoard(jobId)
      return 'done'
    }
    if (repo.startedTodayFor(siteType) >= site.dailyCap) {
      repo.addEvent(jobId, 'deferred', { reason: 'daily cap', siteType })
      this.say(
        `deferred  ${job.company} | ${job.title}  (daily cap of ${site.dailyCap} for ${siteType})`,
      )
      return 'deferred'
    }

    await this.pace(siteType)

    const decision = decidePolicy(this.d.db, config, siteType)
    const policy = decision.effective === 'auto' ? 'auto' : 'review'
    if (decision.reason)
      repo.addEvent(jobId, 'policy_downgraded', { siteType, reason: decision.reason })

    const attempts = app.attempts + 1
    repo.setStatus(jobId, 'filling', { startedAt: new Date().toISOString(), attempts })
    const route = new BackendRouter(this.d.registry, config).route(siteType, jobId)
    const artifactsDir = join(config.outputDir, 'applications', jobId)
    const t0 = Date.now()

    let outcome: ApplyOutcome | undefined
    let usedBackend = route.primary
    let lastError: unknown
    for (const name of [route.primary, route.fallback].filter(Boolean) as string[]) {
      usedBackend = name
      try {
        outcome = await this.attempt(
          name,
          job,
          recipe,
          app.resume_path,
          policy,
          artifactsDir,
          route.headless,
        )
        break
      } catch (err) {
        lastError = err
        repo.addEvent(jobId, 'backend_error', {
          backend: name,
          error: redact((err as Error).message).slice(0, 200),
        })
        this.say(
          `backend   ${name} failed for ${job.company}: ${redact((err as Error).message).slice(0, 100)}`,
        )
        if (classifyError(err) === 'fatal' && name === route.primary && !route.fallback) break
      }
    }

    const finishedAt = new Date().toISOString()
    if (!outcome) {
      const reason = `Error: ${redact((lastError as Error)?.message ?? 'unknown').slice(0, 300)}`
      const retriable = classifyError(lastError) === 'transient' && attempts < config.maxAttempts
      repo.setStatus(jobId, retriable ? 'ready' : 'failed', {
        reason,
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

    await this.saveRecord(artifactsDir, job, outcome, usedBackend)
    const status: JobStatus = outcome.status
    repo.setStatus(jobId, status, {
      reason: outcome.reason ?? null,
      finishedAt,
      backend: usedBackend,
    })
    for (const q of outcome.unknownQuestions) repo.recordUnanswered(q)
    repo.recordMetric({
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
    await this.shadow(
      job,
      recipe,
      app.resume_path,
      artifactsDir,
      route.shadow,
      route.headless,
      outcome,
    )
    return 'done'
  }

  private async attempt(
    backend: string,
    job: Job,
    recipe: ReturnType<typeof pickRecipe>,
    resumePath: string,
    policy: 'auto' | 'review',
    artifactsDir: string,
    headless: boolean,
  ): Promise<ApplyOutcome> {
    const { config, registry, repo } = this.d
    const key = recipe.sessionKey(job)
    const storageStatePath = key ? join(config.sessionsDir, `${key}.json`) : undefined
    let session: BrowserSession | undefined
    try {
      session = await registry.launch(backend, { headless, storageStatePath })
      return await runApply(session, {
        job,
        profile: this.d.profile,
        recipe,
        resumePath,
        gateway: this.d.gateway,
        policy,
        artifactsDir,
        onUnansweredQuestion: (q) => repo.recordUnanswered(q),
      })
    } finally {
      await session?.close()
    }
  }

  /** Run another backend on the same job without submitting, then record how the fields differ. */
  private async shadow(
    job: Job,
    recipe: ReturnType<typeof pickRecipe>,
    resumePath: string,
    artifactsDir: string,
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
        artifactsDir: join(artifactsDir, 'shadow'),
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
      if (shadow.status === 'needs_human')
        diffs.push({
          field: '(run)',
          primary: primary.status,
          shadow: `${shadow.status}: ${shadow.reason ?? ''}`,
        })
      this.d.repo.recordShadow({
        jobId: job.id,
        backend,
        ok: true,
        compared: mine.size,
        diffs,
        durationMs: Date.now() - t0,
      })
      this.say(`shadow    ${backend}: ${mine.size} fields compared, ${diffs.length} differences`)
    } catch (err) {
      this.d.repo.recordShadow({
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

  private async saveRecord(
    dir: string,
    job: Job,
    outcome: ApplyOutcome,
    backend: string,
  ): Promise<void> {
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'record.json'),
      JSON.stringify(
        {
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
        },
        null,
        2,
      ),
    )
  }

  private async logBoard(jobId: string): Promise<void> {
    const { repo, board } = this.d
    if (!board) return
    const job = repo.getJob(jobId)
    const app = repo.getApplication(jobId)
    if (!job || !app || !BOARD_STATUSES.includes(app.status)) return
    try {
      await board.log({
        job,
        status: app.status,
        reason: app.error ?? undefined,
        resumeFile: app.resume_path ? app.resume_path.split(/[\\/]/).pop() : undefined,
      })
    } catch (err) {
      repo.addEvent(jobId, 'board_error', { error: redact((err as Error).message).slice(0, 200) })
    }
  }

  /** Random pause between two jobs on the same site type. */
  private async pace(siteType: SiteType): Promise<void> {
    const { minDelayMs, maxDelayMs } = this.d.config.pacing
    if (maxDelayMs <= 0) return
    const last = this.lastFinished.get(siteType)
    if (last === undefined) return
    const want =
      minDelayMs + (this.d.random ?? Math.random)() * Math.max(0, maxDelayMs - minDelayMs)
    const wait = want - (Date.now() - last)
    if (wait > 0) await (this.d.sleep ?? defaultSleep)(wait)
  }
}
