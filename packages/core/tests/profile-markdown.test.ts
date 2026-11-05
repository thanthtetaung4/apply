import { describe, expect, it } from 'vitest'
import {
  bullets,
  dateRange,
  keyValues,
  paragraph,
  pipeParts,
  splitByHeading,
  toLines,
} from '../src/profile/markdown'

describe('markdown helpers', () => {
  it('splits by heading level and ignores headings in code fences', () => {
    const md = [
      'intro',
      '# A',
      'a1',
      '```',
      '# not a heading',
      '```',
      '## sub',
      's1',
      '# B',
      'b1',
    ].join('\n')
    const { preamble, sections } = splitByHeading(toLines(md), 1)
    expect(preamble).toEqual(['intro'])
    expect(sections.map((s) => s.title)).toEqual(['A', 'B'])
    expect(sections[0]!.lines).toContain('# not a heading')
    expect(sections[0]!.lines).toContain('## sub')
  })

  it('closes a section at a higher level heading', () => {
    const { sections } = splitByHeading(toLines('# Top\n## One\nx\n# Next\ny'), 2)
    expect(sections).toHaveLength(1)
    expect(sections[0]!.lines).toEqual(['x'])
  })

  it('handles BOM and CRLF', () => {
    expect(toLines('﻿# A\r\n- x\r\n')).toEqual(['# A', '- x', ''])
  })

  it('extracts bullets with continuation lines', () => {
    expect(bullets(['- one', '  more', '* two', '', 'text', '+ three'])).toEqual([
      'one more',
      'two',
      'three',
    ])
  })

  it('reads only allowed key value pairs', () => {
    const kv = keyValues(['Stack: A, B', 'Note: x', 'Link: https://a.test'], ['stack', 'link'])
    expect(kv).toEqual({ stack: 'A, B', link: 'https://a.test' })
  })

  it('builds a paragraph without bullets or known keys', () => {
    expect(paragraph(['Stack: A', 'Hello', 'world', '- b'], ['stack'])).toBe('Hello world')
  })

  it('parses pipe headers and date ranges', () => {
    expect(pipeParts('A | B | C')).toEqual(['A', 'B', 'C'])
    expect(dateRange('Jan 2020 - Present')).toEqual(['Jan 2020', 'Present'])
    expect(dateRange('2020 – 2022')).toEqual(['2020', '2022'])
    expect(dateRange('2020 to 2022')).toEqual(['2020', '2022'])
    expect(dateRange('2020')).toBeNull()
  })
})
