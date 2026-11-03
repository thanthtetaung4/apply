import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import puppeteer, { type Browser } from 'puppeteer-core'
import { resolveChromium } from '../browser/chromium'

/** Renders HTML to PDF with Puppeteer. One browser is reused across resumes. */
export class ResumeRenderer {
  private browser?: Promise<Browser>

  constructor(private readonly executablePath?: string) {}

  private launch(): Promise<Browser> {
    this.browser ??= puppeteer.launch({
      executablePath: this.executablePath ?? resolveChromium(),
      headless: true,
      // Chromium refuses to start as root without this. Only our own generated HTML is loaded.
      args: process.getuid?.() === 0 ? ['--no-sandbox', '--disable-setuid-sandbox'] : [],
    })
    return this.browser
  }

  async renderPdf(html: string, outPath: string): Promise<{ pages: number; bytes: number }> {
    const browser = await this.launch()
    const page = await browser.newPage()
    try {
      await page.setContent(html, { waitUntil: 'load' })
      const pdf = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true })
      await mkdir(dirname(outPath), { recursive: true })
      await writeFile(outPath, pdf)
      const doc = await PDFDocument.load(pdf)
      return { pages: doc.getPageCount(), bytes: pdf.length }
    } finally {
      await page.close()
    }
  }

  async close(): Promise<void> {
    const b = this.browser
    this.browser = undefined
    if (b) await (await b).close().catch(() => undefined)
  }
}
