import { redirect } from 'next/navigation'
import { RegisterForm } from '@/components/AuthForm'
import { registration } from '@/lib/env'
import { currentUser } from '@/lib/session'

export default async function RegisterPage() {
  if (await currentUser()) redirect('/')
  const reg = registration()
  return (
    <main className="auth">
      {reg.mode === 'closed' ? (
        <div className="card">
          <h1>Sign ups are closed</h1>
          <p className="muted">Ask the owner for an account.</p>
        </div>
      ) : (
        <RegisterForm needsInvite={reg.mode === 'invite'} />
      )}
    </main>
  )
}
