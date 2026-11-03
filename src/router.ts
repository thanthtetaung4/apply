import { createHash } from 'node:crypto'
import type { BackendRegistry } from './browser/registry'
import type { AppConfig } from './config/schema'
import type { SiteType } from './shared/status'

export interface Route {
  primary: string
  fallback?: string
  /** Backend to run in shadow mode for this job, if any. */
  shadow?: string
  headless: boolean
}

/**
 * Maps a site type to browser backends. Switching a site to another engine is a config change.
 * Shadow runs are chosen per job by hashing the job id, so a given job is always in or out.
 */
export class BackendRouter {
  constructor(
    private readonly registry: BackendRegistry,
    private readonly config: AppConfig,
  ) {}

  route(siteType: SiteType, jobId: string): Route {
    const site = this.config.sites[siteType]
    const shadowCfg = this.config.backends.shadow
    const fallback =
      site.fallback ??
      (site.backend !== 'playwright-chromium' && this.registry.has('playwright-chromium')
        ? 'playwright-chromium'
        : undefined)
    return {
      primary: site.backend,
      fallback: fallback && fallback !== site.backend ? fallback : undefined,
      shadow:
        shadowCfg.enabled && this.inSample(jobId, shadowCfg.sample) ? shadowCfg.name : undefined,
      headless: site.headless,
    }
  }

  private inSample(jobId: string, sample: number): boolean {
    if (sample >= 1) return true
    if (sample <= 0) return false
    const n = parseInt(createHash('sha1').update(jobId).digest('hex').slice(0, 6), 16) / 0xffffff
    return n < sample
  }
}
