import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadProfileFromDir as loadProfile } from '../../src/profile/fs'

const bank = loadProfile(resolve(__dirname, '../fixtures/profile')).answerBank

describe('AnswerBank.match', () => {
  it('matches an exact pattern with score 1', () => {
    const hit = bank.match('How did you hear about us?')
    expect(hit?.answer).toBe('Company careers page.')
    expect(hit?.score).toBe(1)
  })

  it('matches a longer form question that contains the pattern words', () => {
    const hit = bank.match('Are you legally authorized to work in Singapore? *')
    expect(hit?.answer).toBe('Yes')
  })

  it('matches via an alternate pattern', () => {
    expect(bank.match('When is your earliest start date?')?.answer).toMatch(/2 weeks/)
    expect(bank.match('Salary expectation (SGD per month)')?.answer).toMatch(/Negotiable/)
  })

  it('handles case, punctuation and stems (authorized vs authorization)', () => {
    expect(bank.match('WORK AUTHORISATION status')?.answer).toBe('Yes')
  })

  it('returns null for unrelated or empty questions', () => {
    expect(bank.match('Describe a time you led a team through conflict')).toBeNull()
    expect(bank.match('   ')).toBeNull()
    expect(bank.match('???')).toBeNull()
  })

  it('does not match on a single shared generic word', () => {
    expect(bank.match('What is your favourite website framework?')).toBeNull()
  })

  it('still matches a short question for a one word pattern', () => {
    expect(bank.match('Website')?.answer).toBe('https://example.com')
    expect(bank.match('Personal website?')?.answer).toBe('https://example.com')
  })

  it('respects a stricter threshold', () => {
    const q = 'Do you have work rights in Singapore?'
    expect(bank.match(q)).toBeNull()
    expect(bank.match(q, 0.5)?.answer).toBe('Yes')
  })
})
