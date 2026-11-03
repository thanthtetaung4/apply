import { APPLY_TARGETS, JOB_SOURCES, JOB_STATUSES } from '../shared/status'

const list = (values: readonly string[]) => values.map((v) => `'${v}'`).join(', ')

export interface Migration {
  id: number
  name: string
  sql: string
}

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: 'initial',
    sql: `
      CREATE TABLE jobs (
        id            TEXT PRIMARY KEY,
        source        TEXT NOT NULL CHECK (source IN (${list(JOB_SOURCES)})),
        source_url    TEXT,
        title         TEXT NOT NULL,
        company       TEXT NOT NULL,
        location      TEXT,
        description   TEXT NOT NULL DEFAULT '',
        apply_url     TEXT NOT NULL,
        apply_target  TEXT NOT NULL CHECK (apply_target IN (${list(APPLY_TARGETS)})),
        posted_at     TEXT,
        fetched_at    TEXT NOT NULL
      );
      CREATE INDEX idx_jobs_company_title ON jobs (company, title);

      CREATE TABLE applications (
        job_id       TEXT PRIMARY KEY REFERENCES jobs (id) ON DELETE CASCADE,
        status       TEXT NOT NULL CHECK (status IN (${list(JOB_STATUSES)})),
        attempts     INTEGER NOT NULL DEFAULT 0,
        resume_path  TEXT,
        backend      TEXT,
        started_at   TEXT,
        finished_at  TEXT,
        error        TEXT,
        tokens_in    INTEGER NOT NULL DEFAULT 0,
        tokens_out   INTEGER NOT NULL DEFAULT 0,
        cost_usd     REAL NOT NULL DEFAULT 0,
        updated_at   TEXT NOT NULL
      );
      CREATE INDEX idx_applications_status ON applications (status);

      CREATE TABLE events (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id   TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
        ts       TEXT NOT NULL,
        type     TEXT NOT NULL,
        payload  TEXT
      );
      CREATE INDEX idx_events_job ON events (job_id, ts);

      CREATE TABLE answers_seen (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        question    TEXT NOT NULL UNIQUE,
        answer      TEXT NOT NULL,
        source      TEXT NOT NULL,
        created_at  TEXT NOT NULL
      );
    `,
  },
  {
    id: 2,
    name: 'llm cache, usage, metrics, shadow runs, board mapping',
    sql: `
      CREATE TABLE llm_cache (
        key         TEXT PRIMARY KEY,
        task        TEXT NOT NULL,
        response    TEXT NOT NULL,
        created_at  TEXT NOT NULL
      );

      CREATE TABLE llm_usage (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id      TEXT,
        task        TEXT NOT NULL,
        model       TEXT NOT NULL,
        tokens_in   INTEGER NOT NULL DEFAULT 0,
        tokens_out  INTEGER NOT NULL DEFAULT 0,
        cost_usd    REAL NOT NULL DEFAULT 0,
        cached      INTEGER NOT NULL DEFAULT 0,
        ts          TEXT NOT NULL
      );
      CREATE INDEX idx_llm_usage_ts ON llm_usage (ts);

      CREATE TABLE metrics (
        job_id        TEXT PRIMARY KEY REFERENCES jobs (id) ON DELETE CASCADE,
        site_type     TEXT NOT NULL,
        backend       TEXT NOT NULL,
        duration_ms   INTEGER NOT NULL,
        steps         INTEGER NOT NULL DEFAULT 0,
        fields_total  INTEGER NOT NULL DEFAULT 0,
        fields_rule   INTEGER NOT NULL DEFAULT 0,
        fields_bank   INTEGER NOT NULL DEFAULT 0,
        fields_model  INTEGER NOT NULL DEFAULT 0,
        verify        TEXT NOT NULL,
        outcome       TEXT NOT NULL,
        created_at    TEXT NOT NULL
      );

      CREATE TABLE shadow_runs (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id           TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
        backend          TEXT NOT NULL,
        ok               INTEGER NOT NULL,
        error            TEXT,
        fields_compared  INTEGER NOT NULL DEFAULT 0,
        diff_count       INTEGER NOT NULL DEFAULT 0,
        duration_ms      INTEGER NOT NULL DEFAULT 0,
        diffs            TEXT,
        created_at       TEXT NOT NULL
      );

      CREATE TABLE board_map (
        job_id      TEXT PRIMARY KEY REFERENCES jobs (id) ON DELETE CASCADE,
        board_id    TEXT NOT NULL,
        last_stage  TEXT,
        updated_at  TEXT NOT NULL
      );

      CREATE TABLE board_outbox (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id      TEXT NOT NULL,
        payload     TEXT NOT NULL,
        attempts    INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL
      );
    `,
  },
  {
    id: 3,
    name: 'job match score and skip reason',
    sql: `
      ALTER TABLE jobs ADD COLUMN match_score INTEGER;
    `,
  },
]
