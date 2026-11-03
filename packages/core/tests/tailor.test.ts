import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MemoryLlmStore } from './helpers/memory-llm-store'
import { LlmGateway } from '../src/llm/gateway'
import { OfflineProvider } from '../src/llm/offline'
import type { LlmProvider } from '../src/llm/types'
import { loadProfileFromDir as loadProfile } from '../src/profile/fs'
import type { Job } from '../src/shared/job'
import { checkGrounding, checkRewrite } from '../src/tailor/grounding'
import { ResumeRenderer, tailorResume } from '../src/tailor'
import { selectContent } from '../src/tailor/select'

const profile = loadProfile(resolve(__dirname, '../../../demo/profile'))
const models = { cheap: 'c', mid: 'm', strong: 's' }
const job = (over: Partial<Job> = {}): Job => ({
  id: 'j1',
  source: 'indeed',
  title: 'AI Engineer',
  company: 'Lumen AI',
  description:
    'Build and evaluate LLM features. Design prompts, RAG pipelines and regression evaluation suites in Python and TypeScript, and work with PostgreSQL.',
  applyUrl: 'http://x.test',
  applyTarget: 'greenhouse',
  fetchedAt: new Date().toISOString(),
  ...over,
})

let renderer: ResumeRenderer
let outDir: string
beforeAll(() => {
  renderer = new ResumeRenderer()
  outDir = mkdtempSync(join(tmpdir(), 'aa-resumes-'))
})
afterAll(async () => renderer.close())

const gateway = (provider: LlmProvider = new OfflineProvider()) =>
  new LlmGateway({ provider, models, store: new MemoryLlmStore() })

describe('selection', () => {
  const ai = { skills: ['LLM', 'Python', 'evaluation', 'RAG'], keywords: [] }
  const web = { skills: ['React', 'Node.js', 'PostgreSQL'], keywords: [] }

  it('prefers bullets and projects that match the requirements', () => {
    const a = selectContent(profile, ai)
    const b = selectContent(profile, web)
    expect(a.projects[0]!.project.name).toBe('Eval Harness')
    expect(b.projects[0]!.project.name).toBe('Client Booking Sites')
    const aBullets = a.experience[0]!.bullets.map((x) => x.text).join(' ')
    expect(aBullets).toContain('evaluation framework')
  })

  it('keeps every profile skill and moves matches to the front', () => {
    const a = selectContent(profile, ai)
    const all = (s: typeof a) => s.skills.flatMap((g) => g.skills).sort()
    expect(all(a)).toEqual(profile.skills.flatMap((g) => g.skills).sort())
    expect(a.skills[0]!.category).toBe('AI')
  })

  it('is deterministic', () => {
    expect(JSON.stringify(selectContent(profile, ai))).toBe(
      JSON.stringify(selectContent(profile, ai)),
    )
  })
})

describe('grounding', () => {
  const sel = selectContent(profile, { skills: ['LLM'], keywords: [] })
  const base = {
    bullets: new Map<string, string>(),
    summary: profile.contact.summary,
    skills: sel.skills.map((g) => ({ category: g.category, skills: g.skills })),
  }

  it('accepts the profile wording', () => {
    expect(checkGrounding(profile, sel, base)).toEqual([])
  })

  it('blocks a made up skill, an unknown bullet and a new number', () => {
    const bad = {
      ...base,
      skills: [{ category: 'AI', skills: ['LLM', 'Kubernetes'] }],
      bullets: new Map([['b_0000000000', 'Led a team of 50']]),
    }
    const v = checkGrounding(profile, sel, bad)
    expect(v.map((x) => x.problem).join('|')).toMatch(/Kubernetes/)
    expect(v.map((x) => x.problem).join('|')).toMatch(/no such bullet/)
    const id = profile.experience[0]!.bullets[0]!.id
    const rewrite = checkGrounding(profile, sel, {
      ...base,
      bullets: new Map([[id, 'Migrated an LLM assistant and cut costs by 90%']]),
    })
    expect(rewrite.some((x) => x.problem.includes('90%'))).toBe(true)
  })

  it('allows a faithful rewording and flags new tools', () => {
    const src = 'Built two chart types in TypeScript that are still used in production.'
    const known = new Set(['typescript'])
    expect(
      checkRewrite(src, 'Built two chart types in TypeScript, still used in production.', known),
    ).toEqual([])
    expect(checkRewrite(src, 'Built two chart types in TypeScript and Kubernetes.', known)).toEqual(
      ['new term "Kubernetes"'],
    )
    expect(checkRewrite(src, 'Built 12 chart types in TypeScript.', known)).toEqual([
      'new number "12"',
    ])
  })
})

describe('tailorResume', () => {
  it('writes a valid one page PDF and a sidecar file', async () => {
    const res = await tailorResume(job(), { profile, gateway: gateway(), renderer, outDir })
    expect(existsSync(res.pdfPath)).toBe(true)
    expect(res.pages).toBe(1)
    expect(res.fileName).toBe('Alex_Tan_Resume.pdf')
    const doc = await PDFDocument.load(readFileSync(res.pdfPath))
    expect(doc.getPageCount()).toBe(1)
    expect(res.requirements.skills).toEqual(
      expect.arrayContaining(['LLM', 'Python', 'TypeScript', 'PostgreSQL']),
    )
    expect(res.headline).toBe('AI Engineer')
    expect(existsSync(join(outDir, 'j1', 'tailor.json'))).toBe(true)
  }, 30_000)

  it('produces different content for different jobs', async () => {
    const web = await tailorResume(
      job({
        id: 'j2',
        title: 'Backend Developer',
        description: 'Node.js, TypeScript, PostgreSQL, Redis and REST APIs for payments.',
      }),
      { profile, gateway: gateway(), renderer, outDir },
    )
    const ai = await tailorResume(job({ id: 'j3' }), {
      profile,
      gateway: gateway(),
      renderer,
      outDir,
    })
    expect(web.selectedProjectIds).not.toEqual(ai.selectedProjectIds)
    expect(web.headline).toBe('Backend Developer')
  }, 30_000)

  it('shrinks to one page when there is too much content', async () => {
    const res = await tailorResume(job({ id: 'j4' }), {
      profile,
      gateway: gateway(),
      renderer,
      outDir,
      limits: { firstRoleBullets: 9, otherRoleBullets: 9, minBullets: 1, maxProjects: 9 },
    })
    expect(res.pages).toBe(1)
  }, 30_000)

  it('falls back to profile wording when a model rewrite invents something', async () => {
    const lying: LlmProvider = {
      name: 'liar',
      async complete(req) {
        if (req.task === 'rephrase_bullet') {
          return {
            text: JSON.stringify({ text: 'Led 40 engineers building Kubernetes clusters' }),
            tokensIn: 5,
            tokensOut: 5,
            costUsd: 0,
            model: 'x',
          }
        }
        return new OfflineProvider().complete(req)
      },
    }
    const res = await tailorResume(job({ id: 'j5' }), {
      profile,
      gateway: gateway(lying),
      renderer,
      outDir,
      rephrase: true,
    })
    expect(res.usedFallback).toBe(true)
    expect(res.warnings.join(' ')).toMatch(/new number "40"|new term "Kubernetes"/)
    expect(res.pages).toBe(1)
  }, 30_000)

  it('uses the cache on a repeat run', async () => {
    const gw = gateway()
    await tailorResume(job({ id: 'j6' }), { profile, gateway: gw, renderer, outDir })
    const again = await tailorResume(job({ id: 'j6' }), { profile, gateway: gw, renderer, outDir })
    expect(again.tokensIn).toBe(0)
  }, 30_000)
})
