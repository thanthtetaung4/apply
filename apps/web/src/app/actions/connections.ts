'use server'

import { revalidatePath } from 'next/cache'
import { isSignInSite, SIGN_IN_LABEL, signInTarget } from '@apply/core/signin'
import {
  AuthError,
  createApiToken,
  createLoginTicket,
  getSettings,
  deleteSecret,
  revokeApiToken,
  SECRET_NAMES,
  setSecret,
  type SecretName,
} from '@apply/db'
import { db, stores } from '@/lib/db'
import { encryptionKey, workerSignInUrl } from '@/lib/env'
import { requireUser } from '@/lib/session'
import type { FormState } from '@/lib/state'

export async function saveModelKeyAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const user = await requireUser()
  const key = String(fd.get('apiKey') ?? '').trim()
  if (key.length < 12) return { error: 'That does not look like an API key.' }
  await setSecret(db(), encryptionKey(), user.id, SECRET_NAMES.openrouterKey, key)
  revalidatePath('/connections')
  return { ok: true, message: 'Model key saved. It is stored encrypted and never shown again.' }
}

export async function saveBoardAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const user = await requireUser()
  const url = String(fd.get('url') ?? '').trim()
  const token = String(fd.get('token') ?? '').trim()
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { error: 'Enter the full board URL, for example https://board.example.com/mcp.' }
  }
  if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost')
    return { error: 'The board URL must use https.' }
  await setSecret(db(), encryptionKey(), user.id, SECRET_NAMES.boardUrl, parsed.toString())
  if (token) await setSecret(db(), encryptionKey(), user.id, SECRET_NAMES.boardToken, token)
  revalidatePath('/connections')
  return { ok: true, message: 'Board saved. Updates are sent after each application.' }
}

export async function removeSecretAction(names: SecretName[]): Promise<void> {
  const user = await requireUser()
  for (const n of names) {
    if (Object.values(SECRET_NAMES).includes(n)) await deleteSecret(db(), user.id, n)
  }
  revalidatePath('/connections')
}

export async function createTokenAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const user = await requireUser()
  try {
    const { token } = await createApiToken(db(), user.id, String(fd.get('name') ?? ''))
    revalidatePath('/connections')
    return { ok: true, secret: token, message: 'Copy this token now. It is shown only once.' }
  } catch (err) {
    if (err instanceof AuthError) return { error: err.message }
    throw err
  }
}

export async function revokeTokenAction(id: string): Promise<void> {
  const user = await requireUser()
  await revokeApiToken(db(), user.id, id)
  revalidatePath('/connections')
}

export async function removeSessionAction(key: string): Promise<void> {
  const user = await requireUser()
  await stores(user.id).sessions.remove(key)
  revalidatePath('/connections')
}

export type StartSignInResult =
  | { ok: true; wsUrl: string; ticket: string; key: string; label: string }
  | { ok: false; error: string }

/**
 * Permission to open one sign in window for the signed in user. The ticket names the user, the
 * site and the first page, lasts two minutes and works once. The window itself runs on the worker.
 */
export async function startSignInAction(
  site: string,
  workdayUrl?: string,
): Promise<StartSignInResult> {
  const user = await requireUser()
  if (!isSignInSite(site)) return { ok: false, error: 'Unknown site.' }
  const target = signInTarget(site, await getSettings(db(), user.id), workdayUrl)
  if ('error' in target) return { ok: false, error: target.error }
  const ticket = createLoginTicket(encryptionKey(), {
    userId: user.id,
    site: target.site,
    key: target.key,
    url: target.url,
  })
  return { ok: true, wsUrl: workerSignInUrl(), ticket, key: target.key, label: SIGN_IN_LABEL[site] }
}

/** Called by the sign in window after a save, so the page shows the new status. */
export async function refreshConnectionsAction(): Promise<void> {
  await requireUser()
  revalidatePath('/connections')
  revalidatePath('/')
}
