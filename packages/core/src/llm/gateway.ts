import { createHash } from 'node:crypto'
import { z } from 'zod'
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
  /**
   * Asked before every model call that the cache does not answer. Returning false stops the call
   * with an LlmError of kind "quota"; callers then carry on without AI. Used for the app's own
   * model, which is free for a few applications a week and paid after that.
   */
  admit?: (jobId: string | undefined) => Promise<boolean>
  now?: () => Date
}

export interface RunOptions {
  jobId?: string
  tier?: ModelTier
  /**
   * A stricter JSON Schema for providers that enforce one while generating, e.g. the allowed
   * options of a select question. The reply is still validated against the zod schema.
   */
  replySchema?: Record<string, unknown>
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

/** The reply schema as JSON Schema, for providers that enforce it. Undefined if not expressible. */
function toJsonSchema(schema: z.ZodType): Record<string, unknown> | undefined {
  try {
    const json = z.toJSONSchema(schema) as Record<string, unknown>
    delete json.$schema
    return json
  } catch {
    return undefined
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
    // The provider is part of the key: the offline stand-in answers UNKNOWN to everything, and
    // those answers must not be served once a real model is configured under the same name.
    const key = createHash('sha1')
      .update([task, PROMPT_VERSION, this.o.provider.name, model, system, prompt].join('\u0000'))
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
    if (this.o.admit && !(await this.o.admit(options.jobId))) {
      throw new LlmError('No AI applications left this week', 'quota')
    }

    const jsonSchema = options.replySchema ?? toJsonSchema(schema)
    let tokensIn = 0
    let tokensOut = 0
    let costUsd = 0
    let problem = ''
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.o.provider.complete({
        task,
        model,
        system,
        schema: jsonSchema,
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
