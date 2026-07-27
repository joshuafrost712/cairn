// Client-side document ingestion for the scenario draft-fill.
//
// Plain text and markdown are read directly with no dependencies. Binary formats
// (PDF, DOCX) would need a parser bundled into the client (pdfjs-dist / mammoth) —
// deliberately NOT added yet to keep the bundle lean; the paste-text box is the
// zero-dependency floor for those. readDocumentFile() reads what it safely can and
// returns a clear reason otherwise, so the UI can steer the user to paste instead.

const TEXT_EXTENSIONS = ['.txt', '.md', '.markdown', '.text', '.csv', '.json']

export async function readDocumentFile(
  file: File,
): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  const name = file.name.toLowerCase()
  const isText =
    file.type.startsWith('text/') ||
    file.type === 'application/json' ||
    TEXT_EXTENSIONS.some((ext) => name.endsWith(ext))

  if (!isText) {
    return {
      ok: false,
      reason:
        'That looks like a binary file (e.g. PDF or Word). Export or copy its text and paste it below instead.',
    }
  }

  try {
    const text = await file.text()
    if (!text.trim()) return { ok: false, reason: 'The file appears to be empty.' }
    return { ok: true, text }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'Could not read the file.' }
  }
}
