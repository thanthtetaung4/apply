import { parse, type HTMLElement } from 'node-html-parser'

export interface ParsedJob {
  title: string
  company: string
  location?: string
  description: string
  postedAt?: string
  /** Link to the employer's own application page, if the board shows one. */
  externalApplyUrl?: string
  /** A link or button on the board that starts its own apply flow. */
  boardApplyUrl?: string
  hasEasyApplyButton: boolean
}

const clean = (s: string) => s.replace(/\s+/g, ' ').trim()
const stripTags = (html: string) => clean(parse(html).textContent)

type Json = Record<string, unknown>

function* jobPostings(node: unknown): Generator<Json> {
  if (Array.isArray(node)) {
    for (const n of node) yield* jobPostings(n)
  } else if (node && typeof node === 'object') {
    const o = node as Json
    const type = o['@type']
    if (type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'))) yield o
    if (o['@graph']) yield* jobPostings(o['@graph'])
  }
}

function locationOf(posting: Json): string | undefined {
  const loc = Array.isArray(posting.jobLocation) ? posting.jobLocation[0] : posting.jobLocation
  const addr = (loc as Json | undefined)?.address as Json | string | undefined
  if (typeof addr === 'string') return addr
  return (
    (addr?.addressLocality as string | undefined) ?? (addr?.addressRegion as string | undefined)
  )
}

/** Read the job from schema.org JSON-LD when present, otherwise from plain page markup. */
export function parseJobPage(html: string, pageUrl: string): ParsedJob {
  const root = parse(html)
  let posting: Json | undefined
  for (const script of root.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      posting = jobPostings(JSON.parse(script.textContent)).next().value
    } catch {
      continue
    }
    if (posting) break
  }

  const h1 = clean(root.querySelector('h1')?.textContent ?? '')
  const og = root.querySelector('meta[property="og:title"]')?.getAttribute('content')
  const org = posting?.hiringOrganization as Json | string | undefined
  const title = (posting?.title as string | undefined) ?? (h1 || og || '')
  // Boards often name the company only in the page title, e.g. LinkedIn's
  // "AI Engineer at Arros AI — Singapore | LinkedIn Jobs".
  const pageTitle = clean(root.querySelector('title')?.textContent ?? og ?? '')
  // Or "Job title | Company" / "Job title - Company", when the first part really is the job title.
  const parts = pageTitle.split(/\s+[|–—-]\s+/)
  const titleThenCompany =
    parts.length === 2 && title && parts[0]!.toLowerCase() === clean(title).toLowerCase()
      ? parts[1]!
      : ''
  const siteName = clean(
    root.querySelector('meta[property="og:site_name"]')?.getAttribute('content') ?? '',
  )
  // "Northstar Logistics careers", "Acme Jobs": the company is the part before the word.
  const fromTitle = (
    /^.+? at (.+?)(?: [—–-] .*)?(?: \| .*)?$/.exec(pageTitle)?.[1]?.trim() ||
    titleThenCompany ||
    siteName
  ).replace(/\s+(careers?|jobs|job board|hiring)$/i, '')
  const company =
    (typeof org === 'string' ? org : (org?.name as string | undefined)) ??
    (clean(
      root.querySelector('.company, [data-company-name], .topcard__org-name-link')?.textContent ??
        '',
    ) ||
      fromTitle)
  const description = posting?.description
    ? stripTags(String(posting.description))
    : clean(root.querySelector('main')?.textContent ?? root.textContent).slice(0, 6000)

  const base = new URL(pageUrl)
  const anchors = root.querySelectorAll('a')
  const resolve = (a: HTMLElement) => {
    const href = a.getAttribute('href')
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) return undefined
    try {
      return new URL(href, base).toString()
    } catch {
      return undefined
    }
  }
  const text = (a: HTMLElement) => clean(a.textContent)

  const external = anchors.find((a) => {
    const u = resolve(a)
    if (!u) return false
    const sameHost = new URL(u).hostname === base.hostname
    return (
      a.classList.contains('apply-external') ||
      (/apply (on|at|via|with)\b.*(company|employer|site|website)|apply on .* (site|website)/i.test(
        text(a),
      ) &&
        !sameHost)
    )
  })
  const boardApply = anchors.find((a) => /^apply( now| here)?$/i.test(text(a)) && resolve(a))

  const hasEasyApplyButton = root
    .querySelectorAll('button, [role=button]')
    .some((b) => /^easy apply$/i.test(clean(b.textContent)))

  return {
    title,
    company,
    location: locationOf(posting ?? {}),
    description,
    postedAt: posting?.datePosted as string | undefined,
    externalApplyUrl: external ? resolve(external) : undefined,
    boardApplyUrl: boardApply ? resolve(boardApply) : undefined,
    hasEasyApplyButton,
  }
}

/** Links to job pages on a search results page. */
export function parseSearchLinks(
  html: string,
  pageUrl: string,
  selector: string,
  max: number,
): string[] {
  const root = parse(html)
  const seen = new Set<string>()
  const out: string[] = []
  for (const a of root.querySelectorAll(selector)) {
    const href = a.getAttribute('href')
    if (!href) continue
    let url: string
    try {
      url = new URL(href, pageUrl).toString()
    } catch {
      continue
    }
    if (seen.has(url)) continue
    seen.add(url)
    out.push(url)
    if (out.length >= max) break
  }
  return out
}
