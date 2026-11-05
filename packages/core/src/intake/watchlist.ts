import { parse } from 'node-html-parser'
import type { CareersSite } from './careers-url'

/** One job from a company's careers page, as its hiring system lists it. */
export interface Listing {
  title: string
  company: string
  location?: string
  description: string
  /** The public job page. Identifies the job. */
  url: string
  /** Where the application form lives. */
  applyUrl: string
  postedAt?: string
  /**
   * Workday lists jobs without the description or full location. This loads them, and is called
   * only for jobs whose title passed the filters.
   */
  details?: () => Promise<Pick<Listing, 'description' | 'location'>>
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export interface ListOptions {
  fetch: FetchLike
  /** Job titles to search for, where the system searches server side (Workday). */
  titles: string[]
  timeoutMs?: number
}

type Json = Record<string, unknown>

const clean = (s: string) => s.replace(/\s+/g, ' ').trim()
/** Greenhouse escapes its HTML (&lt;p&gt;), so decode once, then strip the tags. */
const htmlText = (html: string) => clean(parse(parse(html).textContent).textContent)
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const titleCase = (slug: string) =>
  slug
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
const joinPlaces = (...places: unknown[]) => {
  const all = places.flat().map(str).filter(Boolean) as string[]
  return all.length ? [...new Set(all)].join('; ') : undefined
}

async function getJson(
  o: ListOptions,
  url: string,
  init: RequestInit = {},
  notFound = 'not found',
): Promise<unknown> {
  const res = await o.fetch(url, {
    ...init,
    headers: {
      accept: 'application/json',
      'user-agent': 'auto-apply-job-search/0.2',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
    signal: AbortSignal.timeout(o.timeoutMs ?? 20_000),
  })
  if (res.status === 404) throw new Error(notFound)
  if (!res.ok) throw new Error(`${new URL(url).hostname} answered HTTP ${res.status}`)
  return res.json()
}

async function greenhouse(site: { slug: string }, o: ListOptions): Promise<Listing[]> {
  const base = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(site.slug)}`
  const missing = `Greenhouse has no job board "${site.slug}". Check the link.`
  const board = (await getJson(o, base, {}, missing)) as Json
  const data = (await getJson(o, `${base}/jobs?content=true`, {}, missing)) as { jobs?: Json[] }
  const company = str(board.name) ?? titleCase(site.slug)
  return (data.jobs ?? []).flatMap((j) => {
    const title = str(j.title)
    if (!title || j.id === undefined) return []
    // The Greenhouse hosted page always has the form, even when the company's own site embeds it.
    const url = `https://job-boards.greenhouse.io/${site.slug}/jobs/${String(j.id)}`
    return [
      {
        title,
        company,
        location: str((j.location as Json | undefined)?.name),
        description: htmlText(String(j.content ?? '')),
        url,
        applyUrl: url,
        postedAt: str(j.updated_at),
      },
    ]
  })
}

async function lever(site: { slug: string; eu: boolean }, o: ListOptions): Promise<Listing[]> {
  const host = site.eu ? 'api.eu.lever.co' : 'api.lever.co'
  const data = (await getJson(
    o,
    `https://${host}/v0/postings/${encodeURIComponent(site.slug)}?mode=json`,
    {},
    `Lever has no job board "${site.slug}". Check the link.`,
  )) as Json[]
  const company = titleCase(site.slug)
  return (Array.isArray(data) ? data : []).flatMap((j) => {
    const title = str(j.text)
    const url = str(j.hostedUrl)
    if (!title || !url) return []
    const cat = (j.categories ?? {}) as Json
    return [
      {
        title,
        company,
        location: joinPlaces(cat.allLocations ?? [], cat.location),
        description: clean(
          [j.descriptionPlain, j.additionalPlain].map((x) => str(x) ?? '').join(' '),
        ),
        url,
        applyUrl: str(j.applyUrl) ?? url,
        postedAt: typeof j.createdAt === 'number' ? new Date(j.createdAt).toISOString() : undefined,
      },
    ]
  })
}

async function ashby(site: { slug: string }, o: ListOptions): Promise<Listing[]> {
  const data = (await getJson(
    o,
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(site.slug)}`,
    {},
    `Ashby has no job board "${site.slug}". Check the link.`,
  )) as { jobs?: Json[] }
  const company = titleCase(site.slug)
  return (data.jobs ?? []).flatMap((j) => {
    const title = str(j.title)
    const url = str(j.jobUrl)
    if (!title || !url || j.isListed === false) return []
    const secondary = Array.isArray(j.secondaryLocations)
      ? (j.secondaryLocations as Json[]).map((s) => s.location)
      : []
    return [
      {
        title,
        company,
        // Ashby's isRemote flag says nothing about the country (OpenAI sets it on San Francisco
        // jobs), so it is used only when the job names no place at all.
        location: joinPlaces(j.location, secondary) ?? (j.isRemote === true ? 'Remote' : undefined),
        description: clean(str(j.descriptionPlain) ?? ''),
        url,
        applyUrl: str(j.applyUrl) ?? url,
        postedAt: str(j.publishedAt),
      },
    ]
  })
}

/** Workday has thousands of jobs per company, so search it per title instead of listing all. */
async function workday(
  site: { origin: string; tenant: string; site: string },
  o: ListOptions,
): Promise<Listing[]> {
  const api = `${site.origin}/wday/cxs/${site.tenant}/${site.site}`
  const company = titleCase(site.tenant)
  const missing = `Workday has no careers site "${site.site}" for ${site.tenant}. Check the link.`
  const seen = new Map<string, Listing>()
  for (const title of o.titles.length ? o.titles : ['']) {
    const data = (await getJson(
      o,
      `${api}/jobs`,
      {
        method: 'POST',
        body: JSON.stringify({ appliedFacets: {}, limit: 20, offset: 0, searchText: title }),
      },
      missing,
    )) as { jobPostings?: Json[] }
    for (const j of data.jobPostings ?? []) {
      const path = str(j.externalPath)
      const jobTitle = str(j.title)
      if (!path || !jobTitle || seen.has(path)) continue
      const url = `${site.origin}/${site.site}${path}`
      const listed = str(j.locationsText)
      seen.set(path, {
        title: jobTitle,
        company,
        // "2 Locations" says nothing about where, so the details call fills it in.
        location: listed && !/^\d+ locations?$/i.test(listed) ? listed : undefined,
        description: '',
        url,
        applyUrl: url,
        details: async () => {
          const d = (await getJson(o, `${api}${path}`)) as { jobPostingInfo?: Json }
          const info = d.jobPostingInfo ?? {}
          return {
            description: htmlText(String(info.jobDescription ?? '')),
            location: joinPlaces(
              info.location,
              Array.isArray(info.additionalLocations) ? info.additionalLocations : [],
              (info.country as Json | undefined)?.descriptor,
            ),
          }
        },
      })
    }
  }
  return [...seen.values()]
}

/** Every open job on one company's careers page. Throws a readable error when it cannot. */
export function listCompanyJobs(site: CareersSite, o: ListOptions): Promise<Listing[]> {
  switch (site.kind) {
    case 'greenhouse':
      return greenhouse(site, o)
    case 'lever':
      return lever(site, o)
    case 'ashby':
      return ashby(site, o)
    case 'workday':
      return workday(site, o)
  }
}
