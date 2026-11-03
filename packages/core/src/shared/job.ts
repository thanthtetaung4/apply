import type { ApplyTarget, JobSource } from './status'

export interface Job {
  id: string
  source: JobSource
  sourceUrl?: string
  title: string
  company: string
  location?: string
  description: string
  /** Where the application form lives. For board native flows this is the board page. */
  applyUrl: string
  applyTarget: ApplyTarget
  postedAt?: string
  fetchedAt: string
}
