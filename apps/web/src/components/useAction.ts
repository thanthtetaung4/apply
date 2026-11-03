'use client'

import { startTransition, useActionState } from 'react'
import type { FormState } from '@/lib/state'

/**
 * Run a server action from a form without React's automatic form reset. With `<form action={fn}>`
 * React 19 clears every field once the action returns, which wipes what the user typed when the
 * action reports an error. This keeps the fields as they are.
 */
export function useAction(action: (prev: FormState, fd: FormData) => Promise<FormState>) {
  const [state, dispatch, pending] = useActionState(action, {} as FormState)
  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    startTransition(() => dispatch(fd))
  }
  return { state, onSubmit, pending }
}
