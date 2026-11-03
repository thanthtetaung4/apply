import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FallbackBoardLogger, McpBoardLogger } from '../src/board/mcp-logger'
import { FileBoardLogger } from '../src/board/file-logger'
import { boardStage, sgDate, type BoardEntry } from '../src/board/types'
import { openDb } from '../src/db'
import { createMockBoard, type MockBoard } from '../src/demo/mock-board'
import { JobRepo } from '../src/queue/repo'
import type { Job } from '../src/shared/job'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
let repo: JobRepo
beforeEach(async () => {
  board = await createMockBoard()
  repo = new JobRepo(openDb(':memory:'))
  for (const id of ['j1', 'j2', 'j3']) repo.addJob(job(id, `Co ${id}`))
})
afterEach(async () => board.close())

describe('McpBoardLogger', () => {
  it('creates an application with the right fields', async () => {
    const logger = new McpBoardLogger(board.client, repo, () => new Date('2026-11-03T20:00:00Z'))
    await logger.log(entry(job('j1', 'Co j1'), 'ready_to_submit'))
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
    expect(repo.getBoardMap('j1')).toMatchObject({ lastStage: 'Wishlist' })
  })

  it('moves to Applied with a Singapore date, and logs one note per status', async () => {
    const logger = new McpBoardLogger(board.client, repo, () => new Date('2026-11-03T20:00:00Z')) // 04:00 next day in SGT
    const j = job('j1', 'Co j1')
    await logger.log(entry(j, 'ready_to_submit'))
    await logger.log(entry(j, 'submitted'))
    await logger.log(entry(j, 'submitted')) // repeat
    expect(board.apps).toHaveLength(1)
    expect(board.apps[0]).toMatchObject({ stage: 'Applied', dateApplied: '2026-11-04' })
    const notes = board.apps[0]!.activities.filter((a) => a.type === 'note')
    // Creation carries the note in the notes field. Later changes add one timeline note each.
    expect(notes.map((n) => n.externalRef)).toEqual(['auto-apply:j1:submitted'])
    expect(board.apps[0]!.activities.some((a) => a.type === 'stage_change')).toBe(true)
  })

  it('never moves an Applied application back to Wishlist', async () => {
    const logger = new McpBoardLogger(board.client, repo)
    const j = job('j1', 'Co j1')
    await logger.log(entry(j, 'submitted'))
    await logger.log(entry(j, 'needs_human', 'late problem'))
    expect(board.apps[0]!.stage).toBe('Applied')
  })

  it('links to an application that is already on the board instead of duplicating it', async () => {
    const existing = await createMockBoard([
      { company: 'Co j2', role: 'AI Engineer', stage: 'Interview - R1' },
    ])
    try {
      const logger = new McpBoardLogger(existing.client, repo)
      await logger.log(entry(job('j2', 'Co j2'), 'ready_to_submit'))
      expect(existing.apps).toHaveLength(1)
      expect(existing.apps[0]!.stage).toBe('Interview - R1') // not downgraded
      expect(
        existing.apps[0]!.activities.some((a) => a.externalRef === 'auto-apply:j2:ready_to_submit'),
      ).toBe(true)
      expect(repo.getBoardMap('j2')?.boardId).toBe(existing.apps[0]!.id)
    } finally {
      await existing.close()
    }
  })

  it('upgrades an existing Wishlist entry when the application is submitted', async () => {
    const existing = await createMockBoard([
      { company: 'Co j3', role: 'AI Engineer', stage: 'Wishlist' },
    ])
    try {
      await new McpBoardLogger(existing.client, repo).log(entry(job('j3', 'Co j3'), 'submitted'))
      expect(existing.apps[0]!.stage).toBe('Applied')
    } finally {
      await existing.close()
    }
  })

  it('throws a clear error when the board reports one', async () => {
    const logger = new McpBoardLogger(
      { callTool: async () => ({ isError: true, content: [{ type: 'text', text: 'boom' }] }) },
      repo,
    )
    await expect(logger.log(entry(job('j1', 'Co j1'), 'failed'))).rejects.toThrow('boom')
  })
})

describe('FallbackBoardLogger', () => {
  it('writes to the file and queues a retry when the board is down, then flushes', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'aa-board-')), 'board.jsonl')
    let down = true
    const flaky = {
      callTool: async (p: { name: string; arguments: Record<string, unknown> }) => {
        if (down) throw new Error('connection refused')
        return board.client.callTool(p)
      },
    }
    const logger = new FallbackBoardLogger(
      new McpBoardLogger(flaky, repo),
      new FileBoardLogger(path),
      repo,
    )
    await logger.log(entry(job('j1', 'Co j1'), 'submitted'))
    expect(board.apps).toHaveLength(0)
    expect(readFileSync(path, 'utf8')).toContain('"status":"submitted"')
    expect(repo.outbox()).toHaveLength(1)
    expect(await logger.flush()).toBe(0) // still down
    expect(repo.outbox()[0]!.attempts).toBe(1)

    down = false
    expect(await logger.flush()).toBe(1)
    expect(repo.outbox()).toHaveLength(0)
    expect(board.apps[0]).toMatchObject({ company: 'Co j1', stage: 'Applied' })
  })
})

describe('FileBoardLogger and helpers', () => {
  it('is idempotent across restarts', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'aa-board-')), 'b.jsonl')
    const j = job('j1')
    await new FileBoardLogger(path).log(entry(j, 'needs_human', 'captcha'))
    await new FileBoardLogger(path).log(entry(j, 'needs_human', 'captcha'))
    await new FileBoardLogger(path).log(entry(j, 'submitted'))
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(2)
  })

  it('maps statuses to stages and dates to Singapore time', () => {
    expect(boardStage('submitted')).toBe('Applied')
    expect(boardStage('submitted_unconfirmed')).toBe('Applied')
    expect(boardStage('needs_human')).toBe('Wishlist')
    expect(sgDate(new Date('2026-11-03T15:59:00Z'))).toBe('2026-11-03')
    expect(sgDate(new Date('2026-11-03T16:00:00Z'))).toBe('2026-11-04')
  })
})
