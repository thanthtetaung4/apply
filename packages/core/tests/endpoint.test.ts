import { describe, expect, it } from 'vitest'
import { endpointProblem, isPrivateAddress } from '../src/llm/endpoint'

const resolvesTo =
  (...addresses: string[]) =>
  async () =>
    addresses.map((address) => ({ address }))

describe('model server address check', () => {
  it('knows private, loopback, link-local and metadata addresses', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.20.0.1',
      '192.168.1.10',
      '169.254.169.254',
      '100.100.1.1',
      '0.0.0.0',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
    ])
      expect(isPrivateAddress(ip), ip).toBe(true)
    for (const ip of ['1.1.1.1', '8.8.8.8', '172.32.0.1', '2606:4700::1111'])
      expect(isPrivateAddress(ip), ip).toBe(false)
  })

  it('accepts a public https address', async () => {
    expect(
      await endpointProblem('https://ollama.example.com/v1', { lookup: resolvesTo('1.2.3.4') }),
    ).toBeUndefined()
  })

  it('refuses localhost, private targets, http and credentials in the URL', async () => {
    const lookup = resolvesTo('1.2.3.4')
    expect(await endpointProblem('http://localhost:11434/v1', { lookup })).toMatch(
      /your computer|https/,
    )
    expect(await endpointProblem('https://localhost:11434/v1', { lookup })).toMatch(/your computer/)
    expect(await endpointProblem('http://ollama.example.com/v1', { lookup })).toMatch(/https/)
    expect(await endpointProblem('https://a:b@ollama.example.com/v1', { lookup })).toMatch(
      /key field/,
    )
    expect(await endpointProblem('https://169.254.169.254/latest', { lookup })).toMatch(/private/)
    // A public name that resolves to a private address is refused too.
    expect(
      await endpointProblem('https://sneaky.example.com/v1', {
        lookup: resolvesTo('1.2.3.4', '10.0.0.5'),
      }),
    ).toMatch(/private/)
    expect(await endpointProblem('not a url')).toMatch(/full address/)
  })

  it('allows private addresses on self-hosted installs', async () => {
    expect(
      await endpointProblem('http://192.168.1.10:11434/v1', { allowPrivate: true }),
    ).toBeUndefined()
  })
})
