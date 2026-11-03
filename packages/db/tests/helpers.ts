import type { Job } from '@apply/core/job'
import { generateKey, parseKey } from '../src/crypto'
import type { Db } from '../src/client'
import { registerUser } from '../src/auth'
import { createTestDb } from '../src/testing'

export const KEY = parseKey(generateKey())

export async function setup() {
  const t = await createTestDb()
  return t
}

let n = 0
export async function newUser(db: Db, email = `user${++n}@example.com`) {
  return registerUser(db, { email, password: 'correct horse battery', name: 'Test User' })
}

export const job = (id: string, over: Partial<Job> = {}): Job => ({
  id,
  source: 'indeed',
  title: 'AI Engineer',
  company: `Company ${id}`,
  location: 'Singapore',
  description: 'desc',
  applyUrl: `https://careers.example.com/${id}`,
  applyTarget: 'greenhouse',
  fetchedAt: '2026-11-03T08:00:00.000Z',
  ...over,
})
