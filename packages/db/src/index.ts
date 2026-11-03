export { createDb, sharedDb, ping, schema, type Db, type DbHandle } from './client'
export { runMigrations, MIGRATIONS_FOLDER } from './migrate'
export * from './auth'
export * from './tasks'
export * from './user-data'
export * from './queries'
export { PgJobStore, siteTypeOfRow } from './job-store'
export { PgLlmStore, PgArtifactStore, PgSessionStore, SESSION_KEY_PATTERN } from './stores'
export { parseKey, generateKey, encryptString, decryptString, safeEqual as safeEqualStrings } from './crypto'

import type { Stores } from '@apply/core/store'
import type { Db } from './client'
import { PgJobStore } from './job-store'
import { PgArtifactStore, PgLlmStore, PgSessionStore } from './stores'

/** All the stores one user's engine needs. */
export function userStores(
  db: Db,
  userId: string,
  encryptionKey: Buffer,
): Stores & { jobs: PgJobStore; sessions: PgSessionStore } {
  return {
    jobs: new PgJobStore(db, userId),
    llm: new PgLlmStore(db, userId),
    artifacts: new PgArtifactStore(db, userId),
    sessions: new PgSessionStore(db, userId, encryptionKey),
  }
}
