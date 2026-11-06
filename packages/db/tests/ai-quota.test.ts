import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { admitPlatformAiJob, aiWeekStart, getAiQuota, grantAiCredits } from '../src/ai-quota'
import { createTestDb } from '../src/testing'
import { newUser } from './helpers'

let t: Awaited<ReturnType<typeof createTestDb>>
beforeAll(async () => {
  t = await createTestDb()
})
afterAll(async () => t.close())

describe('App AI quota', () => {
  it('weeks start on Monday 00:00 UTC', () => {
    expect(aiWeekStart(new Date('2026-11-06T15:00:00Z')).toISOString()).toBe(
      '2026-11-02T00:00:00.000Z',
    ) // a Friday
    expect(aiWeekStart(new Date('2026-11-08T23:59:00Z')).toISOString()).toBe(
      '2026-11-02T00:00:00.000Z',
    ) // Sunday
    expect(aiWeekStart(new Date('2026-11-09T00:00:00Z')).toISOString()).toBe(
      '2026-11-09T00:00:00.000Z',
    ) // Monday
  })

  it('counts each job once, then uses credits, then refuses; renews weekly', async () => {
    const u = await newUser(t.db)
    const mon = new Date('2026-11-02T10:00:00Z')
    expect(await admitPlatformAiJob(t.db, u.id, 'a', 2, mon)).toBe(true)
    expect(await admitPlatformAiJob(t.db, u.id, 'a', 2, mon)).toBe(true) // same job: free
    expect(await admitPlatformAiJob(t.db, u.id, 'b', 2, mon)).toBe(true)
    expect(await admitPlatformAiJob(t.db, u.id, 'c', 2, mon)).toBe(false) // allowance used

    await grantAiCredits(t.db, { userId: u.id, stripeSessionId: 'cs_1', credits: 1 })
    expect(await admitPlatformAiJob(t.db, u.id, 'c', 2, mon)).toBe(true) // credit
    expect(await admitPlatformAiJob(t.db, u.id, 'c', 2, mon)).toBe(true) // already counted
    expect(await admitPlatformAiJob(t.db, u.id, 'd', 2, mon)).toBe(false)
    expect(await getAiQuota(t.db, u.id, 2, mon)).toMatchObject({
      freeUsed: 2,
      freeLimit: 2,
      credits: 0,
      resetsAt: new Date('2026-11-09T00:00:00Z'),
    })

    const nextMon = new Date('2026-11-09T01:00:00Z')
    expect(await admitPlatformAiJob(t.db, u.id, 'd', 2, nextMon)).toBe(true)
    expect((await getAiQuota(t.db, u.id, 2, nextMon)).freeUsed).toBe(1)
  })

  it('does not spend the same free slot twice when browsers run in parallel', async () => {
    const u = await newUser(t.db)
    const now = new Date('2026-11-03T10:00:00Z')
    const results = await Promise.all(
      ['j1', 'j2', 'j3', 'j4'].map((j) => admitPlatformAiJob(t.db, u.id, j, 2, now)),
    )
    expect(results.filter(Boolean)).toHaveLength(2)
  })

  it('grants a Stripe session once, however often the webhook repeats', async () => {
    const u = await newUser(t.db)
    const p = { userId: u.id, stripeSessionId: 'cs_repeat', credits: 50, amountCents: 500 }
    expect(await grantAiCredits(t.db, p)).toBe(true)
    expect(await grantAiCredits(t.db, p)).toBe(false)
    expect(await grantAiCredits(t.db, { ...p, stripeSessionId: 'cs_other' })).toBe(true)
    expect((await getAiQuota(t.db, u.id, 0)).credits).toBe(100)
  })
})
