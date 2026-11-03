import type { LlmProvider, LlmRequest, LlmResponse } from './types'

const STOP = new Set(
  'the and for with you your our are will this that from have has can who what their they them about into over more able work working team role join build using used use also such like good strong experience required plus daily part'.split(
    ' ',
  ),
)

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Whole-term match that also works for terms like "C++", "Node.js" and "CI/CD". */
export function containsTerm(text: string, term: string): boolean {
  const re = new RegExp(`(^|[^a-z0-9+#.])${escapeRegExp(term.toLowerCase())}($|[^a-z0-9+#])`)
  return re.test(text.toLowerCase())
}

/**
 * Deterministic stand-in for a hosted model. It makes the whole pipeline runnable with no
 * API key and no network, and it never invents anything: unknown questions stay unknown.
 */
export class OfflineProvider implements LlmProvider {
  readonly name = 'offline'

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const input = JSON.parse(req.prompt) as Record<string, unknown>
    let out: unknown
    switch (req.task) {
      case 'extract_requirements': {
        const description = String(input.description ?? '')
        const known = (input.knownTerms as string[] | undefined) ?? []
        const skills = known.filter((t) => containsTerm(description, t))
        const counts = new Map<string, number>()
        for (const w of description.toLowerCase().match(/[a-z][a-z0-9+#.]{3,}/g) ?? []) {
          const word = w.replace(/\.+$/, '')
          if (STOP.has(word) || skills.some((s) => s.toLowerCase() === word)) continue
          counts.set(word, (counts.get(word) ?? 0) + 1)
        }
        const keywords = [...counts.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, 8)
          .map(([w]) => w)
        out = { skills, keywords }
        break
      }
      case 'rephrase_bullet':
        out = { text: String(input.text ?? '') }
        break
      case 'answer_field':
      default:
        out = { answer: 'UNKNOWN' }
    }
    const text = JSON.stringify(out)
    return { text, tokensIn: 0, tokensOut: 0, costUsd: 0, model: 'offline' }
  }
}
