import { join } from 'node:path'
import { FallbackBoardLogger, McpBoardLogger, connectBoard } from '@apply/core/board'
import type { BoardLogger } from '@apply/core/board'
import { createEngine, type Engine } from '@apply/core/engine'
import type { TargetRule } from '@apply/core/intake'
import { OfflineProvider, OpenRouterProvider, type LlmProvider } from '@apply/core/llm'
import {
  getSecret,
  getSettings,
  isStarterProfile,
  getProfileFiles,
  loadProfile,
  SECRET_NAMES,
  userStores,
  isCancelRequested,
  addTaskLog,
  type Db,
} from '@apply/db'
import { NoopBoardLogger } from '@apply/core/board'
import type { WorkerEnv } from './env'

/** Hooks tests and the demo use to replace network things. Never set in production. */
export interface WorkerHooks {
  boardFor?: (userId: string, stores: ReturnType<typeof userStores>) => BoardLogger | undefined
  provider?: LlmProvider
  targetRules?: TargetRule[]
  sleep?: (ms: number) => Promise<void>
}

export interface UserEngine {
  engine: Engine
  stores: ReturnType<typeof userStores>
  profileFiles: Awaited<ReturnType<typeof getProfileFiles>>
  close(): Promise<void>
}

export class PreflightError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PreflightError'
  }
}

/** Build everything one user's task needs from their saved profile, settings and secrets. */
export async function buildUserEngine(
  db: Db,
  env: WorkerEnv,
  userId: string,
  taskId: string,
  hooks: WorkerHooks = {},
): Promise<UserEngine> {
  const files = await getProfileFiles(db, userId)
  if (isStarterProfile({ resume: files.resume.content })) {
    throw new PreflightError(
      'Your resume is still the starter template. Replace it with your own details on the Profile page first.',
    )
  }
  let profile
  try {
    profile = await loadProfile(db, userId)
  } catch (err) {
    throw new PreflightError(
      `Your profile has problems. Fix them on the Profile page.\n${(err as Error).message}`,
    )
  }

  const settings = await getSettings(db, userId)
  if (!env.ALLOW_HEADED) {
    for (const site of Object.values(settings.sites)) site.headless = true
  }

  const stores = userStores(db, userId, env.encryptionKey)

  const apiKey = await getSecret(db, env.encryptionKey, userId, SECRET_NAMES.openrouterKey)
  const provider =
    hooks.provider ?? (apiKey ? new OpenRouterProvider({ apiKey }) : new OfflineProvider())

  let board: BoardLogger = new NoopBoardLogger()
  const injected = hooks.boardFor?.(userId, stores)
  if (injected) {
    board = injected
  } else {
    const url = await getSecret(db, env.encryptionKey, userId, SECRET_NAMES.boardUrl)
    if (url) {
      const token = await getSecret(db, env.encryptionKey, userId, SECRET_NAMES.boardToken)
      try {
        const client = await connectBoard(url, token)
        board = new FallbackBoardLogger(
          new McpBoardLogger(client, stores.jobs),
          new NoopBoardLogger(),
          stores.jobs,
        )
      } catch (err) {
        await addTaskLog(
          db,
          taskId,
          `Could not reach your Job Search Board (${(err as Error).message.slice(0, 80)}). Continuing without it.`,
          'error',
        )
      }
    }
  }

  // Questions you have since answered no longer need attention.
  for (const q of await stores.jobs.unanswered()) {
    if (profile.answerBank.match(q)) await stores.jobs.markAnswered(q)
  }

  const engine = await createEngine({
    settings,
    profile,
    stores,
    provider,
    board,
    workDir: join(env.WORK_DIR, userId),
    chromiumPath: env.CHROMIUM_PATH,
    maxWorkers: env.MAX_BROWSERS_PER_TASK,
    targetRules: hooks.targetRules,
    sleep: hooks.sleep,
    log: (line) => void addTaskLog(db, taskId, line).catch(() => undefined),
    shouldStop: () => isCancelRequested(db, taskId),
  })
  return { engine, stores, profileFiles: files, close: () => engine.close() }
}
