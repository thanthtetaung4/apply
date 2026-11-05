import type { ApplyTarget } from '../shared/status'

export interface TargetRule {
  pattern: RegExp
  target: ApplyTarget
}

/**
 * Decide where the application form lives from its URL.
 * `boardHost` is the job board's own host: a link that stays on it is a board native flow.
 * `rules` are extra URL patterns checked first (used for local test sites).
 */
export function classifyApplyTarget(
  applyUrl: string,
  boardHost: string,
  rules: TargetRule[] = [],
): ApplyTarget {
  let url: URL
  try {
    url = new URL(applyUrl)
  } catch {
    return 'company_site'
  }
  for (const r of rules) if (r.pattern.test(applyUrl)) return r.target
  const host = url.hostname.toLowerCase()
  if (host.endsWith('greenhouse.io')) return 'greenhouse'
  if (host.includes('myworkdayjobs.com') || host.endsWith('workday.com')) return 'workday'
  // The board itself, including its country subdomains: job links from www.linkedin.com search
  // point at sg.linkedin.com.
  const board = boardHost.toLowerCase().replace(/^www\./, '')
  if (host === board || host.endsWith(`.${board}`)) return 'board_native'
  return 'company_site'
}
