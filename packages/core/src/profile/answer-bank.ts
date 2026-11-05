import { normalizeText } from '../shared/hash'
import type { AnswerEntry } from './types'

export interface AnswerMatch {
  answer: string
  entryId: string
  pattern: string
  /** 1 for an exact match, otherwise the share of pattern words found in the question. */
  score: number
}

const STOP = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'of',
  'to',
  'in',
  'on',
  'for',
  'with',
  'at',
  'by',
  'from',
  'are',
  'is',
  'do',
  'does',
  'did',
  'you',
  'your',
  'we',
  'our',
  'will',
  'would',
  'can',
  'could',
  'have',
  'has',
  'be',
  'this',
  'that',
  'any',
  'please',
  'if',
  'what',
  'which',
  'how',
  'many',
  'when',
])

/** Lowercase words, no punctuation, no stop words, cut to 6 chars so "authorized" ~ "authorization". */
function stems(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w))
  return new Set(words.map((w) => w.slice(0, 6)))
}

export class AnswerBank {
  constructor(private readonly entries: AnswerEntry[]) {}

  get size(): number {
    return this.entries.length
  }

  /**
   * Find the best answer for a form question. Exact (normalized) match wins. Otherwise a pattern
   * matches when at least `threshold` of its words appear in the question. Ties go to the
   * pattern that covers more of the question.
   */
  match(question: string, threshold = 0.75): AnswerMatch | null {
    const q = normalizeText(question.replace(/[?:*]+/g, ' '))
    if (!q) return null
    const qStems = stems(q)
    let best: (AnswerMatch & { dice: number }) | null = null

    for (const entry of this.entries) {
      for (const pattern of entry.patterns) {
        const p = normalizeText(pattern.replace(/[?:*]+/g, ' '))
        let score: number
        let dice: number
        if (p === q) {
          score = 1
          dice = 1
        } else {
          const pStems = stems(p)
          if (pStems.size === 0) continue
          let overlap = 0
          for (const s of pStems) if (qStems.has(s)) overlap++
          // A one-word pattern ("website") must cover most of the question, otherwise it
          // would answer any long question that happens to contain that word.
          if (pStems.size === 1 && overlap / (qStems.size || 1) < 0.5) continue
          score = overlap / pStems.size
          dice = (2 * overlap) / (pStems.size + qStems.size || 1)
        }
        if (score < threshold) continue
        if (!best || score > best.score || (score === best.score && dice > best.dice)) {
          best = { answer: entry.answer, entryId: entry.id, pattern, score, dice }
        }
      }
    }
    if (!best) return null
    return { answer: best.answer, entryId: best.entryId, pattern: best.pattern, score: best.score }
  }
}
