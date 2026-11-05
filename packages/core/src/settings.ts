import { z } from 'zod'

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

export const UserSettingsSchema = z.object({
  /** Parallel browser contexts for one run. Capped by the worker. */
  workers: z.number().int().min(1).max(4).default(2),
  llm: z
    .object({
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
