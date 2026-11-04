import { parseKey, parsePublicKey } from '@apply/db'
import type { KeyObject } from 'node:crypto'

export type RegistrationMode = 'open' | 'invite' | 'closed'

export function registration(): { mode: RegistrationMode; inviteCode?: string } {
  const mode = (process.env.REGISTRATION_MODE ?? 'open') as RegistrationMode
  return {
    mode: ['open', 'invite', 'closed'].includes(mode) ? mode : 'closed',
    inviteCode: process.env.INVITE_CODE,
  }
}

export const encryptionKey = () => parseKey(process.env.APP_ENCRYPTION_KEY)

let sealKey: KeyObject | undefined
/** The worker's public key. The web app can lock sign in sessions with it, never open them. */
export const sessionPublicKey = () => (sealKey ??= parsePublicKey(process.env.SESSION_PUBLIC_KEY))

/**
 * Where the browser opens sign in windows: the worker's WebSocket endpoint, as the user's browser
 * reaches it. Use wss:// in production.
 */
export const workerSignInUrl = () =>
  (process.env.WORKER_SIGNIN_URL ?? 'ws://localhost:4100/signin').replace(/\/$/, '')
