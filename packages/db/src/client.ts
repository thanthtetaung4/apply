import { sql } from 'drizzle-orm'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import pg from 'pg'
import * as schema from './schema'

/** Works with node-postgres (Neon, local Postgres) and PGlite (tests). */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>
export { schema }

export interface DbHandle {
  db: Db
  pool: pg.Pool
  close(): Promise<void>
}

export interface CreateDbOptions {
  /** Pool size. Keep small on serverless (Vercel): 1 to 3. The worker can use more. */
  max?: number
}

/**
 * Connect with node-postgres. Use Neon's pooled connection string (the host with "-pooler") for the
 * web app and the direct one for migrations. `sslmode=require` in the URL turns on TLS.
 */
export function createDb(url: string, options: CreateDbOptions = {}): DbHandle {
  if (!url) throw new Error('DATABASE_URL is not set')
  const pool = new pg.Pool({
    connectionString: url,
    max: options.max ?? 5,
    idleTimeoutMillis: 20_000,
    connectionTimeoutMillis: 10_000,
  })
  pool.on('error', () => undefined) // an idle client dropping must not crash the process
  const db: NodePgDatabase<typeof schema> = drizzle({ client: pool, schema })
  return { db: db as unknown as Db, pool, close: () => pool.end() }
}

/** One shared handle per process. Next.js dev reloads modules, so keep it on globalThis. */
const g = globalThis as unknown as { __applyDb?: DbHandle }
export function sharedDb(
  url = process.env.DATABASE_URL ?? '',
  options?: CreateDbOptions,
): DbHandle {
  g.__applyDb ??= createDb(url, options ?? { max: process.env.VERCEL ? 1 : 5 })
  return g.__applyDb
}

/** Cheap connectivity check for health endpoints. */
export async function ping(db: Db): Promise<void> {
  await db.execute(sql`select 1`)
}
