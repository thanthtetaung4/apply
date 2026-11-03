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
  return normalizeValue(type, intended) === normalizeValue(type, actual)
}
