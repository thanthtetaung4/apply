import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { containsTerm, OfflineProvider } from '../llm/offline'
import { LlmGateway } from '../llm/gateway'
import { LlmError } from '../llm/types'
import { extractRequirements, rephraseBullet, type Requirements } from '../llm/tasks'
import type { LoadedProfile } from '../profile'
import type { Job } from '../shared/job'
import { checkGrounding, type GroundingViolation } from './grounding'
import { ResumeRenderer } from './render'
import {
  dropLeastRelevant,
  selectContent,
  DEFAULT_LIMITS,
  type Selection,
  type SelectionLimits,
} from './select'
import { BASE_VOCAB } from './vocab'

export { ResumeRenderer } from './render'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const HERE = dirname(fileURLToPath(import.meta.url))
export const DEFAULT_TEMPLATE = resolve(HERE, '../../templates/resume.html')

export interface TailoredResume {
  jobId: string
  pdfPath: string
  fileName: string
  pages: number
  requirements: Requirements
  headline: string
  selectedBulletIds: string[]
  selectedProjectIds: string[]
  /** True when the fallback (no rewording) path was used after a grounding failure. */
  usedFallback: boolean
  warnings: string[]
  tokensIn: number
  tokensOut: number
  costUsd: number
}

export interface TailorDeps {
  profile: LoadedProfile
  gateway: LlmGateway
  renderer: ResumeRenderer
  outDir: string
  templatePath?: string
  /** Reword bullets with a model. Off by default. Every rewrite goes through the grounding check. */
  rephrase?: boolean
  limits?: SelectionLimits
}

/** About 3,000 tokens: with the known terms and instructions it fits an 8k context. */
export const MAX_DESCRIPTION_CHARS = 12_000

/** A store-less gateway over the deterministic offline provider: no cache, budget or usage. */
function offlineGateway(): LlmGateway {
  return new LlmGateway({
    provider: new OfflineProvider(),
    models: { cheap: 'offline', mid: 'offline', strong: 'offline' },
  })
}

function knownTerms(profile: LoadedProfile): string[] {
  const set = new Map<string, string>()
  const add = (t: string) => set.set(t.toLowerCase(), t)
  BASE_VOCAB.forEach(add)
  for (const g of profile.skills) g.skills.forEach(add)
  for (const p of profile.projects) p.stack.forEach(add)
  profile.titles.keywords.forEach(add)
  return [...set.values()]
}

function headlineFor(profile: LoadedProfile, jobTitle: string): string {
  const words = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 2),
    )
  const jw = words(jobTitle)
  let best = profile.titles.titles[0]!
  let bestScore = -1
  for (const t of profile.titles.titles) {
    const score = [...words(t)].filter((w) => jw.has(w)).length
    if (score > bestScore) [best, bestScore] = [t, score]
  }
  return best
}

function bullets(items: string[]): string {
  return items.length ? `<ul>${items.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''
}

export function renderHtml(
  template: string,
  profile: LoadedProfile,
  sel: Selection,
  headline: string,
  texts: Map<string, string>,
): { html: string; summary: string } {
  const c = profile.contact
  const contact = [
    c.email,
    c.phone,
    c.location,
    ...c.links.map((l) => l.url.replace(/^https?:\/\//, '')),
  ]
    .filter(Boolean)
    .map((x) => esc(String(x)))
    .join(' &nbsp;|&nbsp; ')
  const summary = c.summary ?? ''

  const experience = sel.experience
    .map(
      ({ exp, bullets: bs }) =>
        `<div class="item"><div class="row"><span>${esc(exp.role)}, ${esc(exp.company)}</span><span class="when">${esc(exp.start)} - ${esc(exp.end)}</span></div>${bullets(bs.map((b) => texts.get(b.id) ?? b.text))}</div>`,
    )
    .join('')

  const projects = sel.projects
    .map(
      ({ project: p }) =>
        `<div class="item"><div class="row"><span>${esc(p.name)}</span><span class="when">${esc(p.period ?? '')}</span></div><div class="sub">${esc(p.stack.join(', '))}</div>${p.description ? `<div>${esc(p.description)}</div>` : ''}${bullets(p.highlights.map((h) => texts.get(h.id) ?? h.text))}</div>`,
    )
    .join('')

  const skills = sel.skills
    .map((g) => `<div><b>${esc(g.category)}:</b> ${esc(g.skills.join(', '))}</div>`)
    .join('')
  const education = profile.education
    .map(
      (e) =>
        `<div class="item"><div class="row"><span>${esc(e.degree)}, ${esc(e.institution)}</span><span class="when">${esc([e.start, e.end].filter(Boolean).join(' - '))}</span></div>${bullets(e.notes.map((n) => n.text))}</div>`,
    )
    .join('')
  const certs = profile.certifications.length ? bullets(profile.certifications) : ''

  const section = (title: string, body: string) => (body ? `<h2>${title}</h2>${body}` : '')
  const html = template
    .replace(/\{\{name\}\}/g, esc(c.name))
    .replace('{{headline}}', esc(headline))
    .replace('{{contact}}', contact)
    .replace('{{summary}}', summary ? `<p class="summary">${esc(summary)}</p>` : '')
    .replace('{{experience}}', section('Experience', experience))
    .replace('{{projects}}', section('Projects', projects))
    .replace('{{skills}}', section('Skills', `<div class="skills">${skills}</div>`))
    .replace('{{education}}', section('Education', education))
    .replace('{{certifications}}', section('Certifications', certs))
  return { html, summary }
}

/** Build a one page, job specific resume from the profile. Never adds content the profile lacks. */
export async function tailorResume(job: Job, deps: TailorDeps): Promise<TailoredResume> {
  const { profile, gateway, renderer } = deps
  const template = readFileSync(deps.templatePath ?? DEFAULT_TEMPLATE, 'utf8')
  const warnings: string[] = []
  let tokensIn = 0
  let tokensOut = 0
  let costUsd = 0

  const reqInput = {
    jobTitle: job.title,
    // Long postings are mostly boilerplate after the requirements, and a local model's context is
    // small. The skills the model returns are still checked against the full description.
    description: job.description.slice(0, MAX_DESCRIPTION_CHARS),
    knownTerms: knownTerms(profile),
  }
  // A model failure (budget, network, bad output) falls back to the offline keyword match instead
  // of failing the job: the result is filtered against the description below either way.
  const reqRes = await extractRequirements(gateway, reqInput, { jobId: job.id }).catch(
    async (err: unknown) => {
      if (!(err instanceof LlmError)) throw err
      warnings.push(`requirements: model failed (${err.message}), used keyword matching`)
      return extractRequirements(offlineGateway(), reqInput)
    },
  )
  tokensIn += reqRes.tokensIn
  tokensOut += reqRes.tokensOut
  costUsd += reqRes.costUsd
  // Only terms the model returned that really appear in the description count as requirements.
  const requirements: Requirements = {
    skills: reqRes.data.skills.filter((s) => containsTerm(job.description, s)),
    keywords: reqRes.data.keywords,
  }

  const headline = headlineFor(profile, job.title)
  const limits = deps.limits ?? DEFAULT_LIMITS
  const sel = selectContent(profile, requirements, limits)

  // Optional rewording, checked below. Without it the texts are the profile's own words.
  const texts = new Map<string, string>()
  if (deps.rephrase) {
    for (const role of sel.experience) {
      for (const b of role.bullets) {
        const r = await rephraseBullet(
          gateway,
          { text: b.text, jobTitle: job.title },
          { jobId: job.id },
        )
        tokensIn += r.tokensIn
        tokensOut += r.tokensOut
        costUsd += r.costUsd
        texts.set(b.id, r.data.text)
      }
    }
  }

  const fileName = `${profile.contact.name.replace(/[^A-Za-z0-9]+/g, '_')}_Resume.pdf`
  const pdfPath = join(deps.outDir, job.id, fileName)

  const verify = (): GroundingViolation[] =>
    checkGrounding(profile, sel, {
      bullets: new Map([
        ...sel.experience.flatMap((r) =>
          r.bullets.map((b) => [b.id, texts.get(b.id) ?? b.text] as const),
        ),
        ...sel.projects.flatMap((p) =>
          p.project.highlights.map((h) => [h.id, texts.get(h.id) ?? h.text] as const),
        ),
      ]),
      summary: profile.contact.summary,
      skills: sel.skills.map((g) => ({ category: g.category, skills: g.skills })),
    })

  let usedFallback = false
  let violations = verify()
  if (violations.length > 0) {
    warnings.push(
      ...violations.map((v) => `grounding: ${v.where}: ${v.problem}`),
      'fell back to the profile wording',
    )
    texts.clear()
    usedFallback = true
    violations = verify()
    if (violations.length > 0) {
      throw new Error(
        `Resume failed the grounding check: ${violations.map((v) => `${v.where} ${v.problem}`).join('; ')}`,
      )
    }
  }

  // Render, and drop the least relevant item until the resume fits on one page.
  let pages = 0
  for (let i = 0; i < 20; i++) {
    const { html } = renderHtml(template, profile, sel, headline, texts)
    pages = (await renderer.renderPdf(html, pdfPath)).pages
    if (pages <= 1) break
    if (!dropLeastRelevant(sel, limits.minBullets)) break
  }
  if (pages > 1) warnings.push(`resume is ${pages} pages and nothing more can be removed`)

  const result: TailoredResume = {
    jobId: job.id,
    pdfPath,
    fileName,
    pages,
    requirements,
    headline,
    selectedBulletIds: sel.experience.flatMap((r) => r.bullets.map((b) => b.id)),
    selectedProjectIds: sel.projects.map((p) => p.project.id),
    usedFallback,
    warnings,
    tokensIn,
    tokensOut,
    costUsd,
  }
  await writeFile(join(deps.outDir, job.id, 'tailor.json'), JSON.stringify(result, null, 2))
  return result
}
