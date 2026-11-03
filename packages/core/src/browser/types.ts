import type { StorageState } from '../store'

/**
 * The only browser API the rest of the app may use. A backend (Playwright now, an agent-native
 * browser later) implements these two interfaces and registers under a name.
 */

export type FieldType =
  | 'text'
  | 'email'
  | 'tel'
  | 'url'
  | 'number'
  | 'date'
  | 'password'
  | 'textarea'
  | 'select'
  | 'radio'
  | 'checkbox'
  | 'file'

export type FieldValue = string | boolean | string[]

export interface FormField {
  /** Stable across reloads of the same page. Derived from label, name, type and section. */
  id: string
  label: string
  type: FieldType
  name?: string
  required: boolean
  /** Visible option labels for select, radio and multi checkbox fields. */
  options?: string[]
  /** Current value read from the page. Files report the selected file name. */
  value?: FieldValue
  section?: string
  hint?: string
  disabled?: boolean
}

export type ActionKind = 'next' | 'submit' | 'back' | 'open' | 'other'

export interface FormAction {
  id: string
  label: string
  kind: ActionKind
}

export interface StepInfo {
  index: number
  total: number
}

export interface FormSchema {
  url: string
  title: string
  step?: StepInfo
  fields: FormField[]
  actions: FormAction[]
}

export interface PageSnapshot {
  url: string
  title: string
  /** Visible text, truncated. For block and confirmation detection, not for filling. */
  text: string
  headings: string[]
}

export interface StepResult {
  /** The page moved on (URL or field set changed). */
  advanced: boolean
  /** Visible validation or error messages after the click. */
  errors: string[]
}

export interface LaunchOptions {
  headless: boolean
  /** Saved cookies and local storage for a signed in session. */
  storageState?: StorageState
}

export interface BrowserSession {
  readonly backend: string
  open(url: string): Promise<void>
  url(): Promise<string>
  snapshot(): Promise<PageSnapshot>
  /** Rendered HTML, for intake parsing. */
  content(): Promise<string>
  formSchema(): Promise<FormSchema>
  fill(fieldId: string, value: FieldValue): Promise<void>
  upload(fieldId: string, filePath: string): Promise<void>
  click(actionId: string): Promise<StepResult>
  /** Click the "next" action. Throws if the page has none. */
  next(): Promise<StepResult>
  /** Click the "submit" action. Throws if the page has none. */
  submit(): Promise<StepResult>
  /** Current value of every field on the page, by field id. */
  readValues(): Promise<Record<string, FieldValue | undefined>>
  screenshot(): Promise<Buffer>
  /** Current cookies and local storage, to save a signed in session. */
  exportState(): Promise<StorageState>
  close(): Promise<void>
}

export interface BrowserBackend {
  readonly name: string
  launch(options: LaunchOptions): Promise<BrowserSession>
  /** Release shared resources (the browser process). */
  dispose(): Promise<void>
}

export class BrowserError extends Error {
  constructor(
    message: string,
    readonly code: 'not_implemented' | 'no_such_field' | 'no_such_action' | 'timeout' | 'launch',
  ) {
    super(message)
    this.name = 'BrowserError'
  }
}
