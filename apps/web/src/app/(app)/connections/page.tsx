import { headers } from 'next/headers'
import { SIGN_IN_LABEL } from '@apply/core/signin'
import { listApiTokens, listSecretNames, type SessionInfo } from '@apply/db'
import {
  BoardForm,
  EndpointForm,
  ModelKeyForm,
  RemoveSessionButton,
  RevokeButton,
  TokenForm,
} from '@/components/ConnectionForms'
import { ConnectButton } from '@/components/SignInWindow'
import { db, stores } from '@/lib/db'
import { timeAgo } from '@/lib/format'
import { requireUser } from '@/lib/session'

const BOARDS = ['linkedin', 'indeed', 'glassdoor'] as const

function Status({ s }: { s?: SessionInfo }) {
  if (!s) return <span className="chip gray">not connected</span>
  if (s.status === 'expired')
    return <span className="chip warn">signed out {timeAgo(s.statusAt)}, sign in again</span>
  return <span className="chip ok">connected {timeAgo(s.updatedAt)}</span>
}

export default async function Connections() {
  const user = await requireUser()
  const [sessions, secrets, tokens, h] = await Promise.all([
    stores(user.id).sessions.list(),
    listSecretNames(db(), user.id),
    listApiTokens(db(), user.id),
    headers(),
  ])
  const has = (n: string) => secrets.some((s) => s.name === n)
  const origin = `${h.get('x-forwarded-proto') ?? 'http'}://${h.get('host')}`
  const byKey = new Map(sessions.map((s) => [s.key, s]))
  const workday = sessions.filter((s) => s.key.startsWith('workday-'))
  const expired = sessions.filter((s) => s.status === 'expired').length
  const state = (s?: SessionInfo) =>
    !s ? 'none' : s.status === 'expired' ? 'expired' : 'connected'

  return (
    <>
      <div className="head">
        <div>
          <h1>Connections</h1>
          <p className="muted">Accounts, models and the board the app uses on your behalf.</p>
        </div>
      </div>

      {expired > 0 && (
        <div className="banner warn">
          <strong>
            {expired === 1 ? 'One account has' : `${expired} accounts have`} been signed out.
          </strong>{' '}
          Sites end sessions from time to time. Press Sign in again next to it; jobs on that site
          wait until you do.
        </div>
      )}

      <div className="card">
        <h2>Job site accounts</h2>
        <p className="muted">
          Connect the sites you want the app to search and apply on. You sign in yourself in a
          secure window, including any verification code. We keep only the signed in session,
          encrypted so only the application worker can use it, never your password.
        </p>
        <table>
          <tbody>
            {BOARDS.map((k) => (
              <tr key={k}>
                <td>{SIGN_IN_LABEL[k]}</td>
                <td>
                  <Status s={byKey.get(k)} />
                </td>
                <td className="num">
                  <div className="row" style={{ justifyContent: 'flex-end' }}>
                    <ConnectButton site={k} label={SIGN_IN_LABEL[k]} status={state(byKey.get(k))} />
                    {byKey.has(k) && <RemoveSessionButton name={k} />}
                  </div>
                </td>
              </tr>
            ))}
            {workday.map((s) => (
              <tr key={s.key}>
                <td>Workday: {s.key.replace('workday-', '')}</td>
                <td>
                  <Status s={s} />
                </td>
                <td className="num">
                  <div className="row" style={{ justifyContent: 'flex-end' }}>
                    {s.status === 'expired' && (
                      <ConnectButton site="workday" label="Workday" status="expired" askForLink />
                    )}
                    <RemoveSessionButton name={s.key} />
                  </div>
                </td>
              </tr>
            ))}
            <tr>
              <td>
                Workday
                <div className="muted small">
                  Many companies use Workday, with a separate account for each company.
                </div>
              </td>
              <td />
              <td className="num">
                <ConnectButton site="workday" label="Workday" status="none" askForLink />
              </td>
            </tr>
          </tbody>
        </table>
        <p className="muted small" style={{ marginBottom: 0 }}>
          Greenhouse and most company career pages need no account. Automating your personal
          LinkedIn, Indeed or Glassdoor account goes against those sites&apos; terms and can get it
          restricted, so the app keeps to low daily limits and stops before submitting unless you
          change that in Settings.
        </p>
      </div>

      <div className="card">
        <h2>AI model</h2>
        <p className="muted small">
          Optional. The app works without AI: it fills forms from your profile and saved answers and
          brings anything else to you. Choose which AI to use on the Settings page.
        </p>
        <h3>Your OpenRouter key</h3>
        <p className="muted small">
          Your key pays for the calls, so there is no limit from the app. Many OpenRouter models
          ending in <code>:free</code> cost nothing.
        </p>
        <ModelKeyForm saved={has('openrouter_api_key')} />
        <h3 style={{ marginTop: 18 }}>Your own server (Ollama, LM Studio, llama.cpp)</h3>
        <p className="muted small">
          Your Ollama address, or any OpenAI-compatible one ending in <code>/v1</code>. The app runs
          on a server, so it cannot reach <code>localhost</code> on your computer: share Ollama
          through a tunnel such as Cloudflare Tunnel, Tailscale Funnel or ngrok, and use that https
          address. For Ollama the app sets the context size, keeps replies to the right format and
          turns thinking on only for models that support it.
        </p>
        <p className="muted small">
          Ollama has no password of its own, so anyone with the tunnel address could use your
          computer. Protect the tunnel (for example Cloudflare Access or ngrok basic auth) and put
          its token in the key field: the app sends it as a Bearer token.
        </p>
        <EndpointForm saved={has('llm_endpoint_url')} />
      </div>

      <div className="card">
        <h2>Job Search Board</h2>
        <p className="muted small">
          Optional. After each application the app records it on your board over MCP. If the board
          is unreachable, updates are retried later and never block applying.
        </p>
        <BoardForm saved={has('board_mcp_url')} />
      </div>

      <details className="card advanced">
        <summary>For developers: connect from your own computer</summary>
        <p className="muted small">
          Instead of the sign in window, you can sign in with a browser on your own computer and
          upload the session with an access token. A token can upload sessions to your account and
          nothing else.
        </p>
        <pre>{`APPLY_API_URL=${origin} APPLY_API_TOKEN=<your token> pnpm login linkedin`}</pre>
        {tokens.length > 0 && (
          <table style={{ marginBottom: 10 }}>
            <thead>
              <tr>
                <th>Name</th>
                <th>Starts with</th>
                <th>Last used</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {tokens.map((t) => (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td>
                    <code>{t.prefix}</code>
                  </td>
                  <td className="muted">{t.lastUsedAt ? timeAgo(t.lastUsedAt) : 'never'}</td>
                  <td className="num">
                    <RevokeButton id={t.id} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <TokenForm />
      </details>
    </>
  )
}
