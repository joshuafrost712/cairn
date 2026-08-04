import { getAiConfig } from '../../db/aiConfig'
import { buildBriefPack, type BriefPack } from '../pack'
import { failed, operatorAction, type AiOutcome } from './types'

/**
 * The `pack` intent's outcome, shared by `byo-agent` and by the fallback (tl-15).
 *
 * ONE IMPLEMENTATION, TWO INSTRUCTION IDS. `fallbackOutcome` in ./index.ts deliberately
 * does not call `byoAgentProvider.run`, because that would trace a hand-off as though the
 * workshop had chosen bring-your-own; the same reasoning applies to the pack, so the
 * instruction id is the caller's and everything else is here.
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
