// Per-workshop settings: turning stored rows into answers. Pure, no IO.
//
// The storage shape is key/value with jsonb values, which is right for a set of
// operator knobs that grows one at a time but wrong for every reader. This
// module is the one place that translation happens, so nothing downstream ever
// parses a jsonb value or remembers a default.

import type { SettingKey, WorkshopSettings, WorkshopSettingRow } from './types'

/**
 * Applied when a workshop has no stored row for a key.
 *
 * `requiredConfirmations: 2` matches what the app has always behaved as, so a
 * workshop that pulls before anyone opens Settings is unchanged rather than
 * silently re-gated.
 *
 * The two quota defaults are null on purpose, meaning "no explicit number set".
 * The fair share of the cohort is a better answer than any constant, and it is
 * computed from the actual roster by `fairShare()` in ./assignment.ts. Baking
 * in a 4 here would be a made-up number that looked authoritative.
 */
export const SETTINGS_DEFAULTS: WorkshopSettings = {
  requiredConfirmations: 2,
  reviewQuotaDefault: null,
  observationQuotaDefault: null,
  reviewQuotaOverrides: {},
  observationQuotaOverrides: {},
}

/** A stored jsonb value read as a positive integer, or null if it isn't one. */
function asCount(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 1) return null
  return Math.floor(n)
}

/**
 * A stored jsonb value read as an email → count map.
 *
 * Entries that are not positive integers are dropped rather than coerced: a
 * quota of 0 or NaN would read as "this person is already over their limit" and
 * quietly exclude them from auto-assignment, which is a worse outcome than
 * ignoring a malformed row.
 */
function asOverrides(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, number> = {}
  for (const [email, raw] of Object.entries(value as Record<string, unknown>)) {
    const n = asCount(raw)
    if (n !== null) out[email.trim().toLowerCase()] = n
  }
  return out
}

/** Resolve stored rows into settings, with every default already applied. */
export function resolveSettings(rows: WorkshopSettingRow[]): WorkshopSettings {
  const by = new Map<SettingKey, unknown>(rows.map((r) => [r.key, r.value]))
  return {
    requiredConfirmations:
      asCount(by.get('required_confirmations')) ?? SETTINGS_DEFAULTS.requiredConfirmations,
    reviewQuotaDefault: asCount(by.get('review_quota_default')),
    observationQuotaDefault: asCount(by.get('observation_quota_default')),
    reviewQuotaOverrides: asOverrides(by.get('review_quota_overrides')),
    observationQuotaOverrides: asOverrides(by.get('observation_quota_overrides')),
  }
}

/** The jsonb value to store for a key, given the resolved settings. */
export function settingValue(settings: WorkshopSettings, key: SettingKey): unknown {
  switch (key) {
    case 'required_confirmations':
      return settings.requiredConfirmations
    case 'review_quota_default':
      return settings.reviewQuotaDefault
    case 'observation_quota_default':
      return settings.observationQuotaDefault
    case 'review_quota_overrides':
      return settings.reviewQuotaOverrides
    case 'observation_quota_overrides':
      return settings.observationQuotaOverrides
  }
}
