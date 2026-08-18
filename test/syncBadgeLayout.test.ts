import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The sync badge must stay OUT of the document flow, checked structurally.
 *
 * Joshua reported that the screen jiggled up and down while people typed. The
 * cause was not the indicator's content but its position: `saveAnswers` runs on
 * every keystroke of a capture and flips the row's sync_status, `pushOutbox`
 * flips it back, and the badge's live query sees both — so its pending count and
 * its "Send now" button appeared and vanished several times a second. While it
 * lived in `.shell__identity`, a flex child of the sticky content-height header,
 * every one of those flips resized the header and moved the page.
 *
 * None of that is visible in a unit test of the component, and it is easy to undo
 * by accident: putting the status back beside the user's name looks tidier than
 * floating it in a corner. So the two properties that actually fix the bug are
 * asserted here, against the source that states them.
 *
 * The third assertion is a different invisible bug. An element that rewrites
 * itself per keystroke must not be a live region: `aria-live` would read a fresh
 * sentence for every letter typed, which is worse for a screen-reader user than
 * the layout shift was for a sighted one. `role="alert"` on the stranded block is
 * fine and expected — that state is a property of the build and announces once.
 */

const SRC = join(import.meta.dirname, '..', 'src')
const layoutCss = readFileSync(join(SRC, 'styles', 'layout.css'), 'utf8')
const appShell = readFileSync(join(SRC, 'layout', 'AppShell.tsx'), 'utf8')
const badge = readFileSync(join(SRC, 'components', 'SyncStatusBadge.tsx'), 'utf8')

/** Strip comments, so a rule explained in prose is not read as code. */
const cssCode = layoutCss.replace(/\/\*[\s\S]*?\*\//g, '')
const tsxCode = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

describe('the sync badge cannot move the rest of the page', () => {
  it('is fixed-position in layout.css', () => {
    const block = cssCode.match(/\.syncbadge\s*\{([^}]*)\}/)
    expect(block, 'layout.css must declare a .syncbadge rule').not.toBeNull()
    expect(block![1]).toMatch(/position:\s*fixed/)
  })

  it('does not intercept clicks meant for the page underneath', () => {
    // The workbench approve bar is sticky to this same edge.
    const block = cssCode.match(/\.syncbadge\s*\{([^}]*)\}/)
    expect(block![1]).toMatch(/pointer-events:\s*none/)
    expect(cssCode).toMatch(/\.syncbadge button\s*\{[^}]*pointer-events:\s*auto/)
  })

  it('has no width transition or animation, so a live count cannot slide', () => {
    const block = cssCode.match(/\.syncbadge\s*\{([^}]*)\}/)
    expect(block![1]).not.toMatch(/transition:/)
    expect(block![1]).not.toMatch(/animation:/)
  })

  it('is rendered outside the sticky header', () => {
    const code = tsxCode(appShell)
    expect(code, 'AppShell must render the badge').toMatch(/<SyncStatusBadge\s*\/>/)
    const header = code.match(/<header[\s\S]*?<\/header>/)
    expect(header, 'AppShell must still have a header').not.toBeNull()
    expect(header![0]).not.toMatch(/SyncStatusBadge/)
  })

  it('is mounted exactly once', () => {
    expect(tsxCode(appShell).match(/<SyncStatusBadge/g)).toHaveLength(1)
  })

  it('is not a live region', () => {
    const code = tsxCode(badge)
    expect(code).not.toMatch(/aria-live/)
    expect(code).not.toMatch(/role="status"/)
    // The stranded warning is the exception, and it is meant to be there.
    expect(code).toMatch(/role="alert"/)
  })
})
