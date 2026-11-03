import { describe, expect, it } from 'vitest'
import { listTables, migrate, openDb } from '../src/db'
import { MIGRATIONS } from '../src/db/migrations'

function insertJob(db: ReturnType<typeof openDb>, id = 'job1') {
  db.prepare(
    `INSERT INTO jobs (id, source, title, company, apply_url, apply_target, fetched_at)
     VALUES (?, 'indeed', 'AI Engineer', 'Acme', 'https://x.test/apply', 'greenhouse', ?)`,
  ).run(id, new Date().toISOString())
}

describe('database', () => {
  it('creates all tables', () => {
    const db = openDb(':memory:')
    expect(listTables(db)).toEqual(
      [
        'answers_seen',
        'applications',
        'board_map',
        'board_outbox',
        'events',
        'jobs',
        'llm_cache',
        'llm_usage',
        'metrics',
        'schema_migrations',
        'shadow_runs',
      ].sort(),
    )
  })

  it('is idempotent when migrations are applied twice', () => {
    const db = openDb(':memory:')
    expect(migrate(db, MIGRATIONS)).toEqual([])
  })

  it('enforces the status list', () => {
    const db = openDb(':memory:')
    insertJob(db)
    const insert = db.prepare(
      'INSERT INTO applications (job_id, status, updated_at) VALUES (?, ?, ?)',
    )
    expect(() => insert.run('job1', 'dancing', 'now')).toThrow(/CHECK/)
    insert.run('job1', 'queued', 'now')
  })

  it('enforces foreign keys and cascades deletes', () => {
    const db = openDb(':memory:')
    expect(() =>
      db
        .prepare('INSERT INTO applications (job_id, status, updated_at) VALUES (?, ?, ?)')
        .run('ghost', 'queued', 'now'),
    ).toThrow(/FOREIGN KEY/)

    insertJob(db)
    db.prepare('INSERT INTO applications (job_id, status, updated_at) VALUES (?, ?, ?)').run(
      'job1',
      'queued',
      'now',
    )
    db.prepare('DELETE FROM jobs WHERE id = ?').run('job1')
    const row = db.prepare('SELECT COUNT(*) AS c FROM applications').get() as { c: number }
    expect(row.c).toBe(0)
  })

  it('rolls back a failing migration', () => {
    const db = openDb(':memory:')
    expect(() =>
      migrate(db, [...MIGRATIONS, { id: 4, name: 'broken', sql: 'CREATE TABLE ok(a); SELEKT 1;' }]),
    ).toThrow(/Migration 4/)
    expect(listTables(db)).not.toContain('ok')
  })
})
