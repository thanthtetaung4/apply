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

/**
 * App AI: the app's own model. The worker holds the key (PLATFORM_OPENROUTER_KEY); the web app
 * only needs to know whether it is offered (PLATFORM_AI=on) and the weekly free allowance, which
 * must match the worker's FREE_AI_APPLICATIONS_PER_WEEK.
 */
export const platformAi = () => ({
  enabled: process.env.PLATFORM_AI === 'on',
  freePerWeek: Math.max(0, Math.floor(Number(process.env.FREE_AI_APPLICATIONS_PER_WEEK ?? 5)) || 0),
})

/**
 * Selling AI applications with Stripe Checkout. STRIPE_PRICE_ID is a one-time price for one pack
 * of AI_CREDITS_PER_PACK applications. Off unless the secret key, webhook secret and price are set.
 */
export const billing = () => {
  const secretKey = process.env.STRIPE_SECRET_KEY
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET
  const priceId = process.env.STRIPE_PRICE_ID
  const creditsPerPack = Math.floor(Number(process.env.AI_CREDITS_PER_PACK ?? 50))
  return {
    enabled: Boolean(secretKey && webhookSecret && priceId && creditsPerPack > 0),
    secretKey,
    webhookSecret,
    priceId,
    creditsPerPack,
    /** Public address of the web app, for Stripe's return links. */
    appUrl: (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, ''),
  }
}
