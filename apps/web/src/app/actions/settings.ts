'use server'

import { revalidatePath } from 'next/cache'
import { defaultSettings } from '@apply/core/settings'
import { getSettings, saveSettings } from '@apply/db'
import { db } from '@/lib/db'
import { platformAi } from '@/lib/env'
import { formToSettings, settingLabel } from '@/lib/settings-form'
import { requireUser } from '@/lib/session'
import type { FormState } from '@/lib/state'

export async function saveSettingsAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const user = await requireUser()
  const current = await getSettings(db(), user.id)
  const r = formToSettings(fd, current)
  if (!r.ok) return { error: 'Some settings are not valid.', issues: r.issues.map(settingLabel) }
  const llm = r.settings.llm
  if (llm.mode === 'openrouter' && Object.values(llm.models).some((m) => /^TBD-/i.test(m)))
    return { error: 'Enter OpenRouter model names for all three models, or choose another AI.' }
  if (llm.mode === 'custom' && !llm.custom.model.trim())
    return { error: 'Enter the model name your server uses, for example qwen3:8b.' }
  if (llm.mode === 'hosted' && !platformAi().enabled)
    return { error: 'App AI is not available on this server. Choose another AI option.' }
  await saveSettings(db(), user.id, r.settings)
  revalidatePath('/settings')
  return { ok: true, message: 'Settings saved.' }
}

/** Back to the defaults, keeping the job board addresses (they are country specific). */
export async function resetSettingsAction(): Promise<FormState> {
  const user = await requireUser()
  const current = await getSettings(db(), user.id)
  const next = defaultSettings()
  for (const src of ['indeed', 'linkedin', 'glassdoor'] as const)
    next.sources[src].baseUrl = current.sources[src].baseUrl
  await saveSettings(db(), user.id, next)
  revalidatePath('/settings')
  return { ok: true, message: 'Settings reset to the defaults.' }
}
