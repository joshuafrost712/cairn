import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../auth/AuthContext'
import { c } from '../../lib/content/chrome'
import { setAiLocalFiles } from '../../db/aiConfig'
import {
  MAX_LOCAL_FILES_NOTE_CHARS,
  MAX_LOCAL_FILE_PATHS,
  MAX_LOCAL_FILE_PATH_CHARS,
  type AiConfig,
} from '../../lib/aiConfig'
import { useSetupSave } from '../useSetupSave'
import { countsForAiConfig } from '../counts'

/**
 * Setup → AI → the operator's own course materials (tl-15).
 *
 * WHY THIS IS CONFIGURATION AND THE PACK IS NOT. What an administrator records here
 * changes what every future pack tells an agent to read, which is a property of the
 * workshop and belongs behind tl-07's dialog and in its log. Generating a pack is an
 * action taken with that configuration, so it lives at `/admin/agent-brief` — the same
 * split tl-14 drew between choosing a model (a dialog) and reading an estimate (not).
 *
 * ONE TEXTAREA, ONE PATH PER LINE, rather than a repeating row of inputs with an add
 * button. An administrator pasting three paths out of a Finder window or a terminal is
 * the actual case, and a line-per-item textarea is the only control that makes that a
 * paste rather than three. It also degrades honestly on a phone, where a repeating row
 * of narrow inputs is the shape the wave has twice had to unpick.
 *
 * NOTHING HERE IS VALIDATED AS A PATH, and the copy says so rather than leaving somebody
 * to infer it from the absence of a tick. Throughline cannot see the operator's disk; a
 * red or green mark beside a line would be a claim it is in no position to make.
 */
export function AiBrief({ workshopId, config }: { workshopId: string; config: AiConfig }) {
  const { identity } = useAuth()
  const { request, busy } = useSetupSave()
  const [pathsText, setPathsText] = useState(config.brief.localFiles.join('\n'))
  const [note, setNote] = useState(config.brief.localFilesNote ?? '')
  const [error, setError] = useState<string | null>(null)

  const parsePaths = (text: string): string[] =>
    text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)

  const save = async () => {
    const paths = parsePaths(pathsText)
    if (paths.length > MAX_LOCAL_FILE_PATHS) {
      setError(c('setup.ai.brief.too-many', 'label', { max: MAX_LOCAL_FILE_PATHS }))
      return
    }
    const tooLong = paths.find((p) => p.length > MAX_LOCAL_FILE_PATH_CHARS)
    if (tooLong) {
      setError(c('setup.ai.brief.path-too-long', 'label', { max: MAX_LOCAL_FILE_PATH_CHARS }))
      return
    }
    if (note.length > MAX_LOCAL_FILES_NOTE_CHARS) {
      setError(c('setup.ai.brief.note-too-long', 'label', { max: MAX_LOCAL_FILES_NOTE_CHARS }))
      return
    }
    setError(null)
    const counts = await countsForAiConfig(workshopId)
    const before = config.brief.localFiles.length
    await request({
      change: {
        entity: 'ai_config',
        operation: 'update',
        entityId: null,
        label: c('setup.ai.brief.title'),
        fields: [{ field: 'local_files', before, after: paths.length }],
        counts,
      },
      commit: async () => {
        await setAiLocalFiles(workshopId, paths, note.trim() || null, identity?.email ?? null)
        // Deliberately NOT a `setSaved` here. The panel is keyed on the stored values (see
        // AiSection), so a successful save changes the key and remounts this component —
        // which would throw away a confirmation set in local state before anybody read it.
        // The confirmation is the derived line at the bottom instead: it comes from the
        // config, so it survives the remount and is true rather than merely optimistic.
      },
    })
  }

  return (
    <div className="card form-col">
      <h2>{c('setup.ai.brief.title')}</h2>
      <p className="small muted">{c('setup.ai.brief.help')}</p>
      <p className="small muted">{c('setup.ai.brief.not-checked')}</p>

      <label className="small muted" htmlFor="ai-brief-paths">
        {c('setup.ai.brief.paths-label')}
      </label>
      <textarea
        id="ai-brief-paths"
        className="mono"
        rows={4}
        value={pathsText}
        placeholder={'/Users/you/Documents/Psalms Workshop/Curriculum'}
        onChange={(e) => setPathsText(e.target.value)}
      />

      <label className="small muted" htmlFor="ai-brief-note">
        {c('setup.ai.brief.note-label')}
      </label>
      <textarea
        id="ai-brief-note"
        rows={3}
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />

      <div className="row" style={{ flexWrap: 'wrap', gap: 'var(--s-1)' }}>
        <button className="ghost small" disabled={busy} onClick={() => void save()}>
          {c('setup.ai.brief.save')}
        </button>
        <span className="spacer" />
        <Link className="small" to="/admin/agent-brief">
          {c('setup.ai.brief.generate-link')}
        </Link>
      </div>
      {error && <p className="small banner warn">{error}</p>}
      {/* The confirmation, derived from what is stored rather than from what was typed. */}
      {!error && config.brief.localFiles.length > 0 && (
        <p className="small muted">
          {c('setup.ai.brief.stored', 'label', { n: config.brief.localFiles.length })}
        </p>
      )}
      {config.brief.packGeneratedAt && (
        <p className="small muted">
          {c('setup.ai.brief.last-pack', 'label', { at: config.brief.packGeneratedAt.slice(0, 16).replace('T', ' ') })}
        </p>
      )}
    </div>
  )
}
