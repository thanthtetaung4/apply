'use client'

import Link from 'next/link'
import { useAction } from './useAction'
import { loginAction, registerAction } from '@/app/actions/auth'
import { Messages } from './Messages'
import { SubmitButton } from './SubmitButton'

export function LoginForm() {
  const { state, onSubmit, pending } = useAction(loginAction)
  return (
    <form onSubmit={onSubmit} className="card">
      <h1>Sign in</h1>
      <p className="muted">Auto Apply</p>
      <div className="field">
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" autoComplete="email" required autoFocus />
      </div>
      <div className="field">
        <label htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
      </div>
      <SubmitButton busy={pending} pending="Signing in...">
        Sign in
      </SubmitButton>
      <Messages state={state} />
      <p className="muted small" style={{ marginTop: 14 }}>
        No account? <Link href="/register">Create one</Link>
      </p>
    </form>
  )
}

export function RegisterForm({ needsInvite }: { needsInvite: boolean }) {
  const { state, onSubmit, pending } = useAction(registerAction)
  return (
    <form onSubmit={onSubmit} className="card">
      <h1>Create your account</h1>
      <p className="muted">You will add your resume next.</p>
      <div className="field">
        <label htmlFor="name">
          Name <span className="hint">optional</span>
        </label>
        <input id="name" name="name" type="text" autoComplete="name" />
      </div>
      <div className="field">
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" autoComplete="email" required />
      </div>
      <div className="field">
        <label htmlFor="password">
          Password <span className="hint">at least 10 characters</span>
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={10}
          required
        />
      </div>
      <div className="field">
        <label htmlFor="confirm">Repeat password</label>
        <input id="confirm" name="confirm" type="password" autoComplete="new-password" required />
      </div>
      {needsInvite && (
        <div className="field">
          <label htmlFor="invite">Invite code</label>
          <input id="invite" name="invite" type="text" required />
        </div>
      )}
      <SubmitButton busy={pending} pending="Creating...">
        Create account
      </SubmitButton>
      <Messages state={state} />
      <p className="muted small" style={{ marginTop: 14 }}>
        Already registered? <Link href="/login">Sign in</Link>
      </p>
    </form>
  )
}
