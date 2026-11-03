import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConfigError, loadConfig } from '../src/config/load'

const root = resolve(__dirname, '..')

function tempConfig(yaml: string): { root: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'apply-cfg-'))
  const file = join(dir, 'c.yaml')
  writeFileSync(file, yaml)
  return { root: dir, file }
}

describe('loadConfig', () => {
  it('loads the shipped default config and resolves paths', () => {
    const cfg = loadConfig({ root, env: {} })
    expect(cfg.workers).toBe(2)
    expect(cfg.profileDir).toBe(resolve(root, 'profile'))
    expect(cfg.sites.workday.headless).toBe(false)
    expect(cfg.sites.greenhouse.submit).toBe('review')
    expect(cfg.board.type).toBe('mcp')
    expect(cfg.board.url).toBeUndefined()
  })

  it('fills defaults for an empty file', () => {
    const t = tempConfig('')
    const cfg = loadConfig({ root: t.root, file: t.file, env: {} })
    expect(cfg.sites.greenhouse.dailyCap).toBe(30)
    expect(cfg.sites.linkedin.headless).toBe(false)
    expect(cfg.backends.shadow.enabled).toBe(false)
  })

  it('applies env overrides', () => {
    const cfg = loadConfig({
      root,
      env: { APPLY_WORKERS: '4', BOARD_MCP_URL: 'https://board.example.com/mcp' },
    })
    expect(cfg.workers).toBe(4)
    expect(cfg.board.url).toBe('https://board.example.com/mcp')
  })

  it('reports every invalid field with its path', () => {
    const t = tempConfig('workers: 0\nsites:\n  greenhouse:\n    submit: yolo\n')
    try {
      loadConfig({ root: t.root, file: t.file, env: {} })
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError)
      const e = err as ConfigError
      expect(e.issues.some((i) => i.startsWith('workers:'))).toBe(true)
      expect(e.issues.some((i) => i.startsWith('sites.greenhouse.submit:'))).toBe(true)
    }
  })

  it('rejects a bad board url and a non numeric APPLY_WORKERS', () => {
    const t = tempConfig('board:\n  url: not-a-url\n')
    expect(() => loadConfig({ root: t.root, file: t.file, env: {} })).toThrow(/board\.url/)
    expect(() => loadConfig({ root, env: { APPLY_WORKERS: 'many' } })).toThrow(/APPLY_WORKERS/)
  })

  it('fails when an explicit config file is missing', () => {
    expect(() => loadConfig({ root, file: 'nope.yaml', env: {} })).toThrow(/not found/)
  })
})
