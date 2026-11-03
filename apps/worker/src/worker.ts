import {
  addTaskLog,
  cancelTaskDone,
  claimNextTask,
  completeTask,
  failTask,
  heartbeat,
  purgeExpiredSessions,
  reclaimStaleTasks,
  type Db,
  type Task,
} from '@apply/db'
import type { WorkerEnv } from './env'
import { handleTask } from './handlers'
import type { WorkerHooks } from './user-engine'

export interface WorkerHandle {
  /** Stop taking new tasks and wait for running ones to finish. */
  stop(): Promise<void>
  /** Resolves when the queue is empty and nothing is running. For tests and the demo. */
  idle(): Promise<void>
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * Poll the queue and run tasks. Safe to run several copies: the claim query cannot hand one task to
 * two workers, and a user never has two running tasks.
 */
export function startWorker(
  db: Db,
  env: WorkerEnv,
  options: { hooks?: WorkerHooks; log?: (line: string) => void; exitWhenIdle?: boolean } = {},
): WorkerHandle {
  const log = options.log ?? (() => undefined)
  const active = new Set<Promise<void>>()
  let stopping = false
  let lastMaintenance = 0

  const runOne = async (task: Task) => {
    const beat = setInterval(() => void heartbeat(db, task.id).catch(() => undefined), 15_000)
    log(`task ${task.id.slice(0, 8)} ${task.type} started`)
    try {
      const out = await handleTask(db, env, task, options.hooks)
      if (out.canceled) await cancelTaskDone(db, task.id, out.result)
      else await completeTask(db, task.id, out.result)
      log(`task ${task.id.slice(0, 8)} ${out.canceled ? 'canceled' : 'done'}`)
    } catch (err) {
      const message = (err as Error).message ?? String(err)
      await addTaskLog(db, task.id, message, 'error').catch(() => undefined)
      await failTask(db, task.id, message).catch(() => undefined)
      log(`task ${task.id.slice(0, 8)} failed: ${message.split('\n')[0]}`)
    } finally {
      clearInterval(beat)
    }
  }

  const loop = (async () => {
    while (!stopping) {
      try {
        if (Date.now() - lastMaintenance > 30_000) {
          lastMaintenance = Date.now()
          await reclaimStaleTasks(db, env.STALE_MS)
          await purgeExpiredSessions(db)
        }
        if (active.size < env.WORKER_CONCURRENCY) {
          const task = await claimNextTask(db, env.workerId)
          if (task) {
            const p = runOne(task).finally(() => active.delete(p))
            active.add(p)
            continue
          }
        }
      } catch (err) {
        log(`worker loop error: ${(err as Error).message}`)
      }
      await sleep(env.POLL_MS)
    }
  })()

  return {
    async stop() {
      stopping = true
      await loop
      await Promise.allSettled([...active])
    },
    async idle() {
      for (;;) {
        await Promise.allSettled([...active])
        const next = await claimNextTask(db, env.workerId).catch(() => undefined)
        if (!next) {
          if (active.size === 0) return
          continue
        }
        const p = runOne(next).finally(() => active.delete(p))
        active.add(p)
      }
    },
  }
}
