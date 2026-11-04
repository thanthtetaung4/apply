import { createPublicKey } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  generateSealKeyPair,
  isSealed,
  open,
  parsePrivateKeys,
  parsePublicKey,
  seal,
  sealKeyId,
} from '../src/sealed'

const pair = () => {
  const p = generateSealKeyPair()
  return { pub: parsePublicKey(p.publicKey), priv: parsePrivateKeys(p.privateKey) }
}

describe('sealed sessions', () => {
  it('round trips with the private key and binds the context', () => {
    const k = pair()
    const v = seal(k.pub, 'u1:browser_session:linkedin', '{"cookies":[1]}')
    expect(isSealed(v)).toBe(true)
    expect(v).not.toContain('cookies')
    expect(open(k.priv, 'u1:browser_session:linkedin', v)).toBe('{"cookies":[1]}')
    expect(() => open(k.priv, 'u2:browser_session:linkedin', v)).toThrow(/wrong owner/)
    expect(() => open(k.priv, 'u1:browser_session:indeed', v)).toThrow(/wrong owner/)
  })

  it('uses a fresh ephemeral key each time', () => {
    const k = pair()
    expect(seal(k.pub, 'c', 'x')).not.toBe(seal(k.pub, 'c', 'x'))
  })

  it('needs the matching private key and supports an old key during rotation', () => {
    const oldK = pair()
    const newK = pair()
    const old = seal(oldK.pub, 'c', 'secret')
    expect(() => open(newK.priv, 'c', old)).toThrow(/no longer has/)
    expect(open([...newK.priv, ...oldK.priv], 'c', old)).toBe('secret')
    expect(sealKeyId(createPublicKey(newK.priv[0]!))).toBe(sealKeyId(newK.pub))
  })

  it('rejects tampering and bad keys', () => {
    const k = pair()
    const parts = seal(k.pub, 'c', 'secret').split('.')
    parts[5] = Buffer.from('nope').toString('base64url')
    expect(() => open(k.priv, 'c', parts.join('.'))).toThrow()
    expect(() => open(k.priv, 'c', 'v1.a.b.c')).toThrow(/Unreadable/)
    expect(() => parsePublicKey('')).toThrow(/keys:generate/)
    expect(() => parsePublicKey('aGVsbG8=')).toThrow(/X25519/)
    expect(() => parsePrivateKeys(generateSealKeyPair().publicKey)).toThrow(/X25519/)
  })
})
