import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { boardStage, nextActionFor, notesFor, type BoardEntry, type BoardLogger } from './types'

/** Local JSONL log. Used when no board is configured or the board cannot be reached. */
export class FileBoardLogger implements BoardLogger {
  readonly name = 'file'
  private last = new Map<string, string>()

  constructor(
    private readonly path: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (existsSync(path)) {
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          const row = JSON.parse(line) as { jobId: string; status: string; reason?: string }
          this.last.set(row.jobId, `${row.status}|${row.reason ?? ''}`)
        } catch {
          // Skip a damaged line.
        }
      }
    }
  }

  async log(entry: BoardEntry): Promise<void> {
    const sig = `${entry.status}|${entry.reason ?? ''}`
    if (this.last.get(entry.job.id) === sig) return // idempotent
    mkdirSync(dirname(this.path), { recursive: true })
    appendFileSync(
      this.path,
      JSON.stringify({
        ts: this.now().toISOString(),
        jobId: entry.job.id,
        company: entry.job.company,
        role: entry.job.title,
        link: entry.job.applyUrl,
        source: entry.job.source,
        stage: boardStage(entry.status),
        status: entry.status,
        reason: entry.reason,
        nextAction: nextActionFor(entry),
        notes: notesFor(entry),
        resume: entry.resumeFile,
      }) + '\n',
    )
    this.last.set(entry.job.id, sig)
  }
}
