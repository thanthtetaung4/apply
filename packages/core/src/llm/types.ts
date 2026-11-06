export type LlmTask = 'extract_requirements' | 'answer_field' | 'rephrase_bullet'
export type ModelTier = 'cheap' | 'mid' | 'strong'

export interface LlmRequest {
  task: LlmTask
  model: string
  system: string
  /** JSON text of the task input. Offline providers parse it, hosted models read it as data. */
  prompt: string
  /**
   * JSON Schema of the reply. Providers that can enforce it while generating (Ollama's native
   * API) use it; the gateway validates every reply against the same schema either way.
   */
  schema?: Record<string, unknown>
}

export interface LlmResponse {
  text: string
  tokensIn: number
  tokensOut: number
  costUsd: number
  model: string
}

export interface LlmProvider {
  readonly name: string
  complete(req: LlmRequest): Promise<LlmResponse>
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly kind: 'http' | 'network' | 'output' | 'budget' | 'quota',
    readonly status?: number,
  ) {
    super(message)
    this.name = 'LlmError'
  }
}
