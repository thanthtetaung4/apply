export const JOB_STATUSES = [
  'queued',
  'tailoring',
  'ready',
  'filling',
  'verifying',
  'ready_to_submit',
  'submitted',
  'submitted_unconfirmed',
  'needs_human',
  'failed',
  'skipped',
] as const
export type JobStatus = (typeof JOB_STATUSES)[number]

export const SITE_TYPES = [
  'greenhouse',
  'workday',
  'indeed',
  'linkedin',
  'glassdoor',
  'company_site',
] as const
export type SiteType = (typeof SITE_TYPES)[number]

/** Boards the app searches for jobs. */
export const SEARCH_SOURCES = ['indeed', 'linkedin', 'glassdoor'] as const
export type SearchSource = (typeof SEARCH_SOURCES)[number]

/** Company careers pages the user watches, read through their hiring system's job API. */
export const WATCHLIST_SOURCE = 'company'

/** What an intake can be asked to search: the boards and the company watchlist. */
export const INTAKE_SOURCES = [...SEARCH_SOURCES, WATCHLIST_SOURCE] as const
export type IntakeSource = (typeof INTAKE_SOURCES)[number]

/**
 * Where a job came from: a board search, a watched company careers page ("company"), or "direct"
 * (a link the user added).
 */
export const JOB_SOURCES = [...INTAKE_SOURCES, 'direct'] as const
export type JobSource = (typeof JOB_SOURCES)[number]

export const APPLY_TARGETS = ['board_native', 'greenhouse', 'workday', 'company_site'] as const
export type ApplyTarget = (typeof APPLY_TARGETS)[number]
