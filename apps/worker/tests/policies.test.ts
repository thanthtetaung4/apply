import { describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { enqueueTask, getTask } from '@apply/db'
import { makeWorld, statusOf } from './helpers'

const intakeIndeed = (
  w: Awaited<ReturnType<typeof makeWorld>>,
  u: Awaited<ReturnType<Awaited<ReturnType<typeof makeWorld>>['addUser']>>,
) => w.run(u, 'intake', { sources: ['indeed'] })

describe('submit policy, gate, caps and fallback', () => {
  it('does not auto submit while the gate is enforced', async () => {
    const w = await makeWorld({ tweak: (s) => ({ ...s, gate: { ...s.gate, enforce: true } }) })
    try {
      const u = await w.addUser()
      await intakeIndeed(w, u)
      await w.run(u, 'run')
      expect(w.server.submissions).toHaveLength(0)
      expect(await statusOf(w, u, 'Lumen AI')).toMatchObject({ status: 'ready_to_submit' })
      const evt = (await w.db.execute(
        sql`select count(*)::int as n from events where type = 'policy_downgraded'`,
      )) as unknown as { rows: { n: number }[] }
      expect(evt.rows[0]!.n).toBeGreaterThanOrEqual(2)
    } finally {
      await w.close()
    }
  })

  it('defers jobs past the daily cap', async () => {
    const w = await makeWorld({
      tweak: (s) => ({
        ...s,
        workers: 1,
        sites: { ...s.sites, greenhouse: { ...s.sites.greenhouse, dailyCap: 1 } },
      }),
    })
    try {
      const u = await w.addUser()
      await intakeIndeed(w, u)
      await w.run(u, 'run')
      expect(w.server.submissions).toHaveLength(1)
      expect(
        [
          (await statusOf(w, u, 'Lumen AI'))!.status,
          (await statusOf(w, u, 'Harbor Pay'))!.status,
        ].sort(),
      ).toEqual(['ready', 'submitted'])
    } finally {
      await w.close()
    }
  })

  it('manual policy never opens the form', async () => {
    const w = await makeWorld({
      tweak: (s) => ({
        ...s,
        sites: { ...s.sites, greenhouse: { ...s.sites.greenhouse, submit: 'manual' } },
      }),
    })
    try {
      const u = await w.addUser()
      await intakeIndeed(w, u)
      await w.run(u, 'run')
      expect(await statusOf(w, u, 'Lumen AI')).toMatchObject({
        status: 'needs_human',
        reason: expect.stringContaining('manual'),
      })
      expect(w.server.submissions).toHaveLength(0)
    } finally {
      await w.close()
    }
  })

  it('falls back to Chromium when the primary backend cannot start', async () => {
    const w = await makeWorld({
      tweak: (s) => ({
        ...s,
        sites: {
          ...s.sites,
          greenhouse: {
            ...s.sites.greenhouse,
            backend: 'ai-browser',
            fallback: 'playwright-chromium',
          },
        },
      }),
    })
    try {
      const u = await w.addUser()
      await intakeIndeed(w, u)
      await w.run(u, 'run')
      expect(await statusOf(w, u, 'Lumen AI')).toMatchObject({ status: 'submitted' })
      const m = (await w.db.execute(
        sql`select m.backend from metrics m join jobs j on j.id = m.job_id and j.user_id = m.user_id where j.company = 'Lumen AI'`,
      )) as unknown as { rows: { backend: string }[] }
      expect(m.rows[0]!.backend).toBe('playwright-chromium')
    } finally {
      await w.close()
    }
  })

  it('fails one job when no backend works and keeps going with the rest', async () => {
    const w = await makeWorld({
      tweak: (s) => ({
        ...s,
        sites: {
          ...s.sites,
          greenhouse: { ...s.sites.greenhouse, backend: 'ai-browser', fallback: 'also-missing' },
        },
      }),
    })
    try {
      const u = await w.addUser()
      await intakeIndeed(w, u)
      await w.run(u, 'run')
      expect(['failed', 'ready']).toContain((await statusOf(w, u, 'Lumen AI'))!.status)
      expect(await statusOf(w, u, 'BrightPath Learning')).toMatchObject({
        status: 'ready_to_submit',
      })
    } finally {
      await w.close()
    }
  })

  it('records a failed task without stopping the worker loop', async () => {
    const w = await makeWorld()
    try {
      const u = await w.addUser()
      const bad = await enqueueTask(w.db, u.id, 'run', { limit: 'not a number' })
      await w.drain()
      expect((await getTask(w.db, u.id, bad.id))?.status).toBe('failed')
      const ok = await enqueueTask(w.db, u.id, 'intake', { dryRun: true })
      await w.drain()
      expect((await getTask(w.db, u.id, ok.id))?.status).toBe('succeeded')
    } finally {
      await w.close()
    }
  })
})
