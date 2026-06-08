// Synthetic field-like evaluations for the calibration workstream (brief step 6).
// Each pins to a seeded activity by sort_order and resembles real dictated input:
// multi-participant, free-form, sometimes a group remark, sometimes a thin/ambiguous
// note that should come back needs_review. Used by scripts/calibrate.ts.

import { seedActivities, seedActivityKsas, seedKsas } from '../data/seed'
import type { Ksa } from '../lib/types'

export interface SyntheticEvaluation {
  activitySortOrder: number
  participantScopeNames: string[]
  text: string
  note: string // what we expect, for the human reading the calibration output
}

/** KSAs linked to an activity, by the activity's sort_order (Node-side; no Dexie). */
export function ksasForActivitySortOrder(sortOrder: number): Ksa[] {
  const activity = seedActivities.find((a) => a.sort_order === sortOrder)
  if (!activity) return []
  const links = seedActivityKsas
    .filter((l) => l.activity_id === activity.id)
    .sort((a, b) => a.sort_order - b.sort_order)
  return links.map((l) => seedKsas.find((k) => k.id === l.ksa_id)).filter((k): k is Ksa => Boolean(k))
}

export const SYNTHETIC_EVALUATIONS: SyntheticEvaluation[] = [
  {
    activitySortOrder: 1, // Genre Repertoire Mapping -> GENRE, AESTH
    participantScopeNames: ['CIT One', 'CIT Two'],
    text: `CIT One led the genre mapping really well. She asked open questions about which songs the community uses for mourning versus celebration and got the artists to list five distinct genres with their functions. She clearly treated the local forms as resources, not problems. CIT Two was quieter, mostly took notes, and at one point framed a chant form as just a simpler version of a hymn, which flattened the genre rather than mapping its real function.`,
    note: 'Expect: CIT One strong on GENRE (and AESTH); CIT Two weaker on GENRE.',
  },
  {
    activitySortOrder: 3, // Internalization & Crafting (Psalm 1) -> CLAT, EXEG
    participantScopeNames: ['CIT Three', 'CIT Four'],
    text: `Both of them facilitated internalization patiently and didn't rush the team. CIT Three used the Four Es well, walking the MTT through engaging and embodying the psalm before any drafting. CIT Four had clearly internalized Psalm 1 deeply himself, recited it from memory with feeling, but he jumped the team straight to drafting before they had internalized it, so the CLAT facilitation slipped there.`,
    note: 'Expect: group remark splits to both on EXEG; CIT Three solid CLAT, CIT Four mixed (strong personal internalization, weaker CLAT facilitation).',
  },
  {
    activitySortOrder: 6, // Community Check of Psalm 1 -> CHECK
    participantScopeNames: ['CIT One'],
    text: `CIT One's consulting questions were excellent. Open-ended, inferential, suited to the song form. She led the community check from issue identification right through to a resolution the team owned, and stayed humble throughout.`,
    note: 'Expect: CIT One high on CHECK, designation near 3.',
  },
  {
    activitySortOrder: 6, // CHECK — deliberately thin/ambiguous
    participantScopeNames: ['CIT Two', 'CIT Three'],
    text: `One of them seemed a bit lost during the check but I couldn't tell which from where I was sitting. Questions were okay I guess.`,
    note: 'Expect: low confidence + needs_review (ambiguous participant, thin evidence).',
  },
]
