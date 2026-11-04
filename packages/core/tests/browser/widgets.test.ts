import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PlaywrightBackend } from '../../src/browser/playwright-backend'
import type { BrowserSession, FormField } from '../../src/browser/types'
import { valuesMatch } from '../../src/verify/compare'

// Custom widgets from real application forms (Greenhouse, Ashby, Lever). See the fixture.
const PAGE = pathToFileURL(resolve(__dirname, '../fixtures/widgets.html')).toString()

let backend: PlaywrightBackend
let s: BrowserSession
let fields: FormField[]
const byLabel = (re: RegExp) => {
  const f = fields.find((x) => re.test(x.label))
  if (!f) throw new Error(`no field ${re}; have ${fields.map((x) => x.label).join(' | ')}`)
  return f
}

beforeAll(async () => {
  backend = new PlaywrightBackend()
  s = await backend.launch({ headless: true })
  await s.open(PAGE)
  fields = (await s.formSchema()).fields
}, 60_000)

afterAll(async () => {
  await s?.close()
  await backend?.dispose()
})

describe('reading custom widgets', () => {
  it('turns react-select dropdowns into selects with their real options', () => {
    expect(byLabel(/sponsorship/)).toMatchObject({
      type: 'select',
      hint: 'combobox',
      options: ['Yes', 'No'],
      required: true,
      value: '',
    })
    expect(byLabel(/country of residence/).options).toContain('Singapore')
  })

  it('treats search boxes without options as suggestions fields', () => {
    expect(byLabel(/^Location$/)).toMatchObject({ type: 'text', hint: 'autocomplete' })
    expect(byLabel(/^Current location$/)).toMatchObject({
      type: 'text',
      hint: 'autocomplete',
      required: true,
    })
  })

  it('reads Lever questions from the card and Ashby yes/no buttons as questions', () => {
    expect(byLabel(/legally authorized/)).toMatchObject({
      type: 'radio',
      options: ['Yes', 'No'],
      required: true,
    })
    expect(byLabel(/proudest accomplishment/)).toMatchObject({ type: 'textarea', required: true })
    expect(byLabel(/Anchor Days/)).toMatchObject({
      type: 'radio',
      hint: 'buttons',
      options: ['Yes', 'No'],
      required: true,
    })
    expect(fields.some((f) => /cards\[/.test(f.label))).toBe(false)
  })

  it('does not list answer buttons as page actions', async () => {
    const { actions } = await s.formSchema()
    expect(actions.map((a) => a.label)).not.toContain('Yes')
    expect(actions.some((a) => a.kind === 'submit')).toBe(true)
  })
})

describe('filling custom widgets', () => {
  it('chooses dropdown options and reads back the chosen value, not typed text', async () => {
    await s.fill(byLabel(/sponsorship/).id, 'Yes')
    await s.fill(byLabel(/country of residence/).id, 'Singapore')
    await s.fill(byLabel(/Anchor Days/).id, 'Yes')
    await s.fill(byLabel(/legally authorized/).id, 'Yes')
    await s.fill(byLabel(/^Location$/).id, 'Singapore')
    await s.fill(byLabel(/^Current location$/).id, 'Singapore')
    await s.fill(byLabel(/hear about us/).id, 'Company careers page')

    const back = await s.readValues()
    fields = (await s.formSchema()).fields
    const v = (re: RegExp) => back[byLabel(re).id]
    expect(v(/sponsorship/)).toBe('Yes')
    expect(v(/country of residence/)).toBe('Singapore')
    expect(v(/Anchor Days/)).toBe('Yes')
    expect(v(/legally authorized/)).toBe('Yes')
    expect(valuesMatch('text', 'Singapore', v(/^Location$/))).toBe(true)
    expect(v(/^Current location$/)).toBe('Singapore')
    expect(v(/hear about us/)).toBe('Company careers page')
  }, 60_000)

  it('refuses an answer that is not an option instead of leaving typed text', async () => {
    const country = byLabel(/country of residence/)
    await expect(s.fill(country.id, 'Atlantis')).rejects.toThrow(/not an option/)
    await expect(s.fill(byLabel(/^Location$/).id, 'Zzyzx')).rejects.toThrow(/No suggestion/)
  }, 60_000)

  it('a typed but unchosen dropdown reads back empty', async () => {
    await s.open(PAGE)
    const f = (await s.formSchema()).fields.find((x) => /sponsorship/.test(x.label))!
    // What the old code did: type into the input and move on.
    const page = (s as unknown as { page: import('playwright-core').Page }).page
    await page.locator(`[data-aa="${f.id}"]`).fill('Yes')
    await page.locator('#native').focus()
    expect((await s.readValues())[f.id]).toBe('')
  }, 60_000)
})

describe('comparing chosen suggestions', () => {
  it('accepts extra detail after a comma or bracket only', () => {
    expect(valuesMatch('text', 'Singapore', 'Singapore, Singapore')).toBe(true)
    expect(valuesMatch('text', 'Singapore', 'Singapore (SG)')).toBe(true)
    expect(valuesMatch('text', 'Singapore', 'Singapore River')).toBe(false)
    expect(valuesMatch('text', 'No', 'Not sure')).toBe(false)
  })
})

describe('Greenhouse file fields', () => {
  it('reads the question above an "Attach" button and uploads the resume there', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    await s.open(PAGE)
    const file = (await s.formSchema()).fields.find((f) => f.type === 'file')!
    expect(file).toMatchObject({ label: 'Resume/CV', required: true })
    const pdf = join(mkdtempSync(join(tmpdir(), 'aa-')), 'Thant_Htet_Aung_Resume.pdf')
    writeFileSync(pdf, '%PDF-1.4 test')
    await s.upload(file.id, pdf)
    expect((await s.readValues())[file.id]).toBe('Thant_Htet_Aung_Resume.pdf')
  }, 60_000)
})

describe('phone country pickers', () => {
  it('accept the dialling code shown for the chosen country, nothing looser', () => {
    expect(valuesMatch('select', 'Singapore +65', '+65')).toBe(true)
    expect(valuesMatch('select', 'Singapore+65', '+65')).toBe(true)
    expect(valuesMatch('select', 'Singapore +65', '+60')).toBe(false)
    expect(valuesMatch('select', 'Yes, I need sponsorship', 'sponsorship')).toBe(false)
  })
})
