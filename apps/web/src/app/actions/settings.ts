'use server'

import { revalidatePath } from 'next/cache'
import { getSettings, saveSettings } from '@apply/db'
import { db } from '@/lib/db'
import { formToSettings } from '@/lib/settings-form'
import { requireUser } from '@/lib/session'
import type { FormState } from '@/lib/state'

export async function saveSettingsAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const user = await requireUser()
  const current = await getSettings(db(), user.id)
  const r = formToSettings(fd, current)
  if (!r.ok) return { error: 'Some settings are not valid.', issues: r.issues }
  await saveSettings(db(), user.id, r.settings)
  revalidatePath('/settings')
  return { ok: true, message: 'Settings saved.' }
}
