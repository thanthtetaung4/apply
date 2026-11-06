import { mkdir } from 'node:fs/promises'
import type { BoardLogger } from './board/types'
import { NoopBoardLogger } from './board/types'
import { BackendRegistry, NotImplementedBackend } from './browser/registry'
import { PlaywrightBackend } from './browser/playwright-backend'
import { runIntake, type IntakeSummary } from './intake'
import type { TargetRule } from './intake/classify'
import { LlmGateway } from './llm/gateway'
import { OfflineProvider } from './llm/offline'
import type { LlmProvider } from './llm/types'
import { Orchestrator } from './orchestrator'
import type { Profile } from './profile'
import type { UserSettings } from './settings'
import type { IntakeSource } from './shared/status'
import type { FetchLike } from './intake/watchlist'
import type { Stores } from './store'
import { ResumeRenderer } from './tailor'

export { Orchestrator } from './orchestrator'
export type { RunSummary } from './orchestrator'
export { ResumeRenderer } from './tailor'
export { BackendRegistry } from './browser/registry'
export { LlmGateway } from './llm/gateway'

/** Registry with the real backend, a lean variant, and a placeholder for the future agent browser. */
export function createRegistry(chromiumPath?: string): BackendRegistry {
  return new BackendRegistry()
    .register(
      'playwright-chromium',
      () => new PlaywrightBackend('playwright-chromium', { executablePath: chromiumPath }),
    )
    .register(
      'playwright-lean',
      () => new PlaywrightBackend('playwright-lean', { lean: true, executablePath: chromiumPath }),
    )
    .register('ai-browser', () => new NotImplementedBackend('ai-browser'))
}

export interface EngineOptions {
  settings: UserSettings
  profile: Profile
  stores: Stores
  /** Model provider. Defaults to the offline stand-in that never answers questions. */
  provider?: LlmProvider
  board?: BoardLogger
  /** Scratch folder for files the browser must read from disk (the tailored resume). */
  workDir: string
  chromiumPath?: string
  maxWorkers?: number
  log?: (line: string) => void
  shouldStop?: () => boolean | Promise<boolean>
  sleep?: (ms: number) => Promise<void>
  random?: () => number
  rephrase?: boolean
  /** See GatewayOptions.admit: limits model calls on the app's own model. */
  admitModelCall?: (jobId: string | undefined) => Promise<boolean>
  /** Replaces settings.llm.dailyBudgetUsd, e.g. a lower cap when the app's own key pays. */
  dailyBudgetUsd?: number
  /** Extra URL rules for classifying apply targets (local test sites). */
  targetRules?: TargetRule[]
  /** For the company watchlist's job APIs. Default: the global fetch. */
  fetch?: FetchLike
}

export interface Engine {
  orchestrator: Orchestrator
  registry: BackendRegistry
  gateway: LlmGateway
  intake(options?: {
    sources?: IntakeSource[]
    urls?: string[]
    dryRun?: boolean
  }): Promise<IntakeSummary>
  close(): Promise<void>
}

/** Everything one user's run needs, wired together. Free it with close(). */
export async function createEngine(o: EngineOptions): Promise<Engine> {
  await mkdir(o.workDir, { recursive: true })
  const registry = createRegistry(o.chromiumPath)
  const renderer = new ResumeRenderer(o.chromiumPath)
  const gateway = new LlmGateway({
    provider: o.provider ?? new OfflineProvider(),
    models: o.settings.llm.models,
    store: o.stores.llm,
    dailyBudgetUsd: o.dailyBudgetUsd ?? o.settings.llm.dailyBudgetUsd,
    admit: o.admitModelCall,
  })
  const orchestrator = new Orchestrator({
    settings: o.settings,
    stores: o.stores,
    profile: o.profile,
    gateway,
    registry,
    renderer,
    board: o.board ?? new NoopBoardLogger(),
    workDir: o.workDir,
    log: o.log,
    shouldStop: o.shouldStop,
    maxWorkers: o.maxWorkers,
    sleep: o.sleep,
    random: o.random,
    rephrase: o.rephrase,
  })
  return {
    orchestrator,
    registry,
    gateway,
    intake: (options = {}) =>
      runIntake({
        settings: o.settings,
        registry,
        profile: o.profile,
        store: o.stores.jobs,
        sessions: o.stores.sessions,
        targetRules: o.targetRules,
        fetch: o.fetch,
        sources: options.sources,
        urls: options.urls,
        dryRun: options.dryRun,
        log: o.log,
      }),
    async close() {
      await registry.disposeAll()
      await renderer.close()
    },
  }
}
