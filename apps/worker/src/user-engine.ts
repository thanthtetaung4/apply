import { join } from 'node:path'
import { FallbackBoardLogger, McpBoardLogger, connectBoard } from '@apply/core/board'
import type { BoardLogger } from '@apply/core/board'
import { createEngine, type Engine } from '@apply/core/engine'
import type { TargetRule } from '@apply/core/intake'
import {
  endpointProblem,
  isOllamaServer,
  OfflineProvider,
  OllamaProvider,
  OpenRouterProvider,
  type LlmProvider,
} from '@apply/core/llm'
import { effectiveAiMode, type UserSettings } from '@apply/core/settings'
import {
  admitPlatformAiJob,
  getAiQuota,
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

  const stores = userStores(db, userId, env.encryptionKey, env.sessionKeys)

  const ai = await resolveAi(db, env, userId, settings, hooks)
  if (ai.models) settings.llm.models = ai.models
  if (ai.note) await addTaskLog(db, taskId, ai.note)

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
    provider: ai.provider,
    admitModelCall: ai.admit,
    dailyBudgetUsd: ai.dailyBudgetUsd,
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

/**
 * The local model server from LLM_BASE_URL (Ollama, LM Studio, llama.cpp), or undefined.
 * For testing on one machine: it applies to every user and replaces their saved OpenRouter key.
 */
export function localModel(
  env: Pick<
    WorkerEnv,
    | 'LLM_BASE_URL'
    | 'LLM_API_KEY'
    | 'LLM_MODEL'
    | 'LLM_THINK_TASKS'
    | 'LLM_TIMEOUT_MS'
    | 'LLM_MAX_TOKENS'
  >,
): { provider: LlmProvider; models?: { cheap: string; mid: string; strong: string } } | undefined {
  if (!env.LLM_BASE_URL) return undefined
  const provider = compatServer({
    name: 'local',
    baseUrl: env.LLM_BASE_URL,
    apiKey: env.LLM_API_KEY,
    thinkTasks: env.LLM_THINK_TASKS,
    timeoutMs: env.LLM_TIMEOUT_MS,
    maxTokens: env.LLM_MAX_TOKENS,
  })
  const m = env.LLM_MODEL
  return { provider, models: m ? { cheap: m, mid: m, strong: m } : undefined }
}

type Task = 'extract_requirements' | 'answer_field' | 'rephrase_bullet'
type Models = { cheap: string; mid: string; strong: string }
const allTiers = (m: string): Models => ({ cheap: m, mid: m, strong: m })

/** An OpenAI-compatible server run by the user or the operator (Ollama, LM Studio, llama.cpp). */
function compatServer(o: {
  name: string
  baseUrl: string
  apiKey?: string
  thinkTasks: readonly Task[]
  timeoutMs: number
  maxTokens: number
}): LlmProvider {
  const think = new Set(o.thinkTasks)
  // With an empty list the model is treated as one without thinking: no reasoning field is sent,
  // because Ollama refuses it for models that cannot think.
  const thinkingModel = think.size > 0
  const tasks = ['extract_requirements', 'answer_field', 'rephrase_bullet'] as const
  return new OpenRouterProvider({
    apiKey: o.apiKey || 'local',
    baseUrl: o.baseUrl.replace(/\/$/, ''),
    name: o.name,
    timeoutMs: o.timeoutMs,
    // A timed out local call is retried once, not three times: each try can take minutes.
    maxRetries: 1,
    extraBody: { max_tokens: o.maxTokens },
    perTask: Object.fromEntries(
      tasks.map((t) => [
        t,
        think.has(t)
          ? { jsonMode: false }
          : {
              jsonMode: true,
              extraBody: thinkingModel ? { reasoning_effort: 'none' } : undefined,
            },
      ]),
    ),
  })
}

interface ServerOptions {
  name: string
  baseUrl: string
  apiKey?: string
  thinkTasks: readonly Task[]
  timeoutMs: number
  maxTokens: number
  contextTokens: number
}

/**
 * A model server run by the user or the operator. Ollama gets its native API (context size,
 * schema-constrained replies, thinking per task, all checked against what the model can do);
 * any other OpenAI-compatible server (LM Studio, llama.cpp) gets /v1/chat/completions.
 */
export async function modelServer(o: ServerOptions): Promise<LlmProvider> {
  if (await isOllamaServer(o.baseUrl, { apiKey: o.apiKey })) {
    return new OllamaProvider({
      name: o.name,
      baseUrl: o.baseUrl,
      apiKey: o.apiKey,
      timeoutMs: o.timeoutMs,
      maxTokens: o.maxTokens,
      numCtx: o.contextTokens,
      thinkTasks: o.thinkTasks,
    })
  }
  return compatServer(o)
}

export interface ResolvedAi {
  provider: LlmProvider
  /** Replaces settings.llm.models when the mode fixes the model. */
  models?: Models
  admit?: (jobId: string | undefined) => Promise<boolean>
  dailyBudgetUsd?: number
  /** One line for the task log about how AI runs this time. */
  note?: string
}

/**
 * Choose the model provider for one user's task. Every mode can end in "no AI": the app still
 * fills forms from the profile and saved answers and brings other questions to the user.
 */
export async function resolveAi(
  db: Db,
  env: WorkerEnv,
  userId: string,
  settings: UserSettings,
  hooks: Pick<WorkerHooks, 'provider'> = {},
): Promise<ResolvedAi> {
  if (hooks.provider) return { provider: hooks.provider }
  // Operator override for a self-hosted install or local testing.
  if (env.LLM_BASE_URL) {
    const m = env.LLM_MODEL
    return {
      provider: await modelServer({
        name: 'local',
        baseUrl: env.LLM_BASE_URL,
        apiKey: env.LLM_API_KEY,
        thinkTasks: env.LLM_THINK_TASKS,
        timeoutMs: env.LLM_TIMEOUT_MS,
        maxTokens: env.LLM_MAX_TOKENS,
        contextTokens: env.LLM_NUM_CTX,
      }),
      models: m ? allTiers(m) : undefined,
    }
  }

  const secret = (name: (typeof SECRET_NAMES)[keyof typeof SECRET_NAMES]) =>
    getSecret(db, env.encryptionKey, userId, name)
  const openrouterKey = await secret(SECRET_NAMES.openrouterKey)
  const mode = effectiveAiMode(settings, Boolean(openrouterKey))
  const offline = (note?: string): ResolvedAi => ({ provider: new OfflineProvider(), note })

  switch (mode) {
    case 'none':
      return offline()

    case 'openrouter': {
      if (!openrouterKey)
        throw new PreflightError(
          'AI is set to use your OpenRouter key, but none is saved. Add it on the Connections page or choose another AI option in Settings.',
        )
      // The default model names are placeholders. OpenRouter rejects them on every call.
      const placeholders = Object.entries(settings.llm.models).filter(([, m]) => /^TBD-/i.test(m))
      if (placeholders.length > 0)
        throw new PreflightError(
          `Choose your OpenRouter models on the Settings page first (${placeholders.map(([t]) => t).join(', ')} still ${placeholders.length === 1 ? 'is a placeholder' : 'are placeholders'}).`,
        )
      return { provider: new OpenRouterProvider({ apiKey: openrouterKey }) }
    }

    case 'custom': {
      const url = await secret(SECRET_NAMES.llmEndpointUrl)
      const model = settings.llm.custom.model.trim()
      if (!url || !model)
        throw new PreflightError(
          'AI is set to use your own server, but its address or model name is missing. Add them on the Connections and Settings pages.',
        )
      // Checked again on every run: the address could resolve somewhere else since it was saved.
      const problem = await endpointProblem(url, {
        allowPrivate: Boolean(env.ALLOW_PRIVATE_LLM_ENDPOINTS),
      })
      if (problem) throw new PreflightError(`Your model server address is not usable: ${problem}`)
      const c = settings.llm.custom
      return {
        provider: await modelServer({
          name: 'custom',
          baseUrl: url,
          apiKey: await secret(SECRET_NAMES.llmEndpointKey),
          thinkTasks: c.thinkTasks,
          timeoutMs: c.timeoutMs,
          maxTokens: c.maxTokens,
          contextTokens: c.contextTokens,
        }),
        models: allTiers(model),
      }
    }

    case 'hosted': {
      if (!env.PLATFORM_OPENROUTER_KEY) return offline()
      const free = env.FREE_AI_APPLICATIONS_PER_WEEK
      const quota = await getAiQuota(db, userId, free)
      const left = Math.max(0, quota.freeLimit - quota.freeUsed) + quota.credits
      return {
        provider: new OpenRouterProvider({ apiKey: env.PLATFORM_OPENROUTER_KEY, name: 'platform' }),
        models: allTiers(env.PLATFORM_MODEL),
        // Every call needs a job: a call that is not for a job cannot be counted, so it is refused.
        admit: async (jobId) =>
          jobId !== undefined && (await admitPlatformAiJob(db, userId, jobId, free)),
        dailyBudgetUsd: Math.min(settings.llm.dailyBudgetUsd, env.PLATFORM_DAILY_BUDGET_USD),
        note:
          left > 0
            ? `App AI: ${left} AI application${left === 1 ? '' : 's'} left (${Math.max(0, quota.freeLimit - quota.freeUsed)} free this week, ${quota.credits} purchased). Jobs after that run without AI.`
            : 'App AI: no AI applications left this week, so this run works without AI. Buy more on the Settings page or wait for Monday.',
      }
    }
  }
}
