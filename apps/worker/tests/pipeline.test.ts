import { afterAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { PDFDocument } from 'pdf-lib'
import { appendAnswer } from '@apply/core/profile'
import { retryJob } from '@apply/core/retry'
import { buildReport } from '@apply/core/report'
import { defaultSettings } from '@apply/core/settings'
import {
  claimNextTask,
  enqueueRun,
  enqueueTask,
  getProfileFiles,
  getTask,
  listTaskLogs,
  PgArtifactStore,
  requestCancel,
  saveProfileFile,
  registerUser,
} from '@apply/db'
import { handleTask } from '../src/handlers'
import { makeWorld, statusOf, type TestWorld } from './helpers'

describe('full pipeline through the task queue', () => {
  let w: TestWorld
  afterAll(async () => w?.close())

  it('finds jobs, tailors resumes, applies, parks what needs a human, and logs to the board', async () => {
    w = await makeWorld({
      tweak: (s) => ({
        ...s,
        backends: { shadow: { enabled: true, name: 'playwright-lean', sample: 1 } },
      }),
    })
    const u = await w.addUser()
    await w.run(u, 'intake', { thenRun: true })

    const intake = (await w.db.execute(
      (await import('drizzle-orm'))
        .sql`select result from tasks where user_id = ${u.id} and type = 'intake'`,
    )) as unknown as { rows: { result: { found: number; queued: number } }[] }
    expect(intake.rows[0]!.result).toMatchObject({ found: 12, queued: 9 })

    expect(await statusOf(w, u, 'Lumen AI')).toMatchObject({ status: 'submitted' })
    expect(await statusOf(w, u, 'Harbor Pay')).toMatchObject({ status: 'submitted' })
    expect(await statusOf(w, u, 'Northstar Logistics')).toMatchObject({ status: 'submitted' })
    expect(await statusOf(w, u, 'Quanta Cloud')).toMatchObject({ status: 'submitted' })
    expect(await statusOf(w, u, 'BrightPath Learning')).toMatchObject({ status: 'ready_to_submit' })
    expect(await statusOf(w, u, 'Atlas Retail')).toMatchObject({ status: 'ready_to_submit' })
    expect(await statusOf(w, u, 'NovaTech')).toMatchObject({
      status: 'needs_human',
      reason: expect.stringContaining('led a team through conflict'),
    })
    expect(await statusOf(w, u, 'Meridian Bank')).toMatchObject({
      status: 'needs_human',
      reason: expect.stringContaining('sign in'),
    })
    expect(await statusOf(w, u, 'ShadyCorp')).toMatchObject({
      status: 'needs_human',
      reason: expect.stringContaining('verify you are human'),
    })

    // Parked jobs say why, so the web app can show the right next step.
    const kind = async (c: string) =>
      (await w.store(u).getApplication((await statusOf(w, u, c))!.jobId))?.blockKind
    expect(await kind('NovaTech')).toBe('unknown_question')
    expect(await kind('Meridian Bank')).toBe('login_required')
    expect(await kind('ShadyCorp')).toBe('captcha')
    expect(await kind('Lumen AI')).toBeNull()

    // What the employer sites really received.
    expect(w.server.submissions.map((s) => s.company).sort()).toEqual([
      'Harbor Pay',
      'Lumen AI',
      'Northstar Logistics',
      'Quanta Cloud',
    ])
    const harbor = w.server.submissions.find((s) => s.company === 'Harbor Pay')!
    expect(harbor.fields).toMatchObject({
      first_name: 'Alex',
      email: 'alex.tan@example.com',
      gender: 'decline to self-identify',
      work_auth: 'yes',
      sponsorship: 'no',
      location: 'Singapore',
    })
    expect(harbor.files.resume?.filename).toBe('Alex_Tan_Resume.pdf')

    // Artifacts are in the database, not on disk.
    const lumen = (await statusOf(w, u, 'Lumen AI'))!
    const arts = new PgArtifactStore(w.db, u.id)
    const list = await arts.list(lumen.jobId)
    expect(list.map((a) => `${a.kind}:${a.name}`)).toEqual(
      expect.arrayContaining([
        'resume_pdf:Alex_Tan_Resume.pdf',
        'record:record.json',
        'screenshot:step-1.png',
        'screenshot:confirmation.png',
        'tailor:tailor.json',
      ]),
    )
    const pdf = await arts.get(list.find((a) => a.kind === 'resume_pdf')!.id)
    expect(pdf!.data.subarray(0, 4).toString()).toBe('%PDF')
    expect((await PDFDocument.load(pdf!.data)).getPageCount()).toBe(1)
    const rec = JSON.parse(
      (await arts.get(list.find((a) => a.kind === 'record')!.id))!.data.toString(),
    )
    expect(rec.outcome.verify).toBe('pass')
    expect(JSON.stringify(rec)).not.toMatch(/Bearer|OPENROUTER/)

    // The board over MCP.
    const stage = (c: string) => w.board.apps.find((a) => a.company === c)?.stage
    expect(stage('Lumen AI')).toBe('Applied')
    expect(stage('Atlas Retail')).toBe('Wishlist')
    expect(w.board.apps.find((a) => a.company === 'ShadyCorp')?.nextAction).toMatch(
      /Finish by hand/,
    )

    // Progress lines reached the task log, and shadow runs found no differences on finished jobs.
    const taskRow = (await w.db.execute(
      (await import('drizzle-orm'))
        .sql`select id from tasks where user_id = ${u.id} and type = 'run'`,
    )) as unknown as { rows: { id: string }[] }
    const logs = await listTaskLogs(w.db, u.id, taskRow.rows[0]!.id)
    expect(
      logs.some((l) => l.message.includes('submitted') && l.message.includes('Lumen AI')),
    ).toBe(true)
    const rep = await buildReport(w.store(u), defaultSettings())
    expect(rep.shadow.find((s) => s.backend === 'playwright-lean')).toMatchObject({ runs: 9 })
    expect(rep.unanswered).toEqual(['Describe a time you led a team through conflict'])
  })

  it('does not apply twice when run again', async () => {
    const u = w.users[0]!
    const before = w.server.submissions.length
    await w.run(u, 'run')
    expect(w.server.submissions.length).toBe(before)
  })

  it('recovers parked jobs after a saved sign in and a new saved answer', async () => {
    const u = w.users[0]!
    // Sign in to Workday once (here by driving the mock site), as the local uploader would.
    const stores = w.stores(u)
    const { PlaywrightBackend } = await import('@apply/core/browser')
    const backend = new PlaywrightBackend()
    const s = await backend.launch({ headless: true })
    await s.open(`${w.server.url}/wd/meridian/job/301`)
    const wall = await s.formSchema()
    await s.fill(wall.fields.find((f) => f.type === 'email')!.id, 'a@b.test')
    await s.fill(wall.fields.find((f) => f.type === 'password')!.id, 'pw')
    await s.click(wall.actions.find((a) => a.label === 'Sign In')!.id)
    await stores.sessions.put('workday-meridian', await s.exportState())
    await s.close()
    await backend.dispose()

    // Answer the question the way the "needs you" screen does: append to answers.md, then retry.
    const files = await getProfileFiles(w.db, u.id)
    await saveProfileFile(
      w.db,
      u.id,
      'answers',
      appendAnswer(
        files.answers.content,
        'Describe a time you led a team through conflict',
        'I mediated a scope disagreement between a client and a designer and agreed clear deliverables.',
      ),
      files.answers.revision,
    )
    for (const c of ['Meridian Bank', 'NovaTech'])
      await retryJob(stores.jobs, (await statusOf(w, u, c))!.jobId)
    await w.run(u, 'run')

    expect(await statusOf(w, u, 'Meridian Bank')).toMatchObject({ status: 'ready_to_submit' })
    expect(await statusOf(w, u, 'NovaTech')).toMatchObject({ status: 'submitted' })
    expect(w.server.submissions.find((x) => x.company === 'NovaTech')!.fields.conflict).toContain(
      'mediated a scope disagreement',
    )
    // The question is cleared from the "needs you" list once the profile answers it.
    expect(await stores.jobs.unanswered()).toEqual([])
    // Workday's resume parser overwrote name and phone after upload, and the final values are right.
    const rec = JSON.parse(
      (await stores.artifacts.get(
        (await stores.artifacts.list((await statusOf(w, u, 'Meridian Bank'))!.jobId)).find(
          (a) => a.kind === 'record',
        )!.id,
      ))!.data.toString(),
    )
    expect(
      rec.outcome.fields.find((f: { label: string }) => f.label === 'First Name'),
    ).toMatchObject({ actual: 'Alex', status: 'ok' })
    // The session was refreshed and saved back, still encrypted.
    expect(await stores.sessions.get('workday-meridian')).toBeTruthy()
  })
})

describe('approving a reviewed job', () => {
  it('submits it on request, even though the site policy is review, and merges into a waiting run', async () => {
    const w3 = await makeWorld()
    try {
      const u = await w3.addUser()
      await w3.run(u, 'intake', { sources: ['linkedin'], thenRun: true })
      const atlas = (await statusOf(w3, u, 'Atlas Retail'))!
      expect(atlas.status).toBe('ready_to_submit')
      expect(w3.server.submissions.map((x) => x.kind)).not.toContain('linkedin_easy_apply')

      // Approve it, plus ask for a second approval while the run is still waiting.
      const store = w3.store(u)
      await retryJob(store, atlas.jobId)
      const a = await enqueueRun(w3.db, u.id, { approveJobIds: [atlas.jobId] })
      const b = await enqueueRun(w3.db, u.id, { approveJobIds: ['someone-else'] })
      expect(b).toEqual({ id: a.id, alreadyQueued: true })
      expect((await getTask(w3.db, u.id, a.id))?.payload).toMatchObject({
        approveJobIds: [atlas.jobId, 'someone-else'],
      })

      await w3.drain()
      expect((await statusOf(w3, u, 'Atlas Retail'))!.status).toBe('submitted')
      expect(w3.server.submissions.map((x) => x.kind)).toContain('linkedin_easy_apply')
      const ev = await store.events(atlas.jobId)
      expect(ev.some((e) => e.type === 'approved_by_user')).toBe(true)
    } finally {
      await w3.close()
    }
  })
})

describe('task behaviour', () => {
  it('fails clearly when the resume is still the starter template', async () => {
    const w2 = await makeWorld()
    try {
      const u = await registerUser(w2.db, {
        email: 'fresh@example.com',
        password: 'correct horse battery',
      })
      const q = await enqueueTask(w2.db, u.id, 'intake')
      await w2.drain()
      const t = await getTask(w2.db, u.id, q.id)
      expect(t).toMatchObject({
        status: 'failed',
        error: expect.stringContaining('starter template'),
      })
    } finally {
      await w2.close()
    }
  })

  it('fails with the exact profile problems when a file is broken', async () => {
    const w2 = await makeWorld()
    try {
      const u = await w2.addUser()
      await saveProfileFile(w2.db, u.id, 'projects', '## Broken project\n')
      const q = await enqueueTask(w2.db, u.id, 'run')
      await w2.drain()
      expect((await getTask(w2.db, u.id, q.id))?.error).toMatch(/projects\.md.*Stack/)
    } finally {
      await w2.close()
    }
  })

  it('stops cleanly when the user cancels a running task', async () => {
    const w2 = await makeWorld()
    try {
      const u = await w2.addUser()
      await w2.run(u, 'intake')
      const q = await enqueueTask(w2.db, u.id, 'run')
      const claimed = (await claimNextTask(w2.db, 'test-worker'))!
      await requestCancel(w2.db, u.id, q.id)
      const out = await handleTask(w2.db, w2.env, claimed, w2.hooks)
      expect(out.canceled).toBe(true)
      const counts = await w2.store(u).counts()
      expect(counts.some((c) => c.status === 'submitted')).toBe(false)
      expect(w2.server.submissions).toHaveLength(0)
    } finally {
      await w2.close()
    }
  })
})

describe('saved sign ins', () => {
  it('are sealed, and marked expired when the site asks to sign in again', async () => {
    const w4 = await makeWorld()
    try {
      const u = await w4.addUser()
      const stores = w4.stores(u)
      // A sign in the site no longer accepts (wrong session cookie).
      const host = new URL(w4.server.url).hostname
      await stores.sessions.put('workday-meridian', {
        cookies: [
          {
            name: 'wd_sid',
            value: 'stale',
            domain: host,
            path: '/',
            expires: -1,
            httpOnly: true,
            secure: false,
            sameSite: 'Lax',
          },
        ],
        origins: [],
      })
      const raw = (await w4.db.execute(
        sql`select ciphertext from browser_sessions where user_id = ${u.id}`,
      )) as unknown as { rows: { ciphertext: string }[] }
      expect(raw.rows[0]!.ciphertext.startsWith('v2.')).toBe(true)
      expect((await stores.sessions.list())[0]).toMatchObject({ status: 'connected' })

      await w4.run(u, 'intake', { thenRun: true })
      expect(await statusOf(w4, u, 'Meridian Bank')).toMatchObject({
        status: 'needs_human',
        reason: expect.stringContaining('Connections page'),
      })
      expect((await stores.sessions.list())[0]).toMatchObject({
        key: 'workday-meridian',
        status: 'expired',
      })
    } finally {
      await w4.close()
    }
  })
})

describe('a model that fails while answering', () => {
  it('leaves the question to the user instead of failing the application', async () => {
    const w5 = await makeWorld()
    try {
      const { OfflineProvider } = await import('@apply/core/llm')
      const offline = new OfflineProvider()
      // Questions get invalid JSON (as a real local model returned on a Stripe form); everything
      // else is answered normally.
      w5.hooks.provider = {
        name: 'broken',
        complete: async (req) =>
          req.task === 'answer_field'
            ? { text: 'Okay, let me think...', tokensIn: 1, tokensOut: 1, costUsd: 0, model: 'x' }
            : offline.complete(req),
      }
      const u = await w5.addUser()
      await w5.run(u, 'intake', { thenRun: true })
      expect(await statusOf(w5, u, 'NovaTech')).toMatchObject({
        status: 'needs_human',
        reason: expect.stringContaining('led a team through conflict'),
      })
      // The rest of that form was still filled and checked before it stopped.
      const rec = JSON.parse(
        (await w5
          .stores(u)
          .artifacts.get(
            (await w5.stores(u).artifacts.list((await statusOf(w5, u, 'NovaTech'))!.jobId)).find(
              (a) => a.kind === 'record',
            )!.id,
          ))!.data.toString(),
      )
      expect(
        rec.outcome.fields.filter((f: { status: string }) => f.status === 'ok').length,
      ).toBeGreaterThan(2)
    } finally {
      await w5.close()
    }
  })
})
