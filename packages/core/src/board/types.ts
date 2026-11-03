import type { Job } from '../shared/job'
import type { JobStatus } from '../shared/status'

export interface BoardEntry {
  job: Job & { matchScore?: number }
  status: JobStatus
  reason?: string
  resumeFile?: string
}

export interface BoardLogger {
  readonly name: string
  log(entry: BoardEntry): Promise<void>
}

/** Statuses worth recording on the board. `queued`, `skipped` and in-flight states are not. */
export const BOARD_STATUSES: JobStatus[] = [
  'ready_to_submit',
  'needs_human',
  'failed',
  'submitted',
  'submitted_unconfirmed',
]

export type BoardStage = 'Wishlist' | 'Applied'

export const boardStage = (status: JobStatus): BoardStage =>
  status === 'submitted' || status === 'submitted_unconfirmed' ? 'Applied' : 'Wishlist'

export class BoardError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BoardError'
  }
}

/** Dates on the board are YYYY-MM-DD in Singapore time (UTC+8). */
export const sgDate = (now: Date): string =>
  new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10)

export function nextActionFor(entry: BoardEntry): string | null {
  switch (entry.status) {
    case 'ready_to_submit':
      return 'Review the filled application and submit it'
    case 'needs_human':
      return `Finish by hand: ${entry.reason ?? 'needs input'}`.slice(0, 480)
    case 'failed':
      return `Retry or apply by hand: ${entry.reason ?? 'error'}`.slice(0, 480)
    case 'submitted_unconfirmed':
      return 'Check that the application went through'
    default:
      return null
  }
}

export function notesFor(entry: BoardEntry): string {
  const parts = [`Auto Apply status: ${entry.status}`]
  if (entry.reason) parts.push(entry.reason)
  if (entry.resumeFile) parts.push(`Tailored resume: ${entry.resumeFile}`)
  return parts.join('. ')
}

/** Used when the user has not connected a board. The web app shows statuses itself. */
export class NoopBoardLogger implements BoardLogger {
  readonly name = 'none'
  async log(): Promise<void> {}
}

/** Keeps entries in memory. For tests and the demo. */
export class MemoryBoardLogger implements BoardLogger {
  readonly name = 'memory'
  readonly entries: BoardEntry[] = []
  async log(entry: BoardEntry): Promise<void> {
    this.entries.push(entry)
  }
}
