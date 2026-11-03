import type {
  ApplicationRow,
  BoardMapRow,
  JobLine,
  JobRecord,
  JobStore,
  MetricRow,
  ReportRows,
  ShadowRow,
  SiteStats,
  StatusPatch,
} from '@apply/core/store'
import type { Job } from '@apply/core/job'
import { redactJson } from '@apply/core/redact'
import type { ApplyTarget, JobSource, JobStatus, SiteType } from '@apply/core/status'
import { and, asc, desc, eq, gte, sql } from 'drizzle-orm'
import type { Db } from './client'
import {
  answersSeen,
  applications,
  boardMap,
  boardOutbox,
  events,
  jobs,
  llmUsage,
  metrics,
  shadowRuns,
} from './schema'

const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[\s.;,]+$/, '')
    .trim()

/** The site type that decides recipe, config block, daily cap and metrics group. */
export const siteTypeOfRow = (r: { source: string; applyTarget: string }): SiteType =>
  (r.applyTarget === 'board_native' ? r.source : r.applyTarget) as SiteType

const toRecord = (r: typeof jobs.$inferSelect): JobRecord => ({
  id: r.id,
  source: r.source as JobSource,
  sourceUrl: r.sourceUrl ?? undefined,
  title: r.title,
  company: r.company,
  location: r.location ?? undefined,
  description: r.description,
  applyUrl: r.applyUrl,
  applyTarget: r.applyTarget as ApplyTarget,
  postedAt: r.postedAt ?? undefined,
  fetchedAt: r.fetchedAt.toISOString(),
  matchScore: r.matchScore ?? undefined,
})

const utcDayStart = (d: Date) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))

/** Postgres implementation of the engine's JobStore, scoped to one user. */
export class PgJobStore implements JobStore {
  constructor(
    private readonly db: Db,
    readonly userId: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async addJob(
    job: Job,
    status: JobStatus = 'queued',
    reason?: string,
    matchScore?: number,
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(jobs)
        .values({
          userId: this.userId,
          id: job.id,
          source: job.source,
          sourceUrl: job.sourceUrl ?? null,
          title: job.title,
          company: job.company,
          location: job.location ?? null,
          description: job.description,
          applyUrl: job.applyUrl,
          applyTarget: job.applyTarget,
          postedAt: job.postedAt ?? null,
          fetchedAt: new Date(job.fetchedAt),
          matchScore: matchScore ?? null,
        })
        .onConflictDoNothing()
        .returning({ id: jobs.id })
      if (inserted.length === 0) return false
      await tx
        .insert(applications)
        .values({
          userId: this.userId,
          jobId: job.id,
          status,
          error: reason ?? null,
          updatedAt: this.now(),
        })
      await tx.insert(events).values({
        userId: this.userId,
        jobId: job.id,
        ts: this.now(),
        type: 'added',
        payload: JSON.parse(redactJson({ status, reason })),
      })
      return true
    })
  }

  async getJob(id: string): Promise<JobRecord | undefined> {
    const [r] = await this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.userId, this.userId), eq(jobs.id, id)))
    return r ? toRecord(r) : undefined
  }

  async getApplication(id: string): Promise<ApplicationRow | undefined> {
    const [r] = await this.db
      .select()
      .from(applications)
      .where(and(eq(applications.userId, this.userId), eq(applications.jobId, id)))
    return r ? ({ ...r, status: r.status as JobStatus } satisfies ApplicationRow) : undefined
  }

  async listByStatus(status: JobStatus, limit = 1000): Promise<JobRecord[]> {
    const rows = await this.db
      .select({ job: jobs })
      .from(applications)
      .innerJoin(jobs, and(eq(jobs.userId, applications.userId), eq(jobs.id, applications.jobId)))
      .where(and(eq(applications.userId, this.userId), eq(applications.status, status)))
      .orderBy(asc(applications.updatedAt), asc(jobs.id))
      .limit(limit)
    return rows.map((r) => toRecord(r.job))
  }

  async setStatus(jobId: string, status: JobStatus, patch: StatusPatch = {}): Promise<void> {
    const cur = await this.getApplication(jobId)
    if (!cur) throw new Error(`No application for job ${jobId}`)
    const keepError = ['needs_human', 'failed', 'skipped'].includes(status)
    await this.db
      .update(applications)
      .set({
        status,
        error: patch.reason === undefined ? (keepError ? cur.error : null) : patch.reason,
        blockKind: patch.blockKind === undefined ? (keepError ? cur.blockKind : null) : patch.blockKind,
        resumeArtifactId: patch.resumeArtifactId ?? cur.resumeArtifactId,
        backend: patch.backend ?? cur.backend,
        startedAt: patch.startedAt ?? cur.startedAt,
        finishedAt: patch.finishedAt ?? cur.finishedAt,
        attempts: patch.attempts ?? cur.attempts,
        updatedAt: this.now(),
      })
      .where(and(eq(applications.userId, this.userId), eq(applications.jobId, jobId)))
    await this.addEvent(jobId, 'status', {
      from: cur.status,
      to: status,
      reason: patch.reason ?? undefined,
    })
  }

  async addUsage(
    jobId: string,
    tokensIn: number,
    tokensOut: number,
    costUsd: number,
  ): Promise<void> {
    await this.db
      .update(applications)
      .set({
        tokensIn: sql`${applications.tokensIn} + ${tokensIn}`,
        tokensOut: sql`${applications.tokensOut} + ${tokensOut}`,
        costUsd: sql`${applications.costUsd} + ${costUsd}`,
      })
      .where(and(eq(applications.userId, this.userId), eq(applications.jobId, jobId)))
  }

  async addEvent(jobId: string, type: string, payload?: unknown): Promise<void> {
    await this.db.insert(events).values({
      userId: this.userId,
      jobId,
      ts: this.now(),
      type,
      payload: payload === undefined ? null : JSON.parse(redactJson(payload)),
    })
  }

  async events(jobId: string): Promise<{ ts: Date; type: string; payload: unknown }[]> {
    const rows = await this.db
      .select({ ts: events.ts, type: events.type, payload: events.payload })
      .from(events)
      .where(and(eq(events.userId, this.userId), eq(events.jobId, jobId)))
      .orderBy(asc(events.id))
    return rows
  }

  async findDuplicate(
    job: Pick<Job, 'applyUrl' | 'company' | 'title' | 'location'>,
  ): Promise<string | undefined> {
    const [byUrl] = await this.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.userId, this.userId), eq(jobs.applyUrl, job.applyUrl)))
      .limit(1)
    if (byUrl) return byUrl.id
    const key = (c: string, t: string, l?: string | null) =>
      [c, t, l ?? ''].map(normalize).join('|')
    const rows = await this.db
      .select({ id: jobs.id, company: jobs.company, title: jobs.title, location: jobs.location })
      .from(jobs)
      .where(eq(jobs.userId, this.userId))
    const want = key(job.company, job.title, job.location)
    return rows.find((r) => key(r.company, r.title, r.location) === want)?.id
  }

  async startedTodayFor(siteType: SiteType, now: Date = this.now()): Promise<number> {
    const rows = await this.db
      .select({ source: jobs.source, applyTarget: jobs.applyTarget })
      .from(applications)
      .innerJoin(jobs, and(eq(jobs.userId, applications.userId), eq(jobs.id, applications.jobId)))
      .where(
        and(eq(applications.userId, this.userId), gte(applications.startedAt, utcDayStart(now))),
      )
    return rows.filter((r) => siteTypeOfRow(r) === siteType).length
  }

  async counts(): Promise<{ status: JobStatus; siteType: SiteType; n: number }[]> {
    const rows = await this.db
      .select({
        status: applications.status,
        source: jobs.source,
        applyTarget: jobs.applyTarget,
        n: sql<number>`count(*)::int`,
      })
      .from(applications)
      .innerJoin(jobs, and(eq(jobs.userId, applications.userId), eq(jobs.id, applications.jobId)))
      .where(eq(applications.userId, this.userId))
      .groupBy(applications.status, jobs.source, jobs.applyTarget)
    const merged = new Map<string, { status: JobStatus; siteType: SiteType; n: number }>()
    for (const r of rows) {
      const siteType = siteTypeOfRow(r)
      const k = `${r.status}|${siteType}`
      const cur = merged.get(k)
      if (cur) cur.n += r.n
      else merged.set(k, { status: r.status as JobStatus, siteType, n: r.n })
    }
    return [...merged.values()]
  }

  async recordUnanswered(question: string): Promise<void> {
    await this.db
      .insert(answersSeen)
      .values({
        userId: this.userId,
        question,
        answer: '',
        source: 'unanswered',
        createdAt: this.now(),
      })
      .onConflictDoNothing()
  }

  async unanswered(): Promise<string[]> {
    const rows = await this.db
      .select({ question: answersSeen.question })
      .from(answersSeen)
      .where(and(eq(answersSeen.userId, this.userId), eq(answersSeen.source, 'unanswered')))
      .orderBy(asc(answersSeen.createdAt), asc(answersSeen.question))
    return rows.map((r) => r.question)
  }

  /** The user answered it (in answers.md), so it no longer needs attention. */
  async markAnswered(question: string): Promise<void> {
    await this.db
      .update(answersSeen)
      .set({ source: 'answered' })
      .where(and(eq(answersSeen.userId, this.userId), eq(answersSeen.question, question)))
  }

  async recordMetric(m: MetricRow): Promise<void> {
    const values = {
      userId: this.userId,
      jobId: m.jobId,
      siteType: m.siteType,
      backend: m.backend,
      durationMs: m.durationMs,
      steps: m.steps,
      fieldsTotal: m.fieldsTotal,
      fieldsRule: m.fieldsRule,
      fieldsBank: m.fieldsBank,
      fieldsModel: m.fieldsModel,
      verify: m.verify,
      outcome: m.outcome,
      createdAt: this.now(),
    }
    await this.db
      .insert(metrics)
      .values(values)
      .onConflictDoUpdate({ target: [metrics.userId, metrics.jobId], set: values })
  }

  async recordShadow(row: ShadowRow): Promise<void> {
    await this.db.insert(shadowRuns).values({
      userId: this.userId,
      jobId: row.jobId,
      backend: row.backend,
      ok: row.ok,
      error: row.error ?? null,
      fieldsCompared: row.compared,
      diffCount: row.diffs.length,
      durationMs: row.durationMs,
      diffs: row.diffs,
      createdAt: this.now(),
    })
  }

  async siteStats(siteType: SiteType): Promise<SiteStats> {
    const [r] = await this.db
      .select({
        runs: sql<number>`count(*)::int`,
        passed: sql<number>`coalesce(sum(case when ${metrics.verify} = 'pass' then 1 else 0 end), 0)::int`,
        done: sql<number>`coalesce(sum(case when ${metrics.outcome} <> 'needs_human' then 1 else 0 end), 0)::int`,
      })
      .from(metrics)
      .where(and(eq(metrics.userId, this.userId), eq(metrics.siteType, siteType)))
    const runs = r?.runs ?? 0
    return {
      siteType,
      runs,
      accuracy: runs ? r!.passed / runs : 0,
      completion: runs ? r!.done / runs : 0,
    }
  }

  async reportRows(): Promise<ReportRows> {
    const rows = await this.db
      .select({
        jobId: jobs.id,
        company: jobs.company,
        title: jobs.title,
        source: jobs.source,
        applyTarget: jobs.applyTarget,
        matchScore: jobs.matchScore,
        status: applications.status,
        error: applications.error,
        m: metrics,
      })
      .from(jobs)
      .innerJoin(
        applications,
        and(eq(applications.userId, jobs.userId), eq(applications.jobId, jobs.id)),
      )
      .leftJoin(metrics, and(eq(metrics.userId, jobs.userId), eq(metrics.jobId, jobs.id)))
      .where(eq(jobs.userId, this.userId))
      .orderBy(asc(applications.updatedAt), asc(jobs.id))

    const lines: JobLine[] = rows.map((r) => ({
      jobId: r.jobId,
      company: r.company,
      title: r.title,
      siteType: r.m?.siteType ?? siteTypeOfRow(r),
      source: r.source,
      status: r.status,
      backend: r.m?.backend ?? '',
      verify: r.m?.verify ?? '',
      steps: r.m?.steps ?? 0,
      durationMs: r.m?.durationMs ?? 0,
      fieldsRule: r.m?.fieldsRule ?? 0,
      fieldsBank: r.m?.fieldsBank ?? 0,
      fieldsModel: r.m?.fieldsModel ?? 0,
      reason: r.error ?? '',
      matchScore: r.matchScore,
    }))

    const [u] = await this.db
      .select({
        calls: sql<number>`count(*)::int`,
        cached: sql<number>`coalesce(sum(case when ${llmUsage.cached} then 1 else 0 end), 0)::int`,
        tokensIn: sql<number>`coalesce(sum(${llmUsage.tokensIn}), 0)::int`,
        tokensOut: sql<number>`coalesce(sum(${llmUsage.tokensOut}), 0)::int`,
        costUsd: sql<number>`coalesce(sum(${llmUsage.costUsd}), 0)::float8`,
      })
      .from(llmUsage)
      .where(eq(llmUsage.userId, this.userId))

    const sh = await this.db
      .select({
        backend: shadowRuns.backend,
        runs: sql<number>`count(*)::int`,
        ok: sql<number>`coalesce(sum(case when ${shadowRuns.ok} then 1 else 0 end), 0)::int`,
        compared: sql<number>`coalesce(sum(${shadowRuns.fieldsCompared}), 0)::int`,
        diffs: sql<number>`coalesce(sum(${shadowRuns.diffCount}), 0)::int`,
      })
      .from(shadowRuns)
      .where(eq(shadowRuns.userId, this.userId))
      .groupBy(shadowRuns.backend)
    const errs = await this.db
      .select({ backend: shadowRuns.backend, error: shadowRuns.error })
      .from(shadowRuns)
      .where(and(eq(shadowRuns.userId, this.userId), eq(shadowRuns.ok, false)))

    return {
      jobs: lines,
      llm: u ?? { calls: 0, cached: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 },
      shadow: sh.map((s) => ({
        ...s,
        errors: [
          ...new Set(errs.filter((e) => e.backend === s.backend && e.error).map((e) => e.error!)),
        ],
      })),
      unanswered: await this.unanswered(),
    }
  }

  async getBoardMap(jobId: string): Promise<BoardMapRow | undefined> {
    const [r] = await this.db
      .select()
      .from(boardMap)
      .where(and(eq(boardMap.userId, this.userId), eq(boardMap.jobId, jobId)))
    return r ? { boardId: r.boardId, lastStage: r.lastStage } : undefined
  }

  async setBoardMap(jobId: string, boardId: string, stage: string | null): Promise<void> {
    const values = { userId: this.userId, jobId, boardId, lastStage: stage, updatedAt: this.now() }
    await this.db
      .insert(boardMap)
      .values(values)
      .onConflictDoUpdate({ target: [boardMap.userId, boardMap.jobId], set: values })
  }

  async pushOutbox(jobId: string, payload: unknown): Promise<void> {
    await this.db.insert(boardOutbox).values({
      userId: this.userId,
      jobId,
      payload: JSON.parse(JSON.stringify(payload)),
      createdAt: this.now(),
    })
  }

  async outbox(): Promise<{ id: number; jobId: string; payload: unknown; attempts: number }[]> {
    return this.db
      .select({
        id: boardOutbox.id,
        jobId: boardOutbox.jobId,
        payload: boardOutbox.payload,
        attempts: boardOutbox.attempts,
      })
      .from(boardOutbox)
      .where(eq(boardOutbox.userId, this.userId))
      .orderBy(asc(boardOutbox.id))
  }

  async dropOutbox(id: number): Promise<void> {
    await this.db
      .delete(boardOutbox)
      .where(and(eq(boardOutbox.userId, this.userId), eq(boardOutbox.id, id)))
  }

  async bumpOutbox(id: number): Promise<void> {
    await this.db
      .update(boardOutbox)
      .set({ attempts: sql`${boardOutbox.attempts} + 1` })
      .where(and(eq(boardOutbox.userId, this.userId), eq(boardOutbox.id, id)))
  }
}

export { desc }
