/**
 * Mask personal and secret values before text goes to logs, events or error messages.
 * It is deliberately blunt: better to hide too much than to leak.
 */
export function redact(text: string): string {
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer ***')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, '$1***@$2')
    .replace(/\+?\d[\d\s().-]{7,}\d/g, '***')
}

export function redactJson(value: unknown): string {
  return redact(JSON.stringify(value) ?? '')
}
