/** Shape returned by form actions to client forms. */
export interface FormState {
  ok?: boolean
  error?: string
  issues?: string[]
  message?: string
  /** One time value to show once, for example a new API token. */
  secret?: string
}
