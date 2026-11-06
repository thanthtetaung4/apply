import { describe, expect, it, vi } from 'vitest'
import { LlmGateway } from '../src/llm/gateway'
import { isOllamaServer, OllamaProvider, ollamaRoot } from '../src/llm/ollama'
import { answerField, extractRequirements } from '../src/llm/tasks'

type Call = { url: string; body: Record<string, unknown> }

/** A fake Ollama: /api/show reports the given capabilities, /api/chat returns `reply`. */
function fakeOllama(o: { capabilities: string[]; contextLength?: number; reply: string }) {
  const calls: Call[] = []
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : {}
    calls.push({ url, body })
    if (url.endsWith('/api/version')) return Response.json({ version: '0.32.1' })
    if (url.endsWith('/api/show'))
      return Response.json({
        capabilities: o.capabilities,
        model_info: o.contextLength ? { 'qwen3.context_length': o.contextLength } : {},
      })
    if (url.endsWith('/api/chat'))
      return Response.json({
        message: { content: o.reply, thinking: 'some reasoning' },
        prompt_eval_count: 100,
        eval_count: 5,
      })
    return new Response('not found', { status: 404 })
  })
  return {
    f: f as unknown as typeof fetch,
    calls,
    chats: () => calls.filter((c) => c.url.endsWith('/api/chat')),
  }
}

const models = { cheap: 'qwen3:4b', mid: 'qwen3:4b', strong: 'qwen3:4b' }
const selectQuestion = {
  question: 'Which programming language do you know best?',
  type: 'select',
  options: ['Python', 'TypeScript', 'Go'],
  required: true,
  job: { title: 'Backend Engineer', company: 'Acme' },
  facts: { skills: [{ category: 'Languages', skills: ['TypeScript', 'SQL'] }] },
}

describe('OllamaProvider', () => {
  it('accepts the address with or without /v1', () => {
    expect(ollamaRoot('https://o.example.com/v1/')).toBe('https://o.example.com')
    expect(ollamaRoot('https://o.example.com')).toBe('https://o.example.com')
  })

  it('detects an Ollama server and nothing else', async () => {
    const { f } = fakeOllama({ capabilities: [], reply: '' })
    expect(await isOllamaServer('https://o.example.com/v1', { fetch: f })).toBe(true)
    const other = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch
    expect(await isOllamaServer('https://lmstudio.example.com/v1', { fetch: other })).toBe(false)
    const down = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    expect(await isOllamaServer('https://o.example.com', { fetch: down })).toBe(false)
  })

  it('sets the context size, sends the task schema and thinks only on questions', async () => {
    const fake = fakeOllama({
      capabilities: ['completion', 'thinking'],
      contextLength: 262_144,
      reply: '{"skills":["TypeScript"],"keywords":[]}',
    })
    const gw = new LlmGateway({
      provider: new OllamaProvider({
        baseUrl: 'https://o.example.com/v1',
        fetch: fake.f,
        numCtx: 8192,
      }),
      models,
    })
    const r = await extractRequirements(gw, {
      jobTitle: 'Engineer',
      description: 'TypeScript',
      knownTerms: ['TypeScript'],
    })
    expect(r.data.skills).toEqual(['TypeScript'])
    const [chat] = fake.chats()
    expect(chat!.url).toBe('https://o.example.com/api/chat')
    expect(chat!.body).toMatchObject({
      model: 'qwen3:4b',
      stream: false,
      think: false,
      options: { temperature: 0, num_ctx: 8192 },
      format: { type: 'object', required: ['skills', 'keywords'] },
    })

    await answerField(gw, selectQuestion).catch(() => undefined)
    const q = fake.chats().at(-1)!.body
    expect(q.think).toBe(true)
    // A select question can only be answered with one of its options or UNKNOWN.
    expect(q.format).toMatchObject({
      properties: { answer: { enum: ['Python', 'TypeScript', 'Go', 'UNKNOWN'] } },
    })
  })

  it('never sends think to a model that cannot think, and caps num_ctx at its maximum', async () => {
    const fake = fakeOllama({
      capabilities: ['completion'],
      contextLength: 4096,
      reply: '{"answer":"UNKNOWN"}',
    })
    const p = new OllamaProvider({
      baseUrl: 'https://o.example.com',
      fetch: fake.f,
      numCtx: 16_384,
    })
    await p.complete({ task: 'answer_field', model: 'llama3.1:8b', system: 's', prompt: '{}' })
    await p.complete({ task: 'answer_field', model: 'llama3.1:8b', system: 's', prompt: '{}' })
    const chat = fake.chats()[0]!.body
    expect('think' in chat).toBe(false)
    expect(chat.options).toMatchObject({ num_ctx: 4096 })
    // The model is looked up once.
    expect(fake.calls.filter((c) => c.url.endsWith('/api/show'))).toHaveLength(1)
  })

  it('says how to fix a model that is not pulled', async () => {
    const f = (async (url: string) =>
      url.endsWith('/api/show')
        ? new Response('{}', { status: 404 })
        : Response.json({ error: 'model not found' }, { status: 404 })) as unknown as typeof fetch
    const p = new OllamaProvider({ baseUrl: 'https://o.example.com', fetch: f })
    await expect(
      p.complete({ task: 'answer_field', model: 'qwen3:8b', system: 's', prompt: '{}' }),
    ).rejects.toThrow('ollama pull qwen3:8b')
  })
})

// Runs only when an Ollama server with qwen3:4b is reachable (OLLAMA_TEST_URL overrides).
const LIVE_URL = process.env.OLLAMA_TEST_URL ?? 'http://localhost:11434'
const live = await isOllamaServer(LIVE_URL, { timeoutMs: 1000 })

describe.skipIf(!live)('OllamaProvider against a real Ollama (qwen3:4b)', () => {
  const gw = () =>
    new LlmGateway({ provider: new OllamaProvider({ baseUrl: LIVE_URL, numCtx: 8192 }), models })

  it('answers a select question from the facts, thinking first', async () => {
    const r = await answerField(gw(), selectQuestion)
    expect(r.answer).toBe('TypeScript')
  }, 300_000)

  it('reads a long job posting completely', async () => {
    const filler = 'We are a fast growing company with great benefits and a friendly team. '.repeat(
      250,
    )
    const r = await extractRequirements(gw(), {
      jobTitle: 'Backend Engineer',
      // The requirement sits after about 4,000 tokens: lost with Ollama's default context.
      description: `${filler}\nRequirements: strong experience with Kubernetes.`,
      knownTerms: ['Kubernetes', 'TypeScript', 'React'],
    })
    expect(r.data.skills).toContain('Kubernetes')
  }, 300_000)
})
