import { basename } from 'node:path'
import type { FieldType, FieldValue } from '../browser/types'

/** Reduce a field value to a comparable form. */
export function normalizeValue(type: FieldType, v: FieldValue | undefined): string {
  if (v === undefined || v === null) return ''
  if (type === 'file') return basename(String(v)).toLowerCase()
  if (type === 'checkbox' && typeof v === 'boolean') return v ? 'true' : 'false'
  if (Array.isArray(v))
    return [...v]
      .map((x) => x.toLowerCase().trim())
      .sort()
      .join('|')
  const s = String(v).replace(/\s+/g, ' ').trim().toLowerCase()
  if (type === 'tel') return s.replace(/[^\d+]/g, '')
  if (type === 'url') return s.replace(/\/+$/, '')
  return s
}

export function valuesMatch(
  type: FieldType,
  intended: FieldValue,
  actual: FieldValue | undefined,
): boolean {
  const want = normalizeValue(type, intended)
  const got = normalizeValue(type, actual)
  if (want === got) return true
  // A picked suggestion may add detail: "Singapore" becomes "Singapore, Singapore" or
  // "Singapore (SG)". Only extra detail after a comma or bracket counts, never a different value.
  if (type === 'text' && want !== '' && (got.startsWith(`${want},`) || got.startsWith(`${want} (`)))
    return true
  // Phone country pickers show only the dialling code of the chosen country: "Singapore +65"
  // reads back as "+65" (seen on a real Greenhouse form).
  return type === 'select' && /^\+\d{1,4}$/.test(got) && want.endsWith(got)
}
