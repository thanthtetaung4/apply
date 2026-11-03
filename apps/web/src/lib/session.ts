import 'server-only'
import { cache } from 'react'
import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { createSession, deleteSession, getSessionUser, type SessionUser } from '@apply/db'
import { db } from './db'

export const COOKIE = 'aa_session'

export const currentUser = cache(async (): Promise<SessionUser | null> => {
  const token = (await cookies()).get(COOKIE)?.value
  return token ? getSessionUser(db(), token) : null
})

export async function requireUser(): Promise<SessionUser> {
  const u = await currentUser()
  if (!u) redirect('/login')
  return u
}

export async function startSession(userId: string): Promise<void> {
  const h = await headers()
  const { token, expiresAt } = await createSession(db(), userId, { userAgent: h.get('user-agent') })
  ;(await cookies()).set(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production' && process.env.INSECURE_COOKIES !== '1',
    path: '/',
    expires: expiresAt,
  })
}

export async function endSession(): Promise<void> {
  const jar = await cookies()
  const token = jar.get(COOKIE)?.value
  if (token) await deleteSession(db(), token)
  jar.delete(COOKIE)
}

export async function clientIp(): Promise<string> {
  const h = await headers()
  return h.get('x-forwarded-for')?.split(',')[0]?.trim() || h.get('x-real-ip') || 'unknown'
}
