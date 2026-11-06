import {
  PROFILE_KINDS,
  PROFILE_TEMPLATES,
  parseProfile,
  type Profile,
  type ProfileKind,
} from '@apply/core/profile'
import { defaultSettings, parseSettings, type UserSettings } from '@apply/core/settings'
import { and, eq, sql } from 'drizzle-orm'
import type { Db } from './client'
import { decryptString, encryptString } from './crypto'
import { profileFiles, userSecrets, userSettings } from './schema'

// --- profile files -----------------------------------------------------------------------------

export interface ProfileFileRow {
  content: string
  revision: number
  updatedAt: Date
}

export class ConflictError extends Error {
  constructor() {
    super('This file changed somewhere else. Reload it and apply your edit again.')
    this.name = 'ConflictError'
  }
}

export async function getProfileFiles(
  db: Db,
  userId: string,
): Promise<Record<ProfileKind, ProfileFileRow>> {
  const rows = await db.select().from(profileFiles).where(eq(profileFiles.userId, userId))
  const out = {} as Record<ProfileKind, ProfileFileRow>
  for (const kind of PROFILE_KINDS) {
    const r = rows.find((x) => x.kind === kind)
    out[kind] = r
      ? { content: r.content, revision: r.revision, updatedAt: r.updatedAt }
      : { content: '', revision: 0, updatedAt: new Date(0) }
  }
  return out
}

/**
 * Save one markdown file. Pass the revision you loaded: if someone else (another tab, or the
 * "needs you" screen) saved in between, you get a ConflictError instead of overwriting their edit.
 */
export async function saveProfileFile(
  db: Db,
  userId: string,
  kind: ProfileKind,
  content: string,
  expectedRevision?: number,
): Promise<{ revision: number }> {
  if (!PROFILE_KINDS.includes(kind)) throw new Error('Unknown profile file')
  if (content.length > 200_000) throw new Error('The file is too large (limit 200 KB).')
  const where = and(
    eq(profileFiles.userId, userId),
    eq(profileFiles.kind, kind),
    ...(expectedRevision === undefined ? [] : [eq(profileFiles.revision, expectedRevision)]),
  )
  const updated = await db
    .update(profileFiles)
    .set({ content, revision: sql`${profileFiles.revision} + 1`, updatedAt: new Date() })
    .where(where)
    .returning({ revision: profileFiles.revision })
  if (updated[0]) return updated[0]
  const exists = await db
    .select({ r: profileFiles.revision })
    .from(profileFiles)
    .where(and(eq(profileFiles.userId, userId), eq(profileFiles.kind, kind)))
  if (exists.length > 0) throw new ConflictError()
  const [ins] = await db
    .insert(profileFiles)
    .values({ userId, kind, content })
    .returning({ revision: profileFiles.revision })
  return ins!
}

/** Parse the saved files into a profile. Throws ProfileError listing every problem. */
export async function loadProfile(db: Db, userId: string): Promise<Profile> {
  const files = await getProfileFiles(db, userId)
  return parseProfile(Object.fromEntries(PROFILE_KINDS.map((k) => [k, files[k].content])))
}

/** True while resume.md still contains the starter template details. Runs are blocked until replaced. */
export function isStarterProfile(texts: Partial<Record<ProfileKind, string>>): boolean {
  const resume = texts.resume ?? ''
  return (
    /you@example\.com/.test(resume) ||
    /^Name:\s*Your Name\s*$/m.test(resume) ||
    resume.trim() === PROFILE_TEMPLATES.resume.trim()
  )
}

// --- settings ----------------------------------------------------------------------------------

export async function getSettings(db: Db, userId: string): Promise<UserSettings> {
  const [r] = await db.select().from(userSettings).where(eq(userSettings.userId, userId))
  if (!r) return defaultSettings()
  const parsed = parseSettings(r.settings)
  return parsed.ok ? parsed.settings : defaultSettings()
}

export async function saveSettings(db: Db, userId: string, settings: UserSettings): Promise<void> {
  const parsed = parseSettings(settings)
  if (!parsed.ok) throw new Error(`Invalid settings: ${parsed.issues.join('; ')}`)
  await db
    .insert(userSettings)
    .values({ userId, settings: parsed.settings, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: userSettings.userId,
      set: { settings: parsed.settings, updatedAt: new Date() },
    })
}

// --- secrets -----------------------------------------------------------------------------------

export const SECRET_NAMES = {
  openrouterKey: 'openrouter_api_key',
  llmEndpointUrl: 'llm_endpoint_url',
  llmEndpointKey: 'llm_endpoint_key',
  boardUrl: 'board_mcp_url',
  boardToken: 'board_mcp_token',
} as const
export type SecretName = (typeof SECRET_NAMES)[keyof typeof SECRET_NAMES]

const ctx = (userId: string, name: string) => `${userId}:secret:${name}`

export async function setSecret(
  db: Db,
  key: Buffer,
  userId: string,
  name: SecretName,
  value: string,
): Promise<void> {
  const ciphertext = encryptString(key, ctx(userId, name), value)
  await db
    .insert(userSecrets)
    .values({ userId, name, ciphertext, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [userSecrets.userId, userSecrets.name],
      set: { ciphertext, updatedAt: new Date() },
    })
}

export async function getSecret(
  db: Db,
  key: Buffer,
  userId: string,
  name: SecretName,
): Promise<string | undefined> {
  const [r] = await db
    .select({ c: userSecrets.ciphertext })
    .from(userSecrets)
    .where(and(eq(userSecrets.userId, userId), eq(userSecrets.name, name)))
  return r ? decryptString(key, ctx(userId, name), r.c) : undefined
}

export async function deleteSecret(db: Db, userId: string, name: SecretName): Promise<void> {
  await db
    .delete(userSecrets)
    .where(and(eq(userSecrets.userId, userId), eq(userSecrets.name, name)))
}

/** Which secrets exist, never their values. */
export async function listSecretNames(
  db: Db,
  userId: string,
): Promise<{ name: string; updatedAt: Date }[]> {
  return db
    .select({ name: userSecrets.name, updatedAt: userSecrets.updatedAt })
    .from(userSecrets)
    .where(eq(userSecrets.userId, userId))
}
