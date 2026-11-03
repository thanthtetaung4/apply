import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mapField, pickOption } from '../src/apply/fields'
import type { FormField } from '../src/browser/types'
import { loadProfile } from '../src/profile'
import { normalizeValue, valuesMatch } from '../src/verify/compare'

const profile = loadProfile(resolve(__dirname, '../demo/profile'))
const ctx = { profile, resumePath: '/tmp/Alex_Tan_Resume.pdf' }
const f = (label: string, over: Partial<FormField> = {}): FormField => ({
  id: 'f_x',
  label,
  type: 'text',
  required: true,
  ...over,
})

describe('mapField rules', () => {
  it('fills identity and contact fields from the profile', () => {
    expect(mapField(f('First Name'), ctx)).toEqual({ kind: 'fill', value: 'Alex', source: 'rule' })
    expect(mapField(f('Last name'), ctx)).toMatchObject({ value: 'Tan' })
    expect(mapField(f('Full name'), ctx)).toMatchObject({ value: 'Alex Tan' })
    expect(mapField(f('Email address', { type: 'email' }), ctx)).toMatchObject({
      value: 'alex.tan@example.com',
    })
    expect(mapField(f('Mobile number'), ctx)).toMatchObject({ value: '+65 9000 0000' })
    expect(mapField(f('LinkedIn Profile'), ctx)).toMatchObject({
      value: 'https://linkedin.com/in/alextan-demo',
    })
    expect(mapField(f('Link to GitHub or portfolio'), ctx)).toMatchObject({
      value: 'https://github.com/alextan-demo',
    })
    expect(mapField(f('Website'), ctx)).toMatchObject({ value: 'https://alextan.example.com' })
    expect(mapField(f('Location (City)'), ctx)).toMatchObject({ value: 'Singapore' })
    expect(mapField(f('Current Employer'), ctx)).toMatchObject({ value: 'Acme Analytics' })
  })

  it('uploads the resume and skips optional files', () => {
    expect(mapField(f('Resume/CV', { type: 'file' }), ctx)).toMatchObject({
      kind: 'fill',
      value: ctx.resumePath,
    })
    expect(mapField(f('Cover letter', { type: 'file', required: false }), ctx)).toMatchObject({
      kind: 'skip',
    })
    expect(mapField(f('Portfolio PDF', { type: 'file' }), ctx)).toEqual({ kind: 'unresolved' })
  })

  it('declines voluntary self identification and never answers it with data', () => {
    const gender = f('Gender', {
      type: 'select',
      required: false,
      options: ['Male', 'Female', 'Decline to self-identify'],
    })
    expect(mapField(gender, ctx)).toMatchObject({
      kind: 'fill',
      value: 'Decline to self-identify',
      source: 'rule',
    })
    const noDecline = f('Race/Ethnicity', {
      type: 'select',
      required: false,
      options: ['Chinese', 'Malay'],
    })
    expect(mapField(noDecline, ctx)).toMatchObject({ kind: 'skip' })
    const bySection = f('Question 7', {
      type: 'radio',
      required: false,
      section: 'Voluntary self-identification',
      options: ['A', 'Prefer not to say'],
    })
    expect(mapField(bySection, ctx)).toMatchObject({ value: 'Prefer not to say' })
  })

  it('agrees to privacy consent checkboxes only', () => {
    expect(mapField(f('I agree to the privacy policy', { type: 'checkbox' }), ctx)).toMatchObject({
      value: true,
    })
    expect(
      mapField(f('Subscribe me to the newsletter', { type: 'checkbox', required: false }), ctx),
    ).toMatchObject({ kind: 'skip' })
  })

  it('uses the answer bank and respects options', () => {
    const auth = f('Are you legally authorized to work in Singapore?', {
      type: 'select',
      options: ['Yes', 'No'],
    })
    expect(mapField(auth, ctx)).toEqual({ kind: 'fill', value: 'Yes', source: 'bank' })
    const sponsor = f('Will you now or in the future require visa sponsorship?', {
      type: 'radio',
      options: ['Yes', 'No'],
    })
    expect(mapField(sponsor, ctx)).toMatchObject({ value: 'No', source: 'bank' })
    expect(mapField(f('Earliest start date'), ctx)).toMatchObject({ source: 'bank' })
    // The answer is not one of the options, so it cannot be used.
    const odd = f('Notice period', { type: 'select', options: ['1 month', '3 months'] })
    expect(mapField(odd, ctx)).toEqual({ kind: 'unresolved' })
  })

  it('marks unknown required questions unresolved and unknown optional ones skipped', () => {
    expect(
      mapField(f('Describe a time you led a team through conflict', { type: 'textarea' }), ctx),
    ).toEqual({ kind: 'unresolved' })
    expect(mapField(f('Anything else?', { type: 'textarea', required: false }), ctx)).toMatchObject(
      { kind: 'skip' },
    )
    expect(mapField(f('Password', { type: 'password' }), ctx)).toEqual({ kind: 'unresolved' })
  })

  it('picks options exactly or by prefix', () => {
    expect(pickOption(['Yes', 'No'], 'yes')).toBe('Yes')
    expect(pickOption(['Yes, I am authorized', 'No'], 'yes')).toBe('Yes, I am authorized')
    expect(pickOption(['Yes', 'No'], 'maybe')).toBeNull()
  })
})

describe('value comparison', () => {
  it('normalises phone, url, case, whitespace and files', () => {
    expect(valuesMatch('tel', '+65 9000 0000', '+6590000000')).toBe(true)
    expect(valuesMatch('url', 'https://a.test/x/', 'https://a.test/x')).toBe(true)
    expect(valuesMatch('text', ' Alex  Tan ', 'alex tan')).toBe(true)
    expect(valuesMatch('file', '/tmp/dir/Alex_Tan_Resume.pdf', 'Alex_Tan_Resume.pdf')).toBe(true)
    expect(valuesMatch('checkbox', true, true)).toBe(true)
    expect(valuesMatch('checkbox', true, false)).toBe(false)
    expect(valuesMatch('text', 'Alex', undefined)).toBe(false)
    expect(normalizeValue('checkbox', ['B', 'a'])).toBe('a|b')
  })
})
