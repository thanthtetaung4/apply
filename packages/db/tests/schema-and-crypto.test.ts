import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { decryptString, encryptString, generateKey, parseKey } from '../src/crypto'
import { createTestDb } from '../src/testing'
import { newUser } from './helpers'

let t: Awaited<ReturnType<typeof createTestDb>>
beforeAll(async () => {
  t = await createTestDb()
})
afterAll(async () => t.close())

describe('migrations', () => {
  it('create every table with only plain Postgres features (no extensions)', async () => {
    const res = (await t.db.execute(
      sql`select table_name from information_schema.tables where table_schema = 'public' order by 1`,
    )) as unknown as { rows: { table_name: string }[] }
    const names = res.rows.map((r) => r.table_name)
    for (const want of [
      'users',
      'auth_sessions',
      'api_tokens',
      'profile_files',
      'user_settings',
      'user_secrets',
      'browser_sessions',
      'jobs',
      'applications',
      'events',
      'artifacts',
      'tasks',
      'task_logs',
      'llm_cache',
      'llm_usage',
      'metrics',
      'shadow_runs',
      'board_map',
      'board_outbox',
      'answers_seen',
      'auth_throttle',
    ]) {
      expect(names).toContain(want)
    }
    const ext = (await t.db.execute(
      sql`select extname from pg_extension where extname <> 'plpgsql'`,
    )) as unknown as { rows: unknown[] }
    expect(ext.rows).toEqual([])
  })

  it('enforce status lists and composite foreign keys', async () => {
    const u = await newUser(t.db)
    await expect(
      t.db.execute(
        sql`insert into jobs (user_id, id, source, title, company, apply_url, apply_target, fetched_at) values (${u.id}, 'x', 'bing', 't', 'c', 'u', 'greenhouse', now())`,
      ),
    ).rejects.toThrow()
    await expect(
      t.db.execute(
        sql`insert into applications (user_id, job_id, status) values (${u.id}, 'ghost', 'queued')`,
      ),
    ).rejects.toThrow()
    await t.db.execute(
      sql`insert into jobs (user_id, id, source, title, company, apply_url, apply_target, fetched_at) values (${u.id}, 'x', 'indeed', 't', 'c', 'u', 'greenhouse', now())`,
    )
    await expect(
      t.db.execute(
        sql`insert into applications (user_id, job_id, status) values (${u.id}, 'x', 'dancing')`,
      ),
    ).rejects.toThrow()
  })

  it('cascade user deletion through every table', async () => {
    const u = await newUser(t.db)
    await t.db.execute(
      sql`insert into jobs (user_id, id, source, title, company, apply_url, apply_target, fetched_at) values (${u.id}, 'j', 'indeed', 't', 'c', 'u', 'greenhouse', now())`,
    )
    await t.db.execute(
      sql`insert into applications (user_id, job_id, status) values (${u.id}, 'j', 'queued')`,
    )
    await t.db.execute(sql`delete from users where id = ${u.id}`)
    for (const table of ['jobs', 'applications', 'profile_files', 'user_settings']) {
      const r = (await t.db.execute(
        sql.raw(`select count(*)::int as n from ${table} where user_id = '${u.id}'`),
      )) as unknown as { rows: { n: number }[] }
      expect(r.rows[0]!.n).toBe(0)
    }
  })
})

describe('crypto', () => {
  const key = parseKey(generateKey())

  it('round trips and uses a fresh iv each time', () => {
    const a = encryptString(key, 'ctx', 'secret value')
    const b = encryptString(key, 'ctx', 'secret value')
    expect(a).not.toBe(b)
    expect(a).not.toContain('secret value')
    expect(decryptString(key, 'ctx', a)).toBe('secret value')
  })

  it('fails with the wrong context, wrong key or tampering', () => {
    const a = encryptString(key, 'user1:secret:x', 'v')
    expect(() => decryptString(key, 'user2:secret:x', a)).toThrow(/Could not decrypt/)
    expect(() => decryptString(parseKey(generateKey()), 'user1:secret:x', a)).toThrow(
      /Could not decrypt/,
    )
    const parts = a.split('.')
    parts[3] = Buffer.from('tampered').toString('base64url')
    expect(() => decryptString(key, 'user1:secret:x', parts.join('.'))).toThrow(/Could not decrypt/)
    expect(() => decryptString(key, 'c', 'garbage')).toThrow(/Unreadable/)
  })

  it('validates the key format', () => {
    expect(() => parseKey(undefined)).toThrow(/not set/)
    expect(() => parseKey('c2hvcnQ=')).toThrow(/32 bytes/)
    expect(parseKey(generateKey())).toHaveLength(32)
  })
})
