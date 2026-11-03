import { basename } from 'node:path'
import type { FieldValue, FormField } from '../browser/types'
import type { Profile } from '../profile'

export type FieldSource = 'rule' | 'bank' | 'model'

export type Mapping =
  | { kind: 'fill'; value: FieldValue; source: FieldSource }
  | { kind: 'skip'; reason: string }
  | { kind: 'unresolved' }

export interface MapContext {
  profile: Profile
  resumePath: string
}

const DECLINE = /decline|prefer not|do not wish|don'?t wish|not to (say|answer|disclose)/i
const EEO_LABEL =
  /gender|race|ethnic|veteran|disabilit|pronoun|sexual orientation|religio|self[- ]identif/i
const EEO_SECTION = /voluntary|self[- ]identif|equal (employment|opportunity)|diversity|eeo/i

/** Choose the option that best matches an answer: exact, then contained. */
export function pickOption(options: string[], answer: string): string | null {
  const want = answer.trim().toLowerCase()
  return (
    options.find((o) => o.toLowerCase() === want) ??
    options.find((o) => o.toLowerCase().startsWith(want) && want.length >= 2) ??
    null
  )
}

function link(profile: Profile, re: RegExp): string | undefined {
  return profile.contact.links.find((l) => re.test(l.label) || re.test(l.url))?.url
}

/**
 * Decide what to put in one field. Order: identity rules, optional self-identification fields,
 * then the answer bank. Anything else is "unresolved" and goes to the model or a human.
 */
export function mapField(field: FormField, ctx: MapContext): Mapping {
  const { profile } = ctx
  const label = field.label.toLowerCase()
  const c = profile.contact
  const nameParts = c.name.trim().split(/\s+/)
  const rule = (value: FieldValue): Mapping => ({ kind: 'fill', value, source: 'rule' })

  if (field.type === 'file') {
    if (/resume|cv|curriculum/.test(label)) return rule(ctx.resumePath)
    return field.required ? { kind: 'unresolved' } : { kind: 'skip', reason: 'optional file' }
  }
  if (field.type === 'password') return { kind: 'unresolved' }

  // Voluntary self-identification: always decline when the form allows it.
  if ((EEO_LABEL.test(label) || EEO_SECTION.test(field.section ?? '')) && field.options) {
    const decline = field.options.find((o) => DECLINE.test(o))
    if (decline) return rule(decline)
    if (!field.required) return { kind: 'skip', reason: 'optional self-identification' }
  }

  if (
    field.type === 'checkbox' &&
    !field.options &&
    /privacy|terms|consent|agree|acknowledge/.test(label)
  ) {
    return rule(true)
  }

  // Identity and contact details.
  if (/first name|given name|forename/.test(label)) return rule(nameParts[0]!)
  if (/last name|surname|family name/.test(label))
    return rule(nameParts.slice(1).join(' ') || nameParts[0]!)
  if (/^(full |your |legal )?name$|full name/.test(label)) return rule(c.name)
  if (/e-?mail/.test(label)) return rule(c.email)
  if (/phone|mobile|contact number/.test(label) && c.phone) return rule(c.phone)
  if (/linkedin/.test(label)) {
    const u = link(profile, /linkedin/i)
    if (u) return rule(u)
  }
  if (/github/.test(label)) {
    const u = link(profile, /github/i)
    if (u) return rule(u)
  }
  if (/website|portfolio|personal (site|page)/.test(label)) {
    const u = link(profile, /portfolio|website|personal/i) ?? link(profile, /github/i)
    if (u) return rule(u)
  }
  if (/\b(city|location)\b|where are you (based|located)/.test(label) && c.location) {
    return rule(c.location.split(',')[0]!.trim())
  }
  if (/current (company|employer)/.test(label)) return rule(profile.experience[0]!.company)

  // Answer bank, for screening questions.
  const hit = profile.answerBank.match(field.label)
  if (hit) {
    if (field.options) {
      const opt = pickOption(field.options, hit.answer)
      return opt ? { kind: 'fill', value: opt, source: 'bank' } : { kind: 'unresolved' }
    }
    if (field.type === 'checkbox') {
      return /^(yes|true|agree)/i.test(hit.answer)
        ? { kind: 'fill', value: true, source: 'bank' }
        : { kind: 'unresolved' }
    }
    if (field.type === 'number' && !/^\d+(\.\d+)?$/.test(hit.answer.trim()))
      return { kind: 'unresolved' }
    if (field.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(hit.answer.trim()))
      return { kind: 'unresolved' }
    return { kind: 'fill', value: hit.answer, source: 'bank' }
  }

  return field.required
    ? { kind: 'unresolved' }
    : { kind: 'skip', reason: 'optional, no answer on file' }
}

export const fileNameOf = (path: string) => basename(path)
