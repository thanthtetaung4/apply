import { and, desc, eq, inArray, lt, sql, type SQL } from 'drizzle-orm'
import type { Db } from './client'
import { ARTIFACT_KINDS, artifacts, jobs } from './schema'

/** Files the app produced for a user: tailored resumes, step screenshots and run records. */

export type FileKind = (typeof ARTIFACT_KINDS)[number]
export const FILE_KINDS = ARTIFACT_KINDS

export interface FileRow {
  id: string
  jobId: string
  kind: FileKind
  name: string
  contentType: string
  size: number
  createdAt: Date
  company: string
  title: string
}

export interface FileQuery {
  kind?: FileKind
  /** Matches company, job title or file name. */
  q?: string
  limit?: number
  offset?: number
}

const isKind = (k: unknown): k is FileKind => (FILE_KINDS as readonly unknown[]).includes(k)

function filter(userId: string, q: FileQuery): SQL {
  const parts: SQL[] = [eq(artifacts.userId, userId)]
  if (q.kind && isKind(q.kind)) parts.push(eq(artifacts.kind, q.kind))
  const text = q.q?.trim()
  if (text) {
    const like = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    parts.push(
      sql`(${jobs.company} ilike ${like} or ${jobs.title} ilike ${like} or ${artifacts.name} ilike ${like})`,
    )
  }
  return and(...parts)!
}

/** One page of files, newest first, with the job they belong to. Never loads file contents. */
export async function listFiles(
  db: Db,
  userId: string,
  q: FileQuery = {},
): Promise<{ rows: FileRow[]; total: number }> {
  const where = filter(userId, q)
  const join = and(eq(jobs.userId, artifacts.userId), eq(jobs.id, artifacts.jobId))
  const [rows, [count]] = await Promise.all([
    db
      .select({
        id: artifacts.id,
        jobId: artifacts.jobId,
        kind: artifacts.kind,
        name: artifacts.name,
        contentType: artifacts.contentType,
        size: artifacts.size,
        createdAt: artifacts.createdAt,
        company: jobs.company,
        title: jobs.title,
      })
      .from(artifacts)
      .innerJoin(jobs, join)
      .where(where)
      .orderBy(desc(artifacts.createdAt), artifacts.name)
      .limit(Math.min(Math.max(q.limit ?? 50, 1), 200))
      .offset(Math.max(q.offset ?? 0, 0)),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(artifacts)
      .innerJoin(jobs, join)
      .where(where),
  ])
  return { rows: rows.map((r) => ({ ...r, kind: r.kind as FileKind })), total: count?.n ?? 0 }
}

/** Count and bytes per kind, for the storage summary. */
export async function fileUsage(
  db: Db,
  userId: string,
): Promise<{ kind: FileKind; count: number; bytes: number }[]> {
  const rows = await db
    .select({
      kind: artifacts.kind,
      count: sql<number>`count(*)::int`,
      bytes: sql<number>`coalesce(sum(${artifacts.size}), 0)::bigint`,
    })
    .from(artifacts)
    .where(eq(artifacts.userId, userId))
    .groupBy(artifacts.kind)
  return rows.map((r) => ({ kind: r.kind as FileKind, count: r.count, bytes: Number(r.bytes) }))
}

/** Delete the given files. Ids of other users are ignored. Returns how many were deleted. */
export async function deleteFiles(db: Db, userId: string, ids: string[]): Promise<number> {
  const valid = ids.filter((id) => /^[0-9a-f-]{36}$/i.test(id))
  if (valid.length === 0) return 0
  const r = await db
    .delete(artifacts)
    .where(and(eq(artifacts.userId, userId), inArray(artifacts.id, valid)))
    .returning({ id: artifacts.id })
  return r.length
}

/** Delete every file of a kind, optionally only those older than a date. */
export async function deleteFilesOfKind(
  db: Db,
  userId: string,
  kind: FileKind,
  olderThan?: Date,
): Promise<number> {
  if (!isKind(kind)) throw new Error(`Unknown file kind "${String(kind)}"`)
  const parts = [eq(artifacts.userId, userId), eq(artifacts.kind, kind)]
  if (olderThan) parts.push(lt(artifacts.createdAt, olderThan))
  const r = await db
    .delete(artifacts)
    .where(and(...parts))
    .returning({ id: artifacts.id })
  return r.length
}
