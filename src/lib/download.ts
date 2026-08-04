/** Trigger a client-side file download of text content. */
export function downloadText(filename: string, text: string, type = 'application/json'): void {
  download(filename, new Blob([text], { type }))
}

/** The same, for bytes: the brief pack's zip archive (tl-15). */
export function downloadBytes(filename: string, bytes: Uint8Array, type = 'application/octet-stream'): void {
  // A fresh ArrayBuffer copy rather than `bytes.buffer`, which may be a view into a
  // larger allocation and would put the whole of it in the file.
  download(filename, new Blob([bytes.slice().buffer as ArrayBuffer], { type }))
}

function download(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
