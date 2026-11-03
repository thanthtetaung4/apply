import { existsSync } from 'node:fs'
import { createDb } from '@apply/db'
import { loadEnv } from './env'
import { startWorker } from './worker'

if (existsSync('.env')) process.loadEnvFile('.env')
const env = loadEnv()
const handle = createDb(process.env.DATABASE_URL!, { max: env.WORKER_CONCURRENCY * 3 + 2 })
const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`)

log(`${env.workerId} starting (concurrency ${env.WORKER_CONCURRENCY}, work dir ${env.WORK_DIR})`)
const worker = startWorker(handle.db, env, { log })

let closing = false
const shutdown = async (signal: string) => {
  if (closing) return
  closing = true
  log(`${signal} received, finishing running tasks`)
  await worker.stop()
  await handle.close()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
