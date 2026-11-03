import { containsTerm } from '../llm/offline'
import type { Requirements } from '../llm/tasks'
import type { Experience, LoadedProfile, Project, SkillGroup } from '../profile'

export interface ScoredBullet {
  id: string
  text: string
  score: number
  order: number
}

export interface Selection {
  experience: { exp: Experience; bullets: ScoredBullet[]; all: ScoredBullet[] }[]
  projects: { project: Project; score: number }[]
  skills: SkillGroup[]
}

export interface SelectionLimits {
  firstRoleBullets: number
  otherRoleBullets: number
  minBullets: number
  maxProjects: number
}

export const DEFAULT_LIMITS: SelectionLimits = {
  firstRoleBullets: 5,
  otherRoleBullets: 3,
  minBullets: 2,
  maxProjects: 3,
}

const hits = (text: string, terms: string[]) => terms.filter((t) => containsTerm(text, t)).length

export function scoreText(text: string, req: Requirements): number {
  return hits(text, req.skills) * 2 + hits(text, req.keywords)
}

/** Pick the content most relevant to the job. Pure and deterministic. */
export function selectContent(
  profile: LoadedProfile,
  req: Requirements,
  limits: SelectionLimits = DEFAULT_LIMITS,
): Selection {
  const experience = profile.experience.map((exp, ei) => {
    const all = exp.bullets.map((b, order) => ({
      id: b.id,
      text: b.text,
      order,
      // A small bonus for the most recent role keeps ties from favouring old work.
      score: scoreText(`${b.text} ${exp.role}`, req) + (ei === 0 ? 0.5 : 0),
    }))
    const cap = ei === 0 ? limits.firstRoleBullets : limits.otherRoleBullets
    const top = [...all].sort((a, b) => b.score - a.score || a.order - b.order).slice(0, cap)
    return { exp, all, bullets: top.sort((a, b) => a.order - b.order) }
  })

  const projects = profile.projects
    .map((project) => ({
      project,
      score:
        hits(project.stack.join(' , '), req.skills) * 3 +
        scoreText(
          `${project.name} ${project.description} ${project.highlights.map((h) => h.text).join(' ')}`,
          req,
        ),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limits.maxProjects)

  // Skills: every skill stays (nothing is dropped or invented). Matches move to the front.
  const skills = profile.skills
    .map((g) => ({
      ...g,
      skills: [...g.skills].sort(
        (a, b) => Number(hits(b, req.skills) > 0) - Number(hits(a, req.skills) > 0),
      ),
    }))
    .sort((a, b) => hits(b.skills.join(' , '), req.skills) - hits(a.skills.join(' , '), req.skills))

  return { experience, projects, skills }
}

/** Remove the single least useful removable item. Returns false when nothing can be removed. */
export function dropLeastRelevant(sel: Selection, minBullets: number): boolean {
  type Candidate = { score: number; remove: () => void }
  const candidates: Candidate[] = []
  for (const role of sel.experience) {
    if (role.bullets.length > minBullets) {
      const last = [...role.bullets].sort((a, b) => a.score - b.score || b.order - a.order)[0]!
      candidates.push({
        score: last.score,
        remove: () => void role.bullets.splice(role.bullets.indexOf(last), 1),
      })
    }
  }
  if (sel.projects.length > 0) {
    const last = sel.projects[sel.projects.length - 1]!
    // Projects count a little less than the same score in experience, so they go first on ties.
    candidates.push({ score: last.score - 0.25, remove: () => void sel.projects.pop() })
  }
  if (candidates.length === 0) return false
  candidates.sort((a, b) => a.score - b.score)
  candidates[0]!.remove()
  return true
}
