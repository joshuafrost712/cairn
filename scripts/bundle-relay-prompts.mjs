/**
 * Bundle the shared prompt chain for the Edge Functions (tl-23; extended by tl-16).
 *
 * WHY A GENERATED BUNDLE RATHER THAN A DIRECT IMPORT. The spec's intent is that
 * `route-captures` builds its system prompt from THE SAME `relayRoutingSystem()`
 * the relay uses, so the runbook and the unattended prompt stay one text. A direct
 * Deno import of `src/ai/relayPrompts.ts` fails on two facts of that file: the app
 * uses extensionless imports (which Deno refuses without sloppy-imports), and
 * `relayPrompts.ts` value-imports `OBSERVATIONS_BUNDLE_SCHEMA_ID` from
 * `src/routing/operations.ts`, whose module graph reaches Dexie and the GitHub
 * client — none of which belongs in an Edge Function. (The spec's "the chain is
 * pure" claim verified workspace/contract/scale and missed this one import; the
 * fallback it anticipated is this file.)
 *
 * So: esbuild bundles the chain with that single import shimmed to the constant it
 * carries — READ OUT OF operations.ts AT BUILD TIME, never retyped here — and the
 * committed output is what the function imports. `test/hostedRouting.test.ts`
 * rebuilds the bundle and diffs it against the committed file, so an edit to
 * `relayPrompts.ts` (or any file in its chain) that is not followed by
 * `npm run bundle:relay-prompts` fails the suite instead of quietly forking the
 * prompt.
 *
 * WHY `scenarioRules` RIDES ALONG (tl-16). `draft-scenario` held its own copy of the
 * drafting rules with a comment telling the reader to keep them in sync with
 * `scenarioRules()`. They had already drifted — the server's version described the output
 * as "a JSON object with these keys" while the client's used a four-part numbered list —
 * so the comment was documenting a discipline nobody was keeping. Now that an
 * administrator can author that text, a second copy is not merely untidy: the workshop's
 * authored rules would reach the copy/paste path and the brief pack while the hosted path
 * went on using a paragraph nobody can see or edit. One text, one tripwire.
 *
 * WHY `buildScale` RIDES ALONG. The function reads `scale_point` rows and must
 * turn them into the `Scale` the prompt builders take. `lib/scale.ts` is already
 * in the chain (workspace.ts imports it), so exporting `buildScale` costs nothing
 * and keeps "what counts as a usable scale" (>= MIN_SCALE_POINTS, default
 * fallback) one implementation rather than a Deno re-write.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { build } from 'esbuild'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const BUNDLE_PATH = path.join(
  repoRoot,
  'supabase',
  'functions',
  '_shared',
  'relayPrompts.gen.mjs',
)

const ENTRY = `
export { relayRoutingSystem, relayRoutingPrompt } from './src/ai/relayPrompts'
export { buildScale, defaultScalePoints, DEFAULT_SCALE } from './src/lib/scale'
export { scenarioRules, DEFAULT_DRAFT_SCALE } from './src/ai/scenarioContract'
`

const BANNER = `// GENERATED FILE — do not edit. Built from src/ai/relayPrompts.ts and its
// imports by scripts/bundle-relay-prompts.mjs; regenerate with
// \`npm run bundle:relay-prompts\`. test/hostedRouting.test.ts fails if this
// file is stale, so the Edge Function can never route on a forked prompt.`

/** The schema id, read from the module that owns it rather than retyped. */
function schemaIdFromSource() {
  const source = readFileSync(path.join(repoRoot, 'src', 'routing', 'operations.ts'), 'utf8')
  const match = source.match(/export const OBSERVATIONS_BUNDLE_SCHEMA_ID = '([^']+)'/)
  if (!match) {
    throw new Error(
      'OBSERVATIONS_BUNDLE_SCHEMA_ID not found in src/routing/operations.ts — the shim below would ship a stale schema id.',
    )
  }
  return match[1]
}

/**
 * Shim src/routing/operations to the one constant relayPrompts.ts needs, so the
 * bundle never touches Dexie or the GitHub client.
 */
function operationsShimPlugin(schemaId) {
  return {
    name: 'operations-schema-id-shim',
    setup(buildApi) {
      buildApi.onResolve({ filter: /^\.\.\/routing\/operations$/ }, () => ({
        path: 'operations-shim',
        namespace: 'tl23-shim',
      }))
      buildApi.onLoad({ filter: /^operations-shim$/, namespace: 'tl23-shim' }, () => ({
        contents: `export const OBSERVATIONS_BUNDLE_SCHEMA_ID = ${JSON.stringify(schemaId)}\n`,
        loader: 'js',
      }))
    },
  }
}

/** Build the bundle and return its text. Pure with respect to the output file. */
export async function buildRelayPromptsBundle() {
  const result = await build({
    stdin: { contents: ENTRY, resolveDir: repoRoot, loader: 'ts', sourcefile: 'relay-prompts-entry.ts' },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    charset: 'utf8',
    banner: { js: BANNER },
    plugins: [operationsShimPlugin(schemaIdFromSource())],
  })
  return result.outputFiles[0].text
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  const { writeFileSync, mkdirSync } = await import('node:fs')
  mkdirSync(path.dirname(BUNDLE_PATH), { recursive: true })
  const text = await buildRelayPromptsBundle()
  writeFileSync(BUNDLE_PATH, text)
  console.log(`wrote ${path.relative(repoRoot, BUNDLE_PATH)} (${text.length} chars)`)
}
