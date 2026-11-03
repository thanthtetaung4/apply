import type { LlmTask } from './types'

/** Bump when a prompt changes so cached answers are not reused. */
export const PROMPT_VERSION = 'v1'

const GROUNDING = `Use only the facts in the input. Never invent employers, titles, dates, numbers, tools or skills. If the input does not support an answer, say UNKNOWN.`

export const SYSTEM_PROMPTS: Record<LlmTask, string> = {
  extract_requirements: `You read a job description. Return JSON: {"skills": string[], "keywords": string[]}.
"skills" lists only terms from input.knownTerms that the description asks for or mentions. "keywords" lists up to 8 other important words from the description. ${GROUNDING}`,
  answer_field: `You fill one job application question for the candidate in input.facts. Return JSON: {"answer": string}.
For select or radio questions the answer must be exactly one of input.options. For other questions write at most 3 sentences in first person. ${GROUNDING}
If you are not certain, return {"answer": "UNKNOWN"}.`,
  rephrase_bullet: `Lightly reword one resume bullet to fit the job, keeping every fact. Return JSON: {"text": string}.
Do not add any number, tool, employer or claim that is not already in input.text. ${GROUNDING}`,
}
