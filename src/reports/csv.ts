// Minimal RFC-4180-ish CSV writer. Quotes only when needed; doubles inner quotes.
export function toCsv(headers: string[], rows: (string | number | boolean | null)[][]): string {
  const esc = (v: string | number | boolean | null): string => {
    const s = v == null ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return [headers, ...rows].map((r) => r.map(esc).join(',')).join('\n') + '\n'
}
