import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'

/**
 * AES-256-GCM for secrets at rest. The "context" (user id and name) is bound to the ciphertext as
 * additional data, so a value copied to another user or field fails to decrypt.
 * Format: v1.<iv>.<tag>.<ciphertext> (base64url).
 */

export function parseKey(value: string | undefined): Buffer {
  if (!value)
    throw new Error('APP_ENCRYPTION_KEY is not set. Generate one with: openssl rand -base64 32')
  const key = Buffer.from(value, 'base64')
  if (key.length !== 32) throw new Error('APP_ENCRYPTION_KEY must be 32 bytes, base64 encoded.')
  return key
}

export function generateKey(): string {
  return randomBytes(32).toString('base64')
}

export function encryptString(key: Buffer, context: string, plaintext: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(context))
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return [
    'v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ct.toString('base64url'),
  ].join('.')
}

export function decryptString(key: Buffer, context: string, payload: string): string {
  const [v, iv, tag, ct] = payload.split('.')
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Unreadable secret')
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'))
  decipher.setAAD(Buffer.from(context))
  decipher.setAuthTag(Buffer.from(tag, 'base64url'))
  try {
    return Buffer.concat([
      decipher.update(Buffer.from(ct, 'base64url')),
      decipher.final(),
    ]).toString('utf8')
  } catch {
    throw new Error('Could not decrypt the secret (wrong key or wrong owner)')
  }
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}
