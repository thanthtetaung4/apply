import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createDb } from './client'

export const MIGRATIONS_FOLDER = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')

/**
 * Apply pending migrations. On Neon pass the DIRECT connection string (not the pooler), because
 * migrations use session level features that a transaction pooler does not allow.
 */
export async function runMigrations(url: string): Promise<void> {
  const h = createDb(url, { max: 1 })
  try {
    await migratePg(h.db as never, { migrationsFolder: MIGRATIONS_FOLDER })
  } finally {
    await h.close()
  }
}
