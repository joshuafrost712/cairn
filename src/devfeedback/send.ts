/**
 * Ship a rendered batch to the developer. Primary path: POST to the dev-only
 * `/__feedback` endpoint (the Vite plugin in vite.config.ts writes it to
 * feedback/incoming/<name>.md in the repo). Fallback for any failure (e.g. a
 * deployed build with no dev server): download the markdown so it can be moved
 * into the repo by hand.
 *
 * Kept self-contained (its own download helper) so the whole devfeedback/
 * folder copies into another app unchanged.
 */
export interface SendResult {
  ok: boolean
  path?: string
  fallback?: 'download'
}

function downloadText(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export async function sendBatch(markdown: string): Promise<SendResult> {
  const filename = `feedback-${new Date().toISOString().replace(/[:.]/g, '-')}.md`
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}__feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename, markdown }),
    })
    if (res.ok) {
      const data = (await res.json().catch(() => ({}))) as { path?: string }
      return { ok: true, path: data.path }
    }
  } catch {
    // dev endpoint unreachable — fall through to download
  }
  downloadText(filename, markdown)
  return { ok: true, fallback: 'download' }
}
