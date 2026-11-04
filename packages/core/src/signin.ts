import { sessionKeyFor } from './apply/recipes'
import type { UserSettings } from './settings'

/**
 * Sites a user can connect by signing in through the streamed browser window. Shared by the web
 * app (which site, which session name) and the worker (where the window may go).
 */

export const SIGN_IN_SITES = ['linkedin', 'indeed', 'glassdoor', 'workday'] as const
export type SignInSite = (typeof SIGN_IN_SITES)[number]

export const SIGN_IN_LABEL: Record<SignInSite, string> = {
  linkedin: 'LinkedIn',
  indeed: 'Indeed',
  glassdoor: 'Glassdoor',
  workday: 'Workday',
}

/**
 * Hosts the window may navigate to, per site. Subresources (scripts, images, CAPTCHA widgets)
 * load from anywhere; only top level page loads are limited, so the window cannot be used to
 * browse the web through our server.
 */
const HOSTS: Record<SignInSite, RegExp> = {
  linkedin: /(^|\.)linkedin\.com$/,
  indeed: /(^|\.)indeed\.(com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$/,
  glassdoor: /(^|\.)glassdoor\.(com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$/,
  workday: /(^|\.)(myworkdayjobs|myworkday|workday)\.com$/,
}

export const isSignInSite = (s: unknown): s is SignInSite =>
  (SIGN_IN_SITES as readonly unknown[]).includes(s)

/** Whether the window may open this host for this site. `extra` is for local test sites only. */
export function signInHostAllowed(site: SignInSite, host: string, extra: string[] = []): boolean {
  const h = host.toLowerCase()
  return HOSTS[site].test(h) || extra.includes(h)
}

export interface SignInTarget {
  site: SignInSite
  /** Session name the result is saved under: linkedin, indeed, glassdoor, workday-<company>. */
  key: string
  /** First page the window opens. */
  url: string
}

/**
 * Where to start signing in. Indeed and Glassdoor use the country site from the user's settings.
 * Workday has one account per company, so it needs a job link of that company.
 */
export function signInTarget(
  site: SignInSite,
  settings: UserSettings,
  workdayUrl?: string,
): SignInTarget | { error: string } {
  switch (site) {
    case 'linkedin':
      return { site, key: 'linkedin', url: 'https://www.linkedin.com/login' }
    case 'indeed':
      return {
        site,
        key: 'indeed',
        url: new URL('/account/login', settings.sources.indeed.baseUrl).toString(),
      }
    case 'glassdoor':
      return {
        site,
        key: 'glassdoor',
        url: new URL('/profile/login_input.htm', settings.sources.glassdoor.baseUrl).toString(),
      }
    case 'workday': {
      let u: URL
      try {
        u = new URL((workdayUrl ?? '').trim())
      } catch {
        return { error: 'Paste a job link from the company Workday site.' }
      }
      if (u.protocol !== 'https:' && u.protocol !== 'http:')
        return { error: 'Paste a job link from the company Workday site.' }
      const key = sessionKeyFor('workday', u.toString())
      if (!key || key === 'workday')
        return {
          error:
            'That does not look like a Workday job link. It usually contains myworkdayjobs.com.',
        }
      return { site, key, url: u.toString() }
    }
  }
}
