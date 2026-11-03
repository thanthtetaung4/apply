'use server'

import { revalidatePath } from 'next/cache'
import {
  AuthError,
  createApiToken,
  deleteSecret,
  revokeApiToken,
  SECRET_NAMES,
  setSecret,
  type SecretName,
} from '@apply/db'
import { db, stores } from '@/lib/db'
import { encryptionKey } from '@/lib/env'
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
