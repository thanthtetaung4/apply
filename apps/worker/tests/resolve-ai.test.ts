import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultSettings } from '@apply/core/settings'
import {
  generateSealKeyPair,
  getAiQuota,
  grantAiCredits,
  registerUser,
  SECRET_NAMES,
  setSecret,
} from '@apply/db'
import { createTestDb } from '@apply/db/testing'
import { loadEnv } from '../src/env'
import { PreflightError, resolveAi } from '../src/user-engine'

const KEY = Buffer.alloc(32, 7)
const base = {
  DATABASE_URL: 'postgres://x',
  APP_ENCRYPTION_KEY: KEY.toString('base64'),
  WORKER_SESSION_PRIVATE_KEY: generateSealKeyPair().privateKey,
}
const hostedEnv = loadEnv({
  ...base,
  PLATFORM_OPENROUTER_KEY: 'sk-or-platform-key',
  FREE_AI_APPLICATIONS_PER_WEEK: '1',
})

let t: Awaited<ReturnType<typeof createTestDb>>
let n = 0
const user = () =>
  registerUser(t.db, { email: `ai${++n}@example.com`, password: 'correct horse battery' })
beforeAll(async () => {
  t = await createTestDb()
})
afterAll(async () => t.close())

describe('choosing the AI for a run', () => {
  it('defaults to App AI, limited per job, with a capped daily budget', async () => {
    const u = await user()
    const s = defaultSettings()
    s.llm.dailyBudgetUsd = 50
    const ai = await resolveAi(t.db, hostedEnv, u.id, s)
    expect(ai.provider.name).toBe('platform')
    expect(ai.models?.cheap).toBe(hostedEnv.PLATFORM_MODEL)
    expect(ai.dailyBudgetUsd).toBe(0.5)
    expect(await ai.admit!('job-1')).toBe(true)
    expect(await ai.admit!('job-1')).toBe(true)
    expect(await ai.admit!('job-2')).toBe(false)
    expect(await ai.admit!(undefined)).toBe(false)
    await grantAiCredits(t.db, { userId: u.id, stripeSessionId: `cs_${u.id}`, credits: 1 })
    expect(await ai.admit!('job-2')).toBe(true)
    expect((await getAiQuota(t.db, u.id, 1)).credits).toBe(0)
  })

  it('runs without AI when the server offers no App AI or the user chose none', async () => {
    const u = await user()
    expect((await resolveAi(t.db, loadEnv(base), u.id, defaultSettings())).provider.name).toBe(
      'offline',
    )
    const s = defaultSettings()
    s.llm.mode = 'none'
    expect((await resolveAi(t.db, hostedEnv, u.id, s)).provider.name).toBe('offline')
  })

  it('uses a saved OpenRouter key with no app limit, once models are chosen', async () => {
    const u = await user()
    await setSecret(t.db, KEY, u.id, SECRET_NAMES.openrouterKey, 'sk-or-user-key-123')
    const s = defaultSettings()
    await expect(resolveAi(t.db, hostedEnv, u.id, s)).rejects.toThrow(PreflightError)
    s.llm.models = { cheap: 'a/b', mid: 'a/b', strong: 'a/b' }
    const ai = await resolveAi(t.db, hostedEnv, u.id, s)
    expect(ai.provider.name).toBe('openrouter')
    expect(ai.admit).toBeUndefined()
  })

  it('uses the user’s own server, refusing private addresses on a hosted worker', async () => {
    const u = await user()
    const s = defaultSettings()
    s.llm.mode = 'custom'
    s.llm.custom.model = 'qwen3:8b'
    await expect(resolveAi(t.db, hostedEnv, u.id, s)).rejects.toThrow(/address or model/)
    await setSecret(t.db, KEY, u.id, SECRET_NAMES.llmEndpointUrl, 'http://192.168.1.10:11434/v1')
    await expect(resolveAi(t.db, hostedEnv, u.id, s)).rejects.toThrow(/not usable/)
    const selfHosted = loadEnv({ ...base, ALLOW_PRIVATE_LLM_ENDPOINTS: '1' })
    const ai = await resolveAi(t.db, selfHosted, u.id, s)
    expect(ai.provider.name).toBe('custom')
    expect(ai.models).toEqual({ cheap: 'qwen3:8b', mid: 'qwen3:8b', strong: 'qwen3:8b' })
    expect(ai.admit).toBeUndefined()
  })
})
