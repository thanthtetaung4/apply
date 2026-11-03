export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'gray'

export const STATUS_LABEL: Record<string, string> = {
  queued: 'Queued',
  tailoring: 'Making resume',
  ready: 'Ready to apply',
  filling: 'Filling form',
  verifying: 'Checking',
  ready_to_submit: 'Review',
  submitted: 'Submitted',
  submitted_unconfirmed: 'Submitted, unconfirmed',
  needs_human: 'Needs you',
  failed: 'Failed',
  skipped: 'Skipped',
}

export const STATUS_TONE: Record<string, Tone> = {
  queued: 'gray',
  tailoring: 'info',
  ready: 'info',
  filling: 'info',
  verifying: 'info',
  ready_to_submit: 'warn',
  submitted: 'ok',
  submitted_unconfirmed: 'warn',
  needs_human: 'bad',
  failed: 'bad',
  skipped: 'gray',
}

export const SITE_LABEL: Record<string, string> = {
  greenhouse: 'Greenhouse',
  workday: 'Workday',
  indeed: 'Indeed',
  linkedin: 'LinkedIn',
  glassdoor: 'Glassdoor',
  company_site: 'Company site',
}

export function timeAgo(d: Date | string | null | undefined, now = Date.now()): string {
  if (!d) return ''
  const t = typeof d === 'string' ? new Date(d).getTime() : d.getTime()
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return `${Math.floor(s / 86400)} d ago`
}

/** The questions listed in a "needs an answer" reason. */
export function questionsFromReason(reason: string | null | undefined): string[] {
  const m = /^Needs an answer for:\s*(.+)$/s.exec(reason ?? '')
  return m
    ? m[1]!
        .split(' | ')
        .map((q) => q.trim())
        .filter(Boolean)
    : []
}

export const BLOCK_HELP: Record<string, string> = {
  captcha: 'The site asked to prove you are human. Apply by hand, then mark it as applied.',
  login_required:
    'The site needs you signed in. Connect your account on the Connections page, then retry.',
  unknown_question:
    'The form asks something your saved answers do not cover. Answer it once and every later application can reuse it.',
  manual_policy: 'You set this site to manual, so the app never opens its forms. Apply by hand.',
  verification_failed: 'A value did not stay in the form, so nothing was submitted.',
  validation: 'The site rejected a step. Check the details and retry, or apply by hand.',
  fill_failed: 'A field could not be filled. Retry, or apply by hand.',
  no_form: 'No application form was found. The posting may be closed.',
  error_page: 'The posting looks closed or removed.',
  stuck: 'The form did not move forward. Apply by hand.',
  too_many_steps: 'The form has more steps than expected. Apply by hand.',
  error: 'Something went wrong while running this job.',
}
