import { z } from 'zod'

export const SubmitPolicySchema = z.enum(['auto', 'review', 'manual'])
export type SubmitPolicy = z.infer<typeof SubmitPolicySchema>

export const SiteConfigSchema = z.object({
  backend: z.string().min(1).default('playwright-chromium'),
  /** Tried when the primary backend cannot launch or crashes. */
  fallback: z.string().min(1).optional(),
  submit: SubmitPolicySchema.default('review'),
  dailyCap: z.number().int().positive().default(10),
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
  maxPerSearch: z.number().int().positive().default(10),
})
export type SourceConfig = z.infer<typeof SourceConfigSchema>

export const ConfigSchema = z.object({
  profileDir: z.string().min(1).default('./profile'),
  dataDir: z.string().min(1).default('./data'),
  outputDir: z.string().min(1).default('./output'),
  sessionsDir: z.string().min(1).default('./sessions'),
  workers: z.number().int().min(1).max(8).default(2),
  llm: z
    .object({
      provider: z.literal('openrouter').default('openrouter'),
      models: z
        .object({
          cheap: z.string().min(1),
          mid: z.string().min(1),
          strong: z.string().min(1),
        })
        .default({ cheap: 'TBD-cheap-model', mid: 'TBD-mid-model', strong: 'TBD-strong-model' }),
      dailyBudgetUsd: z.number().positive().default(2),
    })
    .prefault({}),
  board: z
    .object({
      type: z.literal('mcp').default('mcp'),
      url: z.url().optional(),
      tokenEnv: z.string().min(1).default('BOARD_MCP_TOKEN'),
    })
    .prefault({}),
  sites: z
    .object({
      greenhouse: SiteConfigSchema.prefault({ dailyCap: 30 }),
      company_site: SiteConfigSchema.prefault({ dailyCap: 20 }),
      workday: SiteConfigSchema.prefault({ headless: false }),
      indeed: SiteConfigSchema.prefault({ headless: false }),
      linkedin: SiteConfigSchema.prefault({ headless: false }),
      glassdoor: SiteConfigSchema.prefault({ headless: false }),
    })
    .prefault({}),
  browser: z.object({ executablePath: z.string().optional() }).prefault({}),
  pacing: z
    .object({
      /** Pause between two jobs on the same site, random between min and max. */
      minDelayMs: z.number().int().min(0).default(2000),
      maxDelayMs: z.number().int().min(0).default(6000),
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
          name: z.string().min(1).default('ai-browser'),
          sample: z.number().min(0).max(1).default(0.2),
        })
        .prefault({}),
    })
    .prefault({}),
})

export type AppConfig = z.infer<typeof ConfigSchema>
