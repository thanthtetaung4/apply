import { INTAKE_SOURCES } from '@apply/core/status'
import { z } from 'zod'
import { enqueueTask, isCancelRequested, type Db, type Task } from '@apply/db'
import type { WorkerEnv } from './env'
import { buildUserEngine, type WorkerHooks } from './user-engine'

const IntakePayload = z.object({
  sources: z.array(z.enum(INTAKE_SOURCES)).optional(),
  /** Job pages added by link. */
  urls: z
    .array(z.url({ protocol: /^https?$/ }).max(2000))
    .max(20)
    .optional(),
  dryRun: z.boolean().optional(),
  /** Queue an apply run right after, for jobs that were found. */
  thenRun: z.boolean().optional(),
})

const RunPayload = z.object({
  limit: z.number().int().min(1).max(500).optional(),
  jobIds: z.array(z.string().max(100)).max(500).optional(),
  /** Jobs you reviewed and approved. They are submitted even when the site policy is review. */
  approveJobIds: z.array(z.string().max(100)).max(500).optional(),
})

export interface TaskOutcome {
  /** Set when the task stopped early because the user canceled it. */
  canceled?: boolean
  result: unknown
}

/** Run one task for its owner. Throws for failures. The caller records the result. */
export async function handleTask(
  db: Db,
  env: WorkerEnv,
  task: Task,
  hooks: WorkerHooks = {},
): Promise<TaskOutcome> {
  const ue = await buildUserEngine(db, env, task.userId, task.id, hooks)
  try {
    switch (task.type) {
      case 'intake': {
        const p = IntakePayload.parse(task.payload)
        const summary = await ue.engine.intake({
          sources: p.sources,
          urls: p.urls,
          dryRun: p.dryRun,
        })
        if (p.thenRun && !p.dryRun && summary.queued > 0)
          await enqueueTask(db, task.userId, 'run', {})
        return { result: summary }
      }
      case 'run': {
        const p = RunPayload.parse(task.payload)
        const summary = await ue.engine.orchestrator.run({
          limit: p.limit,
          jobIds: p.jobIds,
          approveJobIds: p.approveJobIds,
        })
        const canceled = await isCancelRequested(db, task.id)
        return { canceled, result: summary }
      }
      default:
        throw new Error(`Unknown task type "${String(task.type)}"`)
    }
  } finally {
    await ue.close()
  }
}
