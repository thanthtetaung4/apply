import { BrowserError } from '../browser/types'
import { LlmError } from '../llm/types'

/**
 * Error taxonomy used for retry decisions.
 * - transient: try again, possibly on another backend (timeouts, rate limits, crashed browser)
 * - fatal: retrying will not help (bad config, missing file, budget reached)
 */
export type ErrorClass = 'transient' | 'fatal'

export function classifyError(err: unknown): ErrorClass {
  if (err instanceof BrowserError) {
    return err.code === 'timeout' || err.code === 'launch' ? 'transient' : 'fatal'
  }
  if (err instanceof LlmError) {
    if (err.kind === 'budget' || err.kind === 'output') return 'fatal'
    return err.kind === 'network' || (err.status ?? 0) >= 429 ? 'transient' : 'fatal'
  }
  const msg = err instanceof Error ? err.message : String(err)
  return /timeout|timed out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|Target closed|Navigation|net::/i.test(
    msg,
  )
    ? 'transient'
    : 'fatal'
}
