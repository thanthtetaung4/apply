/**
 * Company careers pages the watchlist can read through the hiring system's public job API.
 * No browser is involved, so there is no bot protection to run into.
 */
export type CareersSite =
  | { kind: 'greenhouse'; slug: string }
  | { kind: 'lever'; slug: string; eu: boolean }
  | { kind: 'ashby'; slug: string }
  | { kind: 'workday'; origin: string; tenant: string; site: string }

export const CAREERS_SITE_LABEL: Record<CareersSite['kind'], string> = {
  greenhouse: 'Greenhouse',
  lever: 'Lever',
  ashby: 'Ashby',
  workday: 'Workday',
}

/** Example links, shown in the settings page and in error messages. */
export const CAREERS_URL_EXAMPLES = [
  'https://job-boards.greenhouse.io/stripe',
  'https://jobs.lever.co/palantir',
  'https://jobs.ashbyhq.com/openai',
  'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite',
]

const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const LOCALE = /^[a-z]{2}(-[A-Za-z]{2})?$/

/** Work out which hiring system a careers page link belongs to. Null when it is not supported. */
export function parseCareersUrl(input: string): CareersSite | null {
  let u: URL
  try {
    u = new URL(input.trim())
  } catch {
    return null
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  const host = u.hostname.toLowerCase()
  const parts = u.pathname.split('/').filter(Boolean)
  const first = parts[0] ?? ''

  if (host === 'boards.greenhouse.io' || host === 'job-boards.greenhouse.io') {
    return SLUG.test(first) ? { kind: 'greenhouse', slug: first } : null
  }
  if (host === 'boards-api.greenhouse.io') {
    // https://boards-api.greenhouse.io/v1/boards/{slug}/jobs
    const slug = parts[0] === 'v1' && parts[1] === 'boards' ? (parts[2] ?? '') : ''
    return SLUG.test(slug) ? { kind: 'greenhouse', slug } : null
  }
  if (host === 'jobs.lever.co' || host === 'jobs.eu.lever.co') {
    return SLUG.test(first) ? { kind: 'lever', slug: first, eu: host === 'jobs.eu.lever.co' } : null
  }
  if (host === 'jobs.ashbyhq.com') {
    return SLUG.test(first) ? { kind: 'ashby', slug: first } : null
  }
  // https://{tenant}.wd{N}.myworkdayjobs.com/[en-US/]{site}
  const wd = /^([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com$/.exec(host)
  if (wd) {
    const site = LOCALE.test(first) ? (parts[1] ?? '') : first
    if (!SLUG.test(site) || site === 'job' || site === 'wday') return null
    return { kind: 'workday', origin: `https://${host}`, tenant: wd[1]!, site }
  }
  return null
}

/** One readable line for a careers page that is not supported. */
export function careersUrlProblem(input: string): string | null {
  if (parseCareersUrl(input)) return null
  return `"${input}" is not a Greenhouse, Lever, Ashby or Workday careers page (for example ${CAREERS_URL_EXAMPLES[0]})`
}
