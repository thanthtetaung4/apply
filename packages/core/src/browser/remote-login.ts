import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page,
} from 'playwright-core'
import type { StorageState } from '../store'
import { resolveChromium } from './chromium'

/**
 * A real browser the user signs in with, shown to them as a stream of screenshots.
 *
 * The page renders on the worker; the user's clicks and keys are replayed into it. Only the
 * resulting cookies and local storage are kept, never what was typed. Top level page loads are
 * limited to the site's own hosts, so the window cannot be used to browse elsewhere.
 */

export const VIEWPORT = { width: 1280, height: 800 }

export type RemoteInput =
  | { t: 'mouse'; type: 'move' | 'down' | 'up'; x: number; y: number; button?: 'left' | 'right' }
  | { t: 'wheel'; x: number; y: number; dx: number; dy: number }
  | { t: 'key'; key: string; ctrl?: boolean; meta?: boolean; alt?: boolean; shift?: boolean }
  | { t: 'text'; text: string }
  | { t: 'back' }

export interface RemoteLoginOptions {
  url: string
  /** Whether a top level page load may go to this host. */
  allowHost(host: string): boolean
  onFrame(jpeg: Buffer): void
  /** The address the user is on, shown read-only above the window. */
  onUrl?(url: string): void
  /** A page load outside the allowed hosts was stopped. */
  onBlocked?(host: string): void
  chromiumPath?: string
}

/** Keys passed to the page by name. Single characters are typed as text. */
const NAMED_KEYS = new Set([
  'Enter',
  'Tab',
  'Backspace',
  'Delete',
  'Escape',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Space',
])

const clamp = (n: number, max: number) => Math.min(Math.max(Math.round(n) || 0, 0), max)

export class RemoteLoginBrowser {
  private page!: Page
  private cdp: CDPSession | undefined
  private pages: Page[] = []
  private closed = false

  private constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private readonly o: RemoteLoginOptions,
  ) {}

  static async start(o: RemoteLoginOptions): Promise<RemoteLoginBrowser> {
    const start = new URL(o.url)
    if (!o.allowHost(start.hostname)) throw new Error(`Not allowed to open ${start.hostname}`)
    const browser = await chromium.launch({
      executablePath: o.chromiumPath ?? resolveChromium(),
      headless: true,
    })
    try {
      const context = await browser.newContext({
        viewport: VIEWPORT,
        deviceScaleFactor: 1,
        locale: 'en-US',
      })
      const r = new RemoteLoginBrowser(browser, context, o)
      await context.route('**/*', async (route) => {
        const req = route.request()
        // Only main frame navigations are limited. Iframes (CAPTCHA, payment widgets) and
        // subresources load normally.
        if (req.isNavigationRequest() && req.frame().parentFrame() === null) {
          let host = ''
          try {
            host = new URL(req.url()).hostname
          } catch {
            // about:blank and data: URLs have no host
          }
          const scheme = req.url().split(':')[0]
          if (scheme !== 'about' && scheme !== 'data' && !o.allowHost(host)) {
            o.onBlocked?.(host)
            return route.abort('blockedbyclient')
          }
        }
        return route.continue()
      })
      context.on('page', (p) => void r.follow(p))
      const page = await context.newPage()
      await r.follow(page)
      await page.goto(o.url, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {
        // A slow page still streams; the user sees whatever loaded.
      })
      return r
    } catch (err) {
      await browser.close().catch(() => undefined)
      throw err
    }
  }

  /** Show a page: the first one, or a pop up the site opened (for example a 2FA window). */
  private async follow(p: Page): Promise<void> {
    if (this.closed || this.page === p) return
    if (!this.pages.includes(p)) this.pages.push(p)
    p.on('close', () => {
      this.pages = this.pages.filter((x) => x !== p)
      const last = this.pages.at(-1)
      if (this.page === p && last && !this.closed) void this.follow(last)
    })
    p.on('framenavigated', (f) => {
      if (f === p.mainFrame() && this.page === p) this.o.onUrl?.(p.url())
    })
    await this.cdp?.send('Page.stopScreencast').catch(() => undefined)
    await this.cdp?.detach().catch(() => undefined)
    this.page = p
    this.o.onUrl?.(p.url())
    const cdp = await this.context.newCDPSession(p)
    this.cdp = cdp
    cdp.on('Page.screencastFrame', (f: { data: string; sessionId: number }) => {
      if (this.cdp !== cdp || this.closed) return
      this.o.onFrame(Buffer.from(f.data, 'base64'))
      void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => undefined)
    })
    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 70,
      maxWidth: VIEWPORT.width,
      maxHeight: VIEWPORT.height,
    })
    await p.bringToFront().catch(() => undefined)
  }

  /** Replay one user action. Coordinates are in viewport pixels. */
  async input(ev: RemoteInput): Promise<void> {
    if (this.closed) return
    const m = this.page.mouse
    const kb = this.page.keyboard
    switch (ev.t) {
      case 'mouse': {
        const x = clamp(ev.x, VIEWPORT.width)
        const y = clamp(ev.y, VIEWPORT.height)
        const button = ev.button === 'right' ? 'right' : 'left'
        if (ev.type === 'move') await m.move(x, y)
        else if (ev.type === 'down') {
          await m.move(x, y)
          await m.down({ button })
        } else await m.up({ button })
        return
      }
      case 'wheel':
        await m.move(clamp(ev.x, VIEWPORT.width), clamp(ev.y, VIEWPORT.height))
        await m.wheel(
          Math.max(-2000, Math.min(2000, ev.dx || 0)),
          Math.max(-2000, Math.min(2000, ev.dy || 0)),
        )
        return
      case 'key': {
        const key = String(ev.key)
        const mod = ev.ctrl || ev.meta
        if (key.length === 1 && mod) {
          // Copy, paste, select all, undo: the page's own shortcut handling.
          await kb.press(`ControlOrMeta+${key.toLowerCase()}`)
        } else if (key.length === 1) {
          await kb.type(key)
        } else if (NAMED_KEYS.has(key)) {
          await kb.press(ev.shift && key === 'Tab' ? 'Shift+Tab' : key)
        }
        return
      }
      case 'text':
        // Pasted text. Limited so a huge paste cannot hang the page.
        await kb.insertText(String(ev.text).slice(0, 2000))
        return
      case 'back':
        await this.page.goBack({ timeout: 15_000 }).catch(() => undefined)
        return
    }
  }

  url(): string {
    return this.page.url()
  }

  async exportState(): Promise<StorageState> {
    return (await this.context.storageState()) as unknown as StorageState
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.cdp?.detach().catch(() => undefined)
    await this.browser.close().catch(() => undefined)
  }
}

/** Cookies set by the site itself (not by ads or CAPTCHA widgets), to tell a real sign in. */
export function siteCookies(
  state: StorageState,
  allowHost: (host: string) => boolean,
): Record<string, unknown>[] {
  return state.cookies.filter((c) => {
    const domain = String(c.domain ?? '').replace(/^\./, '')
    return domain !== '' && allowHost(domain)
  })
}
