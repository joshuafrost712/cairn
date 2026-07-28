import { describe, expect, it } from 'vitest'
import { resolveSettings, settingValue, SETTINGS_DEFAULTS } from '../src/lib/settings'
import type { SettingKey, WorkshopSettingRow } from '../src/lib/types'

const row = (key: SettingKey, value: unknown): WorkshopSettingRow => ({
  pk: `w1::${key}`,
  workshop_id: 'w1',
  key,
  value,
})

describe('resolveSettings', () => {
  it('applies the defaults when nothing is stored', () => {
    expect(resolveSettings([])).toEqual(SETTINGS_DEFAULTS)
  })

  it('keeps the historical threshold of 2 as the default', () => {
    // Not arbitrary: a workshop that pulls before anyone opens Settings must
    // behave exactly as the app did before the setting became synced.
    expect(resolveSettings([]).requiredConfirmations).toBe(2)
  })

  it('reads a stored threshold', () => {
    expect(resolveSettings([row('required_confirmations', 3)]).requiredConfirmations).toBe(3)
  })

  it('ignores a threshold that is not a usable count', () => {
    for (const bad of [0, -1, 'nope', null, {}]) {
      expect(resolveSettings([row('required_confirmations', bad)]).requiredConfirmations).toBe(2)
    }
  })

  it('accepts a numeric string, since jsonb round-trips are not always typed', () => {
    expect(resolveSettings([row('required_confirmations', '3')]).requiredConfirmations).toBe(3)
  })

  it('leaves quota defaults null so the caller can fall back to the fair share', () => {
    const s = resolveSettings([])
    expect(s.reviewQuotaDefault).toBeNull()
    expect(s.observationQuotaDefault).toBeNull()
  })

  it('lowercases override keys so they join with evaluator emails', () => {
    const s = resolveSettings([row('review_quota_overrides', { 'Viji@SIL.org': 7 })])
    expect(s.reviewQuotaOverrides).toEqual({ 'viji@sil.org': 7 })
  })

  it('drops a zero override rather than storing it', () => {
    // A zero would read as "already over their limit" and silently exclude the
    // person from every auto-assignment run.
    const s = resolveSettings([row('review_quota_overrides', { 'a@b.org': 0, 'c@d.org': 5 })])
    expect(s.reviewQuotaOverrides).toEqual({ 'c@d.org': 5 })
  })

  it('survives an override value that is not an object', () => {
    expect(resolveSettings([row('review_quota_overrides', 'nonsense')]).reviewQuotaOverrides).toEqual({})
    expect(resolveSettings([row('review_quota_overrides', [1, 2])]).reviewQuotaOverrides).toEqual({})
  })

  it('keeps the two kinds of override separate', () => {
    const s = resolveSettings([
      row('review_quota_overrides', { 'a@b.org': 3 }),
      row('observation_quota_overrides', { 'a@b.org': 9 }),
    ])
    expect(s.reviewQuotaOverrides['a@b.org']).toBe(3)
    expect(s.observationQuotaOverrides['a@b.org']).toBe(9)
  })
})

describe('settingValue', () => {
  it('round-trips every key through resolve', () => {
    const original = {
      requiredConfirmations: 3,
      reviewQuotaDefault: 6,
      observationQuotaDefault: 8,
      reviewQuotaOverrides: { 'a@b.org': 9 },
      observationQuotaOverrides: { 'c@d.org': 2 },
    }
    const keys: SettingKey[] = [
      'required_confirmations',
      'review_quota_default',
      'observation_quota_default',
      'review_quota_overrides',
      'observation_quota_overrides',
    ]
    const rows = keys.map((k) => row(k, settingValue(original, k)))
    expect(resolveSettings(rows)).toEqual(original)
  })
})
