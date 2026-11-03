import { UserSettingsSchema, type UserSettings } from '../settings'

/** Settings that point every source at a local mock server. Headless, no pauses, greenhouse and company sites on auto. */
export function demoSettings(serverUrl: string, over: Partial<UserSettings> = {}): UserSettings {
  const site = (submit: 'auto' | 'review') => ({
    backend: 'playwright-chromium',
    submit,
    dailyCap: 20,
    headless: true,
  })
  const src = (path: string, selector: string) => ({
    enabled: true,
    baseUrl: serverUrl,
    searchPath: path,
    linkSelector: selector,
    maxPerSearch: 10,
  })
  return UserSettingsSchema.parse({
    workers: 2,
    pacing: { minDelayMs: 0, maxDelayMs: 0 },
    gate: { enforce: false },
    sites: {
      greenhouse: site('auto'),
      company_site: site('auto'),
      workday: site('review'),
      indeed: site('review'),
      linkedin: site('review'),
      glassdoor: site('review'),
    },
    sources: {
      indeed: src('/indeed/jobs?q={q}&l={l}', 'a[href*="/viewjob"]'),
      linkedin: src('/linkedin/jobs/search?keywords={q}&location={l}', 'a[href*="/jobs/view/"]'),
      glassdoor: src(
        '/glassdoor/Job/jobs.htm?sc.keyword={q}&locKeyword={l}',
        'a[href*="/job-listing/"]',
      ),
    },
    ...over,
  })
}
