import type { ArtifactMeta } from '@apply/core/store'
import { and, desc, eq, ilike, or, sql } from 'drizzle-orm'
import type { Db } from './client'
import { applications, artifacts, events, jobs, metrics } from './schema'

export interface JobListRow {
  id: string
  company: string
  title: string
  location: string | null
  source: string
  applyTarget: string
  applyUrl: string
  matchScore: number | null
  status: string
  error: string | null
  blockKind: string | null
  updatedAt: Date
  verify: string | null
}

export async function listJobs(
  db: Db,
  userId: string,
  opts: { status?: string; q?: string; limit?: number; offset?: number } = {},
): Promise<{ rows: JobListRow[]; total: number }> {
  const where = and(
    eq(jobs.userId, userId),
    opts.status ? eq(applications.status, opts.status) : undefined,
    opts.q
      ? or(
          ilike(jobs.company, `%${opts.q.replace(/[%_]/g, '')}%`),
          ilike(jobs.title, `%${opts.q.replace(/[%_]/g, '')}%`),
        )
      : undefined,
  )
  const base = db
    .select({
      id: jobs.id,
      company: jobs.company,
      title: jobs.title,
      location: jobs.location,
      source: jobs.source,
      applyTarget: jobs.applyTarget,
      applyUrl: jobs.applyUrl,
      matchScore: jobs.matchScore,
      status: applications.status,
      error: applications.error,
      blockKind: applications.blockKind,
      updatedAt: applications.updatedAt,
      verify: metrics.verify,
    })
    .from(jobs)
    .innerJoin(
      applications,
      and(eq(applications.userId, jobs.userId), eq(applications.jobId, jobs.id)),
    )
    .leftJoin(metrics, and(eq(metrics.userId, jobs.userId), eq(metrics.jobId, jobs.id)))
    .where(where)
  const rows = await base
    .orderBy(desc(applications.updatedAt))
    .limit(opts.limit ?? 50)
    .offset(opts.offset ?? 0)
  const [t] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(jobs)
    .innerJoin(
      applications,
      and(eq(applications.userId, jobs.userId), eq(applications.jobId, jobs.id)),
    )
    .where(where)
  return { rows, total: t?.n ?? 0 }
}

export async function getJobDetail(db: Db, userId: string, jobId: string) {
  const [row] = await db
    .select({ job: jobs, app: applications, m: metrics })
    .from(jobs)
    .innerJoin(
      applications,
      and(eq(applications.userId, jobs.userId), eq(applications.jobId, jobs.id)),
    )
    .leftJoin(metrics, and(eq(metrics.userId, jobs.userId), eq(metrics.jobId, jobs.id)))
    .where(and(eq(jobs.userId, userId), eq(jobs.id, jobId)))
  if (!row) return undefined
  const ev = await db
    .select({ ts: events.ts, type: events.type, payload: events.payload })
    .from(events)
    .where(and(eq(events.userId, userId), eq(events.jobId, jobId)))
    .orderBy(events.id)
  const files: ArtifactMeta[] = (
    await db
      .select({
        id: artifacts.id,
        jobId: artifacts.jobId,
        kind: artifacts.kind,
        name: artifacts.name,
        contentType: artifacts.contentType,
        size: artifacts.size,
      })
      .from(artifacts)
      .where(and(eq(artifacts.userId, userId), eq(artifacts.jobId, jobId)))
      .orderBy(artifacts.name)
  ).map((a) => ({ ...a, kind: a.kind as ArtifactMeta['kind'] }))
  return { ...row, events: ev, artifacts: files }
}
