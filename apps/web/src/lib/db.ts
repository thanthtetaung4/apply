import { PgJobStore, sharedDb, userStores } from '@apply/db'
import { encryptionKey } from './env'

export const db = () => sharedDb().db
export const jobStore = (userId: string) => new PgJobStore(db(), userId)
export const stores = (userId: string) => userStores(db(), userId, encryptionKey())
