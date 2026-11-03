import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { getTask, listTasks } from '@apply/db'
import { makeWorld, type TestWorld } from './helpers'

const lastResult = async (w: TestWorld, userId: string) => (await listTasks(w.db, userId, 1))[0]!

describe('intake through the worker', () => {
  let w: TestWorld
  beforeAll(async () => {
    w = await makeWorld()
  })
  afterAll(async () => w.close())

  it('queues good jobs, classifies targets and records why others were skipped', async () => {
    const u = await w.addUser()
    await w.run(u, 'intake')
    const t = await lastResult(w, u.id)
    expect(t.status).toBe('succeeded')
    expect(t.result).toMatchObject({
      found: 12,
      queued: 9,
      skipped: { excluded_title: 1, title_mismatch: 1, duplicate: 1 },
    })

    const q = async (company: string) =>
      (
        (await w.db.execute(
          sql`select j.apply_target, j.apply_url from jobs j join applications a on a.job_id = j.id and a.user_id = j.user_id where j.user_id = ${u.id} and j.company = ${company} and a.status = 'queued'`,
        )) as unknown as { rows: { apply_target: string; apply_url: string }[] }
      ).rows[0]!
    expect((await q('Lumen AI')).apply_target).toBe('greenhouse')
    expect((await q('Meridian Bank')).apply_target).toBe('workday')
    expect((await q('Northstar Logistics')).apply_target).toBe('company_site')
    expect((await q('Atlas Retail')).apply_target).toBe('board_native')
    expect((await q('Atlas Retail')).apply_url).toContain('/linkedin/jobs/view/')
    expect((await q('BrightPath Learning')).apply_url).toContain('/indeed/apply/')
  })

  it('does nothing the second time', async () => {
    const u = w.users[0]!
    await w.run(u, 'intake')
    const t = await lastResult(w, u.id)
    expect(t.result).toMatchObject({ queued: 0, skipped: { already_seen: 12 } })
  })

  it('dry run saves nothing', async () => {
    const u = await w.addUser()
    await w.run(u, 'intake', { dryRun: true })
    expect((await lastResult(w, u.id)).result).toMatchObject({ queued: 9 })
    expect(await w.store(u).counts()).toEqual([])
  })

  it('isolates a failing source', async () => {
    const u = await w.addUser(undefined, (s) => ({
      ...s,
      sources: { ...s.sources, indeed: { ...s.sources.indeed, baseUrl: 'http://127.0.0.1:1' } },
    }))
    await w.run(u, 'intake')
    const t = await lastResult(w, u.id)
    expect(t.status).toBe('succeeded')
    const r = t.result as { errors: string[]; perSource: Record<string, { queued: number }> }
    expect(r.errors.join()).toMatch(/indeed/)
    expect(r.perSource.linkedin!.queued + r.perSource.glassdoor!.queued).toBeGreaterThan(0)
    expect((await getTask(w.db, u.id, t.id))?.status).toBe('succeeded')
  })
})
