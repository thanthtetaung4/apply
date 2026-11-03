import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PlaywrightBackend, classifyAction } from '../../src/browser/playwright-backend'
import { BackendRegistry, NotImplementedBackend } from '../../src/browser/registry'
import type { BrowserSession } from '../../src/browser/types'
import { startMockServer, type MockServer } from '../../src/demo/mock-server'

let server: MockServer
let backend: PlaywrightBackend
let session: BrowserSession
let resumePath: string

beforeAll(async () => {
  server = await startMockServer()
  backend = new PlaywrightBackend()
  resumePath = join(mkdtempSync(join(tmpdir(), 'aa-')), 'Alex_Tan_Resume.pdf')
  writeFileSync(resumePath, '%PDF-1.4 fake')
}, 30_000)

afterAll(async () => {
  await session?.close()
  await backend.dispose()
  await server.close()
})

describe('classifyAction', () => {
  it.each([
    ['Save and Continue', true, 'next'],
    ['Next', true, 'next'],
    ['Review', true, 'next'],
    ['Review and submit', true, 'submit'],
    ['Submit Application', true, 'submit'],
    ['Submit your application', true, 'submit'],
    ['Apply', true, 'submit'],
    ['Apply', false, 'open'],
    ['Easy Apply', false, 'open'],
    ['Easy Apply', true, 'open'],
    ['Back', true, 'back'],
    ['Accept all cookies', false, 'other'],
  ] as const)('%s (fields=%s) is %s', (label, hasFields, kind) => {
    expect(classifyAction(label, hasFields)).toBe(kind)
  })
})

describe('PlaywrightBackend contract (Greenhouse style form)', () => {
  it('extracts a compact schema with labels, types and required flags', async () => {
    session = await backend.launch({ headless: true })
    await session.open(`${server.url}/gh/lumen-ai/jobs/101`)
    const schema = await session.formSchema()
    const by = (label: string) => schema.fields.find((f) => f.label === label)

    expect(by('First Name')).toMatchObject({ type: 'text', required: true })
    expect(by('Email')).toMatchObject({ type: 'email', required: true })
    expect(by('Phone')).toMatchObject({ type: 'tel', required: false })
    expect(by('Resume/CV')).toMatchObject({ type: 'file', required: true })
    expect(by('Location (City)')).toMatchObject({ type: 'text', hint: 'combobox' })
    expect(by('Are you legally authorized to work in Singapore?')).toMatchObject({
      type: 'select',
      options: ['Yes', 'No'],
      value: '',
    })
    expect(by('Will you now or in the future require visa sponsorship?')).toMatchObject({
      type: 'radio',
      options: ['Yes', 'No'],
      required: true,
    })
    expect(schema.fields.find((f) => f.section === 'Additional questions')).toBeTruthy()
    expect(schema.actions.find((a) => a.label === 'Submit Application')?.kind).toBe('submit')
  })

  it('gives the same ids after a reload', async () => {
    const a = (await session.formSchema()).fields.map((f) => f.id)
    await session.open(`${server.url}/gh/lumen-ai/jobs/101`)
    const b = (await session.formSchema()).fields.map((f) => f.id)
    expect(b).toEqual(a)
    expect(new Set(a).size).toBe(a.length)
  })

  it('fills text, select, radio, combobox and file, and reads the values back', async () => {
    const schema = await session.formSchema()
    const id = (label: string) => schema.fields.find((f) => f.label === label)!.id
    await session.fill(id('First Name'), 'Alex')
    await session.fill(id('Last Name'), 'Tan')
    await session.fill(id('Email'), 'alex.tan@example.com')
    await session.fill(id('Location (City)'), 'Sing')
    await session.fill(id('Are you legally authorized to work in Singapore?'), 'yes')
    await session.fill(id('Will you now or in the future require visa sponsorship?'), 'No')
    await session.upload(id('Resume/CV'), resumePath)

    const values = await session.readValues()
    expect(values[id('First Name')]).toBe('Alex')
    expect(values[id('Email')]).toBe('alex.tan@example.com')
    expect(values[id('Location (City)')]).toBe('Singapore') // picked from the dropdown list
    expect(values[id('Are you legally authorized to work in Singapore?')]).toBe('Yes')
    expect(values[id('Will you now or in the future require visa sponsorship?')]).toBe('No')
    expect(values[id('Resume/CV')]).toBe('Alex_Tan_Resume.pdf')
  })

  it('rejects an unknown option and an unknown field', async () => {
    const schema = await session.formSchema()
    const auth = schema.fields.find((f) => f.type === 'select')!
    await expect(session.fill(auth.id, 'maybe')).rejects.toThrow(/not an option/)
    await expect(session.fill('f_nope_0000', 'x')).rejects.toThrow(/No field/)
  })

  it('submits and the server receives the values and the file', async () => {
    const result = await session.submit()
    expect(result.advanced).toBe(true)
    expect((await session.snapshot()).text).toContain('Thank you for applying')
    const sub = server.submissions.at(-1)!
    expect(sub).toMatchObject({ company: 'Lumen AI', kind: 'greenhouse' })
    expect(sub.fields.first_name).toBe('Alex')
    expect(sub.files.resume).toMatchObject({ filename: 'Alex_Tan_Resume.pdf' })
  })
})

describe('multi step forms', () => {
  it('walks a wizard and reports the step', async () => {
    await session.open(`${server.url}/co/quanta/careers/202`)
    let schema = await session.formSchema()
    expect(schema.step).toEqual({ index: 1, total: 2 })
    expect(schema.fields.map((f) => f.label)).toContain('Resume')
    const result = await session.next()
    expect(result.advanced).toBe(true) // this wizard has no client side validation between steps
    schema = await session.formSchema()
    expect(schema.step?.index).toBe(2)
    expect(schema.fields.map((f) => f.label)).not.toContain('Resume') // hidden step is not reported
    expect(schema.actions.find((a) => a.kind === 'submit')).toBeTruthy()
  })

  it('finds the Apply button as an open action, then the form after clicking it', async () => {
    await session.open(`${server.url}/co/northstar/careers/201`)
    let schema = await session.formSchema()
    expect(schema.fields).toHaveLength(0)
    const open = schema.actions.find((a) => a.kind === 'open')!
    expect(open.label).toBe('Apply now')
    const res = await session.click(open.id)
    expect(res.advanced).toBe(true)
    schema = await session.formSchema()
    expect(schema.fields.find((f) => f.label === 'I agree to the privacy policy')?.type).toBe(
      'checkbox',
    )
  })
})

describe('storage state and registry', () => {
  it('saves and reloads cookies (Workday sign in)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aa-state-'))
    const statePath = join(dir, 'wd.json')

    const s1 = await backend.launch({ headless: true })
    await s1.open(`${server.url}/wd/meridian/job/301`)
    const wall = await s1.formSchema()
    expect(wall.fields.map((f) => f.type)).toContain('password')
    await s1.fill(wall.fields.find((f) => f.type === 'email')!.id, 'a@b.test')
    await s1.fill(wall.fields.find((f) => f.type === 'password')!.id, 'x')
    await s1.click(wall.actions.find((a) => a.label === 'Sign In')!.id)
    await s1.saveState(statePath)
    await s1.close()

    const s2 = await backend.launch({ headless: true, storageStatePath: statePath })
    await s2.open(`${server.url}/wd/meridian/job/301`)
    expect((await s2.snapshot()).headings.join(' ')).toContain('AI Engineer')
    await s2.close()
  })

  it('registers backends and refuses unknown or unimplemented ones', async () => {
    const reg = new BackendRegistry()
      .register('playwright-chromium', () => new PlaywrightBackend())
      .register('ai-browser', () => new NotImplementedBackend('ai-browser'))
    expect(reg.names()).toEqual(['playwright-chromium', 'ai-browser'])
    await expect(reg.launch('ai-browser', { headless: true })).rejects.toThrow(/not implemented/)
    expect(() => reg.get('nope')).toThrow(/Unknown browser backend/)
  })
})

describe('lean mode', () => {
  it('still extracts the same fields with images blocked', async () => {
    const lean = new PlaywrightBackend('playwright-lean', { lean: true })
    const s = await lean.launch({ headless: true })
    await s.open(`${server.url}/gh/lumen-ai/jobs/101`)
    const ids = (await s.formSchema()).fields.map((f) => f.id)
    const full = await backend.launch({ headless: true })
    await full.open(`${server.url}/gh/lumen-ai/jobs/101`)
    expect((await full.formSchema()).fields.map((f) => f.id)).toEqual(ids)
    await s.close()
    await full.close()
    await lean.dispose()
  })
})
