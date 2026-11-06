import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { createPublicKey } from 'node:crypto'
import { parseKey, parsePrivateKeys, type SessionKeys } from '@apply/db'

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
  /**
   * Local testing only: send every user's model calls to this OpenAI-compatible server instead of
   * OpenRouter, e.g. http://localhost:11434/v1 for Ollama. Overrides keys saved on Connections.
   */
  LLM_BASE_URL: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.url({ protocol: /^https?$/ }).optional(),
  ),
  /** Bearer token for LLM_BASE_URL. Ollama ignores it. */
  LLM_API_KEY: z.string().optional(),
  /** Model name for every tier (cheap, mid, strong) when LLM_BASE_URL is set, e.g. qwen3:4b. */
  LLM_MODEL: z.string().min(1).optional(),
  /**
   * Comma separated tasks that may think on the local server: extract_requirements, answer_field,
   * rephrase_bullet. Measured with qwen3:4b on Ollama:
   * - Thinking tasks are sent without JSON mode. With JSON mode, or with thinking off, qwen3:4b
   *   echoes the input back instead of answering questions.
   * - Other tasks are sent with reasoning_effort "none" and JSON mode. Thinking about a whole job
   *   description ran past 3 minutes.
   * Use "none" for a model without thinking.
   */
  LLM_THINK_TASKS: z
    .string()
    .default('answer_field')
    .transform((s) =>
      s === 'none'
        ? []
        : s
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
    )
    .pipe(z.array(z.enum(['extract_requirements', 'answer_field', 'rephrase_bullet']))),
  /** Local models on small GPUs are slow, and thinking models write a few hundred tokens a call. */
  LLM_TIMEOUT_MS: z.coerce.number().int().min(1000).default(180_000),
  /**
   * Most tokens a local model may write per call, thinking included. A thinking model can reason
   * for minutes on a hard question (a real Stripe form timed out twice at 3 minutes); with a cap
   * it stops, the reply fails validation, and the question goes to the user instead.
   */
  LLM_MAX_TOKENS: z.coerce.number().int().min(100).max(32_000).default(1200),
  /**
   * Ollama only: context window per request (num_ctx), capped at the model's maximum. Ollama's
   * default (about 2048) silently drops the start of longer prompts, instructions included.
   */
  LLM_NUM_CTX: z.coerce.number().int().min(2048).max(131_072).default(8192),

  /**
   * The app's own model ("App AI" mode). Without a key that mode runs without AI. The app pays for
   * these calls, so they are limited: FREE_AI_APPLICATIONS_PER_WEEK jobs per user each week
   * (Monday 00:00 UTC), then purchased credits.
   */
  PLATFORM_OPENROUTER_KEY: z.string().optional(),
  /** OpenRouter model id for every tier in App AI mode. */
  PLATFORM_MODEL: z.string().min(1).default('openai/gpt-4o-mini'),
  FREE_AI_APPLICATIONS_PER_WEEK: z.coerce.number().int().min(0).max(1000).default(5),
  /** Per user daily spend cap on the app's key, whatever the user's own setting says. */
  PLATFORM_DAILY_BUDGET_USD: z.coerce.number().positive().max(100).default(0.5),
  /**
   * Self-hosted installs: let users point "Your own server" at private addresses such as
   * http://192.168.1.10:11434/v1 or localhost. Never set on a shared, hosted worker.
   */
  ALLOW_PRIVATE_LLM_ENDPOINTS: z.string().optional(),

  /**
   * Private key(s) that open sealed sign in sessions (pnpm keys:generate). Only the worker has
   * it. Comma separated during a key change: new key first, old key after.
   */
  WORKER_SESSION_PRIVATE_KEY: z.string().min(1, 'WORKER_SESSION_PRIVATE_KEY is required'),

  /** Port for the sign in window server (the browser the user signs in with, streamed). */
  LOGIN_PORT: z.coerce.number().int().min(0).max(65535).default(4100),
  /**
   * Web app origins allowed to open sign in windows, comma separated, e.g. https://app.example.com.
   * Default: http://localhost:3000. Tickets are checked too; this stops other sites using them.
   */
  LOGIN_ALLOWED_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform((s) =>
      s
        .split(',')
        .map((o) => o.trim().replace(/\/$/, ''))
        .filter(Boolean),
    ),
  /** Sign in windows open at once on this worker. Each is a real browser. */
  LOGIN_MAX_SESSIONS: z.coerce.number().int().min(1).max(20).default(3),
  /**
   * Extra hosts a sign in window may open, comma separated. Only for local test sites
   * (the demo sets 127.0.0.1). Real sites are fixed per job board.
   */
  LOGIN_EXTRA_HOSTS: z
    .string()
    .default('')
    .transform((s) =>
      s
        .split(',')
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean),
    ),
})

export type WorkerEnv = Omit<
  z.infer<typeof Schema>,
  'APP_ENCRYPTION_KEY' | 'WORKER_SESSION_PRIVATE_KEY'
> & {
  encryptionKey: Buffer
  workerId: string
  /** Seal with the public key, open with the private keys. */
  sessionKeys: SessionKeys
}

export function loadEnv(source: Record<string, string | undefined> = process.env): WorkerEnv {
  const r = Schema.safeParse(source)
  if (!r.success) {
    throw new Error(
      `Worker configuration problem:\n${r.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')}`,
    )
  }
  const { APP_ENCRYPTION_KEY, WORKER_SESSION_PRIVATE_KEY, ...rest } = r.data
  const open = parsePrivateKeys(WORKER_SESSION_PRIVATE_KEY)
  return {
    ...rest,
    encryptionKey: parseKey(APP_ENCRYPTION_KEY),
    workerId: rest.WORKER_ID ?? `worker-${process.pid}`,
    // The current (first) private key's public half seals new sessions.
    sessionKeys: { seal: createPublicKey(open[0]!), open },
  }
}
