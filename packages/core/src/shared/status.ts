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

export const JOB_SOURCES = ['indeed', 'linkedin', 'glassdoor'] as const
export type JobSource = (typeof JOB_SOURCES)[number]

export const APPLY_TARGETS = ['board_native', 'greenhouse', 'workday', 'company_site'] as const
export type ApplyTarget = (typeof APPLY_TARGETS)[number]
