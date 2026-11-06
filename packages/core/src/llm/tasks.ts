import { z } from 'zod'
import { checkRewrite } from '../tailor/grounding'
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

/**
 * Questions with legal or personal consequences. A guess here (work authorisation, sponsorship,
 * criminal record, salary, self-identification) can misrepresent the candidate, so the model is
 * never asked: they go to the user like any other unknown question.
 */
const SENSITIVE =
  /authori[sz]|sponsor|visa\b|citizen|work permit|right to work|legally (?:able|eligible|permitted)|eligib|criminal|convict|felony|background check|drug (?:test|screen)|salary|compensation|pay (?:expectation|range|requirement)|desired pay|gender|\brace\b|ethnic|hispanic|latino|veteran|disabilit|pronoun|sexual orientation|date of birth|security clearance|clearance level|non-?compete|previously (?:worked|employed)|worked (?:here|for us) before/i

export function isSensitiveQuestion(question: string): boolean {
  return SENSITIVE.test(question)
}

export async function answerField(gw: LlmGateway, input: AnswerInput, options?: RunOptions) {
  if (isSensitiveQuestion(input.question)) {
    return {
      data: { answer: 'UNKNOWN' },
      cached: false,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      answer: null,
    }
  }
  // For a select or radio question, a provider that enforces schemas can only pick an option.
  const replySchema = input.options?.length
    ? {
        type: 'object',
        properties: {
          answer: { type: 'string', enum: [...new Set([...input.options, 'UNKNOWN'])] },
        },
        required: ['answer'],
        additionalProperties: false,
      }
    : undefined
  const res = await gw.run('answer_field', input, AnswerSchema, {
    tier: 'cheap',
    replySchema,
    ...options,
  })
  const answer = res.data.answer.trim()
  const unknown = !answer || /^unknown$/i.test(answer)
  // A select or radio answer must be one of the options. Anything else is treated as unknown.
  const valid = input.options
    ? input.options.some((o) => o.toLowerCase() === answer.toLowerCase())
    : // Free text: no number, name or tool that the facts, question and job do not contain.
      checkRewrite(
        [input.question, input.job.title, input.job.company, JSON.stringify(input.facts)].join(
          '\n',
        ),
        answer,
        new Set(),
      ).length === 0
  return { ...res, answer: unknown || !valid ? null : answer }
}

export function rephraseBullet(
  gw: LlmGateway,
  input: { text: string; jobTitle: string },
  options?: RunOptions,
) {
  return gw.run('rephrase_bullet', input, RephraseSchema, { tier: 'strong', ...options })
}
