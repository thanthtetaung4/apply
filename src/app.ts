import { join } from 'node:path'
import { BackendRegistry, NotImplementedBackend } from './browser/registry'
import { PlaywrightBackend } from './browser/playwright-backend'
import { FileBoardLogger } from './board/file-logger'
import { connectBoard, FallbackBoardLogger, McpBoardLogger } from './board/mcp-logger'
import type { BoardLogger } from './board/types'
import type { AppConfig } from './config/schema'
import { openDb, type Db } from './db'
import { LlmGateway } from './llm/gateway'
import { OfflineProvider } from './llm/offline'
import { OpenRouterProvider } from './llm/openrouter'
import type { LlmProvider } from './llm/types'
import { loadProfile, type Profile } from './profile'
import { JobRepo } from './queue/repo'
import { Orchestrator } from './queue/orchestrator'
import { ResumeRenderer } from './tailor'

export interface App {
  config: AppConfig
  db: Db
  repo: JobRepo
  profile: Profile
  gateway: LlmGateway
  registry: BackendRegistry
  renderer: ResumeRenderer
  board: BoardLogger
  fallbackBoard?: FallbackBoardLogger
  orchestrator: Orchestrator
  close(): Promise<void>
}

export interface AppOptions {
  env?: Record<string, string | undefined>
  log?: (line: string) => void
  /** Use this board logger instead of building one from the environment. */
  board?: BoardLogger
  /** Build the board logger once the repo exists (needed by the MCP logger). */
  boardFactory?: (repo: JobRepo, file: BoardLogger) => BoardLogger
  provider?: LlmProvider
  rephrase?: boolean
  sleep?: (ms: number) => Promise<void>
}

/** Registry with the real backend, a lean variant, and a placeholder for the future agent browser. */
export function createRegistry(config: AppConfig): BackendRegistry {
  const exec = config.browser.executablePath
  return new BackendRegistry()
    .register(
      'playwright-chromium',
      () => new PlaywrightBackend('playwright-chromium', { executablePath: exec }),
    )
    .register(
      'playwright-lean',
      () => new PlaywrightBackend('playwright-lean', { lean: true, executablePath: exec }),
    )
    .register('ai-browser', () => new NotImplementedBackend('ai-browser'))
}

/** Wire everything together from config and environment. */
export async function createApp(config: AppConfig, options: AppOptions = {}): Promise<App> {
  const env = options.env ?? process.env
  const db = openDb(join(config.dataDir, 'apply.db'))
  const repo = new JobRepo(db)
  const profile = loadProfile(config.profileDir)

  const provider: LlmProvider =
    options.provider ??
    (env.OPENROUTER_API_KEY
      ? new OpenRouterProvider({ apiKey: env.OPENROUTER_API_KEY })
      : new OfflineProvider())
  const gateway = new LlmGateway({
    provider,
    models: config.llm.models,
    db,
    dailyBudgetUsd: config.llm.dailyBudgetUsd,
  })

  let board: BoardLogger
  let fallbackBoard: FallbackBoardLogger | undefined
  const file = new FileBoardLogger(join(config.dataDir, 'board-log.jsonl'))
  if (options.board) {
    board = options.board
  } else if (options.boardFactory) {
    board = options.boardFactory(repo, file)
  } else if (config.board.url) {
    try {
      const client = await connectBoard(config.board.url, env[config.board.tokenEnv])
      fallbackBoard = new FallbackBoardLogger(new McpBoardLogger(client, repo), file, repo)
      board = fallbackBoard
    } catch (err) {
      options.log?.(
        `board unreachable (${(err as Error).message.slice(0, 80)}), logging to a local file`,
      )
      board = file
    }
  } else {
    board = file
  }

  const registry = createRegistry(config)
  const renderer = new ResumeRenderer(config.browser.executablePath)
  const orchestrator = new Orchestrator({
    config,
    db,
    repo,
    profile,
    gateway,
    registry,
    renderer,
    board,
    log: options.log,
    rephrase: options.rephrase,
    sleep: options.sleep,
  })

  return {
    config,
    db,
    repo,
    profile,
    gateway,
    registry,
    renderer,
    board,
    fallbackBoard,
    orchestrator,
    async close() {
      await registry.disposeAll()
      await renderer.close()
      db.close()
    },
  }
}
