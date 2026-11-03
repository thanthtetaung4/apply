import { parseKey } from '@apply/db'

export type RegistrationMode = 'open' | 'invite' | 'closed'

export function registration(): { mode: RegistrationMode; inviteCode?: string } {
  const mode = (process.env.REGISTRATION_MODE ?? 'open') as RegistrationMode
  return {
    mode: ['open', 'invite', 'closed'].includes(mode) ? mode : 'closed',
    inviteCode: process.env.INVITE_CODE,
  }
}

export const encryptionKey = () => parseKey(process.env.APP_ENCRYPTION_KEY)
