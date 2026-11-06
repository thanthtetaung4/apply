import {
  LlmError,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
  type LlmTask,
} from './types'

/**
 * Ollama through its native API (/api/chat) rather than the OpenAI-compatible /v1 endpoint, because
 * only the native API can:
 * - set the context window per request (options.num_ctx). Without it Ollama keeps about 2048
 *   tokens and silently drops the start of longer prompts, system prompt included: measured on
 *   Ollama 0.32 with a 5.6k token prompt, only 2050 tokens were read.
 * - constrain the reply to the task's JSON Schema (format), not just "some JSON".
 * - turn thinking on or off per request (think), returning the reasoning in a separate field.
 */
export interface OllamaOptions {
  /** Server root, e.g. https://ollama.example.com. A trailing /v1 is removed. */
  baseUrl: string
  /** Sent as a Bearer token, for a tunnel or proxy that checks it. Ollama itself ignores it. */
  apiKey?: string
  fetch?: typeof fetch
  timeoutMs?: number
  maxRetries?: number
  sleep?: (ms: number) => Promise<void>
  /** Name shown in errors and usage. Default "ollama". */
  name?: string
  /** Context window per request, capped at the model's own maximum. Default 8192. */
  numCtx?: number
  /** Most tokens per reply, thinking included (num_predict). */
  maxTokens?: number
  /** Tasks that think when the model can. Others are sent think: false. */
  thinkTasks?: readonly LlmTask[]
}

interface ModelInfo {
  thinking: boolean
  contextLength?: number
}

interface ChatReply {
  message?: { content?: string; thinking?: string }
  prompt_eval_count?: number
  eval_count?: number
  model?: string
}

/** Remove a trailing /v1 (and slash): users often paste the OpenAI-compatible address. */
export function ollamaRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')
}

function headers(apiKey?: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
  }
}

/** True when the server answers like Ollama (GET /api/version). Never throws. */
export async function isOllamaServer(
  baseUrl: string,
  o: { apiKey?: string; fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<boolean> {
  try {
    const res = await (o.fetch ?? fetch)(`${ollamaRoot(baseUrl)}/api/version`, {
      headers: headers(o.apiKey),
      redirect: 'manual',
      signal: AbortSignal.timeout(o.timeoutMs ?? 5000),
    })
    if (!res.ok) return false
    const body = (await res.json()) as { version?: unknown }
    return typeof body.version === 'string'
  } catch {
    return false
  }
}

export class OllamaProvider implements LlmProvider {
  readonly name: string
  private readonly root: string
  private readonly f: typeof fetch
  private readonly sleep: (ms: number) => Promise<void>
  private readonly think: Set<LlmTask>
  private readonly models = new Map<string, Promise<ModelInfo>>()

  constructor(private readonly o: OllamaOptions) {
    this.name = o.name ?? 'ollama'
    this.root = ollamaRoot(o.baseUrl)
    this.f = o.fetch ?? fetch
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.think = new Set(o.thinkTasks ?? ['answer_field'])
  }

  /**
   * What the model can do, from /api/show, asked once per model. Sending `think` to a model that
   * cannot think is an error in Ollama, so an unknown model is treated as not thinking.
   */
  private modelInfo(model: string): Promise<ModelInfo> {
    let info = this.models.get(model)
    if (!info) {
      info = (async (): Promise<ModelInfo> => {
        try {
          const res = await this.f(`${this.root}/api/show`, {
            method: 'POST',
            headers: headers(this.o.apiKey),
            body: JSON.stringify({ model }),
            redirect: 'manual',
            signal: AbortSignal.timeout(15_000),
          })
          if (!res.ok) return { thinking: false }
          const body = (await res.json()) as {
            capabilities?: string[]
            model_info?: Record<string, unknown>
          }
          const ctx = Object.entries(body.model_info ?? {}).find(([k]) =>
            k.endsWith('.context_length'),
          )?.[1]
          return {
            thinking: body.capabilities?.includes('thinking') ?? false,
            contextLength: typeof ctx === 'number' ? ctx : undefined,
          }
        } catch {
          return { thinking: false }
        }
      })()
      this.models.set(model, info)
    }
    return info
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const info = await this.modelInfo(req.model)
    const wanted = this.o.numCtx ?? 8192
    const numCtx = info.contextLength ? Math.min(wanted, info.contextLength) : wanted
    const body = JSON.stringify({
      model: req.model,
      stream: false,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.prompt },
      ],
      // The reply is constrained to the schema; reasoning, if any, goes to message.thinking.
      format: req.schema ?? 'json',
      ...(info.thinking ? { think: this.think.has(req.task) } : {}),
      options: {
        temperature: 0,
        num_ctx: numCtx,
        ...(this.o.maxTokens ? { num_predict: this.o.maxTokens } : {}),
      },
    })

    const maxRetries = this.o.maxRetries ?? 1
    let lastError: LlmError | undefined
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) await this.sleep(1000 * 2 ** (attempt - 1))
      let res: Response
      try {
        res = await this.f(`${this.root}/api/chat`, {
          method: 'POST',
          headers: headers(this.o.apiKey),
          body,
          // A user's server could redirect to an internal address; never follow it.
          redirect: 'manual',
          signal: AbortSignal.timeout(this.o.timeoutMs ?? 180_000),
        })
      } catch (err) {
        lastError = new LlmError(`Ollama request failed: ${(err as Error).message}`, 'network')
        continue
      }
      if (res.status === 404)
        throw new LlmError(
          `Model "${req.model}" is not on your Ollama server. Run: ollama pull ${req.model}`,
          'http',
          404,
        )
      if (res.status === 429 || res.status >= 500) {
        lastError = new LlmError(`Ollama returned ${res.status}`, 'http', res.status)
        continue
      }
      // Never echo the response body: it can contain request details.
      if (!res.ok) throw new LlmError(`Ollama returned ${res.status}`, 'http', res.status)
      const data = (await res.json()) as ChatReply
      const text = data.message?.content
      if (typeof text !== 'string')
        throw new LlmError('Ollama response had no message content', 'output')
      return {
        text,
        tokensIn: data.prompt_eval_count ?? 0,
        tokensOut: data.eval_count ?? 0,
        costUsd: 0,
        model: data.model ?? req.model,
      }
    }
    throw lastError ?? new LlmError('Ollama request failed', 'network')
  }
}
