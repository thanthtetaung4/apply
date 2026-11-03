import type { Db } from '../db'
import type { AppConfig } from '../config/schema'
import type { SubmitPolicy } from '../config/schema'
import type { SiteType } from '../shared/status'

export interface SiteStats {
  siteType: SiteType
  runs: number
  /** Share of runs whose verification passed. */
  accuracy: number
  /** Share of runs that did not need a human. */
  completion: number
}

export function siteStats(db: Db, siteType: SiteType): SiteStats {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS runs,
              COALESCE(SUM(CASE WHEN verify = 'pass' THEN 1 ELSE 0 END), 0) AS passed,
              COALESCE(SUM(CASE WHEN outcome != 'needs_human' THEN 1 ELSE 0 END), 0) AS done
         FROM metrics WHERE site_type = ?`,
    )
    .get(siteType) as { runs: number; passed: number; done: number }
  return {
    siteType,
    runs: row.runs,
    accuracy: row.runs ? row.passed / row.runs : 0,
    completion: row.runs ? row.done / row.runs : 0,
  }
}

export interface GateDecision {
  configured: SubmitPolicy
  effective: SubmitPolicy
  reason?: string
  stats: SiteStats
}

/**
 * "auto" only applies once a site type has enough verified runs. Until then it runs as "review".
 * Turn the gate off with gate.enforce: false.
 */
export function decidePolicy(db: Db, config: AppConfig, siteType: SiteType): GateDecision {
  const configured = config.sites[siteType].submit
  const stats = siteStats(db, siteType)
  if (configured !== 'auto' || !config.gate.enforce)
    return { configured, effective: configured, stats }
  const { minRuns, minAccuracy } = config.gate
  if (stats.runs < minRuns) {
    return {
      configured,
      effective: 'review',
      reason: `${stats.runs} of ${minRuns} verified runs so far`,
      stats,
    }
  }
  if (stats.accuracy < minAccuracy) {
    return {
      configured,
      effective: 'review',
      reason: `accuracy ${(stats.accuracy * 100).toFixed(0)}% is below ${(minAccuracy * 100).toFixed(0)}%`,
      stats,
    }
  }
  return { configured, effective: 'auto', stats }
}
