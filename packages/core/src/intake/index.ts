import type { BackendRegistry } from '../browser/registry'
import type { BrowserSession } from '../browser/types'
import type { SourceConfig, UserSettings } from '../settings'
import type { LoadedProfile } from '../profile'
import type { JobStore, SessionStore } from '../store'
import { isBlockedPage, isSignInForm } from '../apply/recipes'
import { normalizeText, stableId } from '../shared/hash'
import type { Job } from '../shared/job'
import {
  SEARCH_SOURCES,
  WATCHLIST_SOURCE,
  type IntakeSource,
  type JobSource,
  type SearchSource,
} from '../shared/status'
import { CAREERS_SITE_LABEL, parseCareersUrl } from './careers-url'
import { classifyApplyTarget, type TargetRule } from './classify'
import { matchScore, skipReasonFor, type SkipReason } from './filter'
import { parseJobPage, parseSearchLinks } from './parse'
import { listCompanyJobs, type FetchLike, type Listing } from './watchlist'

export interface IntakeSummary {
  found: number
  queued: number
  skipped: Record<SkipReason | 'already_seen' | 'unreadable', number>
  perSource: Record<string, { found: number; queued: number }>
  errors: string[]
  /** Boards that showed a sign in page instead of search results. */
  needsSignIn: JobSource[]
  /** Boards whose bot protection blocked the browser. */
  blocked: JobSource[]
}

export interface IntakeDeps {
  settings: UserSettings
  registry: BackendRegistry
  profile: LoadedProfile
  store: JobStore
  sessions: SessionStore
  log?: (line: string) => void
  /**
   * Only these boards and/or the company watchlist ("company"). Default: all enabled ones. With
   * `urls` and no `sources`, none.
   */
  sources?: IntakeSource[]
  /**
   * Job pages the user added by link (company career pages, Greenhouse, Lever, Ashby). Saved as
   * source "direct". The user chose them, so title and location filters do not apply.
   */
  urls?: string[]
  /** Extra URL rules for classifying apply targets (local test sites). */
  targetRules?: TargetRule[]
  /** For the company watchlist's job APIs. Default: the global fetch. */
  fetch?: FetchLike
  /** Parse and report without saving. */
  dryRun?: boolean
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
}

const fill = (tpl: string, q: string, l: string) =>
  tpl.replace('{q}', encodeURIComponent(q)).replace('{l}', encodeURIComponent(l))

/** The URL that identifies a job on its board, without tracking parameters. */
function canonical(url: string): string {
  const u = new URL(url)
  const keep = ['jk', 'jobId', 'id']
  const params = [...u.searchParams].filter(([k]) => keep.includes(k))
  return `${u.origin}${u.pathname}${params.length ? '?' + params.map(([k, v]) => `${k}=${v}`).join('&') : ''}`
}

/**
 * Find jobs on the boards, work out where each application lives, and queue the good ones.
 * Boards are used for discovery. When a job links out to the employer, that page is the target.
 */
export async function runIntake(d: IntakeDeps): Promise<IntakeSummary> {
  const summary: IntakeSummary = {
    found: 0,
    queued: 0,
    skipped: {
      excluded_title: 0,
      title_mismatch: 0,
      location_mismatch: 0,
      duplicate: 0,
      already_seen: 0,
      unreadable: 0,
    },
    perSource: {},
    errors: [],
    needsSignIn: [],
    blocked: [],
  }
  // Adding links only does not also search every board.
  const wanted: IntakeSource[] =
    d.sources ?? (d.urls?.length ? [] : [...SEARCH_SOURCES, WATCHLIST_SOURCE])
  const sources = wanted
    .filter((s): s is SearchSource => s !== WATCHLIST_SOURCE)
    .filter((s) => d.settings.sources[s].enabled)
  const seenThisRun = new Set<string>()
  const jobKeysThisRun = new Set<string>()
  const now = d.now ?? (() => new Date())
  const locations = d.profile.titles.locations.length ? d.profile.titles.locations : ['']

  for (const source of sources) {
    const cfg: SourceConfig = d.settings.sources[source]
    const site = d.settings.sites[source]
    summary.perSource[source] = { found: 0, queued: 0 }
    let session: BrowserSession | undefined
    try {
      const saved = await d.sessions.get(source)
      session = await d.registry.launch(site.backend, {
        headless: site.headless,
        storageState: saved,
      })
      const boardHost = new URL(cfg.baseUrl).hostname

      const jobUrls: string[] = []
      for (const title of d.profile.titles.titles) {
        for (const loc of locations) {
          const url = new URL(fill(cfg.searchPath, title, loc), cfg.baseUrl).toString()
          await session.open(url)
          // Bot protection instead of results. Reported, never worked around.
          if (isBlockedPage(await session.snapshot())) {
            summary.blocked.push(source)
            throw new Error(
              `${source} blocked the automated browser with its bot protection, so it was skipped.`,
            )
          }
          // A sign in wall instead of results. Without this check the board just looks empty.
          if (isSignInForm(await session.formSchema())) {
            if (saved) await d.sessions.markExpired?.(source)
            summary.needsSignIn.push(source)
            throw new Error(
              `${source} asked you to sign in${saved ? ' again' : ''}. Connect it on the Connections page.`,
            )
          }
          for (const link of parseSearchLinks(
            await session.content(),
            url,
            cfg.linkSelector,
            cfg.maxPerSearch,
          )) {
            const key = canonical(link)
            if (!seenThisRun.has(key)) {
              seenThisRun.add(key)
              jobUrls.push(link)
            }
          }
        }
      }

      for (const url of jobUrls) {
        summary.found++
        summary.perSource[source]!.found++
        const id = stableId('job', source, canonical(url))
        if (await d.store.getJob(id)) {
          summary.skipped.already_seen++
          continue
        }
        await session.open(url)
        // Boards let a signed out visitor see a few job pages, then send them to a sign in or
        // sign up wall (LinkedIn's /authwall). Stop with a clear message instead of reading it.
        const landed = new URL(await session.url())
        if (/\/(authwall|login|signin|signup|uas\/login|checkpoint)(\/|$)/i.test(landed.pathname)) {
          if (saved) await d.sessions.markExpired?.(source)
          summary.needsSignIn.push(source)
          throw new Error(
            `${source} asked you to sign in after a few job pages. Connect it on the Connections page.`,
          )
        }
        if (isBlockedPage(await session.snapshot())) {
          summary.blocked.push(source)
          throw new Error(`${source} blocked the automated browser with its bot protection.`)
        }
        const page = parseJobPage(await session.content(), url)
        if (!page.title || !page.company) {
          summary.skipped.unreadable++
          d.log?.(`unreadable ${url}`)
          continue
        }

        const applyUrl =
          page.externalApplyUrl ?? (page.hasEasyApplyButton ? url : (page.boardApplyUrl ?? url))
        const job: Job = {
          id,
          source,
          sourceUrl: url,
          title: page.title,
          company: page.company,
          location: page.location,
          description: page.description,
          applyUrl,
          applyTarget: classifyApplyTarget(applyUrl, boardHost, d.targetRules),
          postedAt: page.postedAt,
          fetchedAt: now().toISOString(),
        }

        let reason: SkipReason | null = skipReasonFor(job, d.profile)
        // Duplicate: saved earlier, or the same job already seen on another board in this run.
        const keys = [
          job.applyUrl,
          [job.company, job.title, job.location ?? ''].map(normalizeText).join('|'),
        ]
        if (
          !reason &&
          ((await d.store.findDuplicate(job)) || keys.some((k) => jobKeysThisRun.has(k)))
        )
          reason = 'duplicate'
        if (!reason) keys.forEach((k) => jobKeysThisRun.add(k))
        const score = matchScore(job, d.profile)
        if (reason) {
          summary.skipped[reason]++
          if (!d.dryRun) await d.store.addJob(job, 'skipped', reason, score)
          d.log?.(`skipped   ${job.company} | ${job.title}  (${reason})`)
          continue
        }
        if (!d.dryRun) await d.store.addJob(job, 'queued', undefined, score)
        summary.queued++
        summary.perSource[source]!.queued++
        d.log?.(`queued    ${job.company} | ${job.title}  [${job.applyTarget}, score ${score}]`)
      }
    } catch (err) {
      summary.errors.push(`${source}: ${(err as Error).message}`)
      d.log?.(`source ${source} failed: ${(err as Error).message}`)
    } finally {
      await session?.close()
    }
  }

  if (
    wanted.includes(WATCHLIST_SOURCE) &&
    d.settings.watchlist.enabled &&
    d.settings.watchlist.companies.length > 0
  )
    await searchWatchlist(d, summary, jobKeysThisRun, now)
  if (d.urls?.length) await addLinks(d, d.urls, summary, jobKeysThisRun, now)
  return summary
}

/** Most Workday detail pages read per company in one search. */
const MAX_DETAIL_LOADS = 30

/**
 * Read each watched company's careers page through its hiring system's job API, filter with the
 * profile like a board search, and queue the best new matches (up to `maxPerCompany` each).
 * Jobs that do not match are counted but not saved: a company lists hundreds of them.
 */
async function searchWatchlist(
  d: IntakeDeps,
  summary: IntakeSummary,
  jobKeysThisRun: Set<string>,
  now: () => Date,
): Promise<void> {
  const source = WATCHLIST_SOURCE
  const per = (summary.perSource[source] = { found: 0, queued: 0 })
  const doFetch = d.fetch ?? ((url: string, init?: RequestInit) => fetch(url, init))
  const { maxPerCompany, companies } = d.settings.watchlist

  for (const careersUrl of companies) {
    const site = parseCareersUrl(careersUrl)
    if (!site) continue // settings validation rejects these; skip rather than fail the run
    const label = `${CAREERS_SITE_LABEL[site.kind]} ${careersUrl}`
    try {
      const listings = await listCompanyJobs(site, {
        fetch: doFetch,
        titles: d.profile.titles.titles,
      })
      const candidates: { job: Job; score: number }[] = []
      let detailLoads = 0
      for (const l of listings) {
        summary.found++
        per.found++
        // Title and exclude words first: no request and no database read for most jobs.
        const titleReason = skipReasonFor({ title: l.title }, d.profile)
        if (titleReason) {
          summary.skipped[titleReason]++
          continue
        }
        const id = stableId('job', source, canonical(l.url))
        if (await d.store.getJob(id)) {
          summary.skipped.already_seen++
          continue
        }
        let full: Listing = l
        if (l.details) {
          if (detailLoads >= MAX_DETAIL_LOADS) continue // left for the next search
          detailLoads++
          full = { ...l, ...(await l.details()) }
        }
        const job: Job = {
          id,
          source,
          sourceUrl: full.url,
          title: full.title,
          company: full.company,
          location: full.location,
          description: full.description,
          applyUrl: full.applyUrl,
          applyTarget: classifyApplyTarget(full.applyUrl, '', d.targetRules),
          postedAt: full.postedAt,
          fetchedAt: now().toISOString(),
        }
        const reason = skipReasonFor(job, d.profile)
        if (reason) {
          summary.skipped[reason]++
          continue
        }
        candidates.push({ job, score: matchScore(job, d.profile) })
      }

      candidates.sort((a, b) => b.score - a.score)
      let queued = 0
      for (const { job, score } of candidates) {
        if (queued >= maxPerCompany) break // the rest stay unsaved and come back next search
        const keys = [
          job.applyUrl,
          [job.company, job.title, job.location ?? ''].map(normalizeText).join('|'),
        ]
        if ((await d.store.findDuplicate(job)) || keys.some((k) => jobKeysThisRun.has(k))) {
          summary.skipped.duplicate++
          d.log?.(`skipped   ${job.company} | ${job.title}  (duplicate)`)
          continue
        }
        keys.forEach((k) => jobKeysThisRun.add(k))
        if (!d.dryRun) await d.store.addJob(job, 'queued', undefined, score)
        queued++
        summary.queued++
        per.queued++
        d.log?.(`queued    ${job.company} | ${job.title}  [${job.applyTarget}, score ${score}]`)
      }
      d.log?.(`${label}: ${listings.length} jobs listed, ${queued} queued`)
    } catch (err) {
      const message = `${label}: ${(err as Error).message}`
      summary.errors.push(`${source}: ${message}`)
      d.log?.(`source ${source} failed: ${message}`)
    }
  }
}

/** "careers.thunes.com" or "job-boards.greenhouse.io/okx/..." to a company name, if the page has none. */
function companyFromUrl(url: string): string {
  const u = new URL(url)
  // An address like 127.0.0.1 or localhost names no company.
  if (/^[\d.]+$|^localhost$|^\[/.test(u.hostname)) return ''
  const ats = /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com)$/.test(u.hostname)
  const word = ats
    ? (u.pathname.split('/').filter(Boolean)[0] ?? '')
    : (u.hostname.replace(/^(www|jobs|careers|boards|apply)\./, '').split('.')[0] ?? '')
  return word ? word.charAt(0).toUpperCase() + word.slice(1) : ''
}

/** Read job pages the user added and queue them as "direct" jobs. */
async function addLinks(
  d: IntakeDeps,
  urls: string[],
  summary: IntakeSummary,
  jobKeysThisRun: Set<string>,
  now: () => Date,
): Promise<void> {
  const site = d.settings.sites.company_site
  summary.perSource.direct = { found: 0, queued: 0 }
  let session: BrowserSession | undefined
  try {
    session = await d.registry.launch(site.backend, { headless: site.headless })
    for (const url of urls) {
      try {
        if (!/^https?:\/\//i.test(url)) throw new Error('not a web address')
        summary.found++
        summary.perSource.direct.found++
        const id = stableId('job', 'direct', canonical(url))
        if (await d.store.getJob(id)) {
          summary.skipped.already_seen++
          d.log?.(`already added ${url}`)
          continue
        }
        await session.open(url)
        if (isBlockedPage(await session.snapshot())) {
          summary.blocked.push('direct')
          throw new Error('the site blocked the automated browser')
        }
        const page = parseJobPage(await session.content(), url)
        const company = page.company || companyFromUrl(url)
        if (!page.title || !company) {
          summary.skipped.unreadable++
          d.log?.(`unreadable ${url}`)
          continue
        }
        // Apply where the page sends you: the employer site it links to, its own "Apply" page
        // (Stripe keeps the form on /careers/apply/...), or else the page the user gave.
        const applyUrl = page.externalApplyUrl ?? page.boardApplyUrl ?? url
        const job: Job = {
          id,
          source: 'direct',
          sourceUrl: url,
          title: page.title,
          company,
          location: page.location,
          description: page.description,
          applyUrl,
          applyTarget: classifyApplyTarget(applyUrl, '', d.targetRules),
          postedAt: page.postedAt,
          fetchedAt: now().toISOString(),
        }
        const score = matchScore(job, d.profile)
        const keys = [
          job.applyUrl,
          [job.company, job.title, job.location ?? ''].map(normalizeText).join('|'),
        ]
        if ((await d.store.findDuplicate(job)) || keys.some((k) => jobKeysThisRun.has(k))) {
          summary.skipped.duplicate++
          if (!d.dryRun) await d.store.addJob(job, 'skipped', 'duplicate', score)
          d.log?.(`skipped   ${job.company} | ${job.title}  (duplicate)`)
          continue
        }
        keys.forEach((k) => jobKeysThisRun.add(k))
        if (!d.dryRun) await d.store.addJob(job, 'queued', undefined, score)
        summary.queued++
        summary.perSource.direct.queued++
        d.log?.(`queued    ${job.company} | ${job.title}  [${job.applyTarget}, score ${score}]`)
      } catch (err) {
        summary.errors.push(`${url}: ${(err as Error).message}`)
        d.log?.(`link failed ${url}: ${(err as Error).message}`)
      }
    }
  } finally {
    await session?.close()
  }
}

export type { TargetRule } from './classify'
export { classifyApplyTarget } from './classify'
