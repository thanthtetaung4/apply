import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { startMockServer, type MockServer } from '@apply/core/demo'
import {
  createLoginTicket,
  generateKey,
  generateSealKeyPair,
  registerUser,
  userStores,
  type Db,
} from '@apply/db'
import { createTestDb } from '@apply/db/testing'
import { loadEnv, type WorkerEnv } from '../src/env'
import { startLoginServer, type LoginServer } from '../src/login-server'

const ORIGIN = 'http://localhost:3000'

let t: Awaited<ReturnType<typeof createTestDb>>
let db: Db
let mock: MockServer
let env: WorkerEnv
let server: LoginServer
let userId: string

beforeAll(async () => {
  t = await createTestDb()
  db = t.db
  mock = await startMockServer()
  env = loadEnv({
    DATABASE_URL: 'test',
    APP_ENCRYPTION_KEY: generateKey(),
    WORKER_SESSION_PRIVATE_KEY: generateSealKeyPair().privateKey,
    WORK_DIR: mkdtempSync(join(tmpdir(), 'aa-login-')),
    LOGIN_PORT: '0',
    LOGIN_ALLOWED_ORIGINS: ORIGIN,
    LOGIN_EXTRA_HOSTS: new URL(mock.url).hostname,
    LOGIN_MAX_SESSIONS: '2',
  })
  server = await startLoginServer(db, env)
  userId = (
    await registerUser(db, { email: 'signin@example.com', password: 'correct horse battery' })
  ).id
}, 60_000)

afterAll(async () => {
  await server?.close()
  await mock?.close()
  await t?.close()
})

const ticket = (over: Partial<{ site: string; key: string; url: string; userId: string }> = {}) =>
  createLoginTicket(env.encryptionKey, {
    userId,
    site: 'workday',
    key: 'workday-meridian',
    url: `${mock.url}/wd/meridian/job/301`,
    ...over,
  })

/** Open a window and collect what the server sends. */
function connect(tok: string, origin = ORIGIN) {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/signin?t=${encodeURIComponent(tok)}`, {
    origin,
  })
  const messages: Record<string, unknown>[] = []
  let frames = 0
  const waiters: {
    pred: (m: Record<string, unknown>) => boolean
    resolve: (m: Record<string, unknown>) => void
  }[] = []
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      frames++
      return
    }
    const m = JSON.parse(data.toString()) as Record<string, unknown>
    messages.push(m)
    for (const w of [...waiters]) if (w.pred(m)) w.resolve(m)
  })
  const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)))
  const waitFor = (t: string, ms = 30_000) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const hit = messages.find((m) => m.t === t)
      if (hit) return resolve(hit)
      const timer = setTimeout(
        () => reject(new Error(`no "${t}" message; got ${JSON.stringify(messages)}`)),
        ms,
      )
      waiters.push({
        pred: (m) => m.t === t,
        resolve: (m) => {
          clearTimeout(timer)
          resolve(m)
        },
      })
    })
  const send = (m: Record<string, unknown>) => ws.send(JSON.stringify(m))
  return { ws, messages, frames: () => frames, waitFor, send, closed }
}

describe('sign in windows', () => {
  it('stream the page, replay typing, and save a sealed session the worker can use', async () => {
    const c = connect(ticket())
    expect(await c.waitFor('ready')).toMatchObject({ site: 'workday', width: 1280, height: 800 })
    await expect.poll(() => c.frames(), { timeout: 45_000 }).toBeGreaterThan(0)
    // Like a person, start once the page has settled; under load the first frame can arrive
    // before the page takes keyboard input.
    await new Promise((r) => setTimeout(r, 2000))

    // Pressing the button before signing in keeps the window open with a hint.
    c.send({ t: 'done' })
    expect(await c.waitFor('error')).toMatchObject({ keepOpen: true })

    // Sign in with the keyboard, as a user would: Tab to the email field, type, Tab, type, Enter.
    const urlsBefore = c.messages.filter((m) => m.t === 'url').length
    c.send({ t: 'key', key: 'Tab' })
    for (const ch of 'alex@example.com') c.send({ t: 'key', key: ch })
    c.send({ t: 'key', key: 'Tab' })
    c.send({ t: 'text', text: 'pw' })
    c.send({ t: 'key', key: 'Enter' })
    await expect
      // The form posts, the site sets its cookie and sends the browser back to the job page.
      .poll(() => c.messages.filter((m) => m.t === 'url').length, { timeout: 45_000 })
      .toBeGreaterThan(urlsBefore)

    c.send({ t: 'done' })
    expect(await c.waitFor('saved')).toMatchObject({ key: 'workday-meridian' })
    expect(await c.closed).toBe(1000)

    const stores = userStores(db, userId, env.encryptionKey, env.sessionKeys)
    expect((await stores.sessions.list())[0]).toMatchObject({
      key: 'workday-meridian',
      status: 'connected',
    })
    const saved = await stores.sessions.get('workday-meridian')
    expect(saved!.cookies.some((k) => k.name === 'wd_sid' && k.value === 'meridian')).toBe(true)
    // The web app (public key only) cannot read it back.
    await expect(
      userStores(db, userId, env.encryptionKey, { seal: env.sessionKeys.seal }).sessions.get(
        'workday-meridian',
      ),
    ).rejects.toThrow(/Only the worker/)
    await expect.poll(() => server.active()).toBe(0)
  }, 90_000)

  it('refuse other origins, used tickets and forged tickets', async () => {
    const other = connect(ticket(), 'https://evil.example')
    await new Promise<void>((r) => other.ws.on('error', () => r()))

    const tok = ticket()
    const first = connect(tok)
    await first.waitFor('ready')
    const again = connect(tok)
    expect(await again.waitFor('error')).toMatchObject({
      message: expect.stringMatching(/already used/),
    })
    first.send({ t: 'cancel' })
    await first.closed

    // Change a byte in the middle of the signature (the last base64 character can be padding).
    const [body, sig] = tok.split('.')
    const mid = Math.floor(sig!.length / 2)
    const flipped = sig!.slice(0, mid) + (sig![mid] === 'A' ? 'B' : 'A') + sig!.slice(mid + 1)
    const forged = connect(`${body}.${flipped}`)
    expect(await forged.waitFor('error')).toMatchObject({
      message: expect.stringMatching(/expired/),
    })
  }, 60_000)

  it('will not open a site outside the allowed hosts', async () => {
    const c = connect(ticket({ site: 'linkedin', key: 'linkedin', url: 'https://example.com/' }))
    expect(await c.waitFor('error')).toMatchObject({
      message: expect.stringMatching(/Could not open/),
    })
  }, 60_000)
})
