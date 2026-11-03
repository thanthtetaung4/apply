import { redirect } from 'next/navigation'
import { LoginForm } from '@/components/AuthForm'
import { currentUser } from '@/lib/session'

export default async function LoginPage() {
  if (await currentUser()) redirect('/')
  return (
    <main className="auth">
      <LoginForm />
    </main>
  )
}
