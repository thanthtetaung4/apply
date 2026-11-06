'use client'

import { useTransition } from 'react'
import { useAction } from './useAction'
import {
  createTokenAction,
  removeSecretAction,
  removeSessionAction,
  revokeTokenAction,
  saveBoardAction,
  saveEndpointAction,
  saveModelKeyAction,
} from '@/app/actions/connections'
import { Messages } from './Messages'
import { SubmitButton } from './SubmitButton'

export function ModelKeyForm({ saved }: { saved: boolean }) {
  const { state, onSubmit, pending: busy } = useAction(saveModelKeyAction)
  const [pending, start] = useTransition()
  return (
    <form onSubmit={onSubmit}>
      <div className="field">
        <label htmlFor="apiKey">
          OpenRouter API key {saved && <span className="chip ok">saved</span>}
        </label>
        <input
          id="apiKey"
          name="apiKey"
          type="password"
          autoComplete="off"
          placeholder={saved ? 'Enter a new key to replace it' : 'sk-or-...'}
        />
      </div>
      <div className="row">
        <SubmitButton busy={busy} pending="Saving...">
          {saved ? 'Replace key' : 'Save key'}
        </SubmitButton>
        {saved && (
          <button
            type="button"
            className="secondary"
            disabled={pending}
            onClick={() => start(() => removeSecretAction(['openrouter_api_key']))}
          >
            Remove
          </button>
        )}
      </div>
      <Messages state={state} />
    </form>
  )
}

export function EndpointForm({ saved }: { saved: boolean }) {
  const { state, onSubmit, pending: busy } = useAction(saveEndpointAction)
  const [pending, start] = useTransition()
  return (
    <form onSubmit={onSubmit}>
      <div className="two">
        <div className="field">
          <label htmlFor="eu">
            Server address {saved && <span className="chip ok">saved</span>}
          </label>
          <input
            id="eu"
            name="url"
            type="url"
            required
            placeholder="https://your-tunnel.example.com/v1"
          />
        </div>
        <div className="field">
          <label htmlFor="ek">Key (optional)</label>
          <input
            id="ek"
            name="key"
            type="password"
            autoComplete="off"
            placeholder={saved ? 'Leave empty to keep the current key' : 'Ollama needs none'}
          />
        </div>
      </div>
      <div className="row">
        <SubmitButton busy={busy} pending="Checking...">
          {saved ? 'Replace server' : 'Save server'}
        </SubmitButton>
        {saved && (
          <button
            type="button"
            className="secondary"
            disabled={pending}
            onClick={() =>
              start(() => removeSecretAction(['llm_endpoint_url', 'llm_endpoint_key']))
            }
          >
            Remove
          </button>
        )}
      </div>
      <Messages state={state} />
    </form>
  )
}

export function BoardForm({ saved }: { saved: boolean }) {
  const { state, onSubmit, pending: busy } = useAction(saveBoardAction)
  const [pending, start] = useTransition()
  return (
    <form onSubmit={onSubmit}>
      <div className="two">
        <div className="field">
          <label htmlFor="bu">
            Board MCP URL {saved && <span className="chip ok">connected</span>}
          </label>
          <input
            id="bu"
            name="url"
            type="url"
            required
            placeholder="https://board.example.com/mcp"
          />
        </div>
        <div className="field">
          <label htmlFor="bt">Access token</label>
          <input
            id="bt"
            name="token"
            type="password"
            autoComplete="off"
            placeholder={saved ? 'Leave empty to keep the current token' : ''}
          />
        </div>
      </div>
      <div className="row">
        <SubmitButton busy={busy} pending="Saving...">
          {saved ? 'Update board' : 'Connect board'}
        </SubmitButton>
        {saved && (
          <button
            type="button"
            className="secondary"
            disabled={pending}
            onClick={() => start(() => removeSecretAction(['board_mcp_url', 'board_mcp_token']))}
          >
            Disconnect
          </button>
        )}
      </div>
      <Messages state={state} />
    </form>
  )
}

export function TokenForm() {
  const { state, onSubmit, pending: busy } = useAction(createTokenAction)
  return (
    <form onSubmit={onSubmit}>
      <div className="row">
        <input
          name="name"
          type="text"
          placeholder="e.g. my laptop"
          aria-label="Token name"
          style={{ maxWidth: 260 }}
          required
        />
        <SubmitButton busy={busy} pending="Creating...">
          Create token
        </SubmitButton>
      </div>
      <Messages state={state} />
      {state.secret && <pre aria-label="New token">{state.secret}</pre>}
    </form>
  )
}

export function RevokeButton({ id }: { id: string }) {
  const [pending, start] = useTransition()
  return (
    <button
      className="secondary"
      disabled={pending}
      onClick={() => start(() => revokeTokenAction(id))}
    >
      Revoke
    </button>
  )
}

export function RemoveSessionButton({ name }: { name: string }) {
  const [pending, start] = useTransition()
  return (
    <button
      className="secondary"
      disabled={pending}
      onClick={() => start(() => removeSessionAction(name))}
    >
      Disconnect
    </button>
  )
}
