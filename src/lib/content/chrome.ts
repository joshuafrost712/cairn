/**
 * Chrome content layer.
 *
 * Every user-facing string that is NOT authored reference data (KSAs, activities,
 * workshops — those live in Supabase) is held here, in one JSON file keyed by a
 * stable node id. Two reasons:
 *
 *   1. It is the prerequisite for edit-in-place. The dev-feedback EditWindow can
 *      only offer "edit this text" for a string it can locate and write back to;
 *      a literal inlined in JSX has no address. Nodes here have one, and the
 *      renderer stamps it into the DOM as `data-dfb-node` / `data-dfb-field` (see
 *      components/Copy.tsx) so a selection resolves back to its source.
 *   2. It makes the app's whole voice reviewable in one file instead of spread
 *      across 20-odd components.
 *
 * Deliberately NOT here: `lib/ruleset.ts`'s INPUT_RULES and RULESET_VERSION. Those
 * are the rules evaluators attest to at submit, and the version is stamped onto
 * every evaluation record. Changing an input rule is a versioned act, not a
 * wording tweak, so it stays a code change with a deliberate version bump.
 */
import rawChrome from '../../content/chrome.json'

export interface ChromeNode {
  id: string
  label?: string
  guidance?: string
  help?: string
}

export interface ChromeContent {
  version: string
  nodes: ChromeNode[]
}

/** The fields a node may carry, and the only ones edit-in-place may write. */
export const CHROME_FIELDS = ['label', 'guidance', 'help'] as const
export type ChromeField = (typeof CHROME_FIELDS)[number]

const content = rawChrome as ChromeContent

export function getChrome(): ChromeContent {
  return content
}

export function getChromeVersion(): string {
  return content.version
}

let indexCache: Map<string, ChromeNode> | null = null

/** Flat id -> node index, built once. */
export function chromeIndex(): Map<string, ChromeNode> {
  if (indexCache) return indexCache
  const map = new Map<string, ChromeNode>()
  for (const node of content.nodes) map.set(node.id, node)
  indexCache = map
  return map
}

export function findChromeNode(id: string): ChromeNode | undefined {
  return chromeIndex().get(id)
}

/**
 * Every node whose id starts with `prefix`, in file order. Backs the list-shaped
 * copy (the glossary) that used to be a TS array: file order is the render order,
 * so reordering the list is an edit to this JSON rather than a code change.
 */
export function chromeNodesByPrefix(prefix: string): ChromeNode[] {
  return content.nodes.filter((n) => n.id.startsWith(prefix))
}

/**
 * Substitute `{token}` placeholders. Kept deliberately dumb: a missing token is
 * left in place rather than blanked, so a broken interpolation is visible on the
 * page instead of silently swallowing text.
 */
export function fillTokens(text: string, tokens?: Record<string, string | number>): string {
  if (!tokens) return text
  return text.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in tokens ? String(tokens[key]) : whole,
  )
}

/**
 * Read a chrome string. Returns the id itself when the node or field is missing,
 * which makes an authoring mistake loud on the page rather than rendering an
 * empty element that is easy to miss in review.
 */
export function c(
  id: string,
  field: ChromeField = 'label',
  tokens?: Record<string, string | number>,
): string {
  const value = findChromeNode(id)?.[field]
  if (typeof value !== 'string') return id
  return fillTokens(value, tokens)
}
