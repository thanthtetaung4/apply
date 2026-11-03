import type { LlmStore, LlmUsageRow } from '../../src/store'

/** Minimal in-memory LlmStore for unit tests. */
export class MemoryLlmStore implements LlmStore {
  cache = new Map<string, string>()
  usage: LlmUsageRow[] = []
  async getCache(key: string) {
    return this.cache.get(key)
  }
  async putCache(key: string, _task: string, response: string) {
    this.cache.set(key, response)
  }
  async recordUsage(row: LlmUsageRow) {
    this.usage.push(row)
  }
  async spentToday(now: Date) {
    const day = now.toISOString().slice(0, 10)
    return this.usage
      .filter((u) => u.at.toISOString().slice(0, 10) === day)
      .reduce((n, u) => n + u.costUsd, 0)
  }
}
