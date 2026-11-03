import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PgJobStore } from '../src/job-store'
import { PgArtifactStore, PgLlmStore, PgSessionStore } from '../src/stores'
import { createTestDb } from '../src/testing'
import { job, KEY, newUser } from './helpers'

let t: Awaited<ReturnType<typeof createTestDb>>
beforeAll(async () => {
  t = await createTestDb()
})
afterAll(async () => t.close())

const store = async (now = () => new Date('2026-11-03T08:00:00Z')) => {
  const u = await newUser(t.db)
  return { u, s: new PgJobStore(t.db, u.id, now) }
}

describe('PgJobStore', () => {
  it('adds a job once, with an application and an event', async () => {
    const { s } = await store()
    expect(await s.addJob(job('a'))).toBe(true)
    expect(await s.addJob(job('a'))).toBe(false)
    expect((await s.getJob('a'))?.company).toBe('Company a')
    expect(await s.getApplication('a')).toMatchObject({
      status: 'queued',
      attempts: 0,
      resumeArtifactId: null,
    })
    expect((await s.events('a')).map((e) => e.type)).toEqual(['added'])
  })

  it('keeps the reason on needs_human and clears it on moves forward', async () => {
    const { s } = await store()
    await s.addJob(job('a'))
    await s.setStatus('a', 'needs_human', { reason: 'captcha' })
    await s.setStatus('a', 'needs_human')
    expect((await s.getApplication('a'))?.error).toBe('captcha')
    await s.setStatus('a', 'ready')
    expect((await s.getApplication('a'))?.error).toBeNull()
    await s.setStatus('a', 'failed', {
      reason: 'boom',
      attempts: 2,
      backend: 'playwright-chromium',
    })
    expect(await s.getApplication('a')).toMatchObject({
      error: 'boom',
      attempts: 2,
      backend: 'playwright-chromium',
    })
    await expect(s.setStatus('ghost', 'ready')).rejects.toThrow(/No application/)
  })

  it('lists by status oldest first, and stores skipped jobs with their reason', async () => {
    let t0 = 0
    const { s } = await store(() => new Date(Date.UTC(2026, 10, 3, 8, 0, t0++)))
    await s.addJob(job('b'))
    await s.addJob(job('a'))
    await s.addJob(job('c'), 'skipped', 'duplicate', 55)
    expect((await s.listByStatus('queued')).map((j) => j.id)).toEqual(['b', 'a'])
    expect((await s.listByStatus('skipped'))[0]).toMatchObject({ id: 'c', matchScore: 55 })
    expect((await s.getApplication('c'))?.error).toBe('duplicate')
  })

  it('finds duplicates by apply url or by company, title and location', async () => {
    const { s } = await store()
    await s.addJob(
      job('a', { company: 'Acme  Inc.', title: 'AI Engineer', applyUrl: 'https://x.test/1' }),
    )
    expect(await s.findDuplicate({ applyUrl: 'https://x.test/1', company: 'z', title: 'z' })).toBe(
      'a',
    )
    expect(
      await s.findDuplicate({
        applyUrl: 'https://other',
        company: 'acme inc',
        title: 'ai engineer',
        location: ' singapore ',
      }),
    ).toBe('a')
    expect(
      await s.findDuplicate({
        applyUrl: 'https://other',
        company: 'acme',
        title: 'ai engineer',
        location: 'Singapore',
      }),
    ).toBeUndefined()
  })

  it('counts jobs started today per site type, treating board native jobs by their board', async () => {
    const day = new Date('2026-11-03T08:00:00Z')
    const { s } = await store(() => day)
    await s.addJob(job('g1'))
    await s.addJob(job('g2'))
    await s.addJob(job('l1', { source: 'linkedin', applyTarget: 'board_native' }))
    await s.addJob(job('old'))
    await s.setStatus('g1', 'filling', { startedAt: day })
    await s.setStatus('g2', 'filling', { startedAt: new Date('2026-11-03T23:59:00Z') })
    await s.setStatus('l1', 'filling', { startedAt: day })
    await s.setStatus('old', 'filling', { startedAt: new Date('2026-11-02T23:59:00Z') })
    expect(await s.startedTodayFor('greenhouse', day)).toBe(2)
    expect(await s.startedTodayFor('linkedin', day)).toBe(1)
    expect(await s.startedTodayFor('indeed', day)).toBe(0)
    expect(await s.startedTodayFor('greenhouse', new Date('2026-11-04T00:00:01Z'))).toBe(0)
  })

  it('counts by status and site type', async () => {
    const { s } = await store()
    await s.addJob(job('a'))
    await s.addJob(job('b'))
    await s.addJob(job('c', { source: 'linkedin', applyTarget: 'board_native' }))
    await s.setStatus('b', 'ready')
    const c = await s.counts()
    expect(c).toContainEqual({ status: 'queued', siteType: 'greenhouse', n: 1 })
    expect(c).toContainEqual({ status: 'ready', siteType: 'greenhouse', n: 1 })
    expect(c).toContainEqual({ status: 'queued', siteType: 'linkedin', n: 1 })
  })

  it('tracks questions that need an answer, and clears them once answered', async () => {
    const { s } = await store()
    await s.recordUnanswered('Why us?')
    await s.recordUnanswered('Why us?')
    await s.recordUnanswered('Describe a conflict')
    expect(await s.unanswered()).toEqual(['Describe a conflict', 'Why us?'])
    await s.markAnswered('Why us?')
    expect(await s.unanswered()).toEqual(['Describe a conflict'])
    await s.recordUnanswered('Why us?') // already answered, stays answered
    expect(await s.unanswered()).toEqual(['Describe a conflict'])
  })

  it('computes site stats from metrics and replaces a metric on re-run', async () => {
    const { s } = await store()
    for (const [id, verify, outcome] of [
      ['a', 'pass', 'submitted'],
      ['b', 'pass', 'ready_to_submit'],
      ['c', 'n/a', 'needs_human'],
      ['d', 'fail', 'needs_human'],
    ] as const) {
      await s.addJob(job(id))
      await s.recordMetric({
        jobId: id,
        siteType: 'greenhouse',
        backend: 'b',
        durationMs: 10,
        steps: 1,
        fieldsTotal: 5,
        fieldsRule: 3,
        fieldsBank: 2,
        fieldsModel: 0,
        verify,
        outcome,
      })
    }
    expect(await s.siteStats('greenhouse')).toEqual({
      siteType: 'greenhouse',
      runs: 4,
      accuracy: 0.5,
      completion: 0.5,
    })
    expect(await s.siteStats('workday')).toMatchObject({ runs: 0, accuracy: 0 })
    await s.recordMetric({
      jobId: 'c',
      siteType: 'greenhouse',
      backend: 'b',
      durationMs: 10,
      steps: 1,
      fieldsTotal: 5,
      fieldsRule: 3,
      fieldsBank: 2,
      fieldsModel: 0,
      verify: 'pass',
      outcome: 'submitted',
    })
    expect((await s.siteStats('greenhouse')).runs).toBe(4)
    expect((await s.siteStats('greenhouse')).accuracy).toBe(0.75)
  })

  it('builds the report rows', async () => {
    const { s } = await store()
    await s.addJob(job('a'))
    await s.addJob(job('b'), 'skipped', 'duplicate')
    await s.recordMetric({
      jobId: 'a',
      siteType: 'greenhouse',
      backend: 'b',
      durationMs: 1200,
      steps: 2,
      fieldsTotal: 9,
      fieldsRule: 6,
      fieldsBank: 3,
      fieldsModel: 0,
      verify: 'pass',
      outcome: 'submitted',
    })
    await s.recordShadow({
      jobId: 'a',
      backend: 'playwright-lean',
      ok: true,
      compared: 9,
      diffs: [{ field: 'x' }],
      durationMs: 5,
    })
    await s.recordShadow({
      jobId: 'a',
      backend: 'ai-browser',
      ok: false,
      error: 'not implemented',
      compared: 0,
      diffs: [],
      durationMs: 1,
    })
    await new PgLlmStore(t.db, s.userId).recordUsage({
      task: 't',
      model: 'm',
      tokensIn: 10,
      tokensOut: 5,
      costUsd: 0.5,
      cached: false,
      at: new Date(),
    })
    await new PgLlmStore(t.db, s.userId).recordUsage({
      task: 't',
      model: 'm',
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      cached: true,
      at: new Date(),
    })
    const r = await s.reportRows()
    expect(r.jobs.find((j) => j.jobId === 'a')).toMatchObject({
      verify: 'pass',
      steps: 2,
      fieldsRule: 6,
      siteType: 'greenhouse',
    })
    expect(r.jobs.find((j) => j.jobId === 'b')).toMatchObject({
      status: 'skipped',
      reason: 'duplicate',
      verify: '',
    })
    expect(r.llm).toEqual({ calls: 2, cached: 1, tokensIn: 10, tokensOut: 5, costUsd: 0.5 })
    expect(r.shadow.find((x) => x.backend === 'playwright-lean')).toMatchObject({
      runs: 1,
      ok: 1,
      compared: 9,
      diffs: 1,
    })
    expect(r.shadow.find((x) => x.backend === 'ai-browser')?.errors).toEqual(['not implemented'])
  })

  it('records usage on the application, redacts events, and keeps board bookkeeping', async () => {
    const { s } = await store()
    await s.addJob(job('a'))
    await s.addUsage('a', 10, 5, 0.25)
    await s.addUsage('a', 1, 1, 0.25)
    expect(await s.getApplication('a')).toMatchObject({ tokensIn: 11, tokensOut: 6, costUsd: 0.5 })
    await s.addEvent('a', 'note', { email: 'alex.tan@example.com', key: 'Bearer abcdef123456789' })
    const last = (await s.events('a')).at(-1)!
    expect(JSON.stringify(last.payload)).not.toMatch(/alex\.tan|abcdef123456789/)

    expect(await s.getBoardMap('a')).toBeUndefined()
    await s.setBoardMap('a', 'board-1', 'Wishlist')
    await s.setBoardMap('a', 'board-1', 'Applied')
    expect(await s.getBoardMap('a')).toEqual({ boardId: 'board-1', lastStage: 'Applied' })

    await s.pushOutbox('a', { job: { id: 'a' }, status: 'submitted' })
    const [row] = await s.outbox()
    expect(row).toMatchObject({ jobId: 'a', attempts: 0, payload: { status: 'submitted' } })
    await s.bumpOutbox(row!.id)
    expect((await s.outbox())[0]!.attempts).toBe(1)
    await s.dropOutbox(row!.id)
    expect(await s.outbox()).toEqual([])
  })
})

describe('user isolation', () => {
  it('lets two users queue the same job id, and never shows one user the other data', async () => {
    const a = await newUser(t.db)
    const b = await newUser(t.db)
    const sa = new PgJobStore(t.db, a.id)
    const sb = new PgJobStore(t.db, b.id)
    expect(await sa.addJob(job('same'))).toBe(true)
    expect(await sb.addJob(job('same'))).toBe(true)
    await sa.setStatus('same', 'ready')
    expect((await sb.getApplication('same'))?.status).toBe('queued')
    expect(await sb.listByStatus('ready')).toEqual([])
    await sa.recordUnanswered('private question')
    expect(await sb.unanswered()).toEqual([])
    expect(
      await sb.findDuplicate({ applyUrl: job('same').applyUrl, company: 'x', title: 'y' }),
    ).toBe('same') // its own copy

    const aa = new PgArtifactStore(t.db, a.id)
    const ba = new PgArtifactStore(t.db, b.id)
    const id = await aa.put({
      jobId: 'same',
      kind: 'resume_pdf',
      name: 'r.pdf',
      contentType: 'application/pdf',
      data: Buffer.from('A'),
    })
    expect(await ba.get(id)).toBeUndefined()
    expect(await ba.list('same')).toEqual([])

    const sessA = new PgSessionStore(t.db, a.id, KEY)
    await sessA.put('linkedin', { cookies: [{ name: 'li_at', value: 'A-secret' }], origins: [] })
    expect(await new PgSessionStore(t.db, b.id, KEY).get('linkedin')).toBeUndefined()
  })
})
