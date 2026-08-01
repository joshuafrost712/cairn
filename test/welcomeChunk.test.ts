import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import chrome from '../src/content/chrome.json'

/**
 * tl-19's two static guarantees, checked where they are cheap: on every commit.
 *
 * Both of them are the kind of thing that stays true for a week and then quietly
 * stops being true in an unrelated refactor, with nothing failing. A landing page
 * whose animation library leaked into the shell still works perfectly; it just
 * costs every workshop phone another 60 KB forever. A string inlined in a scene
 * still renders; it just cannot be edited by the person reading it.
 *
 * The behavioural half of the spec (does the page actually reveal, does the chunk
 * actually stay unloaded on the signed-in routes, does it fit a 390px phone) is in
 * scripts/ui-responsive-audit.mjs, because none of that can be proved from here.
 */

const SRC = join(import.meta.dirname, '..', 'src')
const WELCOME_DIR = join(SRC, 'pages', 'welcome')

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })
}

const sourceFiles = walk(SRC).filter((f) => /\.(ts|tsx)$/.test(f))

describe('the motion library is confined to the landing chunk', () => {
  const MOTION_IMPORT = /from\s+['"](motion|framer-motion)(\/[^'"]*)?['"]/

  it('is imported only from src/pages/welcome/ and src/pages/Welcome.tsx', () => {
    const offenders = sourceFiles
      .filter((f) => MOTION_IMPORT.test(readFileSync(f, 'utf8')))
      .filter((f) => !f.startsWith(WELCOME_DIR) && f !== join(SRC, 'pages', 'Welcome.tsx'))
      .map((f) => f.slice(SRC.length + 1))
    expect(offenders).toEqual([])
  })

  it('is imported somewhere, so the check cannot pass by the page having been deleted', () => {
    // A guard that would also pass if the feature were gone is not a guard.
    const users = sourceFiles.filter((f) => MOTION_IMPORT.test(readFileSync(f, 'utf8')))
    expect(users.length).toBeGreaterThan(0)
  })

  it('never reaches for the eager `motion.` namespace, which LazyMotion strict forbids', () => {
    // `import { motion }` would load the full feature set at module scope and make
    // the lazy bundle pointless; `strict` throws at render, but only on a route
    // somebody has to actually open.
    const offenders = sourceFiles
      .filter((f) => /import\s*\{[^}]*\bmotion\b[^}]*\}\s*from\s+['"](motion|framer-motion)/.test(
        readFileSync(f, 'utf8'),
      ))
      .map((f) => f.slice(SRC.length + 1))
    expect(offenders).toEqual([])
  })
})

describe('the landing copy is addressable', () => {
  const ids = new Set((chrome as { nodes: Array<{ id: string }> }).nodes.map((n) => n.id))
  const welcomeFiles = [...walk(WELCOME_DIR), join(SRC, 'pages', 'Welcome.tsx')].filter((f) =>
    /\.tsx$/.test(f),
  )

  it('renders no bare text node in src/pages/welcome/', () => {
    // Catches `>Some words<` in JSX. Attributes, expressions and comments are not
    // text nodes, so this is narrow on purpose: the thing it must catch is a
    // sentence a reader can see and nobody can edit.
    //
    // The lookbehind skips an arrow function's return type (`=> Record<string,…>`),
    // which is the one piece of TypeScript that reads like a JSX text node to a
    // regex.
    const offenders: string[] = []
    for (const file of welcomeFiles) {
      const src = readFileSync(file, 'utf8')
      for (const [, text] of src.matchAll(/(?<![=-])>([^<>{}\n]*[A-Za-z]{2,}[^<>{}\n]*)</g)) {
        if (text.trim().length > 1) offenders.push(`${file.slice(SRC.length + 1)}: ${text.trim()}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('resolves every welcome.* id the page asks for', () => {
    // `c()` returns the id itself when a node is missing, so a typo renders as
    // "welcome.scene-c.rubric-9" on the page rather than throwing. Cheaper to
    // catch here.
    // A SceneSection is handed a base ("welcome.scene-a") and reads `.eyebrow`,
    // `.title` and `.body` off it, so the base itself is a prefix rather than a
    // node. Those five bases plus the trust block are the only literals that are
    // legitimately not ids; every other welcome.* string in the directory must
    // resolve.
    const BASES = new Set([
      'welcome.scene-a',
      'welcome.scene-b',
      'welcome.scene-c',
      'welcome.scene-d',
      'welcome.scene-e',
      'welcome.trust',
    ])
    const asked = new Set<string>()
    for (const file of welcomeFiles) {
      const src = readFileSync(file, 'utf8')
      for (const [, id] of src.matchAll(/['"`](welcome\.[a-z0-9.-]+)['"`]/g)) {
        if (!BASES.has(id)) asked.add(id)
      }
    }
    // What each base expands to, and the templated trust points, cannot be read
    // statically — so they are listed rather than inferred.
    for (const base of BASES) {
      asked.add(`${base}.eyebrow`)
      asked.add(`${base}.title`)
      asked.add(`${base}.body`)
    }
    for (const n of [1, 2, 3, 4]) {
      asked.add(`welcome.trust.point-${n}`)
      asked.add(`welcome.trust.point-${n}.title`)
    }
    const missing = [...asked].filter((id) => !ids.has(id))
    expect(missing).toEqual([])
  })

  it('says nothing about the tool having been tested and vetted', () => {
    // docs/ai-transparency.md:102-105 forbids that claim in public copy until a
    // vetting record exists. This page is public and doubles as the pitch link, so
    // the prohibition is enforced rather than remembered.
    const welcomeCopy = (chrome as { nodes: Array<Record<string, unknown>> }).nodes
      .filter((n) => String(n.id).startsWith('welcome.'))
      .flatMap((n) => Object.values(n).filter((v): v is string => typeof v === 'string'))
      .join(' ')
    expect(welcomeCopy).not.toMatch(/\bvetted\b|\bcertified\b|\bproven\b|\bvalidated\b/i)
  })
})
