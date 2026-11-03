import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  AuthError,
  authenticate,
  createApiToken,
  createSession,
  deleteSession,
  deleteUserSessions,
  getSessionUser,
  hashPassword,
  listApiTokens,
  purgeExpiredSessions,
  registerUser,
  revokeApiToken,
  SESSION_TTL_MS,
  verifyApiToken,
  verifyPassword,
} from '../src/auth'
import { getProfileFiles, getSettings } from '../src/user-data'
import { authSessions, users } from '../src/schema'
import { createTestDb } from '../src/testing'

let t: Awaited<ReturnType<typeof createTestDb>>
beforeAll(async () => {
  t = await createTestDb()
})
afterAll(async () => t.close())

const reg = (email: string, password = 'correct horse battery') =>
  registerUser(t.db, { email, password })
const code = async (p: Promise<unknown>) =>
  (await p.then(
    () => null,
    (e) => e,
  )) as AuthError | null

describe('passwords', () => {
  it('hash with scrypt, verify, and never store the password', async () => {
    const h = await hashPassword('hunter2hunter2')
    expect(h).toMatch(/^scrypt\$16384\$8\$1\$/)
    expect(h).not.toContain('hunter2')
    expect(await verifyPassword('hunter2hunter2', h)).toBe(true)
    expect(await verifyPassword('hunter2hunter3', h)).toBe(false)
    expect(await verifyPassword('x', 'garbage')).toBe(false)
    expect(await hashPassword('hunter2hunter2')).not.toBe(h) // random salt
  })
})

describe('registration', () => {
  it('creates the user with starter profile files and default settings', async () => {
    const u = await reg('New@Example.com')
    expect(u.email).toBe('new@example.com')
    const files = await getProfileFiles(t.db, u.id)
    expect(files.resume.content).toContain('Your Name')
    expect(files.answers.revision).toBe(1)
    expect((await getSettings(t.db, u.id)).gate.enforce).toBe(true)
  })

  it('rejects duplicates in any letter case, weak passwords and bad emails', async () => {
    await reg('dupe@example.com')
    expect((await code(reg('DUPE@example.com')))?.code).toBe('email_taken')
    const weak = await code(reg('weak@example.com', 'short'))
    expect(weak?.code).toBe('invalid_input')
    expect(weak?.issues.join()).toMatch(/at least 10/)
    expect((await code(reg('not-an-email')))?.issues.join()).toMatch(/valid email/)
    expect((await code(reg('same@example.com', 'same@example.com')))?.issues.join()).toMatch(
      /cannot be your email/,
    )
  })
})

describe('login and throttling', () => {
  it('accepts the right password, ignoring email case and spaces', async () => {
    await reg('login@example.com')
    const u = await authenticate(t.db, {
      email: ' LOGIN@example.com ',
      password: 'correct horse battery',
      ip: '1.1.1.1',
    })
    expect(u.email).toBe('login@example.com')
  })

  it('gives the same error for a wrong password and an unknown email', async () => {
    await reg('known@example.com')
    const a = await code(
      authenticate(t.db, {
        email: 'known@example.com',
        password: 'wrong password!!',
        ip: '2.2.2.2',
      }),
    )
    const b = await code(
      authenticate(t.db, {
        email: 'nobody@example.com',
        password: 'wrong password!!',
        ip: '2.2.2.3',
      }),
    )
    expect(a?.code).toBe('invalid_credentials')
    expect(b?.code).toBe('invalid_credentials')
    expect(a?.message).toBe(b?.message)
  })

  it('locks an email for 15 minutes after 5 failures, even with the right password', async () => {
    await reg('lock@example.com')
    const now = new Date('2026-11-03T10:00:00Z')
    for (let i = 0; i < 5; i++) {
      await code(
        authenticate(
          t.db,
          { email: 'lock@example.com', password: 'nope nope nope', ip: `9.9.9.${i}` },
          now,
        ),
      )
    }
    const e = await code(
      authenticate(
        t.db,
        { email: 'lock@example.com', password: 'correct horse battery', ip: '9.9.9.99' },
        new Date(now.getTime() + 60_000),
      ),
    )
    expect(e?.code).toBe('locked')
    expect(e?.retryAt?.getTime()).toBe(now.getTime() + 15 * 60_000)
    const later = await authenticate(
      t.db,
      { email: 'lock@example.com', password: 'correct horse battery', ip: '9.9.9.99' },
      new Date(now.getTime() + 16 * 60_000),
    )
    expect(later.email).toBe('lock@example.com')
  })

  it('a success clears earlier failures', async () => {
    await reg('clear@example.com')
    for (let i = 0; i < 4; i++)
      await code(
        authenticate(t.db, {
          email: 'clear@example.com',
          password: 'nope nope nope',
          ip: '7.7.7.7',
        }),
      )
    await authenticate(t.db, {
      email: 'clear@example.com',
      password: 'correct horse battery',
      ip: '7.7.7.8',
    })
    for (let i = 0; i < 4; i++)
      await code(
        authenticate(t.db, {
          email: 'clear@example.com',
          password: 'nope nope nope',
          ip: '7.7.7.9',
        }),
      )
    const ok = await authenticate(t.db, {
      email: 'clear@example.com',
      password: 'correct horse battery',
      ip: '7.7.7.10',
    })
    expect(ok.email).toBe('clear@example.com')
  })

  it('refuses disabled accounts', async () => {
    const u = await reg('off@example.com')
    await t.db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, u.id))
    expect(
      (
        await code(
          authenticate(t.db, { email: 'off@example.com', password: 'correct horse battery' }),
        )
      )?.code,
    ).toBe('disabled')
  })
})

describe('sessions', () => {
  it('stores only a hash of the cookie, and finds the user by the cookie', async () => {
    const u = await reg('sess@example.com')
    const { token } = await createSession(t.db, u.id, { userAgent: 'test' })
    const rows = await t.db.select().from(authSessions).where(eq(authSessions.userId, u.id))
    expect(rows[0]!.tokenHash).not.toBe(token)
    expect(JSON.stringify(rows)).not.toContain(token)
    expect((await getSessionUser(t.db, token))?.id).toBe(u.id)
    expect(await getSessionUser(t.db, 'x'.repeat(43))).toBeNull()
    expect(await getSessionUser(t.db, '')).toBeNull()
  })

  it('expires, slides, and can be deleted', async () => {
    const u = await reg('slide@example.com')
    const t0 = new Date('2026-11-03T00:00:00Z')
    const { token } = await createSession(t.db, u.id, { now: t0 })
    expect(
      await getSessionUser(t.db, token, new Date(t0.getTime() + SESSION_TTL_MS + 1000)),
    ).toBeNull()
    // Using it after an hour pushes the expiry out again.
    const day10 = new Date(t0.getTime() + 10 * 86_400_000)
    expect(await getSessionUser(t.db, token, day10)).not.toBeNull()
    expect(
      await getSessionUser(t.db, token, new Date(t0.getTime() + SESSION_TTL_MS + 86_400_000)),
    ).not.toBeNull()
    await deleteSession(t.db, token)
    expect(await getSessionUser(t.db, token, day10)).toBeNull()
  })

  it('ends all sessions of a user, and for a disabled user', async () => {
    const u = await reg('many@example.com')
    const a = await createSession(t.db, u.id)
    const b = await createSession(t.db, u.id)
    await deleteUserSessions(t.db, u.id)
    expect(await getSessionUser(t.db, a.token)).toBeNull()
    expect(await getSessionUser(t.db, b.token)).toBeNull()
    const c = await createSession(t.db, u.id)
    await t.db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, u.id))
    expect(await getSessionUser(t.db, c.token)).toBeNull()
    await purgeExpiredSessions(t.db, new Date(Date.now() + 2 * SESSION_TTL_MS))
    expect(
      await t.db.select().from(authSessions).where(eq(authSessions.userId, u.id)),
    ).toHaveLength(0)
  })
})

describe('api tokens', () => {
  it('shows the token once, stores a hash, verifies and revokes', async () => {
    const u = await reg('tok@example.com')
    const { id, token } = await createApiToken(t.db, u.id, '  my laptop ')
    expect(token).toMatch(/^aat_/)
    const list = await listApiTokens(t.db, u.id)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ name: 'my laptop', prefix: token.slice(0, 10) })
    expect(JSON.stringify(list)).not.toContain(token)
    expect(await verifyApiToken(t.db, token)).toEqual({ userId: u.id })
    expect(await verifyApiToken(t.db, 'aat_nope')).toBeNull()
    expect(await verifyApiToken(t.db, 'plain')).toBeNull()
    const other = await reg('tok-other@example.com')
    await revokeApiToken(t.db, other.id, id) // wrong owner does nothing
    expect(await verifyApiToken(t.db, token)).not.toBeNull()
    await revokeApiToken(t.db, u.id, id)
    expect(await verifyApiToken(t.db, token)).toBeNull()
    expect(await listApiTokens(t.db, u.id)).toHaveLength(0)
  })

  it('needs a name', async () => {
    const u = await reg('tok2@example.com')
    expect((await code(createApiToken(t.db, u.id, '  ')))?.code).toBe('invalid_input')
  })
})
