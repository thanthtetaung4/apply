import { PgJobStore, sharedDb, userStores } from '@apply/db'
import { encryptionKey, sessionPublicKey } from './env'

export const db = () => sharedDb().db
export const jobStore = (userId: string) => new PgJobStore(db(), userId)
/** Sessions are sealed with the worker's public key: the web app can save them, never read them. */
export const stores = (userId: string) =>
  userStores(db(), userId, encryptionKey(), { seal: sessionPublicKey() })
