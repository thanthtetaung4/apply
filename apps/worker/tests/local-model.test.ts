import { describe, expect, it, vi } from 'vitest'
import { loadEnv } from '../src/env'
import { generateSealKeyPair } from '@apply/db'
import { localModel } from '../src/user-engine'

const base = {
  DATABASE_URL: 'postgres://x',
  APP_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
  WORKER_SESSION_PRIVATE_KEY: generateSealKeyPair().privateKey,
}

/** Send one request per task through the local provider and return each request body. */
async function bodies(extra: Record<string, string>) {
  const env = loadEnv({ ...base, LLM_BASE_URL: 'http://localhost:11434/v1/', ...extra })
  const f = vi.fn(
    async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] })),
  )
  vi.stubGlobal('fetch', f)
  // The provider keeps the fetch it sees when created, so create it after the stub.
  const local = localModel(env)!
  const out: Record<string, Record<string, unknown>> = {}
  try {
    for (const task of ['extract_requirements', 'answer_field', 'rephrase_bullet'] as const) {
      await local.provider.complete({ task, model: 'qwen3:4b', system: '', prompt: '{}' })
      const [url, init] = f.mock.calls.at(-1)!
      expect(url).toBe('http://localhost:11434/v1/chat/completions')
      out[task] = JSON.parse(init.body as string)
    }
  } finally {
    vi.unstubAllGlobals()
  }
  return out
}

describe('local model server (LLM_BASE_URL)', () => {
  it('is off unless LLM_BASE_URL is set', () => {
    expect(localModel(loadEnv(base))).toBeUndefined()
  })

  it('uses one model for every tier and a long timeout', () => {
    const env = loadEnv({
      ...base,
      LLM_BASE_URL: 'http://localhost:11434/v1',
      LLM_MODEL: 'qwen3:4b',
    })
    expect(env.LLM_TIMEOUT_MS).toBe(180_000)
    const local = localModel(env)!
    expect(local.provider.name).toBe('local')
    expect(local.models).toEqual({ cheap: 'qwen3:4b', mid: 'qwen3:4b', strong: 'qwen3:4b' })
    expect(
      localModel(loadEnv({ ...base, LLM_BASE_URL: 'http://localhost:11434/v1' }))!.models,
    ).toBeUndefined()
  })

  it('lets only answer_field think by default, without JSON mode', async () => {
    const b = await bodies({})
    expect(b.answer_field!.response_format).toBeUndefined()
    expect(b.answer_field!.reasoning_effort).toBeUndefined()
    expect(b.answer_field!.max_tokens).toBe(1200)
    for (const t of ['extract_requirements', 'rephrase_bullet']) {
      expect(b[t]!.response_format).toEqual({ type: 'json_object' })
      expect(b[t]!.reasoning_effort).toBe('none')
    }
  })

  it('sends no reasoning field at all for a model without thinking', async () => {
    const b = await bodies({ LLM_THINK_TASKS: 'none' })
    for (const t of Object.values(b)) {
      expect(t.response_format).toEqual({ type: 'json_object' })
      expect(t.reasoning_effort).toBeUndefined()
    }
  })

  it('rejects bad settings', () => {
    expect(() => loadEnv({ ...base, LLM_BASE_URL: 'localhost:11434' })).toThrow(/LLM_BASE_URL/)
    expect(() => loadEnv({ ...base, LLM_THINK_TASKS: 'answer_field,typo' })).toThrow(
      /LLM_THINK_TASKS/,
    )
  })
})
