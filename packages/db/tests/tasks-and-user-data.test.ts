import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PROFILE_TEMPLATES } from '@apply/core/profile'
import { defaultSettings } from '@apply/core/settings'
import {
  addTaskLog,
  cancelTaskDone,
  claimNextTask,
  completeTask,
  enqueueTask,
  failTask,
  getTask,
  heartbeat,
  isCancelRequested,
  listTaskLogs,
  listTasks,
  reclaimStaleTasks,
  requestCancel,
} from '../src/tasks'
import {
  ConflictError,
  deleteSecret,
  getProfileFiles,
  getSecret,
  getSettings,
  isStarterProfile,
  listSecretNames,
  loadProfile,
  saveProfileFile,
  saveSettings,
  setSecret,
  SECRET_NAMES,
} from '../src/user-data'
import { createTestDb } from '../src/testing'
import { KEY, newUser } from './helpers'

let t: Awaited<ReturnType<typeof createTestDb>>
beforeAll(async () => {
  t = await createTestDb()
})
afterAll(async () => t.close())

describe('task queue', () => {
  it('queues work once per type, claims oldest first, one running task per user', async () => {
    const a = await newUser(t.db)
    const b = await newUser(t.db)
    const a1 = await enqueueTask(t.db, a.id, 'intake', { sources: ['indeed'] })
    const dup = await enqueueTask(t.db, a.id, 'intake')
    expect(dup).toEqual({ id: a1.id, alreadyQueued: true })
    const a2 = await enqueueTask(t.db, a.id, 'run')
    const b1 = await enqueueTask(t.db, b.id, 'run')

    const first = await claimNextTask(t.db, 'w1')
    expect(first).toMatchObject({
      id: a1.id,
      status: 'running',
      lockedBy: 'w1',
      attempts: 1,
      payload: { sources: ['indeed'] },
    })
    // a2 belongs to a user who already has a running task, so the next claim skips it for b1.
    const second = await claimNextTask(t.db, 'w2')
    expect(second?.id).toBe(b1.id)
    expect(await claimNextTask(t.db, 'w3')).toBeUndefined()

    await completeTask(t.db, a1.id, { found: 3 })
    expect((await getTask(t.db, a.id, a1.id))?.result).toEqual({ found: 3 })
    const third = await claimNextTask(t.db, 'w1')
    expect(third?.id).toBe(a2.id)
    await failTask(t.db, a2.id, 'boom with Bearer abcdef123456789')
    expect(await getTask(t.db, a.id, a2.id)).toMatchObject({
      status: 'failed',
      error: 'boom with Bearer ***',
    })
    await completeTask(t.db, b1.id, null)
  })

  it('does not hand the same task to two workers claiming at once', async () => {
    const u = await newUser(t.db)
    await enqueueTask(t.db, u.id, 'intake')
    const got = await Promise.all([
      claimNextTask(t.db, 'x'),
      claimNextTask(t.db, 'y'),
      claimNextTask(t.db, 'z'),
    ])
    expect(got.filter(Boolean)).toHaveLength(1)
    await completeTask(t.db, got.find(Boolean)!.id, null)
  })

  it('cancels a waiting task at once and asks a running one to stop', async () => {
    const u = await newUser(t.db)
    const other = await newUser(t.db)
    const q = await enqueueTask(t.db, u.id, 'intake')
    await requestCancel(t.db, other.id, q.id) // not the owner
    expect((await getTask(t.db, u.id, q.id))?.status).toBe('queued')
    await requestCancel(t.db, u.id, q.id)
    expect((await getTask(t.db, u.id, q.id))?.status).toBe('canceled')

    const r = await enqueueTask(t.db, u.id, 'run')
    const running = (await claimNextTask(t.db, 'w'))!
    expect(running.id).toBe(r.id)
    expect(await isCancelRequested(t.db, r.id)).toBe(false)
    await requestCancel(t.db, u.id, r.id)
    expect(await isCancelRequested(t.db, r.id)).toBe(true)
    expect((await getTask(t.db, u.id, r.id))?.status).toBe('running')
    await cancelTaskDone(t.db, r.id, { stopped: true })
    expect((await getTask(t.db, u.id, r.id))?.status).toBe('canceled')
    await requestCancel(t.db, u.id, 'not-a-uuid') // no throw
  })

  it('reclaims tasks whose worker stopped sending heartbeats, and fails them after 3 tries', async () => {
    const u = await newUser(t.db)
    const q = await enqueueTask(t.db, u.id, 'run')
    for (let attempt = 1; attempt <= 3; attempt++) {
      const c = await claimNextTask(t.db, 'dead-worker')
      expect(c?.id).toBe(q.id)
      expect(c?.attempts).toBe(attempt)
      await heartbeat(t.db, q.id)
      expect(await reclaimStaleTasks(t.db, 60_000)).toBe(0) // fresh heartbeat
      await t.db.execute(
        sql`update tasks set heartbeat_at = now() - interval '5 minutes' where id = ${q.id}`,
      )
      expect(await reclaimStaleTasks(t.db, 60_000)).toBe(1)
    }
    expect(await getTask(t.db, u.id, q.id)).toMatchObject({
      status: 'failed',
      error: 'The worker stopped responding.',
    })
  })

  it('stores progress logs per task, redacted, readable only by the owner', async () => {
    const u = await newUser(t.db)
    const other = await newUser(t.db)
    const q = await enqueueTask(t.db, u.id, 'intake')
    await addTaskLog(t.db, q.id, 'queued Acme | AI Engineer')
    await addTaskLog(t.db, q.id, 'contact alex.tan@example.com failed', 'error')
    const logs = await listTaskLogs(t.db, u.id, q.id)
    expect(logs.map((l) => l.message)).toEqual([
      'queued Acme | AI Engineer',
      'contact a***@example.com failed',
    ])
    expect((await listTaskLogs(t.db, u.id, q.id, logs[0]!.id)).map((l) => l.level)).toEqual([
      'error',
    ])
    expect(await listTaskLogs(t.db, other.id, q.id)).toEqual([])
    expect((await listTasks(t.db, u.id)).length).toBeGreaterThan(0)
  })
})

describe('profile files', () => {
  it('saves with revision checks so two tabs cannot overwrite each other', async () => {
    const u = await newUser(t.db)
    const before = await getProfileFiles(t.db, u.id)
    expect(before.titles.revision).toBe(1)
    const r1 = await saveProfileFile(t.db, u.id, 'titles', '# Titles\n- A\n', 1)
    expect(r1.revision).toBe(2)
    await expect(
      saveProfileFile(t.db, u.id, 'titles', '# Titles\n- B\n', 1),
    ).rejects.toBeInstanceOf(ConflictError)
    expect((await getProfileFiles(t.db, u.id)).titles.content).toBe('# Titles\n- A\n')
    expect((await saveProfileFile(t.db, u.id, 'titles', '# Titles\n- C\n')).revision).toBe(3) // no revision given
    await expect(saveProfileFile(t.db, u.id, 'nope' as never, 'x')).rejects.toThrow(/Unknown/)
    await expect(saveProfileFile(t.db, u.id, 'resume', 'x'.repeat(200_001))).rejects.toThrow(
      /too large/,
    )
  })

  it('loads a parsed profile and recognises the untouched starter template', async () => {
    const u = await newUser(t.db)
    const files = await getProfileFiles(t.db, u.id)
    expect(isStarterProfile({ resume: files.resume.content })).toBe(true)
    const p = await loadProfile(t.db, u.id)
    expect(p.contact.name).toBe('Your Name')

    const mine = PROFILE_TEMPLATES.resume
      .replace('Your Name', 'Alex Tan')
      .replace('you@example.com', 'alex@example.org')
    await saveProfileFile(t.db, u.id, 'resume', mine)
    expect(isStarterProfile({ resume: mine })).toBe(false)
    expect((await loadProfile(t.db, u.id)).contact.name).toBe('Alex Tan')

    await saveProfileFile(t.db, u.id, 'projects', '## Broken\n')
    await expect(loadProfile(t.db, u.id)).rejects.toThrow(/Stack/)
  })
})

describe('settings and secrets', () => {
  it('round trips settings and falls back to defaults for bad stored data', async () => {
    const u = await newUser(t.db)
    const s = defaultSettings()
    s.sites.greenhouse.submit = 'auto'
    s.workers = 3
    await saveSettings(t.db, u.id, s)
    const back = await getSettings(t.db, u.id)
    expect(back.sites.greenhouse.submit).toBe('auto')
    expect(back.workers).toBe(3)
    await expect(saveSettings(t.db, u.id, { ...s, workers: 99 })).rejects.toThrow(
      /Invalid settings/,
    )
    await t.db.execute(
      sql`update user_settings set settings = '{"workers": "many"}' where user_id = ${u.id}`,
    )
    expect((await getSettings(t.db, u.id)).workers).toBe(2)
  })

  it('stores secrets encrypted, lists names only, and deletes', async () => {
    const u = await newUser(t.db)
    const other = await newUser(t.db)
    await setSecret(t.db, KEY, u.id, SECRET_NAMES.openrouterKey, 'sk-or-secret-value')
    await setSecret(t.db, KEY, u.id, SECRET_NAMES.openrouterKey, 'sk-or-new-value')
    expect(await getSecret(t.db, KEY, u.id, SECRET_NAMES.openrouterKey)).toBe('sk-or-new-value')
    expect(await getSecret(t.db, KEY, other.id, SECRET_NAMES.openrouterKey)).toBeUndefined()
    const raw = (await t.db.execute(
      sql`select ciphertext from user_secrets where user_id = ${u.id}`,
    )) as unknown as { rows: { ciphertext: string }[] }
    expect(raw.rows[0]!.ciphertext).not.toContain('sk-or')
    expect((await listSecretNames(t.db, u.id)).map((s) => s.name)).toEqual(['openrouter_api_key'])
    await deleteSecret(t.db, u.id, SECRET_NAMES.openrouterKey)
    expect(await getSecret(t.db, KEY, u.id, SECRET_NAMES.openrouterKey)).toBeUndefined()
  })
})
