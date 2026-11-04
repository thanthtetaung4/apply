export { createDb, sharedDb, ping, schema, type Db, type DbHandle } from './client'
export { runMigrations, MIGRATIONS_FOLDER } from './migrate'
export * from './auth'
export * from './tasks'
export * from './user-data'
export * from './queries'
export * from './files'
export * from './login-ticket'
export { PgJobStore, siteTypeOfRow } from './job-store'
export {
  PgLlmStore,
  PgArtifactStore,
  PgSessionStore,
  SESSION_KEY_PATTERN,
  type SessionKeys,
  type SessionInfo,
  type SessionStatus,
} from './stores'
export {
  parseKey,
  generateKey,
  encryptString,
  decryptString,
  safeEqual as safeEqualStrings,
} from './crypto'
export {
  generateSealKeyPair,
  parsePrivateKeys,
  parsePublicKey,
  seal,
  open as openSealed,
  isSealed,
  sealKeyId,
} from './sealed'

import type { Stores } from '@apply/core/store'
import type { Db } from './client'
import { PgJobStore } from './job-store'
import { PgArtifactStore, PgLlmStore, PgSessionStore, type SessionKeys } from './stores'

/**
 * All the stores one user's engine needs. Pass `sessionKeys` in the web app (seal only) and the
 * worker (seal and open). Without them sessions use the legacy app key encryption (tests only).
 */
export function userStores(
  db: Db,
  userId: string,
  encryptionKey: Buffer,
  sessionKeys?: SessionKeys,
): Stores & { jobs: PgJobStore; sessions: PgSessionStore } {
  return {
    jobs: new PgJobStore(db, userId),
    llm: new PgLlmStore(db, userId),
    artifacts: new PgArtifactStore(db, userId),
    sessions: new PgSessionStore(db, userId, encryptionKey, sessionKeys),
  }
}
