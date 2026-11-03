'use server'

import { revalidatePath } from 'next/cache'
import {
  PROFILE_KINDS,
  validateProfileFile,
  type FileValidation,
  type ProfileKind,
} from '@apply/core/profile'
import { ConflictError, saveProfileFile } from '@apply/db'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/session'

const isKind = (k: string): k is ProfileKind => (PROFILE_KINDS as readonly string[]).includes(k)

/** Check a file while the user types. Saves nothing. */
export async function validateFileAction(kind: string, text: string): Promise<FileValidation> {
  await requireUser()
  if (!isKind(kind)) return { ok: false, issues: ['Unknown file.'], summary: [] }
  return validateProfileFile(kind, text.slice(0, 200_000))
}

export interface SaveResult extends FileValidation {
  saved: boolean
  revision?: number
  error?: string
}

export async function saveFileAction(
  kind: string,
  text: string,
  revision: number,
): Promise<SaveResult> {
  const user = await requireUser()
  if (!isKind(kind))
    return { saved: false, ok: false, issues: [], summary: [], error: 'Unknown file.' }
  const check = validateProfileFile(kind, text)
  try {
    // Drafts with problems are saved too, so nothing is lost. Runs are blocked until the profile parses.
    const r = await saveProfileFile(db(), user.id, kind, text, revision)
    revalidatePath('/profile')
    return { ...check, saved: true, revision: r.revision }
  } catch (err) {
    if (err instanceof ConflictError) return { ...check, saved: false, error: err.message }
    return { ...check, saved: false, error: (err as Error).message }
  }
}
