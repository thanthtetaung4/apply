import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { MemoryLlmStore } from './helpers/memory-llm-store'
import { LlmGateway } from '../src/llm/gateway'
import { OfflineProvider } from '../src/llm/offline'
import { OpenRouterProvider } from '../src/llm/openrouter'
import { answerField } from '../src/llm/tasks'
import { LlmError, type LlmProvider } from '../src/llm/types'

const models = { cheap: 'c', mid: 'm', strong: 's' }
const reply = (text: string, extra = {}) => ({
  text,
  tokensIn: 10,
  tokensOut: 5,
  costUsd: 0.01,
  model: 'x',
  ...extra,
})

describe('LlmGateway', () => {
  it('validates structured output, caches it and records usage', async () => {
    const store = new MemoryLlmStore()
    const complete = vi.fn(async () => reply('{"answer":"Yes"}'))
    const gw = new LlmGateway({ provider: { name: 't', complete }, models, store })
    const schema = z.object({ answer: z.string() })
    const a = await gw.run('answer_field', { q: 1 }, schema, { jobId: 'j' })
    const b = await gw.run('answer_field', { q: 1 }, schema, { jobId: 'j' })
    expect(a.cached).toBe(false)
    expect(b.cached).toBe(true)
    expect(complete).toHaveBeenCalledTimes(1)
    expect(store.usage.map((u) => [u.cached, u.costUsd])).toEqual([
      [false, 0.01],
      [true, 0],
    ])
  })

  it('retries once on invalid output and then fails closed', async () => {
    const replies = ['not json', '```json\n{"answer":"ok"}\n```']
    const gw = new LlmGateway({
      provider: { name: 't', complete: async () => reply(replies.shift()!) },
      models,
    })
    const ok = await gw.run('answer_field', {}, z.object({ answer: z.string() }))
    expect(ok.data.answer).toBe('ok')
    expect(ok.tokensIn).toBe(20)

    const bad = new LlmGateway({
      provider: { name: 't', complete: async () => reply('{"nope":1}') },
      models,
    })
    await expect(
      bad.run('answer_field', {}, z.object({ answer: z.string() })),
    ).rejects.toMatchObject({ kind: 'output' })
  })

  it('stops at the daily budget', async () => {
    const store = new MemoryLlmStore()
    const gw = new LlmGateway({
      provider: { name: 't', complete: async () => reply('{"answer":"a"}', { costUsd: 0.6 }) },
      models,
      store,
      dailyBudgetUsd: 1,
    })
    const schema = z.object({ answer: z.string() })
    await gw.run('answer_field', { n: 1 }, schema)
    await gw.run('answer_field', { n: 2 }, schema)
    await expect(gw.run('answer_field', { n: 3 }, schema)).rejects.toMatchObject({ kind: 'budget' })
  })

  it('treats UNKNOWN and answers outside the options as no answer', async () => {
    const mk = (answer: string): LlmProvider => ({
      name: 't',
      complete: async () => reply(JSON.stringify({ answer })),
    })
    const input = {
      question: 'q',
      type: 'select',
      options: ['Yes', 'No'],
      required: true,
      job: { title: 't', company: 'c' },
      facts: {},
    }
    expect(
      (await answerField(new LlmGateway({ provider: mk('UNKNOWN'), models }), input)).answer,
    ).toBeNull()
    expect(
      (await answerField(new LlmGateway({ provider: mk('Maybe'), models }), input)).answer,
    ).toBeNull()
    expect((await answerField(new LlmGateway({ provider: mk('yes'), models }), input)).answer).toBe(
      'yes',
    )
  })
})

describe('OfflineProvider', () => {
  it('extracts known terms and never answers questions', async () => {
    const p = new OfflineProvider()
    const r = await p.complete({
      task: 'extract_requirements',
      model: 'o',
      system: '',
      prompt: JSON.stringify({
        description: 'We use Node.js, C++ and CI/CD with Python.',
        knownTerms: ['Node.js', 'C++', 'CI/CD', 'Python', 'Go', 'Rust'],
      }),
    })
    expect(JSON.parse(r.text).skills).toEqual(['Node.js', 'C++', 'CI/CD', 'Python'])
    const a = await p.complete({ task: 'answer_field', model: 'o', system: '', prompt: '{}' })
    expect(JSON.parse(a.text).answer).toBe('UNKNOWN')
  })
})

describe('OpenRouterProvider', () => {
  const ok = () =>
    new Response(
      JSON.stringify({
        model: 'm1',
        choices: [{ message: { content: '{"a":1}' } }],
        usage: { prompt_tokens: 12, completion_tokens: 3, cost: 0.002 },
      }),
      { status: 200 },
    )

  it('sends the request and reads usage and cost', async () => {
    const f = vi.fn(async (_url: unknown, _init: unknown) => ok())
    const p = new OpenRouterProvider({ apiKey: 'sk-test', fetch: f as unknown as typeof fetch })
    const r = await p.complete({
      task: 'answer_field',
      model: 'vendor/model',
      system: 'sys',
      prompt: '{}',
    })
    expect(r).toMatchObject({
      text: '{"a":1}',
      tokensIn: 12,
      tokensOut: 3,
      costUsd: 0.002,
      model: 'm1',
    })
    const [url, init] = f.mock.calls[0]! as [string, RequestInit]
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-test')
    expect(JSON.parse(init.body as string)).toMatchObject({
      model: 'vendor/model',
      response_format: { type: 'json_object' },
    })
  })

  it('retries rate limits and server errors with backoff', async () => {
    const sleeps: number[] = []
    const f = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(ok())
    const p = new OpenRouterProvider({
      apiKey: 'k',
      fetch: f as unknown as typeof fetch,
      sleep: async (ms) => void sleeps.push(ms),
    })
    await p.complete({ task: 'answer_field', model: 'm', system: '', prompt: '{}' })
    expect(f).toHaveBeenCalledTimes(3)
    expect(sleeps).toEqual([500, 1000])
  })

  it('does not retry client errors and does not leak the response body', async () => {
    const f = vi.fn(async () => new Response('secret details sk-test', { status: 401 }))
    const p = new OpenRouterProvider({ apiKey: 'sk-test', fetch: f as unknown as typeof fetch })
    const err = await p
      .complete({ task: 'answer_field', model: 'm', system: '', prompt: '{}' })
      .catch((e) => e)
    expect(err).toBeInstanceOf(LlmError)
    expect(err.message).toBe('OpenRouter returned 401')
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('requires an API key', () => {
    expect(() => new OpenRouterProvider({ apiKey: '' })).toThrow(/OPENROUTER_API_KEY/)
  })
})
