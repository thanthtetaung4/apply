import {
  LlmError,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
  type LlmTask,
} from './types'

export interface OpenRouterOptions {
  apiKey: string
  baseUrl?: string
  fetch?: typeof fetch
  timeoutMs?: number
  maxRetries?: number
  sleep?: (ms: number) => Promise<void>
  /** Name shown in errors and model usage. Default "openrouter". */
  name?: string
  /**
   * Extra fields merged into every request body, for OpenAI-compatible servers other than
   * OpenRouter, for example { reasoning_effort: 'low' }.
   */
  extraBody?: Record<string, unknown>
  /**
   * Ask the server to force JSON output (response_format json_object). Default true. Turn it off for
   * small local thinking models: forcing JSON stops them reasoning first, and they echo the input
   * back instead of answering. The gateway still validates every reply against the task schema.
   */
  jsonMode?: boolean
  /** Per task overrides of `jsonMode` and `extraBody` (merged over the defaults above). */
  perTask?: Partial<Record<LlmTask, { jsonMode?: boolean; extraBody?: Record<string, unknown> }>>
}

interface ChatCompletion {
  choices?: { message?: { content?: string } }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number }
  model?: string
}

/**
 * OpenRouter chat completions. Retries rate limits and server errors with backoff. Also works with
 * any OpenAI-compatible server (for example Ollama at http://localhost:11434/v1) through `baseUrl`.
 */
export class OpenRouterProvider implements LlmProvider {
  readonly name: string
  private readonly label: string
  private readonly f: typeof fetch
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly options: OpenRouterOptions) {
    if (!options.apiKey) throw new LlmError('OPENROUTER_API_KEY is empty', 'http')
    this.name = options.name ?? 'openrouter'
    this.label = this.name === 'openrouter' ? 'OpenRouter' : `Model server (${this.name})`
    this.f = options.fetch ?? fetch
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const url = `${this.options.baseUrl ?? 'https://openrouter.ai/api/v1'}/chat/completions`
    const task = this.options.perTask?.[req.task]
    const jsonMode = task?.jsonMode ?? this.options.jsonMode ?? true
    const body = JSON.stringify({
      model: req.model,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.prompt },
      ],
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
      temperature: 0,
      usage: { include: true },
      ...this.options.extraBody,
      ...task?.extraBody,
    })
    const maxRetries = this.options.maxRetries ?? 3
    let lastError: LlmError | undefined

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) await this.sleep(500 * 2 ** (attempt - 1))
      let res: Response
      try {
        res = await this.f(url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.options.apiKey}`,
            'content-type': 'application/json',
          },
          body,
          // A user's own server could redirect to an internal address; never follow it.
          redirect: 'manual',
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 60_000),
        })
      } catch (err) {
        lastError = new LlmError(
          `${this.label} request failed: ${(err as Error).message}`,
          'network',
        )
        continue
      }
      if (res.status === 429 || res.status >= 500) {
        lastError = new LlmError(`${this.label} returned ${res.status}`, 'http', res.status)
        continue
      }
      if (!res.ok) {
        // Never echo the response body: it can contain request details.
        throw new LlmError(`${this.label} returned ${res.status}`, 'http', res.status)
      }
      const data = (await res.json()) as ChatCompletion
      const text = data.choices?.[0]?.message?.content
      if (typeof text !== 'string')
        throw new LlmError(`${this.label} response had no message content`, 'output')
      return {
        text,
        tokensIn: data.usage?.prompt_tokens ?? 0,
        tokensOut: data.usage?.completion_tokens ?? 0,
        costUsd: data.usage?.cost ?? 0,
        model: data.model ?? req.model,
      }
    }
    throw lastError ?? new LlmError(`${this.label} request failed`, 'network')
  }
}
