#!/usr/bin/env node
/**
 * `npm run relay:wipe` — empty the relay's state directory (tl-21).
 *
 * Retention is part of operating this thing: job payloads hold participant evidence, so
 * the relay purges completed jobs on a clock and this is the manual version of the same
 * decision, for the end of a workshop. It prints what it removed rather than doing it
 * silently, because "where does our evidence sit" is a question this program answers.
 */

import { readJobs, relayHome, wipe } from './state.mjs'

const before = await readJobs()
const home = relayHome()
await wipe()
process.stdout.write(
  `Wiped ${before.length} job file${before.length === 1 ? '' : 's'}, the token and the drop folders.\n${home}\nA relay started after this mints a new token, so re-paste it in Setup → AI.\n`,
)
