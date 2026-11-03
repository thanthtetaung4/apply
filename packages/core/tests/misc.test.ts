import { describe, expect, it } from 'vitest'
import { BackendRegistry } from '../src/browser/registry'
import { BrowserError } from '../src/browser/types'
import { LlmError } from '../src/llm/types'
import { decidePolicy } from '../src/metrics/gate'
import { BackendRouter } from '../src/router'
import { defaultSettings, parseSettings } from '../src/settings'
import { classifyError } from '../src/shared/errors'
import { redact, redactJson } from '../src/shared/redact'
import type { SiteStats } from '../src/store'

const stats = (runs: number, passed: number): SiteStats => ({
  siteType: 'greenhouse',
  runs,
  accuracy: runs ? passed / runs : 0,
  completion: 1,
})

describe('auto submit gate', () => {
  const base = defaultSettings()
  const auto = {
    ...base,
    sites: { ...base.sites, greenhouse: { ...base.sites.greenhouse, submit: 'auto' as const } },
  }

  it('downgrades auto to review until enough verified runs exist', () => {
    const d = decidePolicy(stats(9, 9), auto, 'greenhouse')
    expect(d).toMatchObject({ configured: 'auto', effective: 'review' })
    expect(d.reason).toMatch(/9 of 10/)
  })

  it('allows auto once the bar is met', () => {
    expect(decidePolicy(stats(10, 10), auto, 'greenhouse').effective).toBe('auto')
  })

  it('keeps review when accuracy is too low', () => {
    const d = decidePolicy(stats(10, 8), auto, 'greenhouse')
    expect(d.effective).toBe('review')
    expect(d.reason).toMatch(/accuracy 80%/)
  })

  it('never upgrades review to auto, and respects gate.enforce false', () => {
    expect(decidePolicy(stats(20, 20), base, 'greenhouse').effective).toBe('review')
    const off = { ...auto, gate: { ...auto.gate, enforce: false } }
    expect(decidePolicy(stats(0, 0), off, 'greenhouse').effective).toBe('auto')
  })
})

describe('settings', () => {
  it('has safe defaults: review everywhere, gate on, boards headless', () => {
    const s = defaultSettings()
    expect(Object.values(s.sites).every((x) => x.submit === 'review')).toBe(true)
    expect(s.sites.greenhouse.dailyCap).toBe(30)
    expect(s.gate).toMatchObject({ enforce: true, minRuns: 10, minAccuracy: 0.9 })
    expect(s.sites.linkedin.headless).toBe(true)
    expect(s.workers).toBe(2)
  })

  it('reports every invalid field with its path', () => {
    const r = parseSettings({
      workers: 0,
      sites: { greenhouse: { submit: 'yolo' } },
      sources: { indeed: { baseUrl: 'nope' } },
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.issues.some((i) => i.startsWith('workers:'))).toBe(true)
      expect(r.issues.some((i) => i.startsWith('sites.greenhouse.submit:'))).toBe(true)
      expect(r.issues.some((i) => i.startsWith('sources.indeed.baseUrl:'))).toBe(true)
    }
  })

  it('round trips through JSON', () => {
    const s = defaultSettings()
    const r = parseSettings(JSON.parse(JSON.stringify(s)))
    expect(r.ok && r.settings).toEqual(s)
  })
})

describe('BackendRouter', () => {
  const registry = new BackendRegistry()
    .register('playwright-chromium', () => ({}) as never)
    .register('ai-browser', () => ({}) as never)
  const base = defaultSettings()

  it('routes a site type to its backend and falls back to Chromium by default', () => {
    const c = {
      ...base,
      sites: { ...base.sites, workday: { ...base.sites.workday, backend: 'ai-browser' } },
    }
    const r = new BackendRouter(registry, c).route('workday', 'j1')
    expect(r).toMatchObject({ primary: 'ai-browser', fallback: 'playwright-chromium' })
    expect(new BackendRouter(registry, base).route('greenhouse', 'j1').fallback).toBeUndefined()
  })

  it('picks shadow jobs deterministically by sample rate', () => {
    const c = (sample: number) => ({
      ...base,
      backends: { shadow: { enabled: true, name: 'ai-browser', sample } },
    })
    const ids = Array.from({ length: 400 }, (_, i) => `job-${i}`)
    const hits = (s: number) =>
      ids.filter((id) => new BackendRouter(registry, c(s)).route('greenhouse', id).shadow).length
    expect(hits(0)).toBe(0)
    expect(hits(1)).toBe(400)
    expect(hits(0.25)).toBeGreaterThan(60)
    expect(hits(0.25)).toBeLessThan(140)
    expect(hits(0.25)).toBe(hits(0.25))
  })
})

describe('redaction and error classes', () => {
  it('masks emails, phones, bearer tokens and api keys', () => {
    const t = redact(
      'mail alex.tan@example.com call +65 9000 0000 Authorization: Bearer abcdef123456789 key sk-abcdef123456',
    )
    expect(t).not.toMatch(/alex\.tan|9000 0000|abcdef123456789|sk-abcdef/)
    expect(t).toContain('a***@example.com')
    expect(redactJson({ phone: '6590000000' })).not.toContain('6590000000')
  })

  it('separates transient from fatal errors', () => {
    expect(classifyError(new BrowserError('x', 'timeout'))).toBe('transient')
    expect(classifyError(new BrowserError('x', 'no_such_field'))).toBe('fatal')
    expect(classifyError(new LlmError('x', 'budget'))).toBe('fatal')
    expect(classifyError(new LlmError('x', 'http', 503))).toBe('transient')
    expect(classifyError(new LlmError('x', 'http', 401))).toBe('fatal')
    expect(classifyError(new Error('net::ERR_CONNECTION_RESET'))).toBe('transient')
    expect(classifyError(new Error('bad config'))).toBe('fatal')
  })
})
