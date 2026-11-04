'use server'

import { revalidatePath } from 'next/cache'
import {
  PROFILE_FILES,
  PROFILE_KINDS,
  validateProfileFile,
  type ProfileKind,
} from '@apply/core/profile'
import { deleteFiles, deleteFilesOfKind, saveProfileFile } from '@apply/db'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/session'
import type { FormState } from '@/lib/state'

const MAX_PROFILE_BYTES = 200_000

export async function deleteFilesAction(ids: string[]): Promise<FormState> {
  const user = await requireUser()
  if (!Array.isArray(ids) || ids.length === 0) return { error: 'Nothing selected.' }
  const n = await deleteFiles(db(), user.id, ids.slice(0, 500).map(String))
  revalidatePath('/files')
  return { ok: true, message: `Deleted ${n} file${n === 1 ? '' : 's'}.` }
}

/** Screenshots take most of the space and matter only while a job is fresh. */
export async function deleteOldScreenshotsAction(days: number): Promise<FormState> {
  const user = await requireUser()
  const d = Number.isFinite(days) && days >= 0 ? Math.min(days, 3650) : 30
  const n = await deleteFilesOfKind(
    db(),
    user.id,
    'screenshot',
    d === 0 ? undefined : new Date(Date.now() - d * 86_400_000),
  )
  revalidatePath('/files')
  return {
    ok: true,
    message:
      n === 0
        ? 'No screenshots to delete.'
        : `Deleted ${n} screenshot${n === 1 ? '' : 's'}${d ? ` older than ${d} days` : ''}.`,
  }
}

/** Replace one profile file with an uploaded .md file. Saved even with problems, like the editor. */
export async function importProfileFileAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const user = await requireUser()
  const kind = String(fd.get('kind') ?? '')
  if (!(PROFILE_KINDS as readonly string[]).includes(kind)) return { error: 'Choose which file.' }
  const file = fd.get('file')
  if (!(file instanceof File) || file.size === 0) return { error: 'Choose a file to upload.' }
  if (file.size > MAX_PROFILE_BYTES) return { error: 'That file is too large (200 KB at most).' }
  if (!/\.(md|markdown|txt)$/i.test(file.name))
    return { error: 'Upload a Markdown (.md) or text file.' }
  const text = (await file.text()).replace(/\r\n/g, '\n')
  const k = kind as ProfileKind
  const check = validateProfileFile(k, text)
  await saveProfileFile(db(), user.id, k, text)
  revalidatePath('/files')
  revalidatePath('/profile')
  return check.ok
    ? { ok: true, message: `${PROFILE_FILES[k]} replaced. ${check.summary.join(', ')}.` }
    : {
        error: `${PROFILE_FILES[k]} was saved, but it needs fixing before the app can run:`,
        issues: check.issues,
      }
}
