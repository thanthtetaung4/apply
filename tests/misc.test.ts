import { describe, expect, it } from 'vitest'
import { BackendRegistry } from '../src/browser/registry'
import { BrowserError } from '../src/browser/types'
import { loadConfig } from '../src/config/load'
import { openDb } from '../src/db'
import { LlmError } from '../src/llm/types'
import { decidePolicy } from '../src/metrics/gate'
import { BackendRouter } from '../src/router'
import { classifyError } from '../src/shared/errors'
import { redact, redactJson } from '../src/shared/redact'
import { ROOT } from './helpers/env'

const cfg = (over: Record<string, unknown> = {}) =>
  loadConfig({ root: ROOT, env: {}, file: 'config/default.yaml', ...over })

function addRuns(db: ReturnType<typeof openDb>, site: string, verify: string[]) {
  verify.forEach((v, i) => {
    const id = `${site}-${i}`
    db.prepare(
      `INSERT INTO jobs (id, source, title, company, apply_url, apply_target, fetched_at) VALUES (?, 'indeed', 't', 'c', 'u', 'greenhouse', 'now')`,
    ).run(id)
    db.prepare(
      `INSERT INTO applications (job_id, status, updated_at) VALUES (?, 'submitted', 'now')`,
    ).run(id)
    db.prepare(
      `INSERT INTO metrics (job_id, site_type, backend, duration_ms, verify, outcome, created_at) VALUES (?, ?, 'b', 1, ?, 'submitted', 'now')`,
    ).run(id, site, v)
  })
}

describe('auto submit gate', () => {
  const base = cfg()
  const auto = {
    ...base,
    sites: { ...base.sites, greenhouse: { ...base.sites.greenhouse, submit: 'auto' as const } },
  }

  it('downgrades auto to review until enough verified runs exist', () => {
    const db = openDb(':memory:')
    addRuns(db, 'greenhouse', Array(9).fill('pass'))
    const d = decidePolicy(db, auto, 'greenhouse')
    expect(d).toMatchObject({ configured: 'auto', effective: 'review' })
    expect(d.reason).toMatch(/9 of 10/)
  })

  it('allows auto once the bar is met', () => {
    const db = openDb(':memory:')
    addRuns(db, 'greenhouse', Array(10).fill('pass'))
    expect(decidePolicy(db, auto, 'greenhouse').effective).toBe('auto')
  })

  it('keeps review when accuracy is too low', () => {
    const db = openDb(':memory:')
    addRuns(db, 'greenhouse', [...Array(8).fill('pass'), 'fail', 'warn'])
    const d = decidePolicy(db, auto, 'greenhouse')
    expect(d.effective).toBe('review')
    expect(d.reason).toMatch(/accuracy 80%/)
  })

  it('never upgrades review to auto, and respects gate.enforce false', () => {
    const db = openDb(':memory:')
    addRuns(db, 'greenhouse', Array(20).fill('pass'))
    expect(decidePolicy(db, base, 'greenhouse').effective).toBe('review')
    expect(
      decidePolicy(db, { ...auto, gate: { ...auto.gate, enforce: false } }, 'workday'),
    ).toMatchObject({ configured: 'review', effective: 'review' })
    const off = { ...auto, gate: { ...auto.gate, enforce: false } }
    expect(decidePolicy(openDb(':memory:'), off, 'greenhouse').effective).toBe('auto')
  })
})

describe('BackendRouter', () => {
  const registry = new BackendRegistry()
    .register('playwright-chromium', () => ({}) as never)
    .register('ai-browser', () => ({}) as never)
  const base = cfg()

  it('routes a site type to its backend and falls back to Chromium by default', () => {
    const c = {
      ...base,
      sites: { ...base.sites, workday: { ...base.sites.workday, backend: 'ai-browser' } },
    }
    const r = new BackendRouter(registry, c).route('workday', 'j1')
    expect(r).toMatchObject({
      primary: 'ai-browser',
      fallback: 'playwright-chromium',
      headless: false,
    })
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
