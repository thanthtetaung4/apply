import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto'

/**
 * Encryption that only the worker can undo, for signed in browser sessions.
 *
 * The worker holds an X25519 private key. Everything else (the web app, upload routes) holds only
 * the public key, so it can lock a session but never read one back. A break in on the web app
 * therefore leaks no usable sessions.
 *
 * Each value gets a fresh ephemeral key pair. The shared secret goes through HKDF-SHA256 to an
 * AES-256-GCM key, and the "context" (owner and session name) is bound as additional data, so a
 * value copied to another user or site fails to open.
 *
 * Format: v2.<keyId>.<ephemeral public key>.<iv>.<tag>.<ciphertext> (base64url). The key id lets
 * the worker hold an old and a new private key while sessions are re-sealed after a key change.
 */

const INFO = Buffer.from('apply/sealed-session/v2')
/** DER prefix of an X25519 SubjectPublicKeyInfo. The raw 32 key bytes follow it. */
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex')
const b64 = (b: Buffer) => b.toString('base64url')

function rawPublic(key: KeyObject): Buffer {
  return key.export({ format: 'der', type: 'spki' }).subarray(SPKI_PREFIX.length)
}

/** Short stable id of a public key, stored with each value. */
export function sealKeyId(publicKey: KeyObject): string {
  return createHash('sha256').update(rawPublic(publicKey)).digest('hex').slice(0, 12)
}

function deriveKey(shared: Buffer, eph: Buffer, recipient: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', shared, Buffer.concat([eph, recipient]), INFO, 32))
}

export function parsePublicKey(value: string | undefined, name = 'SESSION_PUBLIC_KEY'): KeyObject {
  if (!value) throw new Error(`${name} is not set. Generate a key pair with: pnpm keys:generate`)
  let key: KeyObject
  try {
    key = createPublicKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'spki' })
  } catch {
    throw new Error(`${name} is not a valid X25519 public key (base64 SPKI).`)
  }
  if (key.asymmetricKeyType !== 'x25519')
    throw new Error(`${name} is not a valid X25519 public key (base64 SPKI).`)
  return key
}

/** One or more private keys, comma separated. The first is current; the rest open old values. */
export function parsePrivateKeys(
  value: string | undefined,
  name = 'WORKER_SESSION_PRIVATE_KEY',
): KeyObject[] {
  if (!value) throw new Error(`${name} is not set. Generate a key pair with: pnpm keys:generate`)
  return value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => {
      let key: KeyObject
      try {
        key = createPrivateKey({ key: Buffer.from(v, 'base64'), format: 'der', type: 'pkcs8' })
      } catch {
        throw new Error(`${name} contains a value that is not a valid X25519 private key.`)
      }
      if (key.asymmetricKeyType !== 'x25519')
        throw new Error(`${name} contains a value that is not a valid X25519 private key.`)
      return key
    })
}

export function generateSealKeyPair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('x25519')
  return {
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  }
}

export const isSealed = (payload: string) => payload.startsWith('v2.')

export function seal(publicKey: KeyObject, context: string, plaintext: string): string {
  const eph = generateKeyPairSync('x25519')
  const ephRaw = rawPublic(eph.publicKey)
  const key = deriveKey(
    diffieHellman({ privateKey: eph.privateKey, publicKey }),
    ephRaw,
    rawPublic(publicKey),
  )
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(context))
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return ['v2', sealKeyId(publicKey), b64(ephRaw), b64(iv), b64(cipher.getAuthTag()), b64(ct)].join(
    '.',
  )
}

export function open(privateKeys: KeyObject[], context: string, payload: string): string {
  const [v, kid, ephB64, ivB64, tagB64, ctB64] = payload.split('.')
  if (v !== 'v2' || !kid || !ephB64 || !ivB64 || !tagB64 || ctB64 === undefined)
    throw new Error('Unreadable sealed value')
  const priv = privateKeys.find((k) => sealKeyId(createPublicKey(k)) === kid)
  if (!priv) throw new Error('This session was sealed with a key the worker no longer has.')
  const ephRaw = Buffer.from(ephB64, 'base64url')
  const ephKey = createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, ephRaw]),
    format: 'der',
    type: 'spki',
  })
  const key = deriveKey(
    diffieHellman({ privateKey: priv, publicKey: ephKey }),
    ephRaw,
    rawPublic(createPublicKey(priv)),
  )
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'))
  decipher.setAAD(Buffer.from(context))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'))
  try {
    return Buffer.concat([
      decipher.update(Buffer.from(ctB64, 'base64url')),
      decipher.final(),
    ]).toString('utf8')
  } catch {
    throw new Error('Could not open the sealed value (wrong key or wrong owner)')
  }
}
