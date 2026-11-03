import type { SubmitPolicy, UserSettings } from '../settings'
import type { SiteStats } from '../store'
import type { SiteType } from '../shared/status'

export interface GateDecision {
  configured: SubmitPolicy
  effective: SubmitPolicy
  reason?: string
  stats: SiteStats
}

/**
 * "auto" only applies once a site type has enough verified runs. Until then it runs as "review".
 * Turn the gate off with gate.enforce = false.
 */
export function decidePolicy(
  stats: SiteStats,
  settings: UserSettings,
  siteType: SiteType,
): GateDecision {
  const configured = settings.sites[siteType].submit
  if (configured !== 'auto' || !settings.gate.enforce)
    return { configured, effective: configured, stats }
  const { minRuns, minAccuracy } = settings.gate
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
