import { describe, it, expect } from 'vitest'
import { asVerdictsFiles } from '../src/routing/verdicts'

const file = { schema: 'cairn.verdicts/v1', evaluator_email: 'a@x', updated_at: 't', verdicts: [] }

describe('asVerdictsFiles', () => {
  it('accepts a single verdicts file', () => {
    expect(asVerdictsFiles(file)).toHaveLength(1)
  })

  it('accepts a bare array of files', () => {
    expect(asVerdictsFiles([file, file])).toHaveLength(2)
  })

  it('accepts a {results: [...]} bundle', () => {
    expect(asVerdictsFiles({ results: [file] })).toHaveLength(1)
  })

  it('filters out objects without evaluator_email or verdicts', () => {
    expect(asVerdictsFiles([file, { foo: 1 }, { evaluator_email: 'b@x' }])).toHaveLength(1)
  })

  it('returns [] for junk', () => {
    expect(asVerdictsFiles(null)).toHaveLength(0)
    expect(asVerdictsFiles('nope')).toHaveLength(0)
  })
})
