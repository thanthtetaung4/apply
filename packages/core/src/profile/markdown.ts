export interface Section {
  title: string
  lines: string[]
}

export interface SplitResult {
  preamble: string[]
  sections: Section[]
}

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/

export function toLines(md: string): string[] {
  return md
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
}

/**
 * Split lines into sections that start at a heading of exactly `level`.
 * A section ends at the next heading of the same or a higher level. Deeper headings
 * stay inside the section. Headings inside fenced code blocks are ignored.
 */
export function splitByHeading(lines: string[], level: number): SplitResult {
  const preamble: string[] = []
  const sections: Section[] = []
  let current: Section | null = null
  let fenced = false

  for (const line of lines) {
    if (/^\s*```/.test(line)) fenced = !fenced
    const m = fenced ? null : HEADING.exec(line)
    const depth = m?.[1]?.length ?? 0
    if (m && depth === level) {
      current = { title: (m[2] ?? '').trim(), lines: [] }
      sections.push(current)
    } else if (m && depth < level) {
      current = null // a higher-level heading closes the section
      preamble.push(line)
    } else if (current) {
      current.lines.push(line)
    } else {
      preamble.push(line)
    }
  }
  return { preamble, sections }
}

/** List items (`-`, `*`, `+`). Indented continuation lines are joined to the previous item. */
export function bullets(lines: string[]): string[] {
  const out: string[] = []
  for (const line of lines) {
    const item = /^\s{0,3}[-*+]\s+(.*\S)\s*$/.exec(line)
    if (item) {
      out.push((item[1] ?? '').trim())
    } else if (/^\s{2,}\S/.test(line) && out.length > 0 && !/^\s*#/.test(line)) {
      out[out.length - 1] += ' ' + line.trim()
    }
  }
  return out
}

/** `Key: value` lines for the allowed keys (case-insensitive). Keys are returned lowercase. */
export function keyValues(lines: string[], allowed: readonly string[]): Record<string, string> {
  const keys = new Set(allowed.map((k) => k.toLowerCase()))
  const out: Record<string, string> = {}
  for (const line of lines) {
    const m = /^\s*([A-Za-z][A-Za-z ]*?)\s*:\s*(.+?)\s*$/.exec(line)
    if (!m) continue
    const key = (m[1] ?? '').toLowerCase()
    if (keys.has(key) && !(key in out)) out[key] = m[2] ?? ''
  }
  return out
}

/** Free text: lines that are not list items, not headings and not `Key: value` for known keys. */
export function paragraph(lines: string[], excludeKeys: readonly string[] = []): string {
  const keys = new Set(excludeKeys.map((k) => k.toLowerCase()))
  const kept: string[] = []
  for (const line of lines) {
    if (!line.trim()) continue
    if (/^\s*[-*+]\s+/.test(line) || /^\s*#/.test(line)) continue
    const kv = /^\s*([A-Za-z][A-Za-z ]*?)\s*:/.exec(line)
    if (kv && keys.has((kv[1] ?? '').toLowerCase())) continue
    kept.push(line.trim())
  }
  return kept.join(' ')
}

export function findSection(sections: Section[], ...names: string[]): Section | undefined {
  const wanted = names.map((n) => n.toLowerCase())
  return sections.find((s) => wanted.includes(s.title.toLowerCase()))
}

/** Split `A | B | C` header text into trimmed parts. */
export function pipeParts(title: string): string[] {
  return title.split('|').map((p) => p.trim())
}

/** Split `Jan 2024 - Present` into [start, end]. Accepts hyphen, en dash, em dash, or "to". */
export function dateRange(text: string): [string, string] | null {
  const parts = text.split(/\s+(?:[-–—]|to)\s+/i).map((p) => p.trim())
  if (parts.length === 2 && parts[0] && parts[1]) return [parts[0], parts[1]]
  return null
}
