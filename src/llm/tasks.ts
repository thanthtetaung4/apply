import { z } from 'zod'
import type { LlmGateway, RunOptions } from './gateway'

export const RequirementsSchema = z.object({
  skills: z.array(z.string()),
  keywords: z.array(z.string()),
})
export type Requirements = z.infer<typeof RequirementsSchema>

export const AnswerSchema = z.object({ answer: z.string() })
export const RephraseSchema = z.object({ text: z.string().min(1) })

export function extractRequirements(
  gw: LlmGateway,
  input: { jobTitle: string; description: string; knownTerms: string[] },
  options?: RunOptions,
) {
  return gw.run('extract_requirements', input, RequirementsSchema, { tier: 'cheap', ...options })
}

export interface AnswerInput {
  question: string
  type: string
  options?: string[]
  required: boolean
  job: { title: string; company: string }
  /** Facts the model may use. Nothing else about the candidate is sent. */
  facts: Record<string, unknown>
}

export async function answerField(gw: LlmGateway, input: AnswerInput, options?: RunOptions) {
  const res = await gw.run('answer_field', input, AnswerSchema, { tier: 'cheap', ...options })
  const answer = res.data.answer.trim()
  const unknown = !answer || /^unknown$/i.test(answer)
  // A select or radio answer must be one of the options. Anything else is treated as unknown.
  const valid =
    !input.options || input.options.some((o) => o.toLowerCase() === answer.toLowerCase())
  return { ...res, answer: unknown || !valid ? null : answer }
}

export function rephraseBullet(
  gw: LlmGateway,
  input: { text: string; jobTitle: string },
  options?: RunOptions,
) {
  return gw.run('rephrase_bullet', input, RephraseSchema, { tier: 'strong', ...options })
}
