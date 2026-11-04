import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Frame,
  type Locator,
  type Page,
} from 'playwright-core'
import type { StorageState } from '../store'
import { resolveChromium } from './chromium'
import { extractScript } from './extract-script'
import {
  BrowserError,
  type ActionKind,
  type BrowserBackend,
  type BrowserSession,
  type FieldValue,
  type FormAction,
  type FormField,
  type FormSchema,
  type LaunchOptions,
  type PageSnapshot,
  type StepResult,
} from './types'

interface Extracted {
  fields: FormField[]
  actions: { id: string; label: string }[]
  errors: string[]
  stepText: string
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function classifyAction(label: string, hasFields: boolean): ActionKind {
  const l = label.toLowerCase().trim()
  if (/^(back|previous|prev)\b/.test(l)) return 'back'
  if (/\bsubmit\b|\bsend application\b|\bfinish\b|\bcomplete application\b/.test(l)) return 'submit'
  if (/\b(save (and|&) continue|next|continue|proceed|review)\b/.test(l)) return 'next'
  if (/\beasy apply\b|\bapply (now|here|today)\b.*\b(company|employer)/.test(l)) return 'open'
  if (/\bapply\b/.test(l)) return hasFields ? 'submit' : 'open'
  return 'other'
}

export interface PlaywrightBackendOptions {
  /** Block images, fonts and media. Lower memory and faster loads. */
  lean?: boolean
  executablePath?: string
  actionTimeoutMs?: number
}

export class PlaywrightBackend implements BrowserBackend {
  private browsers = new Map<boolean, Promise<Browser>>()

  constructor(
    readonly name = 'playwright-chromium',
    private readonly options: PlaywrightBackendOptions = {},
  ) {}

  private browser(headless: boolean): Promise<Browser> {
    let p = this.browsers.get(headless)
    if (!p) {
      p = chromium
        .launch({ executablePath: this.options.executablePath ?? resolveChromium(), headless })
        .catch((err) => {
          this.browsers.delete(headless)
          throw new BrowserError(`Could not launch Chromium: ${(err as Error).message}`, 'launch')
        })
      this.browsers.set(headless, p)
    }
    return p
  }

  async launch(options: LaunchOptions): Promise<BrowserSession> {
    const browser = await this.browser(options.headless)
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      locale: 'en-SG',
      timezoneId: 'Asia/Singapore',
      storageState: options.storageState as BrowserContextOptions['storageState'],
    })
    context.setDefaultTimeout(this.options.actionTimeoutMs ?? 8000)
    if (this.options.lean) {
      await context.route('**/*', (route) =>
        ['image', 'font', 'media'].includes(route.request().resourceType())
          ? route.abort()
          : route.continue(),
      )
    }
    const page = await context.newPage()
    page.on('dialog', (d) => void d.dismiss().catch(() => undefined))
    return new PlaywrightSession(this.name, context, page)
  }

  async dispose(): Promise<void> {
    const all = [...this.browsers.values()]
    this.browsers.clear()
    await Promise.allSettled(all.map(async (p) => (await p).close()))
  }
}

class PlaywrightSession implements BrowserSession {
  private fieldFrames = new Map<string, Frame>()
  private fieldMeta = new Map<string, FormField>()
  private actionFrames = new Map<string, Frame>()
  /** Options of custom dropdowns, read once per page. null: none until typing (a search box). */
  private comboOptions = new Map<string, string[] | null>()

  constructor(
    readonly backend: string,
    private readonly context: BrowserContext,
    private readonly page: Page,
  ) {}

  async open(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: 'domcontentloaded' })
    await this.settle()
  }

  async url(): Promise<string> {
    return this.page.url()
  }

  async content(): Promise<string> {
    // Real sites redirect after load (LinkedIn does), which makes page.content() throw "the page
    // is navigating". Wait for the page to settle and try again.
    return this.retry(async () => {
      await this.settle()
      return this.page.content()
    }, 5)
  }

  async snapshot(): Promise<PageSnapshot> {
    const data = await this.retry(() =>
      this.page.evaluate(() => ({
        text: (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 4000),
        headings: Array.from(document.querySelectorAll('h1,h2,h3'))
          .map((h) => (h.textContent ?? '').replace(/\s+/g, ' ').trim())
          .filter(Boolean)
          .slice(0, 12),
      })),
    )
    // Embedded forms (Greenhouse inside stripe.com) show their messages, attached file names and
    // confirmations in a child frame. Add the text of frames that hold form fields.
    const formFrames = new Set(
      [...this.fieldFrames.values()].filter((f) => f !== this.page.mainFrame() && !f.isDetached()),
    )
    for (const frame of formFrames) {
      const t = await frame
        .evaluate('(document.body ? document.body.innerText : "").replace(/\\s+/g, " ").trim()')
        .catch(() => '')
      if (t) data.text = `${data.text} ${String(t).slice(0, 4000)}`
    }
    return { url: this.page.url(), title: await this.page.title(), ...data }
  }

  async formSchema(): Promise<FormSchema> {
    const fields: FormField[] = []
    const rawActions: { id: string; label: string; frame: Frame }[] = []
    const errors: string[] = []
    let stepText = ''
    this.fieldFrames.clear()
    this.fieldMeta.clear()
    this.actionFrames.clear()

    const frames = this.page.frames()
    for (const [i, frame] of frames.entries()) {
      if (i > 0 && (frame.url() === 'about:blank' || frame.isDetached())) continue
      let result: Extracted
      try {
        result = await this.retry(() =>
          frame.evaluate<Extracted>(extractScript(i === 0 ? '' : `f${i}`)),
        )
      } catch {
        continue
      }
      for (const f of result.fields) {
        fields.push(f)
        this.fieldFrames.set(f.id, frame)
        this.fieldMeta.set(f.id, f)
      }
      for (const a of result.actions) rawActions.push({ ...a, frame })
      errors.push(...result.errors)
      stepText ||= result.stepText
    }

    // Custom dropdowns only render their options when opened. Open each once per page, read the
    // options, close it. Those with options become selects; those without are search boxes that
    // suggest only after typing (location fields).
    for (const f of fields) {
      if (f.hint !== 'combobox' || f.disabled) continue
      const key = `${this.page.url()}|${f.id}`
      let opts = this.comboOptions.get(key)
      if (opts === undefined) {
        opts = await this.readComboOptions(this.fieldFrames.get(f.id)!, f.id)
        this.comboOptions.set(key, opts)
      }
      if (opts && opts.length > 0) {
        f.type = 'select'
        f.options = opts
      } else {
        f.hint = 'autocomplete'
      }
    }

    const actions: FormAction[] = rawActions.map((a) => {
      this.actionFrames.set(a.id, a.frame)
      return { id: a.id, label: a.label, kind: classifyAction(a.label, fields.length > 0) }
    })

    const m = /(\d+)\s*(?:of|\/)\s*(\d+)/i.exec(stepText)
    return {
      url: this.page.url(),
      title: await this.page.title(),
      step: m ? { index: Number(m[1]), total: Number(m[2]) } : undefined,
      fields,
      actions,
    }
  }

  private meta(fieldId: string): { field: FormField; frame: Frame } {
    const field = this.fieldMeta.get(fieldId)
    const frame = this.fieldFrames.get(fieldId)
    if (!field || !frame) {
      throw new BrowserError(
        `No field "${fieldId}" on the current page. Call formSchema() first.`,
        'no_such_field',
      )
    }
    return { field, frame }
  }

  async fill(fieldId: string, value: FieldValue): Promise<void> {
    const { field, frame } = this.meta(fieldId)
    const loc = frame.locator(`[data-aa="${fieldId}"]`)
    const text = Array.isArray(value) ? value.join(', ') : String(value)

    switch (field.type) {
      case 'select': {
        const options = field.options ?? []
        const want = text.trim().toLowerCase()
        const hit =
          options.find((o) => o.toLowerCase() === want) ??
          options.find((o) => o.toLowerCase().includes(want) || want.includes(o.toLowerCase()))
        if (!hit)
          throw new BrowserError(`"${text}" is not an option of "${field.label}"`, 'no_such_field')
        if (field.hint === 'combobox') await this.pickComboOption(frame, loc.first(), hit)
        else await loc.first().selectOption({ label: hit })
        break
      }
      case 'radio': {
        const options = field.options ?? []
        const want = text.trim().toLowerCase()
        const idx =
          options.findIndex((o) => o.toLowerCase() === want) >= 0
            ? options.findIndex((o) => o.toLowerCase() === want)
            : options.findIndex((o) => o.toLowerCase().includes(want))
        if (idx < 0)
          throw new BrowserError(`"${text}" is not an option of "${field.label}"`, 'no_such_field')
        // Choice buttons (Ashby's Yes / No) are clicked, not checked.
        if (field.hint === 'buttons') await loc.nth(idx).click()
        else await loc.nth(idx).check({ force: true })
        break
      }
      case 'checkbox': {
        if (field.options) {
          const wanted = (Array.isArray(value) ? value : [text]).map((v) => v.toLowerCase())
          for (const [i, o] of field.options.entries()) {
            await loc.nth(i).setChecked(wanted.includes(o.toLowerCase()), { force: true })
          }
        } else {
          await loc
            .first()
            .setChecked(value === true || /^(true|yes|1)$/i.test(text), { force: true })
        }
        break
      }
      case 'file':
        throw new BrowserError(`Use upload() for file field "${field.label}"`, 'no_such_field')
      default: {
        if (field.hint === 'autocomplete' || field.hint === 'combobox') {
          await this.pickSuggestion(frame, loc.first(), field.label, text)
        } else {
          await loc.first().fill(text)
        }
      }
    }
  }

  /** Visible options of the list a dropdown input controls, or of any open list. */
  private async listOptions(frame: Frame, input: Locator): Promise<Locator> {
    const owned = await input
      .evaluate('(e) => e.getAttribute("aria-controls") || e.getAttribute("aria-owns") || ""')
      .catch(() => '')
    const list = owned
      ? frame.locator(`[id="${String(owned)}"]`)
      : frame.locator('[role=listbox]:visible')
    return list.locator('[role=option]')
  }

  /** Open a custom dropdown, read its option labels, close it again. */
  private async readComboOptions(frame: Frame, id: string): Promise<string[] | null> {
    const input = frame.locator(`[data-aa="${id}"]`).first()
    try {
      await input.click({ timeout: 3000 })
      let texts: string[] = []
      for (let i = 0; i < 4 && texts.length === 0; i++) {
        if (i === 2) await input.press('ArrowDown').catch(() => undefined)
        await sleep(200)
        texts = await (await this.listOptions(frame, input)).allInnerTexts()
      }
      return texts
        .map((t) => t.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .slice(0, 500)
    } catch {
      return null
    } finally {
      await input.press('Escape').catch(() => undefined)
      await input.evaluate('(e) => e.blur()').catch(() => undefined)
    }
  }

  /** Choose an option in a custom dropdown: open it, narrow it by typing, click the option. */
  private async pickComboOption(frame: Frame, input: Locator, option: string): Promise<void> {
    const exact = new RegExp(`^\\s*${escapeRe(option)}\\s*$`, 'i')
    // Wait for the option to render, then click it. Note: locator.isVisible() does not wait
    // (its timeout is ignored), which made this fail at random on a real Stripe form.
    const clickOption = async (ms: number) => {
      const options = await this.listOptions(frame, input)
      let target = options.filter({ hasText: exact })
      if ((await target.count()) === 0) target = options.filter({ hasText: option })
      try {
        await target.first().waitFor({ state: 'visible', timeout: ms })
        await target.first().click()
        await sleep(150)
        return true
      } catch {
        return false
      }
    }
    await input.click()
    // Short lists show the option as soon as they open.
    if (await clickOption(1500)) return
    // Long lists (countries, schools) need typing to bring it into view.
    await input.fill('').catch(() => undefined)
    await input.pressSequentially(option.slice(0, 40), { delay: 15 })
    if (await clickOption(6000)) return
    // Last resort: typing left exactly this option, and Enter picks it.
    const left = (await (await this.listOptions(frame, input)).allInnerTexts()).map((t) => t.trim())
    if (left.length === 1 && left[0]!.toLowerCase() === option.trim().toLowerCase()) {
      await input.press('Enter')
      await sleep(150)
      return
    }
    await input.press('Escape').catch(() => undefined)
    throw new BrowserError(`Could not choose "${option}" in a dropdown`, 'no_such_field')
  }

  /**
   * Type into a search box and choose the suggestion that matches (Ashby and Lever location).
   * Throws when nothing suitable is suggested, rather than leaving typed but unselected text.
   */
  private async pickSuggestion(
    frame: Frame,
    input: Locator,
    label: string,
    text: string,
  ): Promise<void> {
    await input.click()
    await input.fill('')
    await input.pressSequentially(text, { delay: 50 })
    const want = text.trim().toLowerCase()
    const candidates = frame.locator('[role=option]:visible, .dropdown-results > *:visible')
    for (let waited = 0; waited < 5000; waited += 250) {
      await sleep(250)
      const texts = (await candidates.allInnerTexts()).map((t) => t.trim().toLowerCase())
      if (texts.length === 0) continue
      let idx = texts.findIndex((t) => t === want)
      if (idx < 0) idx = texts.findIndex((t) => t.startsWith(want))
      if (idx < 0) idx = texts.findIndex((t) => t.includes(want))
      if (idx < 0) break
      await candidates.nth(idx).click()
      await sleep(200)
      return
    }
    await input.press('Escape').catch(() => undefined)
    throw new BrowserError(`No suggestion matched "${text}" for "${label}"`, 'no_such_field')
  }

  async upload(fieldId: string, filePath: string): Promise<void> {
    const { frame } = this.meta(fieldId)
    await frame.locator(`[data-aa="${fieldId}"]`).first().setInputFiles(filePath)
    await sleep(120) // let upload handlers (resume parsing prefill) run
  }

  async click(actionId: string): Promise<StepResult> {
    const frame = this.actionFrames.get(actionId)
    if (!frame)
      throw new BrowserError(`No action "${actionId}" on the current page`, 'no_such_action')
    const before = await this.fingerprint()
    await frame.locator(`[data-aa-action="${actionId}"]`).first().click()
    return this.afterClick(before)
  }

  async next(): Promise<StepResult> {
    return this.clickKind('next')
  }

  async submit(): Promise<StepResult> {
    return this.clickKind('submit')
  }

  private async clickKind(kind: ActionKind): Promise<StepResult> {
    const schema = await this.formSchema()
    const action = schema.actions.find((a) => a.kind === kind)
    if (!action) throw new BrowserError(`No "${kind}" action on ${schema.url}`, 'no_such_action')
    return this.click(action.id)
  }

  async readValues(): Promise<Record<string, FieldValue | undefined>> {
    const schema = await this.formSchema()
    return Object.fromEntries(schema.fields.map((f) => [f.id, f.value]))
  }

  async screenshot(): Promise<Buffer> {
    // When the form lives in an embedded frame (Stripe embeds Greenhouse), a full page shot often
    // comes out blank where the frame is. Capture the frame that holds most of the fields.
    const counts = new Map<Frame, number>()
    for (const fr of this.fieldFrames.values()) counts.set(fr, (counts.get(fr) ?? 0) + 1)
    const [busiest] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? []
    if (busiest && busiest !== this.page.mainFrame() && !busiest.isDetached()) {
      const el = await busiest.frameElement().catch(() => null)
      // Filling scrolls the page; measure from the top so the frame's full height is known.
      await this.page.evaluate('window.scrollTo(0, 0)').catch(() => undefined)
      const box = el ? await el.boundingBox().catch(() => null) : null
      if (el && box) {
        // Chromium paints a frame only inside the viewport; a tall embedded form below the fold
        // comes out white. Grow the viewport to fit the frame for the shot, then restore it.
        const before = this.page.viewportSize()
        const tall = Math.min(Math.ceil(box.y + box.height) + 20, 12_000)
        try {
          if (before && tall > before.height)
            await this.page.setViewportSize({ width: before.width, height: tall })
          await sleep(800)
          return await el.screenshot({ type: 'png' })
        } catch {
          // fall back to a page shot below
        } finally {
          if (before) await this.page.setViewportSize(before).catch(() => undefined)
        }
      }
    }
    return this.page.screenshot({ fullPage: true, type: 'png' })
  }

  async exportState(): Promise<StorageState> {
    const state = await this.context.storageState()
    return {
      cookies: state.cookies as unknown as Record<string, unknown>[],
      origins: state.origins as unknown as Record<string, unknown>[],
    }
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => undefined)
  }

  // --- helpers ---------------------------------------------------------------------------

  private async fingerprint(): Promise<string> {
    const fields: string[] = []
    for (const frame of this.page.frames()) {
      if (frame.isDetached()) continue
      const ids = await frame
        .evaluate(() =>
          Array.from(document.querySelectorAll('[data-aa]')).map((e) => e.getAttribute('data-aa')),
        )
        .catch(() => [] as (string | null)[])
      fields.push(...ids.map(String))
    }
    return `${this.page.url()}|${[...new Set(fields)].join(',')}`
  }

  /** After a click: wait for navigation, a new step, or visible errors (up to about 2.5 seconds). */
  private async afterClick(before: string): Promise<StepResult> {
    await this.page.waitForLoadState('domcontentloaded').catch(() => undefined)
    let schema = await this.formSchema()
    const key = (s: FormSchema) => `${s.url}|${s.fields.map((f) => f.id).join(',')}`
    for (let i = 0; i < 25; i++) {
      const changed = key(schema) !== before
      const errors = await this.visibleErrors()
      if (changed || errors.length > 0) break
      await sleep(100)
      schema = await this.formSchema()
    }
    // Let the page finish rendering the new step before the caller reads it.
    await sleep(60)
    schema = await this.formSchema()
    return { advanced: key(schema) !== before, errors: await this.visibleErrors() }
  }

  private async visibleErrors(): Promise<string[]> {
    const out: string[] = []
    for (const frame of this.page.frames()) {
      if (frame.isDetached()) continue
      const e = await frame
        .evaluate(() =>
          Array.from(
            document.querySelectorAll(
              '[role=alert], .error, .field-error, .error-message, .errors li',
            ),
          )
            .filter((el) => {
              const r = el.getBoundingClientRect()
              return r.width > 0 && r.height > 0
            })
            .map((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim())
            .filter(Boolean)
            .slice(0, 8),
        )
        .catch(() => [] as string[])
      out.push(...e)
    }
    return out
  }

  private async settle(): Promise<void> {
    await this.page.waitForLoadState('load', { timeout: 5000 }).catch(() => undefined)
  }

  private async retry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
    let last: unknown
    for (let i = 0; i < tries; i++) {
      try {
        return await fn()
      } catch (err) {
        last = err
        await sleep(150) // a navigation may have destroyed the execution context
      }
    }
    throw last
  }
}
