import type { FormState } from '@/lib/state'

export function Messages({ state }: { state: FormState }) {
  return (
    <>
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
      {state.issues && state.issues.length > 0 && (
        <ul className="issues error">
          {state.issues.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      )}
      {state.message && <p className="okmsg">{state.message}</p>}
    </>
  )
}
