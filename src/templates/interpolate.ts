/**
 * The one interpolation syntax for authored template bodies (tl-16). Pure.
 *
 * `{{token}}`, double-braced, and it is not a new syntax: `ROUTING_RULES_TEMPLATE`
 * in src/ai/contract.ts has used `{{RANGE}}` since tl-09, which is the only place
 * in this app that already had a *template body* with a hole in it. That function
 * now goes through here, so there is one scanner rather than a `replace()` per
 * caller.
 *
 * NOT chrome's `{token}` (src/lib/content/chrome.ts), and the difference is not
 * taste. Two of the templates in this library are AI instructions whose bodies
 * contain JSON examples — `{ "observations": [...] }`, `{{ "0": "..." }}` — and a
 * single-brace scanner over that text is one lucky whitespace away from treating a
 * JSON key as a variable. Chrome strings are short UI labels and never contain
 * JSON; template bodies routinely do.
 *
 * The two behaviours below are deliberate and are what the validator relies on:
 *
 *  - A token with no value is LEFT IN PLACE, exactly as chrome's filler does, so a
 *    broken interpolation is visible in the document rather than silently blanking
 *    a sentence. The validator is what stops one being authored in the first place;
 *    this is the second line of defence for a body written by an older client.
 *  - Substitution is single-pass. A value that itself contains `{{x}}` is not
 *    re-scanned, so no authored body can build a token out of data.
 */

/** The token spelling. Exported so the validator and the editor cannot disagree. */
export const TOKEN_PATTERN = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g

export type TemplateTokens = Record<string, string | number>

/**
 * Fill `{{token}}` holes in `body`.
 *
 * Single-pass by construction: `String.replace` with a global regex never re-reads
 * what it has written.
 */
export function fillTemplateTokens(body: string, tokens?: TemplateTokens): string {
  if (!tokens) return body
  return body.replace(TOKEN_PATTERN, (whole, name: string) => {
    const value = tokens[name]
    return value === undefined || value === null ? whole : String(value)
  })
}

/** Every distinct token named in `body`, in first-appearance order. */
export function tokensIn(body: string): string[] {
  const out: string[] = []
  for (const m of body.matchAll(TOKEN_PATTERN)) {
    if (!out.includes(m[1])) out.push(m[1])
  }
  return out
}
