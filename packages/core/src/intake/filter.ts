import { containsTerm } from '../llm/offline'
import type { LoadedProfile } from '../profile'
import { BASE_VOCAB } from '../tailor/vocab'

const words = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9+#]+/)
      .filter((w) => w.length > 1),
  )

/** Best share of a preferred title's words that appear in the job title (0 to 1). */
export function titleScore(jobTitle: string, preferred: string[]): number {
  const jw = words(jobTitle)
  let best = 0
  for (const p of preferred) {
    const pw = words(p)
    if (pw.size === 0) continue
    const hit = [...pw].filter((w) => jw.has(w)).length
    best = Math.max(best, hit / pw.size)
  }
  return best
}

export type SkipReason = 'excluded_title' | 'title_mismatch' | 'location_mismatch' | 'duplicate'

export function skipReasonFor(
  job: { title: string; location?: string },
  profile: LoadedProfile,
): SkipReason | null {
  const t = job.title.toLowerCase()
  if (profile.titles.exclude.some((x) => containsTerm(t, x))) return 'excluded_title'
  if (titleScore(job.title, profile.titles.titles) < 0.5) return 'title_mismatch'
  // Remote jobs match only when "Remote" is one of your locations: most are tied to a country
  // ("US-Remote", "Remote in Canada") that a location filter is meant to keep out.
  const locs = profile.titles.locations
  if (locs.length > 0 && job.location) {
    const l = job.location.toLowerCase()
    if (!locs.some((x) => l.includes(x.toLowerCase()))) return 'location_mismatch'
  }
  return null
}

/** 0 to 100: 60 percent title fit, 40 percent how many of the job's technical terms you list. */
export function matchScore(
  job: { title: string; description: string },
  profile: LoadedProfile,
): number {
  const mine = new Set<string>(
    [...profile.skills.flatMap((g) => g.skills), ...profile.projects.flatMap((p) => p.stack)].map(
      (s) => s.toLowerCase(),
    ),
  )
  const terms = BASE_VOCAB.filter((t) => containsTerm(job.description, t))
  const skillFit =
    terms.length === 0 ? 0.5 : terms.filter((t) => mine.has(t.toLowerCase())).length / terms.length
  return Math.round(100 * (0.6 * titleScore(job.title, profile.titles.titles) + 0.4 * skillFit))
}
