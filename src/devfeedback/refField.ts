import { db } from '../db/local'
import type { ProposalTable } from './db'

/**
 * Addressing for reference copy.
 *
 * A KSA's editable text is not always a plain column: `guiding_questions` is an
 * array and `evidence_levels` a 0-3 record. The DOM tags those with a dotted path
 * ("guiding_questions.2", "evidence_levels.3"), and these helpers are the single
 * place that path is interpreted, so the read used to seed an edit and the write
 * used to apply it can never drift apart.
 */

/** Read the current value at `field` on `row`, or '' when it is absent. */
export function readRefField(row: unknown, field: string): string {
  const [key, index] = field.split('.')
  const record = row as Record<string, unknown> | null | undefined
  const container = record?.[key]
  if (index === undefined) return typeof container === 'string' ? container : ''
  if (Array.isArray(container)) {
    const item = container[Number(index)]
    return typeof item === 'string' ? item : ''
  }
  if (container && typeof container === 'object') {
    const item = (container as Record<string, unknown>)[index]
    return typeof item === 'string' ? item : ''
  }
  return ''
}

/**
 * Return a copy of `row` with `field` set to `value`. Copies rather than mutating
 * because the source is a live Dexie object, and the nested array/record is cloned
 * too so an in-place splice can't leak into the cached row before the write lands.
 */
export function writeRefField<T>(row: T, field: string, value: string): T {
  const [key, index] = field.split('.')
  const next = { ...(row as Record<string, unknown>) }
  if (index === undefined) {
    next[key] = value
    return next as T
  }
  const container = next[key]
  if (Array.isArray(container)) {
    const copy = [...container]
    copy[Number(index)] = value
    next[key] = copy
  } else if (container && typeof container === 'object') {
    next[key] = { ...(container as Record<string, unknown>), [index]: value }
  } else {
    // The container is missing entirely; create the shape the path implies.
    next[key] = /^\d+$/.test(index) && key === 'guiding_questions' ? [value] : { [index]: value }
  }
  return next as T
}

/** Fetch the row a proposal targets from the local cache. */
export async function loadRefRow(table: ProposalTable, rowId: string): Promise<unknown> {
  if (table === 'ksa') return db.ksas.get(rowId)
  if (table === 'activity') return db.activities.get(rowId)
  return db.workshops.get(rowId)
}

/** Human label for the field, used in the edit panel and the proposal list. */
export function refFieldLabel(field: string): string {
  const [key, index] = field.split('.')
  const base: Record<string, string> = {
    short_label: 'short label',
    description: 'description',
    evaluator_facing_prompt: 'observation cue',
    guiding_questions: 'guiding question',
    evidence_levels: 'evidence anchor',
    title: 'title',
    name: 'name',
  }
  const label = base[key] ?? key
  return index === undefined ? label : `${label} ${index}`
}
