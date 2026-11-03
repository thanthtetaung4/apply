import type { Db } from '../db'
import type { Job } from '../shared/job'
import { normalizeText } from '../shared/hash'
import { redactJson } from '../shared/redact'
import type { ApplyTarget, JobSource, JobStatus, SiteType } from '../shared/status'
import { siteTypeOf } from '../apply/recipes'

interface JobRow {
  id: string
  source: JobSource
  source_url: string | null
  title: string
  company: string
  location: string | null
  description: string
  apply_url: string
  apply_target: ApplyTarget
  posted_at: string | null
  fetched_at: string
  match_score: number | null
}

export interface ApplicationRow {
  job_id: string
  status: JobStatus
  attempts: number
  resume_path: string | null
  backend: string | null
  started_at: string | null
  finished_at: string | null
  error: string | null
  tokens_in: number
  tokens_out: number
  cost_usd: number
  updated_at: string
}

export interface StatusPatch {
  reason?: string | null
  resumePath?: string
  backend?: string
  startedAt?: string
  finishedAt?: string
  attempts?: number
}

export interface MetricRow {
  jobId: string
  siteType: SiteType
  backend: string
  durationMs: number
  steps: number
  fieldsTotal: number
  fieldsRule: number
  fieldsBank: number
  fieldsModel: number
  verify: string
  outcome: string
}

const toJob = (r: JobRow): Job & { matchScore?: number } => ({
  id: r.id,
  source: r.source,
  sourceUrl: r.source_url ?? undefined,
  title: r.title,
  company: r.company,
  location: r.location ?? undefined,
  description: r.description,
  applyUrl: r.apply_url,
  applyTarget: r.apply_target,
  postedAt: r.posted_at ?? undefined,
  fetchedAt: r.fetched_at,
  matchScore: r.match_score ?? undefined,
})

/** Data access for jobs, application status, events and metrics. */
export class JobRepo {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private ts(): string {
    return this.now().toISOString()
  }

  /** Insert a job with a starting status. Returns false when the job id already exists. */
  addJob(job: Job, status: JobStatus = 'queued', reason?: string, matchScore?: number): boolean {
    const exists = this.db.prepare('SELECT 1 FROM jobs WHERE id = ?').get(job.id)
    if (exists) return false
    this.db
      .prepare(
        `INSERT INTO jobs (id, source, source_url, title, company, location, description, apply_url, apply_target, posted_at, fetched_at, match_score)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        job.id,
        job.source,
        job.sourceUrl ?? null,
        job.title,
        job.company,
        job.location ?? null,
        job.description,
        job.applyUrl,
        job.applyTarget,
        job.postedAt ?? null,
        job.fetchedAt,
        matchScore ?? null,
      )
    this.db
      .prepare('INSERT INTO applications (job_id, status, error, updated_at) VALUES (?, ?, ?, ?)')
      .run(job.id, status, reason ?? null, this.ts())
    this.addEvent(job.id, 'added', { status, reason })
    return true
  }

  getJob(id: string): (Job & { matchScore?: number }) | undefined {
    const r = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined
    return r ? toJob(r) : undefined
  }

  getApplication(id: string): ApplicationRow | undefined {
    return this.db.prepare('SELECT * FROM applications WHERE job_id = ?').get(id) as
      ApplicationRow | undefined
  }

  listByStatus(status: JobStatus, limit = 1000): (Job & { matchScore?: number })[] {
    const rows = this.db
      .prepare(
        `SELECT j.* FROM jobs j JOIN applications a ON a.job_id = j.id WHERE a.status = ? ORDER BY a.updated_at, j.id LIMIT ?`,
      )
      .all(status, limit) as unknown as JobRow[]
    return rows.map(toJob)
  }

  setStatus(jobId: string, status: JobStatus, patch: StatusPatch = {}): void {
    const cur = this.getApplication(jobId)
    if (!cur) throw new Error(`No application for job ${jobId}`)
    this.db
      .prepare(
        `UPDATE applications SET status = ?, error = ?, resume_path = ?, backend = ?, started_at = ?, finished_at = ?, attempts = ?, updated_at = ? WHERE job_id = ?`,
      )
      .run(
        status,
        patch.reason === undefined
          ? ['needs_human', 'failed', 'skipped'].includes(status)
            ? cur.error
            : null
          : patch.reason,
        patch.resumePath ?? cur.resume_path,
        patch.backend ?? cur.backend,
        patch.startedAt ?? cur.started_at,
        patch.finishedAt ?? cur.finished_at,
        patch.attempts ?? cur.attempts,
        this.ts(),
        jobId,
      )
    this.addEvent(jobId, 'status', {
      from: cur.status,
      to: status,
      reason: patch.reason ?? undefined,
    })
  }

  addUsage(jobId: string, tokensIn: number, tokensOut: number, costUsd: number): void {
    this.db
      .prepare(
        'UPDATE applications SET tokens_in = tokens_in + ?, tokens_out = tokens_out + ?, cost_usd = cost_usd + ? WHERE job_id = ?',
      )
      .run(tokensIn, tokensOut, costUsd, jobId)
  }

  /** Events never hold form values, only short facts. The payload is also redacted. */
  addEvent(jobId: string, type: string, payload?: unknown): void {
    this.db
      .prepare('INSERT INTO events (job_id, ts, type, payload) VALUES (?, ?, ?, ?)')
      .run(jobId, this.ts(), type, payload === undefined ? null : redactJson(payload))
  }

  events(jobId: string): { ts: string; type: string; payload: string | null }[] {
    return this.db
      .prepare('SELECT ts, type, payload FROM events WHERE job_id = ? ORDER BY id')
      .all(jobId) as never
  }

  /** The same job seen before: identical apply URL, or same company, title and location. */
  findDuplicate(job: Pick<Job, 'applyUrl' | 'company' | 'title' | 'location'>): string | undefined {
    const byUrl = this.db.prepare('SELECT id FROM jobs WHERE apply_url = ?').get(job.applyUrl) as
      { id: string } | undefined
    if (byUrl) return byUrl.id
    const key = (c: string, t: string, l?: string | null) =>
      [c, t, l ?? ''].map(normalizeText).join('|')
    const rows = this.db.prepare('SELECT id, company, title, location FROM jobs').all() as {
      id: string
      company: string
      title: string
      location: string | null
    }[]
    const want = key(job.company, job.title, job.location)
    return rows.find((r) => key(r.company, r.title, r.location) === want)?.id
  }

  /** Applications started today for a site type, used for daily caps. */
  startedTodayFor(siteType: SiteType): number {
    const day = this.now().toISOString().slice(0, 10)
    const rows = this.db
      .prepare(
        `SELECT j.source, j.apply_target FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.started_at >= ?`,
      )
      .all(day) as { source: JobSource; apply_target: ApplyTarget }[]
    return rows.filter(
      (r) => siteTypeOf({ source: r.source, applyTarget: r.apply_target }) === siteType,
    ).length
  }

  counts(): { status: JobStatus; siteType: SiteType; n: number }[] {
    const rows = this.db
      .prepare(
        `SELECT a.status AS status, j.source AS source, j.apply_target AS target, COUNT(*) AS n FROM applications a JOIN jobs j ON j.id = a.job_id GROUP BY a.status, j.source, j.apply_target`,
      )
      .all() as { status: JobStatus; source: JobSource; target: ApplyTarget; n: number }[]
    const merged = new Map<string, { status: JobStatus; siteType: SiteType; n: number }>()
    for (const r of rows) {
      const siteType = siteTypeOf({ source: r.source, applyTarget: r.target })
      const k = `${r.status}|${siteType}`
      const cur = merged.get(k)
      if (cur) cur.n += r.n
      else merged.set(k, { status: r.status, siteType, n: r.n })
    }
    return [...merged.values()]
  }

  recordUnanswered(question: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO answers_seen (question, answer, source, created_at) VALUES (?, '', 'unanswered', ?)`,
      )
      .run(question, this.ts())
  }

  unanswered(): string[] {
    return (
      this.db
        .prepare(`SELECT question FROM answers_seen WHERE source = 'unanswered' ORDER BY id`)
        .all() as { question: string }[]
    ).map((r) => r.question)
  }

  recordMetric(m: MetricRow): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO metrics (job_id, site_type, backend, duration_ms, steps, fields_total, fields_rule, fields_bank, fields_model, verify, outcome, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        m.jobId,
        m.siteType,
        m.backend,
        m.durationMs,
        m.steps,
        m.fieldsTotal,
        m.fieldsRule,
        m.fieldsBank,
        m.fieldsModel,
        m.verify,
        m.outcome,
        this.ts(),
      )
  }

  recordShadow(row: {
    jobId: string
    backend: string
    ok: boolean
    error?: string
    compared: number
    diffs: unknown[]
    durationMs: number
  }): void {
    this.db
      .prepare(
        `INSERT INTO shadow_runs (job_id, backend, ok, error, fields_compared, diff_count, duration_ms, diffs, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.jobId,
        row.backend,
        row.ok ? 1 : 0,
        row.error ?? null,
        row.compared,
        row.diffs.length,
        row.durationMs,
        JSON.stringify(row.diffs),
        this.ts(),
      )
  }

  // --- board bookkeeping --------------------------------------------------------------
  getBoardMap(jobId: string): { boardId: string; lastStage: string | null } | undefined {
    const r = this.db
      .prepare('SELECT board_id, last_stage FROM board_map WHERE job_id = ?')
      .get(jobId) as { board_id: string; last_stage: string | null } | undefined
    return r ? { boardId: r.board_id, lastStage: r.last_stage } : undefined
  }

  setBoardMap(jobId: string, boardId: string, stage: string | null): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO board_map (job_id, board_id, last_stage, updated_at) VALUES (?, ?, ?, ?)',
      )
      .run(jobId, boardId, stage, this.ts())
  }

  pushOutbox(jobId: string, payload: unknown): void {
    this.db
      .prepare('INSERT INTO board_outbox (job_id, payload, created_at) VALUES (?, ?, ?)')
      .run(jobId, JSON.stringify(payload), this.ts())
  }

  outbox(): { id: number; jobId: string; payload: string; attempts: number }[] {
    return this.db
      .prepare('SELECT id, job_id AS jobId, payload, attempts FROM board_outbox ORDER BY id')
      .all() as never
  }

  dropOutbox(id: number): void {
    this.db.prepare('DELETE FROM board_outbox WHERE id = ?').run(id)
  }

  bumpOutbox(id: number): void {
    this.db.prepare('UPDATE board_outbox SET attempts = attempts + 1 WHERE id = ?').run(id)
  }
}
