import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { FallbackBoardLogger, McpBoardLogger } from '@apply/core/board'
import {
  createMockBoard,
  demoSettings,
  MOCK_TARGET_RULES,
  startMockServer,
  type MockBoard,
  type MockServer,
} from '@apply/core/demo'
import { readProfileTexts } from '@apply/core/profile-fs'
import type { UserSettings } from '@apply/core/settings'
import {
  enqueueTask,
  generateKey,
  generateSealKeyPair,
  registerUser,
  saveProfileFile,
  saveSettings,
  userStores,
  PgJobStore,
  type Db,
  type SessionUser,
  type TaskType,
} from '@apply/db'
import { createTestDb } from '@apply/db/testing'
import { loadEnv, type WorkerEnv } from '../src/env'
import type { WorkerHooks } from '../src/user-engine'
import { startWorker } from '../src/worker'

export const DEMO_PROFILE_DIR = resolve(__dirname, '../../../demo/profile')

export interface TestWorld {
  db: Db
  server: MockServer
  board: MockBoard
  env: WorkerEnv
  hooks: WorkerHooks
  users: SessionUser[]
  logs: string[]
  addUser(email?: string, tweak?: (s: UserSettings) => UserSettings): Promise<SessionUser>
  store(user: SessionUser): PgJobStore
  stores(user: SessionUser): ReturnType<typeof userStores>
  /** Queue a task and run the worker until the queue is empty. */
  run(user: SessionUser, type: TaskType, payload?: Record<string, unknown>): Promise<void>
  /** Run whatever is queued, for all users. */
  drain(): Promise<void>
  close(): Promise<void>
}

/** A database, the mock job sites, a mock board, and a worker, all in process. */
export async function makeWorld(
  options: { tweak?: (s: UserSettings) => UserSettings; workerConcurrency?: number } = {},
): Promise<TestWorld> {
  const t = await createTestDb()
  const server = await startMockServer()
  const board = await createMockBoard()
  const key = generateKey()
  const env = loadEnv({
    DATABASE_URL: 'test',
    APP_ENCRYPTION_KEY: key,
    WORKER_SESSION_PRIVATE_KEY: generateSealKeyPair().privateKey,
    WORK_DIR: mkdtempSync(join(tmpdir(), 'aa-work-')),
    WORKER_CONCURRENCY: String(options.workerConcurrency ?? 2),
    POLL_MS: '200',
  })
  const logs: string[] = []
  const hooks: WorkerHooks = {
    targetRules: MOCK_TARGET_RULES,
    boardFor: (userId, stores) =>
      new FallbackBoardLogger(
        new McpBoardLogger(board.client, stores.jobs),
        { name: 'none', log: async () => undefined },
        stores.jobs,
      ),
  }
  const users: SessionUser[] = []
  let n = 0
  const texts = readProfileTexts(DEMO_PROFILE_DIR)

  const world: TestWorld = {
    db: t.db,
    server,
    board,
    env,
    hooks,
    users,
    logs,
    async addUser(email = `user${++n}@example.com`, tweak = options.tweak ?? ((s) => s)) {
      const u = await registerUser(t.db, { email, password: 'correct horse battery' })
      for (const kind of ['resume', 'titles', 'projects', 'answers'] as const)
        await saveProfileFile(t.db, u.id, kind, texts[kind] ?? '')
      await saveSettings(t.db, u.id, tweak(demoSettings(server.url)))
      users.push(u)
      return u
    },
    store: (u) => new PgJobStore(t.db, u.id),
    stores: (u) => userStores(t.db, u.id, env.encryptionKey, env.sessionKeys),
    async run(user, type, payload = {}) {
      await enqueueTask(t.db, user.id, type, payload)
      await world.drain()
    },
    async drain() {
      const w = startWorker(t.db, env, { hooks, log: (l) => logs.push(l) })
      try {
        await w.idle()
      } finally {
        await w.stop()
      }
    },
    async close() {
      await board.close()
      await server.close()
      await t.close()
    },
  }
  return world
}

export async function statusOf(w: TestWorld, user: SessionUser, company: string) {
  const s = w.store(user)
  const rows = await s.reportRows()
  const r = rows.jobs.find((j) => j.company === company && j.status !== 'skipped')
  return r ? { status: r.status, reason: r.reason, jobId: r.jobId } : undefined
}
