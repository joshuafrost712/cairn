import { createElement, type ReactNode } from 'react'
import { c, type ChromeField } from '../lib/content/chrome'

/**
 * Renders a chrome string and stamps its address into the DOM.
 *
 * The `data-dfb-*` attributes are what make edit-in-place possible: when a text
 * selection lands inside one of these elements, devfeedback/SelectionLayer walks
 * up to the nearest `[data-dfb-node]` and knows exactly which node and field the
 * highlighted words came from, and (via `data-dfb-source`) that they are patched
 * on disk rather than proposed against the database.
 *
 * Use this wherever a whole element's text is one chrome node. Where the string is
 * only part of a larger element, or is an attribute (placeholder, title, aria-label)
 * that cannot be selected, call `c()` directly — those stay centralized here for
 * authoring even though they are not reachable by highlight-to-edit.
 */
export interface CopyProps {
  /** Chrome node id, e.g. "capture.watching-prompt". */
  id: string
  /** Which field of the node to render. Defaults to the node's `label`. */
  field?: ChromeField
  /** Values for any `{token}` placeholders in the string. */
  tokens?: Record<string, string | number>
  /** Element to render. Defaults to a span so it can sit inline anywhere. */
  as?: keyof React.JSX.IntrinsicElements
  className?: string
  style?: React.CSSProperties
  htmlFor?: string
  children?: ReactNode
}

export function Copy({ id, field = 'label', tokens, as = 'span', children, ...rest }: CopyProps) {
  return createElement(
    as,
    { 'data-dfb-node': id, 'data-dfb-field': field, 'data-dfb-source': 'chrome', ...rest },
    c(id, field, tokens),
    children,
  )
}
