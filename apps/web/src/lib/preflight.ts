import 'server-only'
import { getProfileFiles, isStarterProfile, loadProfile } from '@apply/db'
import { db } from './db'

/** Why a run cannot start yet, or null when the profile is ready. */
export async function profileProblem(userId: string): Promise<string | null> {
  const files = await getProfileFiles(db(), userId)
  if (isStarterProfile({ resume: files.resume.content })) {
    return 'Your resume is still the starter template. Replace it with your own details on the Profile page first.'
  }
  try {
    await loadProfile(db(), userId)
    return null
  } catch (err) {
    return `Your profile has problems. Fix them on the Profile page.\n${(err as Error).message}`
  }
}
