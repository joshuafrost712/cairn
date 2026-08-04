import { getAiConfig } from '../../db/aiConfig'
import { buildBriefPack, type BriefPack } from '../pack'
import { failed, operatorAction, type AiOutcome } from './types'

/**
 * The `pack` intent's outcome (tl-15). One caller today: `runAiJob`, which serves the pack
 * in every mode.
 *
 * It is a module of its own rather than an inline branch because the instruction id is a
 * parameter: `runAiJob` passes `setup.ai.op.pack-ready`, and a later spec that wants a
 * differently-worded hand-off (a per-function pack, say) passes its own rather than editing
 * this. That is the same shape `fallbackOutcome` uses for its prompts, and for the same
 * reason — a trace that names the wrong hand-off is worse than a terse one.
 *
 * The pack travels on `value` rather than on `prompt`. `prompt` is text for a human to
 * paste; a pack is a set of files, and the screen that asked for it turns them into a zip.
 * Putting the archive bytes in an outcome would mean the provider layer knew about
 * downloads, which is the browser's business and not the contract's.
 */
export async function packOutcome(workshopId: string, instructionsId: string): Promise<AiOutcome> {
  try {
    const config = await getAiConfig(workshopId)
    const pack = await buildBriefPack({
      workshopId,
      fn: 'observation_routing',
      localFiles: { paths: config.brief.localFiles, note: config.brief.localFilesNote },
    })
    return operatorAction(instructionsId, {
      value: { pack, count: pack.captures } satisfies { pack: BriefPack; count: number },
    })
  } catch (err) {
    return failed(err instanceof Error ? err.message : 'The brief pack could not be built.')
  }
}
