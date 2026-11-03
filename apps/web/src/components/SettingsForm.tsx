'use client'

import { useAction } from './useAction'
import type { UserSettings } from '@apply/core/settings'
import { saveSettingsAction } from '@/app/actions/settings'
import { SITE_LABEL } from '@/lib/format'
import { Messages } from './Messages'
import { SubmitButton } from './SubmitButton'

const SITES = ['greenhouse', 'company_site', 'workday', 'indeed', 'linkedin', 'glassdoor'] as const
const SOURCES = ['indeed', 'linkedin', 'glassdoor'] as const
const BACKENDS = ['playwright-chromium', 'playwright-lean', 'ai-browser']

export function SettingsForm({ settings: s }: { settings: UserSettings }) {
  const { state, onSubmit, pending } = useAction(saveSettingsAction)
  return (
    <form onSubmit={onSubmit}>
      <div className="card">
        <h2>Submitting</h2>
        <p className="muted">
          <b>Review</b> fills the form and stops, so you can look at the screenshots and press
          Approve. <b>Auto</b> submits when every field was read back correctly.
          <b> Manual</b> never opens the site. Auto only takes effect after the safety gate below is
          met.
        </p>
        <table>
          <thead>
            <tr>
              <th>Site</th>
              <th>When the form is filled</th>
              <th className="num">Max per day</th>
              <th>Browser</th>
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
                    <option value="review">Review (stop before submit)</option>
                    <option value="auto">Auto submit</option>
                    <option value="manual">Manual (never open)</option>
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
                <td>
                  <select
                    name={`sites.${t}.backend`}
                    defaultValue={s.sites[t].backend}
                    aria-label={`${SITE_LABEL[t]} browser`}
                  >
                    {BACKENDS.map((b) => (
                      <option key={b}>{b}</option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>Safety gate</h2>
        <label className="row" style={{ fontWeight: 400 }}>
          <input type="checkbox" name="gate.enforce" defaultChecked={s.gate.enforce} /> Keep Auto
          switched off until a site has proven itself
        </label>
        <div className="two" style={{ marginTop: 10 }}>
          <div className="field">
            <label htmlFor="g1">Verified runs needed</label>
            <input
              id="g1"
              type="number"
              min={1}
              name="gate.minRuns"
              defaultValue={s.gate.minRuns}
            />
          </div>
          <div className="field">
            <label htmlFor="g2">Share that must pass checks (%)</label>
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
      </div>

      <div className="card">
        <h2>Pace</h2>
        <p className="muted">
          Pauses between two jobs on the same site look more like a person and lower the chance of
          an account warning.
        </p>
        <div className="three">
          <div className="field">
            <label htmlFor="p1">Shortest pause (seconds)</label>
            <input
              id="p1"
              type="number"
              min={0}
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
              name="pacing.maxDelayMs"
              defaultValue={s.pacing.maxDelayMs / 1000}
            />
          </div>
          <div className="field">
            <label htmlFor="p3">Browsers at once</label>
            <input id="p3" type="number" min={1} max={4} name="workers" defaultValue={s.workers} />
          </div>
        </div>
        <div className="field" style={{ maxWidth: 240 }}>
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

      <div className="card">
        <h2>Models</h2>
        <p className="muted">
          OpenRouter model ids. Add your API key on the Connections page. Without a key, forms are
          filled from your profile and saved answers only.
        </p>
        <div className="three">
          {(['cheap', 'mid', 'strong'] as const).map((m) => (
            <div className="field" key={m}>
              <label htmlFor={`m-${m}`}>{m[0]!.toUpperCase() + m.slice(1)} model</label>
              <input
                id={`m-${m}`}
                type="text"
                name={`llm.models.${m}`}
                defaultValue={s.llm.models[m]}
              />
            </div>
          ))}
        </div>
        <div className="field" style={{ maxWidth: 240 }}>
          <label htmlFor="m-b">Daily budget (USD)</label>
          <input
            id="m-b"
            type="number"
            step="0.1"
            min={0.1}
            name="llm.dailyBudgetUsd"
            defaultValue={s.llm.dailyBudgetUsd}
          />
        </div>
      </div>

      <div className="card">
        <h2>Job boards</h2>
        <p className="muted">
          Where jobs are found. The link selectors are best guesses and change when a board changes
          its pages. Check them with a search before relying on them.
        </p>
        {SOURCES.map((src) => (
          <fieldset
            key={src}
            style={{ border: '1px solid var(--line)', borderRadius: 8, marginBottom: 12 }}
          >
            <legend>
              <label className="row" style={{ fontWeight: 600, margin: 0 }}>
                <input
                  type="checkbox"
                  name={`sources.${src}.enabled`}
                  defaultChecked={s.sources[src].enabled}
                />{' '}
                {SITE_LABEL[src]}
              </label>
            </legend>
            <div className="two">
              <div className="field">
                <label htmlFor={`${src}-u`}>Site address</label>
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
      </div>

      <div className="card">
        <h2>Compare browsers (advanced)</h2>
        <p className="muted">
          Also fill each job in a second browser without submitting, and record any differences.
          Used to test a new browser before switching to it.
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
                <option key={b}>{b}</option>
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
      </div>

      <div className="row">
        <SubmitButton busy={pending} pending="Saving...">
          Save settings
        </SubmitButton>
      </div>
      <Messages state={state} />
    </form>
  )
}
