'use server'

import { redirect } from 'next/navigation'
import { AuthError, authenticate, registerUser, safeEqualStrings } from '@apply/db'
import { db } from '@/lib/db'
import { registration } from '@/lib/env'
import type { FormState } from '@/lib/state'
import { clientIp, endSession, startSession } from '@/lib/session'

const str = (fd: FormData, k: string) => String(fd.get(k) ?? '')

export async function registerAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const reg = registration()
  if (reg.mode === 'closed') return { error: 'Sign ups are closed.' }
  if (reg.mode === 'invite') {
    if (!reg.inviteCode || !safeEqualStrings(str(fd, 'invite'), reg.inviteCode))
      return { error: 'That invite code is not valid.' }
  }
  if (str(fd, 'password') !== str(fd, 'confirm')) return { error: 'The passwords do not match.' }
  try {
    const user = await registerUser(db(), {
      email: str(fd, 'email'),
      password: str(fd, 'password'),
      name: str(fd, 'name') || undefined,
    })
    await startSession(user.id)
  } catch (err) {
    if (err instanceof AuthError) return { error: err.message, issues: err.issues }
    throw err
  }
  redirect('/profile?welcome=1')
}

export async function loginAction(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const user = await authenticate(db(), {
      email: str(fd, 'email'),
      password: str(fd, 'password'),
      ip: await clientIp(),
    })
    await startSession(user.id)
  } catch (err) {
    if (err instanceof AuthError) return { error: err.message }
    throw err
  }
  redirect('/')
}

export async function logoutAction(): Promise<void> {
  await endSession()
  redirect('/login')
}
