import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { parseKey } from '@apply/db'

const Schema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  APP_ENCRYPTION_KEY: z.string().min(1, 'APP_ENCRYPTION_KEY is required'),
  CHROMIUM_PATH: z.string().optional(),
  WORK_DIR: z.string().default(join(tmpdir(), 'apply-worker')),
  /** Tasks running at once across all users. Each task also runs several browser contexts. */
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  /** Upper limit for browser contexts inside one task. */
  MAX_BROWSERS_PER_TASK: z.coerce.number().int().min(1).max(6).default(3),
  POLL_MS: z.coerce.number().int().min(200).default(2000),
  STALE_MS: z.coerce.number().int().min(10_000).default(120_000),
  WORKER_ID: z.string().optional(),
  /** Servers have no display. Set to 1 only on a machine where a browser window can open. */
  ALLOW_HEADED: z.string().optional(),
})

export type WorkerEnv = Omit<z.infer<typeof Schema>, 'APP_ENCRYPTION_KEY'> & {
  encryptionKey: Buffer
  workerId: string
}

export function loadEnv(source: Record<string, string | undefined> = process.env): WorkerEnv {
  const r = Schema.safeParse(source)
  if (!r.success) {
    throw new Error(
      `Worker configuration problem:\n${r.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')}`,
    )
  }
  const { APP_ENCRYPTION_KEY, ...rest } = r.data
  return {
    ...rest,
    encryptionKey: parseKey(APP_ENCRYPTION_KEY),
    workerId: rest.WORKER_ID ?? `worker-${process.pid}`,
  }
}
