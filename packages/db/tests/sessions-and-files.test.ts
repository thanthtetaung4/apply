import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { deleteFiles, deleteFilesOfKind, fileUsage, listFiles } from '../src/files'
import { PgJobStore } from '../src/job-store'
import { browserSessions } from '../src/schema'
import { generateSealKeyPair, parsePrivateKeys, parsePublicKey } from '../src/sealed'
import { PgArtifactStore, PgSessionStore } from '../src/stores'
import { createTestDb } from '../src/testing'
import { job, KEY, newUser } from './helpers'

let t: Awaited<ReturnType<typeof createTestDb>>
beforeAll(async () => {
  t = await createTestDb()
})
afterAll(async () => t.close())

const pair = generateSealKeyPair()
const pub = parsePublicKey(pair.publicKey)
const priv = parsePrivateKeys(pair.privateKey)
const state = {
  cookies: [{ name: 'li_at', value: 'secret-cookie', domain: '.linkedin.com' }],
  origins: [],
}

describe('sealed session store', () => {
  it('lets the web app write but not read, and the worker read', async () => {
    const u = await newUser(t.db)
    const web = new PgSessionStore(t.db, u.id, KEY, { seal: pub })
    const worker = new PgSessionStore(t.db, u.id, KEY, { seal: pub, open: priv })
    await web.put('linkedin', state)

    const [raw] = await t.db.select().from(browserSessions).where(eq(browserSessions.userId, u.id))
    expect(raw!.ciphertext.startsWith('v2.')).toBe(true)
    expect(raw!.ciphertext).not.toContain('secret-cookie')

    await expect(web.get('linkedin')).rejects.toThrow(/Only the worker/)
    // The shared app key alone does not open it either.
    await expect(new PgSessionStore(t.db, u.id, KEY).get('linkedin')).rejects.toThrow(
      /Only the worker/,
    )
    expect(await worker.get('linkedin')).toEqual(state)
  })

  it('reads a legacy v1 value and re-seals it on the next save', async () => {
    const u = await newUser(t.db)
    await new PgSessionStore(t.db, u.id, KEY).put('indeed', state) // v1, app key
    const worker = new PgSessionStore(t.db, u.id, KEY, { seal: pub, open: priv })
    const read = await worker.get('indeed')
    expect(read).toEqual(state)
    await worker.put('indeed', read!)
    const [raw] = await t.db.select().from(browserSessions).where(eq(browserSessions.userId, u.id))
    expect(raw!.ciphertext.startsWith('v2.')).toBe(true)
  })

  it('tracks expiry: marked once, cleared by the next save', async () => {
    const u = await newUser(t.db)
    const s = new PgSessionStore(t.db, u.id, KEY, { seal: pub, open: priv })
    await s.put('glassdoor', state)
    expect((await s.list())[0]).toMatchObject({ key: 'glassdoor', status: 'connected' })
    await s.markExpired('glassdoor')
    const expired = (await s.list())[0]!
    expect(expired.status).toBe('expired')
    await s.markExpired('glassdoor') // a second hit keeps the first time
    expect((await s.list())[0]!.statusAt).toEqual(expired.statusAt)
    await s.markExpired('linkedin') // never saved: nothing happens
    expect(await s.list()).toHaveLength(1)
    await s.put('glassdoor', state)
    expect((await s.list())[0]!.status).toBe('connected')
  })
})

describe('files', () => {
  async function seed() {
    const u = await newUser(t.db)
    const jobs = new PgJobStore(t.db, u.id)
    await jobs.addJob(job('j1', { company: 'Acme', title: 'AI Engineer' }))
    await jobs.addJob(job('j2', { company: 'Globex', title: 'Backend Developer' }))
    const a = new PgArtifactStore(t.db, u.id)
    const file = (jobId: string, kind: 'resume_pdf' | 'screenshot', name: string, size = 10) =>
      a.put({ jobId, kind, name, contentType: 'image/png', data: Buffer.alloc(size) })
    const ids = {
      r1: await file('j1', 'resume_pdf', 'resume.pdf', 100),
      s1: await file('j1', 'screenshot', 'step-1.png'),
      s2: await file('j2', 'screenshot', 'step-1.png'),
    }
    return { u, ids }
  }

  it('lists with the job, filters by kind and text, and pages', async () => {
    const { u } = await seed()
    const all = await listFiles(t.db, u.id)
    expect(all.total).toBe(3)
    expect(all.rows[0]).toHaveProperty('company')
    expect((await listFiles(t.db, u.id, { kind: 'screenshot' })).total).toBe(2)
    const acme = await listFiles(t.db, u.id, { q: 'acme' })
    expect(acme.rows.map((r) => r.company)).toEqual(['Acme', 'Acme'])
    expect((await listFiles(t.db, u.id, { q: '100%' })).total).toBe(0) // % is literal
    const page = await listFiles(t.db, u.id, { limit: 2, offset: 2 })
    expect(page).toMatchObject({ total: 3 })
    expect(page.rows).toHaveLength(1)
  })

  it('reports usage and deletes only the owner files', async () => {
    const { u, ids } = await seed()
    const other = await seed()
    expect(await fileUsage(t.db, u.id)).toEqual(
      expect.arrayContaining([
        { kind: 'resume_pdf', count: 1, bytes: 100 },
        { kind: 'screenshot', count: 2, bytes: 20 },
      ]),
    )
    expect(await deleteFiles(t.db, u.id, [ids.s1, other.ids.s1, 'not-an-id'])).toBe(1)
    expect((await listFiles(t.db, other.u.id)).total).toBe(3)
    expect(await deleteFilesOfKind(t.db, u.id, 'screenshot', new Date(Date.now() - 60_000))).toBe(0)
    expect(await deleteFilesOfKind(t.db, u.id, 'screenshot')).toBe(1)
    expect((await listFiles(t.db, u.id)).total).toBe(1)
    await expect(deleteFilesOfKind(t.db, u.id, 'passwords' as never)).rejects.toThrow(/Unknown/)
  })
})
