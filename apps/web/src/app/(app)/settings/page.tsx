import { effectiveAiMode } from '@apply/core/settings'
import { getAiQuota, getSettings, listSecretNames } from '@apply/db'
import { buyAiCreditsAction } from '@/app/actions/billing'
import { SettingsForm } from '@/components/SettingsForm'
import { db } from '@/lib/db'
import { billing, platformAi } from '@/lib/env'
import { requireUser } from '@/lib/session'

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ bought?: string }>
}) {
  const user = await requireUser()
  const [settings, secrets, params] = await Promise.all([
    getSettings(db(), user.id),
    listSecretNames(db(), user.id),
    searchParams,
  ])
  const has = (n: string) => secrets.some((s) => s.name === n)
  const platform = platformAi()
  const chosen = effectiveAiMode(settings, has('openrouter_api_key'))
  // Without App AI on this server, "hosted" runs without AI (the worker falls back the same way).
  const mode = chosen === 'hosted' && !platform.enabled ? 'none' : chosen
  const quota = platform.enabled ? await getAiQuota(db(), user.id, platform.freePerWeek) : undefined
  const pack = billing()
  return (
    <>
      <div className="head">
        <div>
          <h1>Settings</h1>
          <p className="muted">How and where the app applies for you.</p>
        </div>
      </div>
      {quota && mode === 'hosted' && (
        <div className="card" id="ai">
          <h2>App AI this week</h2>
          {params.bought && (
            <p className="chip ok">
              Thank you. Your AI applications appear here as soon as the payment is confirmed.
            </p>
          )}
          <p>
            <b>
              {Math.max(0, quota.freeLimit - quota.freeUsed)} of {quota.freeLimit}
            </b>{' '}
            free AI applications left, renewing{' '}
            {quota.resetsAt.toLocaleDateString('en', {
              weekday: 'long',
              day: 'numeric',
              month: 'short',
            })}
            . <b>{quota.credits}</b> purchased {quota.credits === 1 ? 'one' : 'ones'} left; they
            never expire.
          </p>
          <p className="muted small">
            One application counts once, however many questions it answers. With none left, jobs
            still run without AI and any question your saved answers do not cover comes to you.
          </p>
          {pack.enabled && (
            <form action={buyAiCreditsAction}>
              <button type="submit">Buy {pack.creditsPerPack} AI applications</button>
            </form>
          )}
        </div>
      )}
      <SettingsForm
        settings={settings}
        ai={{
          mode,
          platformEnabled: platform.enabled,
          freePerWeek: platform.freePerWeek,
          hasKey: has('openrouter_api_key'),
          hasServer: has('llm_endpoint_url'),
        }}
      />
    </>
  )
}
