import type { Job } from './shared/job'
import type { ApplyTarget, JobStatus, SiteType } from './shared/status'

/**
 * Storage the engine needs. Every store is already scoped to one user, so the engine never
 * passes a user id around. `@apply/db` implements these on Postgres.
 */

export type JobRecord = Job & { matchScore?: number }

export interface ApplicationRow {
  jobId: string
  status: JobStatus
  attempts: number
  resumeArtifactId: string | null
  backend: string | null
  startedAt: Date | null
  finishedAt: Date | null
  error: string | null
  /** Why the job is parked (captcha, login_required, unknown_question, ...). */
  blockKind: string | null
  tokensIn: number
  tokensOut: number
  costUsd: number
  updatedAt: Date
}

export interface StatusPatch {
  reason?: string | null
  blockKind?: string | null
  resumeArtifactId?: string
  backend?: string
  startedAt?: Date
  finishedAt?: Date
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

export interface ShadowRow {
  jobId: string
  backend: string
  ok: boolean
  error?: string
  compared: number
  diffs: unknown[]
  durationMs: number
}

export interface SiteStats {
  siteType: SiteType
  runs: number
  /** Share of runs whose verification passed. */
  accuracy: number
  /** Share of runs that did not need a human. */
  completion: number
}

export interface JobLine {
  jobId: string
  company: string
  title: string
  siteType: string
  source: string
  status: string
  backend: string
  verify: string
  steps: number
  durationMs: number
  fieldsRule: number
  fieldsBank: number
  fieldsModel: number
  reason: string
  matchScore: number | null
}

export interface ReportRows {
  jobs: JobLine[]
  llm: { calls: number; cached: number; tokensIn: number; tokensOut: number; costUsd: number }
  shadow: {
    backend: string
    runs: number
    ok: number
    compared: number
    diffs: number
    errors: string[]
  }[]
  unanswered: string[]
}

export interface BoardMapRow {
  boardId: string
  lastStage: string | null
}

export interface JobStore {
  /** Insert a job with a starting status. Returns false when the job already exists. */
  addJob(job: Job, status?: JobStatus, reason?: string, matchScore?: number): Promise<boolean>
  getJob(id: string): Promise<JobRecord | undefined>
  getApplication(id: string): Promise<ApplicationRow | undefined>
  listByStatus(status: JobStatus, limit?: number): Promise<JobRecord[]>
  setStatus(jobId: string, status: JobStatus, patch?: StatusPatch): Promise<void>
  addUsage(jobId: string, tokensIn: number, tokensOut: number, costUsd: number): Promise<void>
  /** Events never hold form values, only short facts. */
  addEvent(jobId: string, type: string, payload?: unknown): Promise<void>
  events(jobId: string): Promise<{ ts: Date; type: string; payload: unknown }[]>
  /** The same job seen before: identical apply URL, or same company, title and location. */
  findDuplicate(
    job: Pick<Job, 'applyUrl' | 'company' | 'title' | 'location'>,
  ): Promise<string | undefined>
  /** Applications started today (UTC) for a site type. Used for daily caps. */
  startedTodayFor(siteType: SiteType, now?: Date): Promise<number>
  counts(): Promise<{ status: JobStatus; siteType: SiteType; n: number }[]>
  recordUnanswered(question: string): Promise<void>
  unanswered(): Promise<string[]>
  recordMetric(m: MetricRow): Promise<void>
  recordShadow(row: ShadowRow): Promise<void>
  siteStats(siteType: SiteType): Promise<SiteStats>
  reportRows(): Promise<ReportRows>
  getBoardMap(jobId: string): Promise<BoardMapRow | undefined>
  setBoardMap(jobId: string, boardId: string, stage: string | null): Promise<void>
  pushOutbox(jobId: string, payload: unknown): Promise<void>
  outbox(): Promise<{ id: number; jobId: string; payload: unknown; attempts: number }[]>
  dropOutbox(id: number): Promise<void>
  bumpOutbox(id: number): Promise<void>
}

export interface LlmUsageRow {
  jobId?: string
  task: string
  model: string
  tokensIn: number
  tokensOut: number
  costUsd: number
  cached: boolean
  at: Date
}

export interface LlmStore {
  getCache(key: string): Promise<string | undefined>
  putCache(key: string, task: string, response: string): Promise<void>
  recordUsage(row: LlmUsageRow): Promise<void>
  /** Spend since 00:00 UTC of the day containing `now`. */
  spentToday(now: Date): Promise<number>
}

export type ArtifactKind = 'resume_pdf' | 'screenshot' | 'record' | 'tailor'

export interface ArtifactMeta {
  id: string
  jobId: string
  kind: ArtifactKind
  name: string
  contentType: string
  size: number
}

export interface ArtifactStore {
  /** Replaces an artifact with the same job, kind and name. Returns its id. */
  put(a: {
    jobId: string
    kind: ArtifactKind
    name: string
    contentType: string
    data: Buffer
  }): Promise<string>
  get(id: string): Promise<(ArtifactMeta & { data: Buffer }) | undefined>
  list(jobId: string): Promise<ArtifactMeta[]>
}

/** Playwright storage state: cookies and local storage for one signed in session. */
export interface StorageState {
  cookies: Record<string, unknown>[]
  origins: Record<string, unknown>[]
}

export interface SessionStore {
  get(key: string): Promise<StorageState | undefined>
  /** Save a sign in. Marks it connected. */
  put(key: string, state: StorageState): Promise<void>
  /** The site showed a sign in page with this saved session, so the user must sign in again. */
  markExpired?(key: string): Promise<void>
}

export interface Stores {
  jobs: JobStore
  llm: LlmStore
  artifacts: ArtifactStore
  sessions: SessionStore
}

export type { ApplyTarget }
