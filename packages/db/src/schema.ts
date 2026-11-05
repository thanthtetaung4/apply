import { sql, type SQL } from 'drizzle-orm'
import {
  bigserial,
  boolean,
  check,
  customType,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { APPLY_TARGETS, JOB_SOURCES, JOB_STATUSES } from '@apply/core/status'

export const PROFILE_KINDS_DB = ['resume', 'titles', 'projects', 'answers'] as const
export const TASK_TYPES = ['intake', 'run'] as const
export const TASK_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'canceled'] as const
export const ARTIFACT_KINDS = ['resume_pdf', 'screenshot', 'record', 'tailor'] as const

const inList = (col: AnyPgColumn, values: readonly string[]): SQL =>
  sql`${col} in (${sql.join(
    values.map((v) => sql`${sql.raw(`'${v}'`)}`),
    sql`, `,
  )})`

/**
 * Multi-user schema. Every table that holds user data has a user_id, and job rows are keyed by
 * (user_id, id) so two users can queue the same posting without colliding.
 * Plain Postgres only (no extensions), so it runs unchanged on Neon.
 */

const bytea = customType<{ data: Buffer; driverData: Buffer | Uint8Array }>({
  dataType: () => 'bytea',
  toDriver: (v) => v,
  fromDriver: (v) => (Buffer.isBuffer(v) ? v : Buffer.from(v)),
})

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' })

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Always stored lowercase. */
    email: text('email').notNull(),
    name: text('name'),
    passwordHash: text('password_hash').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    disabledAt: ts('disabled_at'),
  },
  (t) => [uniqueIndex('users_email_uq').on(t.email)],
)

export const authSessions = pgTable(
  'auth_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 of the cookie value. The cookie itself is never stored. */
    tokenHash: text('token_hash').notNull(),
    userAgent: text('user_agent'),
    createdAt: ts('created_at').notNull().defaultNow(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [
    uniqueIndex('auth_sessions_token_uq').on(t.tokenHash),
    index('auth_sessions_user_idx').on(t.userId),
  ],
)

export const authThrottle = pgTable('auth_throttle', {
  key: text('key').primaryKey(),
  failures: integer('failures').notNull().default(0),
  windowStart: ts('window_start').notNull().defaultNow(),
  lockedUntil: ts('locked_until'),
})

export const apiTokens = pgTable(
  'api_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** First characters of the token, shown in the UI so you can tell tokens apart. */
    prefix: text('prefix').notNull(),
    tokenHash: text('token_hash').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    lastUsedAt: ts('last_used_at'),
    revokedAt: ts('revoked_at'),
  },
  (t) => [
    uniqueIndex('api_tokens_hash_uq').on(t.tokenHash),
    index('api_tokens_user_idx').on(t.userId),
  ],
)

export const profileFiles = pgTable(
  'profile_files',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(), // resume | titles | projects | answers
    content: text('content').notNull().default(''),
    revision: integer('revision').notNull().default(1),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.kind] }),
    check('profile_files_kind_ck', inList(t.kind, PROFILE_KINDS_DB)),
  ],
)

export const userSettings = pgTable('user_settings', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  settings: jsonb('settings').notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
})

/** Encrypted per user secrets: model API key, board URL and token. */
export const userSecrets = pgTable(
  'user_secrets',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    ciphertext: text('ciphertext').notNull(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.name] })],
)

/** Saved sign ins (cookies and local storage) per site, encrypted. */
export const browserSessions = pgTable(
  'browser_sessions',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    key: text('key').notNull(), // indeed | linkedin | glassdoor | workday-<tenant>
    /** v2: sealed to the worker's public key (see sealed.ts). v1: legacy app key encryption. */
    ciphertext: text('ciphertext').notNull(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    /** "connected", or "expired" once the worker met a sign in page with this session. */
    status: text('status').notNull().default('connected'),
    statusAt: ts('status_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.key] }),
    check('browser_sessions_status_ck', inList(t.status, ['connected', 'expired'])),
  ],
)

export const jobs = pgTable(
  'jobs',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    id: text('id').notNull(),
    source: text('source').notNull(),
    sourceUrl: text('source_url'),
    title: text('title').notNull(),
    company: text('company').notNull(),
    location: text('location'),
    description: text('description').notNull().default(''),
    applyUrl: text('apply_url').notNull(),
    applyTarget: text('apply_target').notNull(),
    postedAt: text('posted_at'),
    fetchedAt: ts('fetched_at').notNull(),
    matchScore: integer('match_score'),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    check('jobs_source_ck', inList(t.source, JOB_SOURCES)),
    check('jobs_apply_target_ck', inList(t.applyTarget, APPLY_TARGETS)),
    index('jobs_user_company_idx').on(t.userId, t.company, t.title),
    index('jobs_user_apply_url_idx').on(t.userId, t.applyUrl),
  ],
)

export const applications = pgTable(
  'applications',
  {
    userId: uuid('user_id').notNull(),
    jobId: text('job_id').notNull(),
    status: text('status').notNull(),
    attempts: integer('attempts').notNull().default(0),
    resumeArtifactId: uuid('resume_artifact_id'),
    backend: text('backend'),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
    error: text('error'),
    blockKind: text('block_kind'),
    tokensIn: integer('tokens_in').notNull().default(0),
    tokensOut: integer('tokens_out').notNull().default(0),
    costUsd: doublePrecision('cost_usd').notNull().default(0),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.jobId] }),
    foreignKey({ columns: [t.userId, t.jobId], foreignColumns: [jobs.userId, jobs.id] }).onDelete(
      'cascade',
    ),
    check('applications_status_ck', inList(t.status, JOB_STATUSES)),
    index('applications_user_status_idx').on(t.userId, t.status),
  ],
)

export const events = pgTable(
  'events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: uuid('user_id').notNull(),
    jobId: text('job_id').notNull(),
    ts: ts('ts').notNull().defaultNow(),
    type: text('type').notNull(),
    payload: jsonb('payload'),
  },
  (t) => [
    foreignKey({ columns: [t.userId, t.jobId], foreignColumns: [jobs.userId, jobs.id] }).onDelete(
      'cascade',
    ),
    index('events_job_idx').on(t.userId, t.jobId, t.id),
  ],
)

export const answersSeen = pgTable(
  'answers_seen',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    question: text('question').notNull(),
    answer: text('answer').notNull().default(''),
    source: text('source').notNull(), // unanswered | answered
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.question] })],
)

export const metrics = pgTable(
  'metrics',
  {
    userId: uuid('user_id').notNull(),
    jobId: text('job_id').notNull(),
    siteType: text('site_type').notNull(),
    backend: text('backend').notNull(),
    durationMs: integer('duration_ms').notNull(),
    steps: integer('steps').notNull().default(0),
    fieldsTotal: integer('fields_total').notNull().default(0),
    fieldsRule: integer('fields_rule').notNull().default(0),
    fieldsBank: integer('fields_bank').notNull().default(0),
    fieldsModel: integer('fields_model').notNull().default(0),
    verify: text('verify').notNull(),
    outcome: text('outcome').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.jobId] }),
    foreignKey({ columns: [t.userId, t.jobId], foreignColumns: [jobs.userId, jobs.id] }).onDelete(
      'cascade',
    ),
    index('metrics_user_site_idx').on(t.userId, t.siteType),
  ],
)

export const shadowRuns = pgTable(
  'shadow_runs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: uuid('user_id').notNull(),
    jobId: text('job_id').notNull(),
    backend: text('backend').notNull(),
    ok: boolean('ok').notNull(),
    error: text('error'),
    fieldsCompared: integer('fields_compared').notNull().default(0),
    diffCount: integer('diff_count').notNull().default(0),
    durationMs: integer('duration_ms').notNull().default(0),
    diffs: jsonb('diffs'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.userId, t.jobId], foreignColumns: [jobs.userId, jobs.id] }).onDelete(
      'cascade',
    ),
    index('shadow_runs_user_idx').on(t.userId),
  ],
)

export const boardMap = pgTable(
  'board_map',
  {
    userId: uuid('user_id').notNull(),
    jobId: text('job_id').notNull(),
    boardId: text('board_id').notNull(),
    lastStage: text('last_stage'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.jobId] }),
    foreignKey({ columns: [t.userId, t.jobId], foreignColumns: [jobs.userId, jobs.id] }).onDelete(
      'cascade',
    ),
  ],
)

export const boardOutbox = pgTable(
  'board_outbox',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    jobId: text('job_id').notNull(),
    payload: jsonb('payload').notNull(),
    attempts: integer('attempts').notNull().default(0),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('board_outbox_user_idx').on(t.userId)],
)

export const llmCache = pgTable(
  'llm_cache',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    task: text('task').notNull(),
    response: text('response').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] })],
)

export const llmUsage = pgTable(
  'llm_usage',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    jobId: text('job_id'),
    task: text('task').notNull(),
    model: text('model').notNull(),
    tokensIn: integer('tokens_in').notNull().default(0),
    tokensOut: integer('tokens_out').notNull().default(0),
    costUsd: doublePrecision('cost_usd').notNull().default(0),
    cached: boolean('cached').notNull().default(false),
    ts: ts('ts').notNull().defaultNow(),
  },
  (t) => [index('llm_usage_user_ts_idx').on(t.userId, t.ts)],
)

/** Files produced by runs: tailored resumes, step screenshots, run records. Kept in Postgres for now. */
export const artifacts = pgTable(
  'artifacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    jobId: text('job_id').notNull(),
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    contentType: text('content_type').notNull(),
    size: integer('size').notNull(),
    data: bytea('data').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.userId, t.jobId], foreignColumns: [jobs.userId, jobs.id] }).onDelete(
      'cascade',
    ),
    check('artifacts_kind_ck', inList(t.kind, ARTIFACT_KINDS)),
    uniqueIndex('artifacts_job_kind_name_uq').on(t.userId, t.jobId, t.kind, t.name),
    index('artifacts_user_job_idx').on(t.userId, t.jobId),
  ],
)

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(), // intake | run
    payload: jsonb('payload').notNull().default({}),
    status: text('status').notNull().default('queued'), // queued | running | succeeded | failed | canceled
    attempts: integer('attempts').notNull().default(0),
    lockedBy: text('locked_by'),
    heartbeatAt: ts('heartbeat_at'),
    cancelRequested: boolean('cancel_requested').notNull().default(false),
    createdAt: ts('created_at').notNull().defaultNow(),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
    error: text('error'),
    result: jsonb('result'),
  },
  (t) => [
    check('tasks_type_ck', inList(t.type, TASK_TYPES)),
    check('tasks_status_ck', inList(t.status, TASK_STATUSES)),
    index('tasks_status_idx').on(t.status, t.createdAt),
    index('tasks_user_idx').on(t.userId, t.createdAt),
    // At most one running task per user, so one account never runs two browser pipelines at once.
    uniqueIndex('tasks_one_running_per_user')
      .on(t.userId)
      .where(sql`${t.status} = 'running'`),
    // At most one waiting task of each type per user, so a double click cannot queue the same work twice.
    uniqueIndex('tasks_one_queued_per_type')
      .on(t.userId, t.type)
      .where(sql`${t.status} = 'queued'`),
  ],
)

export const taskLogs = pgTable(
  'task_logs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    ts: ts('ts').notNull().defaultNow(),
    level: text('level').notNull().default('info'),
    message: text('message').notNull(),
  },
  (t) => [index('task_logs_task_idx').on(t.taskId, t.id)],
)
