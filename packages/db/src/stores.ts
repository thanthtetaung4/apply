import type {
  ArtifactKind,
  ArtifactMeta,
  ArtifactStore,
  LlmStore,
  LlmUsageRow,
  SessionStore,
  StorageState,
} from '@apply/core/store'
import type { KeyObject } from 'node:crypto'
import { and, eq, gte, sql } from 'drizzle-orm'
import type { Db } from './client'
import { decryptString, encryptString } from './crypto'
import { isSealed, open, seal } from './sealed'
import { artifacts, browserSessions, llmCache, llmUsage } from './schema'

const utcDayStart = (d: Date) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))

export class PgLlmStore implements LlmStore {
  constructor(
    private readonly db: Db,
    private readonly userId: string,
  ) {}

  async getCache(key: string): Promise<string | undefined> {
    const [r] = await this.db
      .select({ response: llmCache.response })
      .from(llmCache)
      .where(and(eq(llmCache.userId, this.userId), eq(llmCache.key, key)))
    return r?.response
  }

  async putCache(key: string, task: string, response: string): Promise<void> {
    await this.db
      .insert(llmCache)
      .values({ userId: this.userId, key, task, response })
      .onConflictDoUpdate({ target: [llmCache.userId, llmCache.key], set: { response, task } })
  }

  async recordUsage(row: LlmUsageRow): Promise<void> {
    await this.db.insert(llmUsage).values({
      userId: this.userId,
      jobId: row.jobId ?? null,
      task: row.task,
      model: row.model,
      tokensIn: row.tokensIn,
      tokensOut: row.tokensOut,
      costUsd: row.costUsd,
      cached: row.cached,
      ts: row.at,
    })
  }

  async spentToday(now: Date): Promise<number> {
    const [r] = await this.db
      .select({ c: sql<number>`coalesce(sum(${llmUsage.costUsd}), 0)::float8` })
      .from(llmUsage)
      .where(and(eq(llmUsage.userId, this.userId), gte(llmUsage.ts, utcDayStart(now))))
    return r?.c ?? 0
  }
}

/** Artifacts live in Postgres (bytea). Swap this class for S3 or R2 when volume grows. */
export class PgArtifactStore implements ArtifactStore {
  constructor(
    private readonly db: Db,
    private readonly userId: string,
  ) {}

  async put(a: {
    jobId: string
    kind: ArtifactKind
    name: string
    contentType: string
    data: Buffer
  }): Promise<string> {
    const values = {
      userId: this.userId,
      jobId: a.jobId,
      kind: a.kind,
      name: a.name,
      contentType: a.contentType,
      size: a.data.length,
      data: a.data,
    }
    const [r] = await this.db
      .insert(artifacts)
      .values(values)
      .onConflictDoUpdate({
        target: [artifacts.userId, artifacts.jobId, artifacts.kind, artifacts.name],
        set: {
          contentType: values.contentType,
          size: values.size,
          data: values.data,
          createdAt: new Date(),
        },
      })
      .returning({ id: artifacts.id })
    return r!.id
  }

  async get(id: string): Promise<(ArtifactMeta & { data: Buffer }) | undefined> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined
    const [r] = await this.db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.userId, this.userId), eq(artifacts.id, id)))
    return r
      ? {
          id: r.id,
          jobId: r.jobId,
          kind: r.kind as ArtifactKind,
          name: r.name,
          contentType: r.contentType,
          size: r.size,
          data: r.data,
        }
      : undefined
  }

  async list(jobId: string): Promise<ArtifactMeta[]> {
    const rows = await this.db
      .select({
        id: artifacts.id,
        jobId: artifacts.jobId,
        kind: artifacts.kind,
        name: artifacts.name,
        contentType: artifacts.contentType,
        size: artifacts.size,
      })
      .from(artifacts)
      .where(and(eq(artifacts.userId, this.userId), eq(artifacts.jobId, jobId)))
      .orderBy(artifacts.name)
    return rows.map((r) => ({ ...r, kind: r.kind as ArtifactKind }))
  }
}

export const SESSION_KEY_PATTERN = /^(indeed|linkedin|glassdoor|workday-[a-z0-9][a-z0-9-]{0,60})$/

/**
 * Keys for saved sign ins. The web app gets only `seal` (the worker's public key), so it can store
 * a session but never read one. The worker gets `open` (its private keys) as well.
 */
export interface SessionKeys {
  seal?: KeyObject
  open?: KeyObject[]
}

export type SessionStatus = 'connected' | 'expired'

export interface SessionInfo {
  key: string
  updatedAt: Date
  status: SessionStatus
  statusAt: Date
}

/**
 * Saved browser sign ins, bound to the owner and session name. New values are sealed to the
 * worker's public key. Values written before that (v1, app key) are still read, and the worker
 * re-seals them on its next save.
 */
export class PgSessionStore implements SessionStore {
  constructor(
    private readonly db: Db,
    private readonly userId: string,
    private readonly key: Buffer,
    private readonly keys: SessionKeys = {},
  ) {}

  private ctx(name: string) {
    return `${this.userId}:browser_session:${name}`
  }

  private where(name: string) {
    return and(eq(browserSessions.userId, this.userId), eq(browserSessions.key, name))
  }

  async get(name: string): Promise<StorageState | undefined> {
    const [r] = await this.db
      .select({ ciphertext: browserSessions.ciphertext })
      .from(browserSessions)
      .where(this.where(name))
    if (!r) return undefined
    if (isSealed(r.ciphertext)) {
      if (!this.keys.open?.length) throw new Error('Only the worker can read saved sign ins.')
      return JSON.parse(open(this.keys.open, this.ctx(name), r.ciphertext)) as StorageState
    }
    return JSON.parse(decryptString(this.key, this.ctx(name), r.ciphertext)) as StorageState
  }

  /** Save a sign in and mark it connected. */
  async put(name: string, state: StorageState): Promise<void> {
    if (!SESSION_KEY_PATTERN.test(name)) throw new Error(`Invalid session name "${name}"`)
    const plain = JSON.stringify(state)
    const ciphertext = this.keys.seal
      ? seal(this.keys.seal, this.ctx(name), plain)
      : encryptString(this.key, this.ctx(name), plain)
    const now = new Date()
    const set = { ciphertext, updatedAt: now, status: 'connected' as const, statusAt: now }
    await this.db
      .insert(browserSessions)
      .values({ userId: this.userId, key: name, ...set })
      .onConflictDoUpdate({ target: [browserSessions.userId, browserSessions.key], set })
  }

  /** The site showed a sign in page with this session. Keeps the value; the user signs in again. */
  async markExpired(name: string): Promise<void> {
    await this.db
      .update(browserSessions)
      .set({ status: 'expired', statusAt: new Date() })
      .where(and(this.where(name), eq(browserSessions.status, 'connected')))
  }

  /** Names, ages and status only. Never returns the cookies. */
  async list(): Promise<SessionInfo[]> {
    const rows = await this.db
      .select({
        key: browserSessions.key,
        updatedAt: browserSessions.updatedAt,
        status: browserSessions.status,
        statusAt: browserSessions.statusAt,
      })
      .from(browserSessions)
      .where(eq(browserSessions.userId, this.userId))
      .orderBy(browserSessions.key)
    return rows.map((r) => ({ ...r, status: r.status as SessionStatus }))
  }

  async remove(name: string): Promise<void> {
    await this.db.delete(browserSessions).where(this.where(name))
  }
}
