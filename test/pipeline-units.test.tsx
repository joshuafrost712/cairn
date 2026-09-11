import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../src/layout/roles', () => ({ ADMIN_ROLES: [], useHasWorkshopRole: () => true }))

const { PipelineCard } = await import('../src/components/admin/PipelineCard')

describe('PipelineCard unit grouping', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <PipelineCard
        summary={
          { capturesNotRouted: 64, orphanedCaptures: 0, unattributedObservations: 0 } as never
        }
        attribution={{ total: 103, withActivity: 103 } as never}
      />
    </MemoryRouter>,
  )

  it('labels the two units separately', () => {
    expect(html).toContain('Captures — what evaluators submitted')
    expect(html).toContain('Observations — what routing produced from them')
  })

  it('warns on the capture row that it is not comparable to observations', () => {
    expect(html).toContain('not comparable')
  })

  it('still shows both figures', () => {
    expect(html).toContain('64')
    expect(html).toContain('103')
  })
})
