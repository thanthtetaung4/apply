import { parseSettings, type UserSettings } from '@apply/core/settings'
import { SITE_TYPES } from '@apply/core/status'

const num = (fd: FormData, k: string): number | undefined => {
  const v = fd.get(k)
  if (v === null || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : NaN
}
const bool = (fd: FormData, k: string) => fd.get(k) === 'on'
const text = (fd: FormData, k: string) => {
  const v = fd.get(k)
  return v === null ? undefined : String(v).trim()
}

/**
 * Apply a submitted settings form on top of the current settings. Only fields present in the form
 * change, so settings the form does not show (such as headless) are kept.
 */
export function formToSettings(
  fd: FormData,
  current: UserSettings,
): ReturnType<typeof parseSettings> {
  const s: UserSettings = structuredClone(current)
  const set = <T>(v: T | undefined, apply: (v: T) => void) => {
    if (v !== undefined) apply(v)
  }

  set(num(fd, 'workers'), (v) => (s.workers = v))
  set(num(fd, 'maxAttempts'), (v) => (s.maxAttempts = v))
  set(num(fd, 'pacing.minDelayMs'), (v) => (s.pacing.minDelayMs = v * 1000))
  set(num(fd, 'pacing.maxDelayMs'), (v) => (s.pacing.maxDelayMs = v * 1000))
  s.gate.enforce = bool(fd, 'gate.enforce')
  set(num(fd, 'gate.minRuns'), (v) => (s.gate.minRuns = v))
  set(num(fd, 'gate.minAccuracy'), (v) => (s.gate.minAccuracy = v / 100))
  for (const m of ['cheap', 'mid', 'strong'] as const)
    set(text(fd, `llm.models.${m}`), (v) => (s.llm.models[m] = v))
  set(num(fd, 'llm.dailyBudgetUsd'), (v) => (s.llm.dailyBudgetUsd = v))

  for (const t of SITE_TYPES) {
    set(
      text(fd, `sites.${t}.submit`),
      (v) => (s.sites[t].submit = v as 'auto' | 'review' | 'manual'),
    )
    set(num(fd, `sites.${t}.dailyCap`), (v) => (s.sites[t].dailyCap = v))
    set(text(fd, `sites.${t}.backend`), (v) => (s.sites[t].backend = v))
    // An empty choice means "no fallback browser".
    set(text(fd, `sites.${t}.fallback`), (v) => {
      if (v) s.sites[t].fallback = v
      else delete s.sites[t].fallback
    })
  }
  for (const src of ['indeed', 'linkedin', 'glassdoor'] as const) {
    s.sources[src].enabled = bool(fd, `sources.${src}.enabled`)
    set(text(fd, `sources.${src}.baseUrl`), (v) => (s.sources[src].baseUrl = v))
    set(text(fd, `sources.${src}.searchPath`), (v) => (s.sources[src].searchPath = v))
    set(text(fd, `sources.${src}.linkSelector`), (v) => (s.sources[src].linkSelector = v))
    set(num(fd, `sources.${src}.maxPerSearch`), (v) => (s.sources[src].maxPerSearch = v))
  }
  // The watchlist box sends one careers page per line. Only change it when the form has it.
  if (fd.has('watchlist.companies')) {
    s.watchlist.enabled = bool(fd, 'watchlist.enabled')
    s.watchlist.companies = [
      ...new Set(
        String(fd.get('watchlist.companies'))
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean),
      ),
    ]
  }
  set(num(fd, 'watchlist.maxPerCompany'), (v) => (s.watchlist.maxPerCompany = v))
  s.backends.shadow.enabled = bool(fd, 'backends.shadow.enabled')
  set(text(fd, 'backends.shadow.name'), (v) => (s.backends.shadow.name = v))
  set(num(fd, 'backends.shadow.sample'), (v) => (s.backends.shadow.sample = v / 100))

  return parseSettings(s)
}

/** Readable names for setting paths, used in error messages. */
const LABELS: [RegExp, string][] = [
  [/^pacing\.minDelayMs/, 'Shortest pause'],
  [/^pacing\.maxDelayMs/, 'Longest pause'],
  [/^workers/, 'Browsers at once'],
  [/^maxAttempts/, 'Tries per job'],
  [/^gate\.minRuns/, 'Verified runs needed'],
  [/^gate\.minAccuracy/, 'Share that must pass checks'],
  [/^llm\.models\.(\w+)/, 'Model ($1)'],
  [/^llm\.dailyBudgetUsd/, 'Daily model budget'],
  [/^sites\.(\w+)\.dailyCap/, 'Max per day ($1)'],
  [/^sites\.(\w+)\.(backend|fallback)/, 'Browser ($1)'],
  [/^sources\.(\w+)\.baseUrl/, 'Site address ($1)'],
  [/^sources\.(\w+)\.searchPath/, 'Search path ($1)'],
  [/^sources\.(\w+)\.linkSelector/, 'Job link selector ($1)'],
  [/^sources\.(\w+)\.maxPerSearch/, 'Jobs per search ($1)'],
  [/^backends\.shadow\.sample/, 'Share of jobs compared'],
  [/^watchlist\.companies(\.\d+)?/, 'Company careers pages'],
  [/^watchlist\.maxPerCompany/, 'New jobs per company'],
]

/** "pacing.maxDelayMs: message" becomes "Longest pause: message". */
export function settingLabel(issue: string): string {
  const i = issue.indexOf(': ')
  if (i < 0) return issue
  const path = issue.slice(0, i)
  for (const [re, label] of LABELS)
    if (re.test(path)) return `${path.replace(re, label)}: ${issue.slice(i + 2)}`
  return issue
}
