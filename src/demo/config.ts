import { join } from 'node:path'
import type { AppConfig } from '../config/schema'

/** Config that points every source at a local mock server and keeps all output under one folder. */
export function demoConfig(base: AppConfig, serverUrl: string, outRoot: string): AppConfig {
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
  return {
    ...base,
    profileDir: join(outRoot, 'profile'),
    dataDir: join(outRoot, 'data'),
    outputDir: join(outRoot, 'output'),
    sessionsDir: join(outRoot, 'sessions'),
    workers: 2,
    pacing: { minDelayMs: 0, maxDelayMs: 0 },
    gate: { ...base.gate, enforce: false },
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
    backends: { shadow: { enabled: false, name: 'playwright-lean', sample: 1 } },
  }
}
