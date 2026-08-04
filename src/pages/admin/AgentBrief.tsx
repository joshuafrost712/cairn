import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../../db/local'
import { useAuth } from '../../auth/AuthContext'
import { useScopedWorkshopId } from '../../layout/roles'
import { c } from '../../lib/content/chrome'
import { Copy } from '../../components/Copy'
import { runAiJob, type AiOutcome } from '../../ai/providers'
import { aiEnabled, aiUnavailableReason } from '../../ai/aiEnabled'
import { resolveAiConfig } from '../../lib/aiConfig'
import { stampPackGenerated } from '../../db/aiConfig'
import { packToZip, type BriefPack } from '../../ai/pack'
import {
  importObservationsPack,
  listPendingCaptures,
  MAX_IMPORT_FILES,
  type ImportFileReport,
  type ImportReport,
} from '../../routing/operations'
import { downloadBytes } from '../../lib/download'

/**
 * Point your own AI subscription at this workshop's work (tl-15).
 *
 * ADMINISTRATOR-ONLY, at `/admin/agent-brief`, for tl-03's reason: it names a mechanism.
 * It sits beside `/admin/routing` rather than inside the Setup hub because generating a
 * pack is an action rather than a setting — the paths it carries ARE a setting, and they
 * are edited in Setup → AI where tl-07's dialog and log can see them.
 *
 * WHY THE PACK GOES THROUGH `runAiJob`. A download button wired straight to
 * `buildBriefPack` would work and would be wrong twice over: a workshop that has switched
 * observation routing off would still be exporting its captures, and the one screen that
 * tells an administrator what the AI layer has done would have no record of the largest
 * thing it did. The pack is an `observation_routing` intent, so it passes the toggle and
 * lands in the trace like every other way of moving this work.
 *
 * THE TOOL INSTRUCTIONS ARE SPECIFIC ON PURPOSE. Joshua's feedback named Codex and a GPT
 * subscription, and specificity is the whole value of the section: "use your AI tool" is
 * advice nobody can act on, while "unzip it, read brief.md, write output/" is a thing a
 * person does. The strings live in chrome.json so he can fix the wording in place when a
 * tool's own vocabulary moves.
 */
export function AgentBrief() {
  const { identity } = useAuth()
  const workshopId = useScopedWorkshopId()
  const configRows = useLiveQuery(() => db.aiConfigs.toArray(), [], [])
  const config = resolveAiConfig(workshopId ?? '', configRows ?? [])
  const routingOn = aiEnabled('observation_routing', config)
  const routingOffReason = aiUnavailableReason('observation_routing', config)
  const pending = useLiveQuery(async () => (await listPendingCaptures()).length, [], 0)

  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [pack, setPack] = useState<BriefPack | null>(null)
  const [report, setReport] = useState<ImportReport | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const generate = async () => {
    if (!workshopId) return
    setBusy(true)
    setStatus(c('agent-brief.generating'))
    setReport(null)
    try {
      const outcome: AiOutcome = await runAiJob(
        { fn: 'observation_routing', workshopId, actorEmail: identity?.email ?? null, intent: 'pack' },
        { config },
      )
      if (outcome.kind === 'refused') {
        setStatus(c(outcome.reason ?? 'setup.ai.fn.disabled'))
        return
      }
      if (outcome.kind !== 'operator_action') {
        setStatus(outcome.reason ?? c('setup.ai.fn.disabled'))
        return
      }
      const built = (outcome.value as { pack?: BriefPack } | undefined)?.pack
      if (!built) {
        setStatus(c('agent-brief.pack-failed'))
        return
      }
      setPack(built)
      downloadBytes(built.filename, packToZip(built), 'application/zip')
      // Best-effort and after the download, so a failed stamp cannot report a failed pack.
      await stampPackGenerated(workshopId, built.generatedAt, identity?.email ?? null)
      setStatus(
        c('agent-brief.generated', 'label', { filename: built.filename, captures: built.captures }),
      )
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const upload = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    setBusy(true)
    setStatus(c('agent-brief.importing'))
    try {
      const uploads = await Promise.all(
        [...files]
          // Only the JSON answers. A `output/` folder picked whole carries the README
          // this app wrote into it, and reporting that as a malformed answer would be
          // the app complaining about its own file.
          .filter((f) => f.name.toLowerCase().endsWith('.json'))
          .slice(0, MAX_IMPORT_FILES)
          .map(async (f) => ({ name: f.name, text: await f.text() })),
      )
      if (uploads.length === 0) {
        setStatus(c('agent-brief.no-json'))
        return
      }
      const result = await importObservationsPack(uploads)
      setReport(result)
      setStatus(
        c('agent-brief.imported', 'label', {
          stored: result.stored,
          rejected: result.rejected,
          skipped: result.skipped,
          shared: result.shared,
        }),
      )
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  return (
    <>
      <div className="card">
        <Copy id="agent-brief.title" as="h1" />
        <Copy id="agent-brief.intro" as="p" className="small muted" />
        <p className="small">
          <strong>{pending}</strong> {c('agent-brief.pending', 'label', { n: pending })}
        </p>
        {routingOffReason && (
          <p className="small">
            <span className="pill queued">{c('setup.ai.fn.off')}</span> {c(routingOffReason)}
          </p>
        )}
      </div>

      <div className="card form-col">
        <Copy id="agent-brief.pack-title" as="h2" />
        <Copy id="agent-brief.pack-help" as="p" className="small muted" />
        <div className="row" style={{ flexWrap: 'wrap', gap: 'var(--s-1)' }}>
          <button className="primary" disabled={busy || !routingOn || !workshopId} onClick={() => void generate()}>
            {c('agent-brief.generate')}
          </button>
          <span className="spacer" />
          <Link className="small" to="/admin/setup/ai">
            {c('agent-brief.paths-link')}
          </Link>
        </div>
        {config.brief.localFiles.length > 0 ? (
          <p className="small muted">
            {c('agent-brief.paths-included', 'label', { n: config.brief.localFiles.length })}
          </p>
        ) : (
          <Copy id="agent-brief.paths-absent" as="p" className="small muted" />
        )}
        {pack && (
          <ul className="plain-list small muted">
            {pack.files.map((f) => (
              <li key={f.name}>
                <code>{f.name}</code>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card form-col">
        <Copy id="agent-brief.tools-title" as="h2" />
        <Copy id="agent-brief.tools-fs" as="p" className="small" />
        <Copy id="agent-brief.tools-fs-steps" as="p" className="small muted" />
        <Copy id="agent-brief.tools-chat" as="p" className="small" />
        <Copy id="agent-brief.tools-chat-steps" as="p" className="small muted" />
        <Copy id="agent-brief.tools-caveat" as="p" className="small muted" />
      </div>

      <div className="card form-col">
        <Copy id="agent-brief.return-title" as="h2" />
        <Copy id="agent-brief.return-help" as="p" className="small muted" />
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          multiple
          disabled={busy}
          onChange={(e) => void upload(e.target.files)}
        />
        <p className="small muted">
          {c('agent-brief.return-paste')} <Link to="/admin/routing">{c('agent-brief.return-paste-link')}</Link>.
        </p>
      </div>

      {status && <div className="banner">{status}</div>}
      {report && <ImportReportCard report={report} />}
    </>
  )
}

/**
 * The per-item verdict, which is the point of the upload path rather than a nicety.
 *
 * An operator who uploads twenty files and is told "imported 43 observations" has no way
 * to find the two files their agent got wrong, and the likeliest thing it got wrong is the
 * thing this app cares most about: a quotation that is not in the source. So every rejected
 * item names its capture, its participant and its reason, and every skipped file says which
 * of the three reasons it was skipped for.
 */
function ImportReportCard({ report }: { report: ImportReport }) {
  return (
    <div className="card">
      <h2>{c('agent-brief.report-title')}</h2>
      <ul className="plain-list">
        {report.files.map((file, i) => (
          <li key={`${file.name}-${i}`} className="small" style={{ marginBottom: 'var(--s-1)' }}>
            <FileLine file={file} />
          </li>
        ))}
      </ul>
    </div>
  )
}

function FileLine({ file }: { file: ImportFileReport }) {
  const rejected = file.items.filter((item) => item.status === 'rejected')
  return (
    <>
      <span className={`pill ${file.status === 'imported' ? 'ok' : 'queued'}`}>
        {c(`agent-brief.file.${file.status}`)}
      </span>{' '}
      <code>{file.name}</code>
      {file.status === 'imported' && (
        <> · {c('agent-brief.file.counts', 'label', { stored: file.stored, rejected: file.rejected })}</>
      )}
      {rejected.length > 0 && (
        <ul className="plain-list small muted" style={{ marginTop: '0.15rem' }}>
          {rejected.map((item) => (
            <li key={item.index}>
              {c('agent-brief.item.rejected', 'label', {
                index: item.index + 1,
                participant: item.participant ?? c('agent-brief.item.no-participant'),
                reason: c(`agent-brief.reason.${item.rejection}`),
                detail: item.detail ?? '',
              })}
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
