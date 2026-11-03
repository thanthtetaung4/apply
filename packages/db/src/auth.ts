import { randomBytes, scrypt as scryptCb } from 'node:crypto'
import { promisify } from 'node:util'
import { PROFILE_TEMPLATES } from '@apply/core/profile'
import { defaultSettings } from '@apply/core/settings'
import { and, eq, gt, isNull, lt, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { Db } from './client'
import { safeEqual, sha256 } from './crypto'
import { apiTokens, authSessions, authThrottle, profileFiles, userSettings, users } from './schema'

const scrypt = promisify(scryptCb) as (
  pw: string,
  salt: Buffer,
  len: number,
  opts: object,
) => Promise<Buffer>

export type AuthErrorCode =
  'invalid_input' | 'email_taken' | 'invalid_credentials' | 'locked' | 'disabled'

export class AuthError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    message: string,
    readonly issues: string[] = [],
    readonly retryAt?: Date,
  ) {
    super(message)
    this.name = 'AuthError'
  }
}

// --- passwords ---------------------------------------------------------------------------------

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const hash = await scrypt(password, salt, 64, SCRYPT)
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${hash.toString('base64url')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split('$')
  if (alg !== 'scrypt' || !n || !r || !p || !salt || !hash) return false
  const want = Buffer.from(hash, 'base64url')
  const got = await scrypt(password, Buffer.from(salt, 'base64url'), want.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  })
  return safeEqual(got.toString('base64url'), hash)
}

// A hash to compare against when the email is unknown, so timing does not reveal which emails exist.
const DUMMY_HASH = hashPassword('not-a-real-password-for-timing')

// --- registration ------------------------------------------------------------------------------

export const RegisterSchema = z.object({
  email: z.string().trim().toLowerCase().max(254).pipe(z.email('Enter a valid email address.')),
  password: z
    .string()
    .min(10, 'Use at least 10 characters.')
    .max(200, 'Use at most 200 characters.'),
  name: z.string().trim().max(100).optional(),
})

export interface SessionUser {
  id: string
  email: string
  name: string | null
}

/** Create an account with the starter profile files and default settings. */
export async function registerUser(
  db: Db,
  input: { email: string; password: string; name?: string },
): Promise<SessionUser> {
  const parsed = RegisterSchema.safeParse(input)
  if (!parsed.success) {
    throw new AuthError(
      'invalid_input',
      'Check the form.',
      parsed.error.issues.map((i) => i.message),
    )
  }
  const { email, password, name } = parsed.data
  if (password.toLowerCase() === email) {
    throw new AuthError('invalid_input', 'Check the form.', [
      'The password cannot be your email address.',
    ])
  }
  const passwordHash = await hashPassword(password)
  return db.transaction(async (tx) => {
    const [u] = await tx
      .insert(users)
      .values({ email, name: name || null, passwordHash })
      .onConflictDoNothing()
      .returning({ id: users.id, email: users.email, name: users.name })
    if (!u) throw new AuthError('email_taken', 'That email is already registered.')
    await tx.insert(profileFiles).values(
      (Object.keys(PROFILE_TEMPLATES) as (keyof typeof PROFILE_TEMPLATES)[]).map((kind) => ({
        userId: u.id,
        kind,
        content: PROFILE_TEMPLATES[kind],
      })),
    )
    await tx.insert(userSettings).values({ userId: u.id, settings: defaultSettings() })
    return u
  })
}

// --- login with throttling ---------------------------------------------------------------------

const WINDOW_MS = 15 * 60_000
const LIMITS = { email: 5, ip: 25 }

async function lockedUntil(db: Db, keys: string[], now: Date): Promise<Date | undefined> {
  for (const key of keys) {
    const [r] = await db.select().from(authThrottle).where(eq(authThrottle.key, key))
    if (r?.lockedUntil && r.lockedUntil > now) return r.lockedUntil
  }
  return undefined
}

async function recordFailure(db: Db, key: string, limit: number, now: Date): Promise<void> {
  const [r] = await db.select().from(authThrottle).where(eq(authThrottle.key, key))
  const fresh = !r || now.getTime() - r.windowStart.getTime() > WINDOW_MS
  const failures = fresh ? 1 : r.failures + 1
  const values = {
    key,
    failures,
    windowStart: fresh ? now : r.windowStart,
    lockedUntil: failures >= limit ? new Date(now.getTime() + WINDOW_MS) : null,
  }
  await db
    .insert(authThrottle)
    .values(values)
    .onConflictDoUpdate({ target: authThrottle.key, set: values })
}

/**
 * Check an email and password. After 5 failures for one email, or 25 from one address, further
 * attempts are refused for 15 minutes. Unknown emails and wrong passwords look the same.
 */
export async function authenticate(
  db: Db,
  input: { email: string; password: string; ip?: string },
  now: Date = new Date(),
): Promise<SessionUser> {
  const email = input.email.trim().toLowerCase()
  const emailKey = `email:${email}`
  const ipKey = `ip:${input.ip ?? 'unknown'}`

  const until = await lockedUntil(db, [emailKey, ipKey], now)
  if (until) {
    throw new AuthError('locked', 'Too many attempts. Try again in a few minutes.', [], until)
  }

  const [u] = await db.select().from(users).where(eq(users.email, email))
  const ok = await verifyPassword(input.password, u?.passwordHash ?? (await DUMMY_HASH))
  if (!u || !ok) {
    await recordFailure(db, emailKey, LIMITS.email, now)
    await recordFailure(db, ipKey, LIMITS.ip, now)
    throw new AuthError('invalid_credentials', 'Wrong email or password.')
  }
  if (u.disabledAt) throw new AuthError('disabled', 'This account is disabled.')
  await db.delete(authThrottle).where(eq(authThrottle.key, emailKey))
  return { id: u.id, email: u.email, name: u.name }
}

// --- browser sessions (cookies) ----------------------------------------------------------------

export const SESSION_TTL_MS = 30 * 86_400_000
const SLIDE_AFTER_MS = 3_600_000

export async function createSession(
  db: Db,
  userId: string,
  options: { userAgent?: string | null; now?: Date } = {},
): Promise<{ token: string; expiresAt: Date }> {
  const now = options.now ?? new Date()
  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS)
  await db.insert(authSessions).values({
    userId,
    tokenHash: sha256(token),
    userAgent: options.userAgent?.slice(0, 300) ?? null,
    createdAt: now,
    lastSeenAt: now,
    expiresAt,
  })
  return { token, expiresAt }
}

export async function getSessionUser(
  db: Db,
  token: string,
  now: Date = new Date(),
): Promise<SessionUser | null> {
  if (!token || token.length < 20) return null
  const [row] = await db
    .select({
      sessionId: authSessions.id,
      lastSeenAt: authSessions.lastSeenAt,
      id: users.id,
      email: users.email,
      name: users.name,
      disabledAt: users.disabledAt,
    })
    .from(authSessions)
    .innerJoin(users, eq(users.id, authSessions.userId))
    .where(and(eq(authSessions.tokenHash, sha256(token)), gt(authSessions.expiresAt, now)))
  if (!row || row.disabledAt) return null
  if (now.getTime() - row.lastSeenAt.getTime() > SLIDE_AFTER_MS) {
    await db
      .update(authSessions)
      .set({ lastSeenAt: now, expiresAt: new Date(now.getTime() + SESSION_TTL_MS) })
      .where(eq(authSessions.id, row.sessionId))
  }
  return { id: row.id, email: row.email, name: row.name }
}

export async function deleteSession(db: Db, token: string): Promise<void> {
  await db.delete(authSessions).where(eq(authSessions.tokenHash, sha256(token)))
}

export async function deleteUserSessions(db: Db, userId: string): Promise<void> {
  await db.delete(authSessions).where(eq(authSessions.userId, userId))
}

/** Remove expired sessions. Safe to run from the worker on a timer. */
export async function purgeExpiredSessions(db: Db, now: Date = new Date()): Promise<void> {
  await db.delete(authSessions).where(lt(authSessions.expiresAt, now))
}

// --- API tokens (for the local sign in uploader) -----------------------------------------------

export async function createApiToken(
  db: Db,
  userId: string,
  name: string,
): Promise<{ id: string; token: string }> {
  const label = name.trim().slice(0, 60)
  if (!label) throw new AuthError('invalid_input', 'Give the token a name.')
  const token = `aat_${randomBytes(32).toString('base64url')}`
  const [r] = await db
    .insert(apiTokens)
    .values({ userId, name: label, prefix: token.slice(0, 10), tokenHash: sha256(token) })
    .returning({ id: apiTokens.id })
  return { id: r!.id, token }
}

export async function verifyApiToken(
  db: Db,
  token: string,
  now: Date = new Date(),
): Promise<{ userId: string } | null> {
  if (!token.startsWith('aat_')) return null
  const [r] = await db
    .select({
      id: apiTokens.id,
      userId: apiTokens.userId,
      lastUsedAt: apiTokens.lastUsedAt,
      disabledAt: users.disabledAt,
    })
    .from(apiTokens)
    .innerJoin(users, eq(users.id, apiTokens.userId))
    .where(and(eq(apiTokens.tokenHash, sha256(token)), isNull(apiTokens.revokedAt)))
  if (!r || r.disabledAt) return null
  if (!r.lastUsedAt || now.getTime() - r.lastUsedAt.getTime() > 60_000) {
    await db.update(apiTokens).set({ lastUsedAt: now }).where(eq(apiTokens.id, r.id))
  }
  return { userId: r.userId }
}

export async function listApiTokens(db: Db, userId: string) {
  return db
    .select({
      id: apiTokens.id,
      name: apiTokens.name,
      prefix: apiTokens.prefix,
      createdAt: apiTokens.createdAt,
      lastUsedAt: apiTokens.lastUsedAt,
    })
    .from(apiTokens)
    .where(and(eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)))
    .orderBy(apiTokens.createdAt)
}

export async function revokeApiToken(db: Db, userId: string, id: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return
  await db
    .update(apiTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiTokens.userId, userId), eq(apiTokens.id, id)))
}

export { or, sql }
