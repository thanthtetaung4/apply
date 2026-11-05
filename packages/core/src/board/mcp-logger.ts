import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { normalizeText } from '../shared/hash'
import type { JobSource } from '../shared/status'
import type { JobStore } from '../store'
import {
  BoardError,
  boardStage,
  nextActionFor,
  notesFor,
  sgDate,
  type BoardEntry,
  type BoardLogger,
  type BoardStage,
} from './types'

export interface ToolResult {
  content?: { type: string; text?: string }[]
  structuredContent?: unknown
  isError?: boolean
}

/** The part of an MCP client this logger needs. The SDK `Client` satisfies it. */
export interface ToolClient {
  callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<unknown>
}

const SOURCE_LABEL: Record<JobSource, 'Indeed' | 'LinkedIn' | 'Other'> = {
  indeed: 'Indeed',
  linkedin: 'LinkedIn',
  glassdoor: 'Other',
  company: 'Other',
  direct: 'Other',
}

function roleFamily(title: string): string {
  const t = title.toLowerCase()
  if (/\bai\b|machine learning|\bllm\b/.test(t)) return 'AI Engineer'
  if (/full ?stack/.test(t)) return 'Full Stack'
  if (/backend|back-end/.test(t)) return 'Backend'
  if (/devops|sre|platform engineer/.test(t)) return 'DevOps'
  if (/software engineer/.test(t)) return 'Software Engineer'
  if (/developer/.test(t)) return 'Software Developer'
  return 'Other'
}

function payloadOf(raw: unknown): Record<string, unknown> {
  const res = raw as ToolResult
  const text = res.content?.find((c) => c.type === 'text')?.text
  if (res.isError) throw new BoardError(text ?? 'The board returned an error')
  if (res.structuredContent && typeof res.structuredContent === 'object') {
    return res.structuredContent as Record<string, unknown>
  }
  if (!text) return {}
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return { text }
  }
}

const asId = (p: Record<string, unknown>): string | undefined => {
  const app = p.application as Record<string, unknown> | undefined
  const id = app?.id ?? p.id
  return typeof id === 'string' ? id : undefined
}

/**
 * Writes to the Job Search Board through its MCP server. Uses find_duplicate before create_application,
 * update_application for stage changes and log_activity (with a dedupe key) for notes.
 */
export class McpBoardLogger implements BoardLogger {
  readonly name = 'mcp'

  constructor(
    private readonly client: ToolClient,
    private readonly repo: JobStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async call(
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return payloadOf(await this.client.callTool({ name, arguments: args }))
  }

  async log(entry: BoardEntry): Promise<void> {
    const { job } = entry
    const stage = boardStage(entry.status)
    const known = await this.repo.getBoardMap(job.id)

    if (!known) {
      await this.createOrLink(entry, stage)
      return
    }
    // Never move an application back from Applied.
    if (known.lastStage === 'Applied' && stage === 'Wishlist') return
    await this.update(known.boardId, known.lastStage, entry, stage)
  }

  private async createOrLink(entry: BoardEntry, stage: BoardStage): Promise<void> {
    const { job } = entry
    const dup = await this.call('find_duplicate', { company: job.company, role: job.title })
    const matches = (Array.isArray(dup.matches) ? dup.matches : []) as Record<string, unknown>[]
    const same = matches.find(
      (m) =>
        m.exact === true ||
        (normalizeText(String(m.company ?? '')) === normalizeText(job.company) &&
          normalizeText(String(m.role ?? '')) === normalizeText(job.title)),
    )
    if (same && typeof same.id === 'string') {
      const existingStage = typeof same.stage === 'string' ? same.stage : null
      await this.repo.setBoardMap(job.id, same.id, existingStage)
      // The user may have it on the board already. Do not downgrade a later stage.
      if (existingStage && existingStage !== 'Wishlist' && stage === 'Wishlist') {
        await this.note(same.id, entry)
        return
      }
      await this.update(same.id, existingStage, entry, stage)
      return
    }

    const created = await this.call('create_application', {
      company: job.company,
      role: job.title,
      jobLink: job.applyUrl,
      source: SOURCE_LABEL[job.source],
      roleFamily: roleFamily(job.title),
      stage,
      dateApplied: stage === 'Applied' ? sgDate(this.now()) : null,
      resumeVersion: 'Tailored',
      matchScore: job.matchScore ?? null,
      externalId: job.id,
      nextAction: nextActionFor(entry),
      notes: notesFor(entry),
    })
    const id = asId(created)
    if (!id) throw new BoardError('create_application did not return an id')
    await this.repo.setBoardMap(job.id, id, stage)
  }

  private async update(
    boardId: string,
    lastStage: string | null,
    entry: BoardEntry,
    stage: BoardStage,
  ) {
    await this.call('update_application', {
      id: boardId,
      ...(stage !== lastStage ? { stage } : {}),
      ...(stage === 'Applied' ? { dateApplied: sgDate(this.now()) } : {}),
      resumeVersion: 'Tailored',
      nextAction: nextActionFor(entry),
      notes: notesFor(entry),
    })
    await this.note(boardId, entry)
    await this.repo.setBoardMap(entry.job.id, boardId, stage)
  }

  private async note(boardId: string, entry: BoardEntry): Promise<void> {
    await this.call('log_activity', {
      applicationId: boardId,
      type: 'note',
      summary: notesFor(entry).slice(0, 1900),
      // Dedupe key: the same status for the same job is only logged once.
      externalRef: `auto-apply:${entry.job.id}:${entry.status}`,
    })
  }
}

/** Connect to the board's MCP server over streamable HTTP with a bearer token. */
export async function connectBoard(url: string, token?: string): Promise<Client> {
  const client = new Client({ name: 'auto-apply', version: '0.1.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
    }),
  )
  return client
}

/**
 * Primary logger with a safety net: when the primary fails, the entry goes to the fallback logger and
 * a retry queue. Board problems never stop applications.
 */
export class FallbackBoardLogger implements BoardLogger {
  readonly name: string

  constructor(
    private readonly primary: BoardLogger,
    private readonly fallback: BoardLogger,
    private readonly repo: JobStore,
  ) {
    this.name = `${primary.name}+${fallback.name}`
  }

  async log(entry: BoardEntry): Promise<void> {
    try {
      await this.primary.log(entry)
    } catch (err) {
      this.repo.addEvent(entry.job.id, 'board_failed', {
        error: (err as Error).message.slice(0, 200),
      })
      this.repo.pushOutbox(entry.job.id, entry)
      await this.fallback.log(entry)
    }
  }

  /** Retry queued entries. Returns how many went through. */
  async flush(): Promise<number> {
    let sent = 0
    for (const row of await this.repo.outbox()) {
      try {
        await this.primary.log(row.payload as BoardEntry)
        await this.repo.dropOutbox(row.id)
        sent++
      } catch {
        await this.repo.bumpOutbox(row.id)
      }
    }
    return sent
  }
}
