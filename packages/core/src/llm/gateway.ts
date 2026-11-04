import { createHash } from 'node:crypto'
import type { z } from 'zod'
import type { LlmStore } from '../store'
import { PROMPT_VERSION, SYSTEM_PROMPTS } from './prompts'
import { LlmError, type LlmProvider, type LlmTask, type ModelTier } from './types'

export interface GatewayOptions {
  provider: LlmProvider
  models: Record<ModelTier, string>
  /** Cache and usage storage. Optional: without it nothing is cached or counted. */
  store?: LlmStore
  /** Stop when today's spend reaches this amount (USD). */
  dailyBudgetUsd?: number
  now?: () => Date
}

export interface RunOptions {
  jobId?: string
  tier?: ModelTier
}

export interface RunResult<T> {
  data: T
  cached: boolean
  tokensIn: number
  tokensOut: number
  costUsd: number
}

function stripFence(text: string): string {
  // Some local thinking models put their reasoning inline before the JSON. Drop it.
  text = text.replace(/^\s*<think>[\s\S]*?<\/think>/i, '')
  const m = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(text)
  return (m ? m[1]! : text).trim()
}

/**
 * Read the JSON object in a reply. Without forced JSON mode a model may add a sentence before or
 * after it, so fall back to the outermost {...}. Returns undefined when there is no valid object.
 */
export function parseJsonReply(text: string): unknown {
  const body = stripFence(text)
  try {
    return JSON.parse(body)
  } catch {
    const start = body.indexOf('{')
    const end = body.lastIndexOf('}')
    if (start < 0 || end <= start) return undefined
    try {
      return JSON.parse(body.slice(start, end + 1))
    } catch {
      return undefined
    }
  }
}

/** The single entry point for model calls: caching, structured output, budget and accounting. */
export class LlmGateway {
  constructor(private readonly o: GatewayOptions) {}

  get providerName(): string {
    return this.o.provider.name
  }

  async spentToday(): Promise<number> {
    return this.o.store ? this.o.store.spentToday(this.o.now?.() ?? new Date()) : 0
  }

  async run<T>(
    task: LlmTask,
    input: unknown,
    schema: z.ZodType<T>,
    options: RunOptions = {},
  ): Promise<RunResult<T>> {
    const tier = options.tier ?? 'cheap'
    const model = this.o.models[tier]
    const prompt = JSON.stringify(input)
    const system = SYSTEM_PROMPTS[task]
    const key = createHash('sha1')
      .update([task, PROMPT_VERSION, model, system, prompt].join('\u0000'))
      .digest('hex')

    const cached = await this.o.store?.getCache(key)
    if (cached) {
      const parsed = schema.safeParse(JSON.parse(cached))
      if (parsed.success) {
        await this.recordUsage(options.jobId, task, model, 0, 0, 0, true)
        return { data: parsed.data, cached: true, tokensIn: 0, tokensOut: 0, costUsd: 0 }
      }
    }

    if (this.o.dailyBudgetUsd !== undefined && (await this.spentToday()) >= this.o.dailyBudgetUsd) {
      throw new LlmError(`Daily model budget of $${this.o.dailyBudgetUsd} reached`, 'budget')
    }

    let tokensIn = 0
    let tokensOut = 0
    let costUsd = 0
    let problem = ''
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.o.provider.complete({
        task,
        model,
        system,
        prompt:
          attempt === 0
            ? prompt
            : `${prompt}\n\nYour previous reply was invalid: ${problem}. Reply with valid JSON only.`,
      })
      tokensIn += res.tokensIn
      tokensOut += res.tokensOut
      costUsd += res.costUsd
      const json = parseJsonReply(res.text)
      if (json === undefined) {
        problem = 'not valid JSON'
        continue
      }
      const parsed = schema.safeParse(json)
      if (!parsed.success) {
        problem = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
        continue
      }
      await this.o.store?.putCache(key, task, JSON.stringify(parsed.data))
      await this.recordUsage(options.jobId, task, res.model, tokensIn, tokensOut, costUsd, false)
      return { data: parsed.data, cached: false, tokensIn, tokensOut, costUsd }
    }
    await this.recordUsage(options.jobId, task, model, tokensIn, tokensOut, costUsd, false)
    throw new LlmError(`Model output for "${task}" was invalid after a retry: ${problem}`, 'output')
  }

  private async recordUsage(
    jobId: string | undefined,
    task: string,
    model: string,
    tokensIn: number,
    tokensOut: number,
    costUsd: number,
    cached: boolean,
  ): Promise<void> {
    await this.o.store?.recordUsage({
      jobId,
      task,
      model,
      tokensIn,
      tokensOut,
      costUsd,
      cached,
      at: this.o.now?.() ?? new Date(),
    })
  }
}
