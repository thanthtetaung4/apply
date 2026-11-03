import type { BackendRegistry } from '../browser/registry'
import type { BrowserSession } from '../browser/types'
import type { SourceConfig, UserSettings } from '../settings'
import type { LoadedProfile } from '../profile'
import type { JobStore, SessionStore } from '../store'
import { normalizeText, stableId } from '../shared/hash'
import type { Job } from '../shared/job'
import { JOB_SOURCES, type JobSource } from '../shared/status'
import { classifyApplyTarget, type TargetRule } from './classify'
import { matchScore, skipReasonFor, type SkipReason } from './filter'
import { parseJobPage, parseSearchLinks } from './parse'

export interface IntakeSummary {
  found: number
  queued: number
  skipped: Record<SkipReason | 'already_seen' | 'unreadable', number>
  perSource: Record<string, { found: number; queued: number }>
  errors: string[]
}

export interface IntakeDeps {
  settings: UserSettings
  registry: BackendRegistry
  profile: LoadedProfile
  store: JobStore
  sessions: SessionStore
  log?: (line: string) => void
  /** Only these sources. Default: all enabled ones. */
  sources?: JobSource[]
  /** Extra URL rules for classifying apply targets (local test sites). */
  targetRules?: TargetRule[]
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
  }
  const sources = (d.sources ?? [...JOB_SOURCES]).filter((s) => d.settings.sources[s].enabled)
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
      session = await d.registry.launch(site.backend, {
        headless: site.headless,
        storageState: await d.sessions.get(source),
      })
      const boardHost = new URL(cfg.baseUrl).hostname

      const jobUrls: string[] = []
      for (const title of d.profile.titles.titles) {
        for (const loc of locations) {
          const url = new URL(fill(cfg.searchPath, title, loc), cfg.baseUrl).toString()
          await session.open(url)
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
  return summary
}

export type { TargetRule } from './classify'
export { classifyApplyTarget } from './classify'
