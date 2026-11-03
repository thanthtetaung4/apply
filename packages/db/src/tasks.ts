import { redact } from '@apply/core/redact'
import { and, asc, desc, eq, gt, sql } from 'drizzle-orm'
import type { Db } from './client'
import { taskLogs, tasks, TASK_TYPES } from './schema'

const rowsOf = (res: unknown) => (res as { rows: Record<string, unknown>[] }).rows

export type TaskType = (typeof TASK_TYPES)[number]
export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'

export interface Task {
  id: string
  userId: string
  type: TaskType
  payload: Record<string, unknown>
  status: TaskStatus
  attempts: number
  lockedBy: string | null
  cancelRequested: boolean
  createdAt: Date
  startedAt: Date | null
  finishedAt: Date | null
  error: string | null
  result: unknown
}

const MAX_ATTEMPTS = 3

const toTask = (r: typeof tasks.$inferSelect): Task => ({
  id: r.id,
  userId: r.userId,
  type: r.type as TaskType,
  payload: (r.payload ?? {}) as Record<string, unknown>,
  status: r.status as TaskStatus,
  attempts: r.attempts,
  lockedBy: r.lockedBy,
  cancelRequested: r.cancelRequested,
  createdAt: r.createdAt,
  startedAt: r.startedAt,
  finishedAt: r.finishedAt,
  error: r.error,
  result: r.result,
})

/** Queue work for the worker. A second request for the same kind of work returns the waiting one. */
export async function enqueueTask(
  db: Db,
  userId: string,
  type: TaskType,
  payload: Record<string, unknown> = {},
): Promise<{ id: string; alreadyQueued: boolean }> {
  const inserted = await db
    .insert(tasks)
    .values({ userId, type, payload })
    .onConflictDoNothing()
    .returning({ id: tasks.id })
  if (inserted[0]) return { id: inserted[0].id, alreadyQueued: false }
  const [existing] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.userId, userId), eq(tasks.type, type), eq(tasks.status, 'queued')))
  return { id: existing!.id, alreadyQueued: true }
}

/**
 * Take the oldest waiting task whose owner has nothing running. Safe with many workers:
 * FOR UPDATE SKIP LOCKED stops two workers taking the same row, and a unique index allows one
 * running task per user.
 */
export async function claimNextTask(db: Db, workerId: string): Promise<Task | undefined> {
  try {
    const res = await db.execute(sql`
      WITH next AS (
        SELECT t.id FROM tasks t
        WHERE t.status = 'queued'
          AND NOT EXISTS (SELECT 1 FROM tasks r WHERE r.user_id = t.user_id AND r.status = 'running')
        ORDER BY t.created_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE tasks
         SET status = 'running', locked_by = ${workerId}, started_at = now(), heartbeat_at = now(),
             attempts = tasks.attempts + 1
        FROM next
       WHERE tasks.id = next.id
      RETURNING tasks.id
    `)
    const id = rowsOf(res)[0]?.id as string | undefined
    if (!id) return undefined
    const [row] = await db.select().from(tasks).where(eq(tasks.id, id))
    return row ? toTask(row) : undefined
  } catch (err) {
    // Another worker started a task for the same user a moment earlier. Try again next poll.
    if ((err as { code?: string }).code === '23505') return undefined
    throw err
  }
}

export async function heartbeat(db: Db, taskId: string): Promise<void> {
  await db
    .update(tasks)
    .set({ heartbeatAt: new Date() })
    .where(and(eq(tasks.id, taskId), eq(tasks.status, 'running')))
}

/** Put tasks whose worker disappeared back in the queue (or fail them after too many tries). */
export async function reclaimStaleTasks(db: Db, staleAfterMs: number): Promise<number> {
  const res = await db.execute(sql`
    UPDATE tasks
       SET status = CASE WHEN attempts >= ${MAX_ATTEMPTS} THEN 'failed' ELSE 'queued' END,
           error = 'The worker stopped responding.',
           locked_by = NULL,
           finished_at = CASE WHEN attempts >= ${MAX_ATTEMPTS} THEN now() ELSE NULL END
     WHERE status = 'running' AND heartbeat_at < now() - (${staleAfterMs}::int * interval '1 millisecond')
    RETURNING id
  `)
  return rowsOf(res).length
}

export async function completeTask(db: Db, taskId: string, result: unknown): Promise<void> {
  await db
    .update(tasks)
    .set({ status: 'succeeded', finishedAt: new Date(), result: result ?? null, error: null })
    .where(eq(tasks.id, taskId))
}

export async function failTask(db: Db, taskId: string, error: string): Promise<void> {
  await db
    .update(tasks)
    .set({ status: 'failed', finishedAt: new Date(), error: redact(error).slice(0, 500) })
    .where(eq(tasks.id, taskId))
}

export async function cancelTaskDone(db: Db, taskId: string, result?: unknown): Promise<void> {
  await db
    .update(tasks)
    .set({ status: 'canceled', finishedAt: new Date(), result: result ?? null })
    .where(eq(tasks.id, taskId))
}

/** A waiting task is canceled at once. A running one is asked to stop and finishes cleanly. */
export async function requestCancel(db: Db, userId: string, taskId: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(taskId)) return
  await db
    .update(tasks)
    .set({ status: 'canceled', finishedAt: new Date() })
    .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId), eq(tasks.status, 'queued')))
  await db
    .update(tasks)
    .set({ cancelRequested: true })
    .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId), eq(tasks.status, 'running')))
}

export async function isCancelRequested(db: Db, taskId: string): Promise<boolean> {
  const [r] = await db.select({ c: tasks.cancelRequested }).from(tasks).where(eq(tasks.id, taskId))
  return r?.c ?? false
}

export async function getTask(db: Db, userId: string, taskId: string): Promise<Task | undefined> {
  if (!/^[0-9a-f-]{36}$/i.test(taskId)) return undefined
  const [r] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId)))
  return r ? toTask(r) : undefined
}

export async function listTasks(db: Db, userId: string, limit = 10): Promise<Task[]> {
  const rows = await db
    .select()
    .from(tasks)
    .where(eq(tasks.userId, userId))
    .orderBy(desc(tasks.createdAt))
    .limit(limit)
  return rows.map(toTask)
}

export async function addTaskLog(
  db: Db,
  taskId: string,
  message: string,
  level: 'info' | 'error' = 'info',
): Promise<void> {
  await db.insert(taskLogs).values({ taskId, level, message: redact(message).slice(0, 500) })
}

export async function listTaskLogs(
  db: Db,
  userId: string,
  taskId: string,
  afterId = 0,
): Promise<{ id: number; ts: Date; level: string; message: string }[]> {
  if (!(await getTask(db, userId, taskId))) return []
  return db
    .select({ id: taskLogs.id, ts: taskLogs.ts, level: taskLogs.level, message: taskLogs.message })
    .from(taskLogs)
    .where(and(eq(taskLogs.taskId, taskId), gt(taskLogs.id, afterId)))
    .orderBy(asc(taskLogs.id))
    .limit(500)
}

/**
 * Queue a run, or add to the one already waiting. Approving a job while a run is queued must not be
 * lost, so ids are merged. A run with no job list means "everything that is ready".
 */
export async function enqueueRun(
  db: Db,
  userId: string,
  want: { jobIds?: string[]; approveJobIds?: string[]; limit?: number } = {},
): Promise<{ id: string; alreadyQueued: boolean }> {
  const first = await enqueueTask(db, userId, 'run', want)
  if (!first.alreadyQueued) return first
  const [row] = await db.select({ payload: tasks.payload }).from(tasks).where(eq(tasks.id, first.id))
  const old = (row?.payload ?? {}) as { jobIds?: string[]; approveJobIds?: string[]; limit?: number }
  const union = (a?: string[], b?: string[]) => (a && b ? [...new Set([...a, ...b])] : undefined)
  const merged = {
    jobIds: union(old.jobIds, want.jobIds),
    approveJobIds: [...new Set([...(old.approveJobIds ?? []), ...(want.approveJobIds ?? [])])],
    limit: old.limit && want.limit ? Math.max(old.limit, want.limit) : undefined,
  }
  await db
    .update(tasks)
    .set({ payload: JSON.parse(JSON.stringify(merged)) })
    .where(and(eq(tasks.id, first.id), eq(tasks.status, 'queued')))
  return first
}
