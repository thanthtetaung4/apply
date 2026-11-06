import { z } from 'zod'
import { careersUrlProblem } from './intake/careers-url'

/**
 * Per user settings. These are stored as JSON in the database and edited in the web app.
 * System level values (database URL, encryption key, Chromium path) come from the environment.
 */

export const SubmitPolicySchema = z.enum(['auto', 'review', 'manual'])
export type SubmitPolicy = z.infer<typeof SubmitPolicySchema>

export const SiteConfigSchema = z.object({
  backend: z.string().min(1).default('playwright-chromium'),
  /** Tried when the primary backend cannot launch or crashes. */
  fallback: z.string().min(1).optional(),
  submit: SubmitPolicySchema.default('review'),
  dailyCap: z.number().int().min(1).max(200).default(10),
  /** Whether the worker runs this site's browser without a window. Servers have no display, so keep true there. */
  headless: z.boolean().default(true),
})
export type SiteConfig = z.infer<typeof SiteConfigSchema>

export const SourceConfigSchema = z.object({
  enabled: z.boolean().default(true),
  baseUrl: z.url(),
  /** Search path with {q} for the job title and {l} for the location. */
  searchPath: z.string().min(1),
  /** CSS selector for links to job pages on the results page. */
  linkSelector: z.string().min(1),
  maxPerSearch: z.number().int().min(1).max(50).default(10),
})
export type SourceConfig = z.infer<typeof SourceConfigSchema>

export const AiModeSchema = z.enum(['none', 'hosted', 'openrouter', 'custom'])
export type AiMode = z.infer<typeof AiModeSchema>

/** The user's AI mode as it will actually run: unset picks their key, then the app's model. */
export function effectiveAiMode(
  settings: Pick<UserSettings, 'llm'>,
  hasOpenRouterKey: boolean,
): AiMode {
  return settings.llm.mode ?? (hasOpenRouterKey ? 'openrouter' : 'hosted')
}

export const UserSettingsSchema = z.object({
  /** Parallel browser contexts for one run. Capped by the worker. */
  workers: z.number().int().min(1).max(4).default(2),
  llm: z
    .object({
      /**
       * Where AI calls go. "none": no AI, questions come to you. "hosted": the app's own model,
       * free for a few applications a week, then paid credits. "openrouter": your OpenRouter key.
       * "custom": your own OpenAI-compatible server such as Ollama. Unset: your OpenRouter key if
       * you saved one, otherwise the app's model.
       */
      mode: AiModeSchema.optional(),
      /** Your own server (mode "custom"). Its URL and key are saved encrypted on Connections. */
      custom: z
        .object({
          model: z.string().default(''),
          /** Tasks the model may think on. Thinking tasks are sent without JSON mode. */
          thinkTasks: z
            .array(z.enum(['extract_requirements', 'answer_field', 'rephrase_bullet']))
            .default(['answer_field']),
          timeoutMs: z.number().int().min(5_000).max(600_000).default(180_000),
          maxTokens: z.number().int().min(100).max(32_000).default(1200),
          /** Ollama only: context window per request, capped at the model's own maximum. */
          contextTokens: z.number().int().min(2048).max(131_072).default(8192),
        })
        .prefault({}),
      /** OpenRouter model ids, used with mode "openrouter". */
      models: z
        .object({
          cheap: z.string().min(1),
          mid: z.string().min(1),
          strong: z.string().min(1),
        })
        .default({ cheap: 'TBD-cheap-model', mid: 'TBD-mid-model', strong: 'TBD-strong-model' }),
      dailyBudgetUsd: z.number().positive().max(1000).default(2),
    })
    .prefault({}),
  sites: z
    .object({
      greenhouse: SiteConfigSchema.prefault({ dailyCap: 30 }),
      company_site: SiteConfigSchema.prefault({ dailyCap: 20 }),
      workday: SiteConfigSchema.prefault({}),
      indeed: SiteConfigSchema.prefault({}),
      linkedin: SiteConfigSchema.prefault({}),
      glassdoor: SiteConfigSchema.prefault({}),
    })
    .prefault({}),
  pacing: z
    .object({
      /** Pause between two jobs on the same site, random between min and max. */
      minDelayMs: z.number().int().min(0).max(600_000).default(2000),
      maxDelayMs: z.number().int().min(0).max(600_000).default(6000),
    })
    .refine((p) => p.minDelayMs <= p.maxDelayMs, {
      message: 'The longest pause must be at least as long as the shortest pause',
      path: ['maxDelayMs'],
    })
    .prefault({}),
  gate: z
    .object({
      /** Downgrade "auto" to "review" until a site type has proven itself. */
      enforce: z.boolean().default(true),
      minRuns: z.number().int().positive().default(10),
      minAccuracy: z.number().min(0).max(1).default(0.9),
    })
    .prefault({}),
  maxAttempts: z.number().int().min(1).max(5).default(2),
  sources: z
    .object({
      indeed: SourceConfigSchema.prefault({
        baseUrl: 'https://sg.indeed.com',
        searchPath: '/jobs?q={q}&l={l}',
        linkSelector: 'a[href*="/viewjob"]',
      }),
      linkedin: SourceConfigSchema.prefault({
        baseUrl: 'https://www.linkedin.com',
        searchPath: '/jobs/search/?keywords={q}&location={l}',
        linkSelector: 'a[href*="/jobs/view/"]',
      }),
      glassdoor: SourceConfigSchema.prefault({
        baseUrl: 'https://www.glassdoor.sg',
        searchPath: '/Job/jobs.htm?sc.keyword={q}&locKeyword={l}',
        linkSelector: 'a[href*="/job-listing/"]',
      }),
    })
    .prefault({}),
  /**
   * Company careers pages (Greenhouse, Lever, Ashby, Workday) searched through their public job
   * APIs on every search, with the same title, location and exclude filters as the boards.
   */
  watchlist: z
    .object({
      enabled: z.boolean().default(true),
      companies: z
        .array(z.string().trim().min(1).max(500))
        .max(100, 'Watch at most 100 companies')
        .default([])
        .superRefine((list, ctx) => {
          for (const url of list) {
            const problem = careersUrlProblem(url)
            if (problem) ctx.addIssue({ code: 'custom', message: problem })
          }
        }),
      /** New matching jobs queued per company in one search, best first. */
      maxPerCompany: z.number().int().min(1).max(50).default(10),
    })
    .prefault({}),
  backends: z
    .object({
      shadow: z
        .object({
          enabled: z.boolean().default(false),
          name: z.string().min(1).default('playwright-lean'),
          sample: z.number().min(0).max(1).default(0.2),
        })
        .prefault({}),
    })
    .prefault({}),
})

export type UserSettings = z.infer<typeof UserSettingsSchema>

export const defaultSettings = (): UserSettings => UserSettingsSchema.parse({})

/** Validate settings from a form or the database. Returns readable issues on failure. */
export function parseSettings(
  input: unknown,
): { ok: true; settings: UserSettings } | { ok: false; issues: string[] } {
  const r = UserSettingsSchema.safeParse(input)
  if (r.success) return { ok: true, settings: r.data }
  return {
    ok: false,
    issues: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
  }
}
