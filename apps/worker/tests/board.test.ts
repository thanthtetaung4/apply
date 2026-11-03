import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FallbackBoardLogger, McpBoardLogger } from '@apply/core/board'
import { boardStage, sgDate, MemoryBoardLogger, type BoardEntry } from '@apply/core/board'
import { createMockBoard, type MockBoard } from '@apply/core/demo'
import type { Job } from '@apply/core/job'
import { PgJobStore } from '@apply/db'
import { createTestDb } from '@apply/db/testing'
import { registerUser } from '@apply/db'

const job = (
  id: string,
  company = 'Acme',
  title = 'AI Engineer',
): Job & { matchScore?: number } => ({
  id,
  source: 'linkedin',
  title,
  company,
  location: 'Singapore',
  description: 'd',
  applyUrl: `https://acme.test/jobs/${id}`,
  applyTarget: 'company_site',
  fetchedAt: new Date().toISOString(),
  matchScore: 88,
})
const entry = (
  j: ReturnType<typeof job>,
  status: BoardEntry['status'],
  reason?: string,
): BoardEntry => ({ job: j, status, reason, resumeFile: 'Alex_Tan_Resume.pdf' })

let board: MockBoard
let store: PgJobStore
let close: () => Promise<void>
beforeEach(async () => {
  board = await createMockBoard()
  const t = await createTestDb()
  close = t.close
  const u = await registerUser(t.db, { email: 'b@example.com', password: 'correct horse battery' })
  store = new PgJobStore(t.db, u.id)
  for (const id of ['j1', 'j2', 'j3']) await store.addJob(job(id, `Co ${id}`))
})
afterEach(async () => {
  await board.close()
  await close()
})

describe('McpBoardLogger', () => {
  it('creates an application with the right fields', async () => {
    await new McpBoardLogger(board.client, store, () => new Date('2026-11-03T20:00:00Z')).log(
      entry(job('j1', 'Co j1'), 'ready_to_submit'),
    )
    expect(board.apps).toHaveLength(1)
    expect(board.apps[0]).toMatchObject({
      company: 'Co j1',
      role: 'AI Engineer',
      stage: 'Wishlist',
      source: 'LinkedIn',
      roleFamily: 'AI Engineer',
      resumeVersion: 'Tailored',
      externalId: 'j1',
      matchScore: 88,
      dateApplied: null,
      nextAction: 'Review the filled application and submit it',
    })
    expect(await store.getBoardMap('j1')).toMatchObject({ lastStage: 'Wishlist' })
  })

  it('moves to Applied with a Singapore date, and logs one note per status', async () => {
    const logger = new McpBoardLogger(board.client, store, () => new Date('2026-11-03T20:00:00Z'))
    const j = job('j1', 'Co j1')
    await logger.log(entry(j, 'ready_to_submit'))
    await logger.log(entry(j, 'submitted'))
    await logger.log(entry(j, 'submitted'))
    expect(board.apps).toHaveLength(1)
    expect(board.apps[0]).toMatchObject({ stage: 'Applied', dateApplied: '2026-11-04' })
    expect(
      board.apps[0]!.activities.filter((a) => a.type === 'note').map((n) => n.externalRef),
    ).toEqual(['auto-apply:j1:submitted'])
    expect(board.apps[0]!.activities.some((a) => a.type === 'stage_change')).toBe(true)
  })

  it('never moves an Applied application back to Wishlist', async () => {
    const logger = new McpBoardLogger(board.client, store)
    await logger.log(entry(job('j1', 'Co j1'), 'submitted'))
    await logger.log(entry(job('j1', 'Co j1'), 'needs_human', 'late problem'))
    expect(board.apps[0]!.stage).toBe('Applied')
  })

  it('links to an application already on the board instead of duplicating it', async () => {
    const existing = await createMockBoard([
      { company: 'Co j2', role: 'AI Engineer', stage: 'Interview - R1' },
    ])
    try {
      await new McpBoardLogger(existing.client, store).log(
        entry(job('j2', 'Co j2'), 'ready_to_submit'),
      )
      expect(existing.apps).toHaveLength(1)
      expect(existing.apps[0]!.stage).toBe('Interview - R1')
      expect(
        existing.apps[0]!.activities.some((a) => a.externalRef === 'auto-apply:j2:ready_to_submit'),
      ).toBe(true)
      expect((await store.getBoardMap('j2'))?.boardId).toBe(existing.apps[0]!.id)
    } finally {
      await existing.close()
    }
  })

  it('upgrades an existing Wishlist entry when the application is submitted', async () => {
    const existing = await createMockBoard([
      { company: 'Co j3', role: 'AI Engineer', stage: 'Wishlist' },
    ])
    try {
      await new McpBoardLogger(existing.client, store).log(entry(job('j3', 'Co j3'), 'submitted'))
      expect(existing.apps[0]!.stage).toBe('Applied')
    } finally {
      await existing.close()
    }
  })

  it('throws a clear error when the board reports one', async () => {
    const logger = new McpBoardLogger(
      { callTool: async () => ({ isError: true, content: [{ type: 'text', text: 'boom' }] }) },
      store,
    )
    await expect(logger.log(entry(job('j1', 'Co j1'), 'failed'))).rejects.toThrow('boom')
  })
})

describe('FallbackBoardLogger', () => {
  it('queues a retry in the database when the board is down, then flushes', async () => {
    let down = true
    const flaky = {
      callTool: async (p: { name: string; arguments: Record<string, unknown> }) => {
        if (down) throw new Error('connection refused')
        return board.client.callTool(p)
      },
    }
    const memory = new MemoryBoardLogger()
    const logger = new FallbackBoardLogger(new McpBoardLogger(flaky, store), memory, store)
    await logger.log(entry(job('j1', 'Co j1'), 'submitted'))
    expect(board.apps).toHaveLength(0)
    expect(memory.entries).toHaveLength(1)
    expect(await store.outbox()).toHaveLength(1)
    expect(await logger.flush()).toBe(0)
    expect((await store.outbox())[0]!.attempts).toBe(1)

    down = false
    expect(await logger.flush()).toBe(1)
    expect(await store.outbox()).toHaveLength(0)
    expect(board.apps[0]).toMatchObject({ company: 'Co j1', stage: 'Applied' })
  })
})

describe('helpers', () => {
  it('maps statuses to stages and dates to Singapore time', () => {
    expect(boardStage('submitted')).toBe('Applied')
    expect(boardStage('needs_human')).toBe('Wishlist')
    expect(sgDate(new Date('2026-11-03T15:59:00Z'))).toBe('2026-11-03')
    expect(sgDate(new Date('2026-11-03T16:00:00Z'))).toBe('2026-11-04')
  })
})
