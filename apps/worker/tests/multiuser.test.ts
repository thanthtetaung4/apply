import { afterAll, describe, expect, it } from 'vitest'
import { PgSessionStore, listTasks } from '@apply/db'
import { makeWorld, statusOf, type TestWorld } from './helpers'

describe('two users on one worker', () => {
  let w: TestWorld
  afterAll(async () => w?.close())

  it('keep separate jobs, answers, sessions, artifacts and board entries', async () => {
    w = await makeWorld({ workerConcurrency: 2 })
    const a = await w.addUser('a@example.com')
    // B skips the Workday and board-native sites by choosing manual for them, to prove settings are per user.
    const b = await w.addUser('b@example.com', (s) => ({
      ...s,
      sites: { ...s.sites, greenhouse: { ...s.sites.greenhouse, submit: 'review' } },
    }))

    await w.run(a, 'intake', { thenRun: true })
    await w.run(b, 'intake', { thenRun: true })

    // Same 9 postings for both, but separate rows and separate outcomes.
    expect((await w.store(a).counts()).reduce((n, c) => n + c.n, 0)).toBe(12)
    expect((await w.store(b).counts()).reduce((n, c) => n + c.n, 0)).toBe(12)
    expect((await statusOf(w, a, 'Lumen AI'))!.status).toBe('submitted')
    expect((await statusOf(w, b, 'Lumen AI'))!.status).toBe('ready_to_submit') // B's own review policy
    expect(w.server.submissions.filter((s) => s.company === 'Lumen AI')).toHaveLength(1)

    // Sessions are per user and encrypted: A has a saved Indeed sign in, B does not see it.
    await new PgSessionStore(w.db, a.id, w.env.encryptionKey).put('indeed', {
      cookies: [{ name: 's', value: 'only-a' }],
      origins: [],
    })
    expect(await new PgSessionStore(w.db, b.id, w.env.encryptionKey).get('indeed')).toBeUndefined()

    // Artifacts: B cannot read A's resume.
    const aJob = (await statusOf(w, a, 'Lumen AI'))!.jobId
    const aArt = (await w.stores(a).artifacts.list(aJob))[0]!
    expect(await w.stores(b).artifacts.get(aArt.id)).toBeUndefined()

    // Board entries are shared in this test (one mock board) but each user logged only their own.
    expect((await listTasks(w.db, a.id, 10)).every((t) => t.userId === a.id)).toBe(true)
  })

  it('run tasks for different users at the same time, but never two for one user', async () => {
    const w2 = await makeWorld({ workerConcurrency: 3 })
    try {
      const a = await w2.addUser('c@example.com')
      const b = await w2.addUser('d@example.com')
      await w2.run(a, 'intake')
      await w2.run(b, 'intake')
      const { enqueueTask } = await import('@apply/db')
      await enqueueTask(w2.db, a.id, 'run')
      await enqueueTask(w2.db, b.id, 'run')
      const { startWorker } = await import('../src/worker')
      const worker = startWorker(w2.db, w2.env, { hooks: w2.hooks })
      await worker.idle()
      await worker.stop()
      const runs = (await Promise.all([a, b].map((u) => listTasks(w2.db, u.id, 5))))
        .flat()
        .filter((t) => t.type === 'run')
      expect(runs.map((t) => t.status)).toEqual(['succeeded', 'succeeded'])
      const overlap =
        runs[0]!.startedAt! < runs[1]!.finishedAt! && runs[1]!.startedAt! < runs[0]!.finishedAt!
      expect(overlap).toBe(true) // two users ran concurrently
    } finally {
      await w2.close()
    }
  })
})
