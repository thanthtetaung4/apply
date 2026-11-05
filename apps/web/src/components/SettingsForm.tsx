'use client'

import { useState, useTransition } from 'react'
import { useAction } from './useAction'
import type { UserSettings } from '@apply/core/settings'
import { CAREERS_URL_EXAMPLES } from '@apply/core/careers-url'
import { resetSettingsAction, saveSettingsAction } from '@/app/actions/settings'
import { SITE_LABEL } from '@/lib/format'
import type { FormState } from '@/lib/state'
import { Messages } from './Messages'
import { SubmitButton } from './SubmitButton'

const SITES = ['greenhouse', 'company_site', 'workday', 'indeed', 'linkedin', 'glassdoor'] as const
const SOURCES = ['indeed', 'linkedin', 'glassdoor'] as const
const BACKENDS = ['playwright-chromium', 'playwright-lean', 'ai-browser']
const BACKEND_LABEL: Record<string, string> = {
  'playwright-chromium': 'Standard',
  'playwright-lean': 'Lean (faster, skips images)',
  'ai-browser': 'AI browser (not available yet)',
}

/**
 * Everyday settings first, in plain words. Technical tuning is under Advanced; its fields are
 * still part of the form, so saving keeps them.
 */
export function SettingsForm({ settings: s }: { settings: UserSettings }) {
  const { state, onSubmit, pending } = useAction(saveSettingsAction)
  const [reset, setReset] = useState<FormState>({})
  const [resetting, startReset] = useTransition()
  return (
    <form onSubmit={onSubmit}>
      <div className="card">
        <h2>Applying</h2>
        <p className="muted">
          <b>Review first</b> fills the form and stops before the last button, so you can check the
          screenshots and press Approve. <b>Submit automatically</b> sends the application when
          every answer was checked, and only after the site has proven itself (see Advanced).{' '}
          <b>Never open</b> leaves the site to you.
        </p>
        <table>
          <thead>
            <tr>
              <th>Site</th>
              <th>Before submitting</th>
              <th className="num">Max per day</th>
            </tr>
          </thead>
          <tbody>
            {SITES.map((t) => (
              <tr key={t}>
                <td>{SITE_LABEL[t]}</td>
                <td>
                  <select
                    name={`sites.${t}.submit`}
                    defaultValue={s.sites[t].submit}
                    aria-label={`${SITE_LABEL[t]} submit policy`}
                  >
                    <option value="review">Review first (recommended)</option>
                    <option value="auto">Submit automatically</option>
                    <option value="manual">Never open</option>
                  </select>
                </td>
                <td className="num">
                  <input
                    type="number"
                    min={1}
                    max={200}
                    name={`sites.${t}.dailyCap`}
                    defaultValue={s.sites[t].dailyCap}
                    style={{ width: 80 }}
                    aria-label={`${SITE_LABEL[t]} daily cap`}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>Finding jobs</h2>
        <p className="muted">
          Boards to search for the titles and places in your profile. LinkedIn, Indeed and Glassdoor
          need a connected account (Connections page).
        </p>
        <div className="row" style={{ flexWrap: 'wrap', gap: 20 }}>
          {SOURCES.map((src) => (
            <label key={src} className="row" style={{ fontWeight: 400 }}>
              <input
                type="checkbox"
                name={`sources.${src}.enabled`}
                defaultChecked={s.sources[src].enabled}
              />{' '}
              Search {SITE_LABEL[src]}
            </label>
          ))}
        </div>
      </div>

      <div className="card">
        <h2>Company careers pages</h2>
        <p className="muted">
          Every search also reads these companies&apos; job lists directly, with the same titles,
          places and excluded words as the boards. No browser or sign in is needed. Paste one
          careers page per line from Greenhouse, Lever, Ashby or Workday.
        </p>
        <label className="row" style={{ fontWeight: 400 }}>
          <input type="checkbox" name="watchlist.enabled" defaultChecked={s.watchlist.enabled} />{' '}
          Search these companies
        </label>
        <textarea
          name="watchlist.companies"
          aria-label="Company careers pages"
          rows={6}
          defaultValue={s.watchlist.companies.join('\n')}
          placeholder={CAREERS_URL_EXAMPLES.join('\n')}
          style={{ marginTop: 8 }}
        />
        <div className="field" style={{ maxWidth: 260 }}>
          <label htmlFor="wl-max">New jobs per company in one search</label>
          <input
            id="wl-max"
            type="number"
            min={1}
            max={50}
            name="watchlist.maxPerCompany"
            defaultValue={s.watchlist.maxPerCompany}
          />
        </div>
      </div>

      <div className="card">
        <h2>Pace</h2>
        <p className="muted">
          A random pause between two jobs on the same site looks more like a person and lowers the
          chance of an account warning.
        </p>
        <div className="two">
          <div className="field">
            <label htmlFor="p1">Shortest pause (seconds)</label>
            <input
              id="p1"
              type="number"
              min={0}
              max={600}
              name="pacing.minDelayMs"
              defaultValue={s.pacing.minDelayMs / 1000}
            />
          </div>
          <div className="field">
            <label htmlFor="p2">Longest pause (seconds)</label>
            <input
              id="p2"
              type="number"
              min={0}
              max={600}
              name="pacing.maxDelayMs"
              defaultValue={s.pacing.maxDelayMs / 1000}
            />
          </div>
        </div>
      </div>

      <div className="card">
        <h2>AI answers</h2>
        <p className="muted">
          When a form asks something your saved answers do not cover, a model can answer from your
          profile, or leave it for you if it is not sure. It needs an OpenRouter key on the
          Connections page; without one those questions always come to you. Model names are
          OpenRouter ids, for example <code>openai/gpt-4o-mini</code>.
        </p>
        <div className="three">
          {(
            [
              ['cheap', 'Everyday model', 'Reads job descriptions and answers questions.'],
              ['mid', 'Middle model', 'Reserved for harder steps.'],
              ['strong', 'Careful model', 'Rewords resume bullets when that is turned on.'],
            ] as const
          ).map(([m, label, hint]) => (
            <div className="field" key={m}>
              <label htmlFor={`m-${m}`}>{label}</label>
              <input
                id={`m-${m}`}
                type="text"
                name={`llm.models.${m}`}
                defaultValue={s.llm.models[m]}
              />
              <span className="hint">{hint}</span>
            </div>
          ))}
        </div>
        <div className="field" style={{ maxWidth: 260 }}>
          <label htmlFor="m-b">Daily spending limit (USD)</label>
          <input
            id="m-b"
            type="number"
            step="0.1"
            min={0.1}
            max={1000}
            name="llm.dailyBudgetUsd"
            defaultValue={s.llm.dailyBudgetUsd}
          />
          <span className="hint">Model calls stop for the day at this amount.</span>
        </div>
      </div>

      <details className="card advanced">
        <summary>Advanced</summary>

        <h3>Safety gate</h3>
        <label className="row" style={{ fontWeight: 400 }}>
          <input type="checkbox" name="gate.enforce" defaultChecked={s.gate.enforce} /> Keep
          automatic submitting off for a site until it has proven itself
        </label>
        <div className="two" style={{ marginTop: 10 }}>
          <div className="field">
            <label htmlFor="g1">Checked runs needed</label>
            <input
              id="g1"
              type="number"
              min={1}
              name="gate.minRuns"
              defaultValue={s.gate.minRuns}
            />
          </div>
          <div className="field">
            <label htmlFor="g2">Share that must pass the checks (%)</label>
            <input
              id="g2"
              type="number"
              min={0}
              max={100}
              name="gate.minAccuracy"
              defaultValue={Math.round(s.gate.minAccuracy * 100)}
            />
          </div>
        </div>

        <h3>Running</h3>
        <div className="two">
          <div className="field">
            <label htmlFor="p3">Browsers at once</label>
            <input id="p3" type="number" min={1} max={4} name="workers" defaultValue={s.workers} />
          </div>
          <div className="field">
            <label htmlFor="p4">Tries per job</label>
            <input
              id="p4"
              type="number"
              min={1}
              max={5}
              name="maxAttempts"
              defaultValue={s.maxAttempts}
            />
          </div>
        </div>

        <h3>Browser per site</h3>
        <p className="muted small">
          The fallback is used when the first browser cannot start or crashes.
        </p>
        <table>
          <thead>
            <tr>
              <th>Site</th>
              <th>Browser</th>
              <th>Fallback</th>
            </tr>
          </thead>
          <tbody>
            {SITES.map((t) => (
              <tr key={t}>
                <td>{SITE_LABEL[t]}</td>
                <td>
                  <select
                    name={`sites.${t}.backend`}
                    defaultValue={s.sites[t].backend}
                    aria-label={`${SITE_LABEL[t]} browser`}
                  >
                    {BACKENDS.map((b) => (
                      <option key={b} value={b}>
                        {BACKEND_LABEL[b]}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <select
                    name={`sites.${t}.fallback`}
                    defaultValue={s.sites[t].fallback ?? ''}
                    aria-label={`${SITE_LABEL[t]} fallback browser`}
                  >
                    <option value="">None</option>
                    {BACKENDS.map((b) => (
                      <option key={b} value={b}>
                        {BACKEND_LABEL[b]}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <h3 style={{ marginTop: 16 }}>Job board search</h3>
        <p className="muted small">
          How each board is searched. The link selectors are best guesses and change when a board
          changes its pages.
        </p>
        {SOURCES.map((src) => (
          <fieldset
            key={src}
            style={{ border: '1px solid var(--line)', borderRadius: 8, marginBottom: 12 }}
          >
            <legend>{SITE_LABEL[src]}</legend>
            <div className="two">
              <div className="field">
                <label htmlFor={`${src}-u`}>Site address (choose your country site)</label>
                <input
                  id={`${src}-u`}
                  type="url"
                  name={`sources.${src}.baseUrl`}
                  defaultValue={s.sources[src].baseUrl}
                />
              </div>
              <div className="field">
                <label htmlFor={`${src}-p`}>
                  Search path{' '}
                  <span className="hint">
                    use {'{q}'} for the title and {'{l}'} for the place
                  </span>
                </label>
                <input
                  id={`${src}-p`}
                  type="text"
                  name={`sources.${src}.searchPath`}
                  defaultValue={s.sources[src].searchPath}
                />
              </div>
              <div className="field">
                <label htmlFor={`${src}-s`}>Job link selector</label>
                <input
                  id={`${src}-s`}
                  type="text"
                  name={`sources.${src}.linkSelector`}
                  defaultValue={s.sources[src].linkSelector}
                />
              </div>
              <div className="field">
                <label htmlFor={`${src}-n`}>Jobs per search</label>
                <input
                  id={`${src}-n`}
                  type="number"
                  min={1}
                  max={50}
                  name={`sources.${src}.maxPerSearch`}
                  defaultValue={s.sources[src].maxPerSearch}
                />
              </div>
            </div>
          </fieldset>
        ))}

        <h3>Compare browsers</h3>
        <p className="muted small">
          Also fill some jobs in a second browser without submitting, and record any differences.
          Used to test a browser before switching to it.
        </p>
        <label className="row" style={{ fontWeight: 400 }}>
          <input
            type="checkbox"
            name="backends.shadow.enabled"
            defaultChecked={s.backends.shadow.enabled}
          />{' '}
          Run comparisons
        </label>
        <div className="two" style={{ marginTop: 10 }}>
          <div className="field">
            <label htmlFor="sh1">Second browser</label>
            <select id="sh1" name="backends.shadow.name" defaultValue={s.backends.shadow.name}>
              {BACKENDS.map((b) => (
                <option key={b} value={b}>
                  {BACKEND_LABEL[b]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="sh2">Share of jobs (%)</label>
            <input
              id="sh2"
              type="number"
              min={0}
              max={100}
              name="backends.shadow.sample"
              defaultValue={Math.round(s.backends.shadow.sample * 100)}
            />
          </div>
        </div>
      </details>

      <div className="row">
        <SubmitButton busy={pending} pending="Saving...">
          Save settings
        </SubmitButton>
        <span className="spacer" />
        <button
          type="button"
          className="secondary"
          disabled={resetting}
          onClick={() => {
            if (
              !window.confirm('Reset every setting to the default? Your job board countries stay.')
            )
              return
            startReset(async () => {
              setReset(await resetSettingsAction())
              // The form shows the saved values after a reload.
              window.location.reload()
            })
          }}
        >
          Reset to defaults
        </button>
      </div>
      <Messages state={state} />
      <Messages state={reset} />
    </form>
  )
}
