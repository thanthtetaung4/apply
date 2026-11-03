import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generateKey, parseKey } from '../src/crypto'
import { browserSessions } from '../src/schema'
import { PgArtifactStore, PgLlmStore, PgSessionStore } from '../src/stores'
import { PgJobStore } from '../src/job-store'
import { createTestDb } from '../src/testing'
import { job, KEY, newUser } from './helpers'

let t: Awaited<ReturnType<typeof createTestDb>>
beforeAll(async () => {
  t = await createTestDb()
})
afterAll(async () => t.close())

describe('PgLlmStore', () => {
  it('caches by key, replaces on repeat, and sums spend for the current UTC day only', async () => {
    const u = await newUser(t.db)
    const s = new PgLlmStore(t.db, u.id)
    expect(await s.getCache('k')).toBeUndefined()
    await s.putCache('k', 'task', '{"a":1}')
    await s.putCache('k', 'task', '{"a":2}')
    expect(await s.getCache('k')).toBe('{"a":2}')

    const now = new Date('2026-11-03T12:00:00Z')
    await s.recordUsage({
      task: 't',
      model: 'm',
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 0.4,
      cached: false,
      at: new Date('2026-11-03T00:00:01Z'),
    })
    await s.recordUsage({
      task: 't',
      model: 'm',
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 0.1,
      cached: false,
      at: new Date('2026-11-03T11:00:00Z'),
    })
    await s.recordUsage({
      task: 't',
      model: 'm',
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 9,
      cached: false,
      at: new Date('2026-11-02T23:59:59Z'),
    })
    expect(await s.spentToday(now)).toBeCloseTo(0.5)
    expect(await s.spentToday(new Date('2026-11-04T01:00:00Z'))).toBe(0)
  })
})

describe('PgArtifactStore', () => {
  it('stores binary data exactly, replaces by name, and lists metadata', async () => {
    const u = await newUser(t.db)
    await new PgJobStore(t.db, u.id).addJob(job('j'))
    const s = new PgArtifactStore(t.db, u.id)
    const bytes = Buffer.from([0, 255, 1, 254, 37, 80, 68, 70])
    const id = await s.put({
      jobId: 'j',
      kind: 'resume_pdf',
      name: 'r.pdf',
      contentType: 'application/pdf',
      data: bytes,
    })
    const got = await s.get(id)
    expect(got?.data.equals(bytes)).toBe(true)
    expect(got).toMatchObject({
      name: 'r.pdf',
      kind: 'resume_pdf',
      size: 8,
      contentType: 'application/pdf',
    })

    const id2 = await s.put({
      jobId: 'j',
      kind: 'resume_pdf',
      name: 'r.pdf',
      contentType: 'application/pdf',
      data: Buffer.from('new'),
    })
    expect(id2).toBe(id)
    expect((await s.get(id))?.data.toString()).toBe('new')
    await s.put({
      jobId: 'j',
      kind: 'screenshot',
      name: 'step-1.png',
      contentType: 'image/png',
      data: Buffer.from('p'),
    })
    expect((await s.list('j')).map((a) => a.name)).toEqual(['r.pdf', 'step-1.png'])
    expect(await s.get('not-a-uuid')).toBeUndefined()
  })

  it('refuses artifacts for a job that does not exist', async () => {
    const u = await newUser(t.db)
    await expect(
      new PgArtifactStore(t.db, u.id).put({
        jobId: 'ghost',
        kind: 'record',
        name: 'x',
        contentType: 'a/b',
        data: Buffer.from('x'),
      }),
    ).rejects.toThrow()
  })
})

describe('PgSessionStore', () => {
  const state = {
    cookies: [{ name: 'li_at', value: 'super-secret-cookie', domain: '.linkedin.com' }],
    origins: [],
  }

  it('encrypts the cookies at rest and returns them intact', async () => {
    const u = await newUser(t.db)
    const s = new PgSessionStore(t.db, u.id, KEY)
    await s.put('linkedin', state)
    const [raw] = await t.db.select().from(browserSessions).where(eq(browserSessions.userId, u.id))
    expect(raw!.ciphertext).not.toContain('super-secret-cookie')
    expect(raw!.ciphertext.startsWith('v1.')).toBe(true)
    expect(await s.get('linkedin')).toEqual(state)
    expect((await s.list()).map((x) => x.key)).toEqual(['linkedin'])
    await s.remove('linkedin')
    expect(await s.get('linkedin')).toBeUndefined()
  })

  it('cannot be read with a different key, or after being copied to another user', async () => {
    const a = await newUser(t.db)
    const b = await newUser(t.db)
    await new PgSessionStore(t.db, a.id, KEY).put('indeed', state)
    await expect(
      new PgSessionStore(t.db, a.id, parseKey(generateKey())).get('indeed'),
    ).rejects.toThrow(/Could not decrypt/)
    const [raw] = await t.db.select().from(browserSessions).where(eq(browserSessions.userId, a.id))
    await t.db
      .insert(browserSessions)
      .values({ userId: b.id, key: 'indeed', ciphertext: raw!.ciphertext })
    await expect(new PgSessionStore(t.db, b.id, KEY).get('indeed')).rejects.toThrow(
      /Could not decrypt/,
    )
  })

  it('only accepts known site names', async () => {
    const u = await newUser(t.db)
    const s = new PgSessionStore(t.db, u.id, KEY)
    for (const ok of ['indeed', 'linkedin', 'glassdoor', 'workday-meridian', 'workday-acme-corp'])
      await s.put(ok, state)
    for (const bad of [
      'facebook',
      'workday-',
      '../x',
      'Workday-Acme',
      'workday-' + 'a'.repeat(80),
    ]) {
      await expect(s.put(bad, state)).rejects.toThrow(/Invalid session name/)
    }
  })
})
