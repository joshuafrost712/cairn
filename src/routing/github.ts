// Minimal GitHub Contents API client — enough to push capture files and pull
// routed observation files. No SDK; just fetch. Used only when a token is set
// (canPushPull()); the manual download/upload flow needs none of this.

import { getRoutingRepo, getRoutingBranch, getRoutingToken } from './config'

const API = 'https://api.github.com'

function utf8ToBase64(str: string): string {
  const bytes = new TextEncoder().encode(str)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

function base64ToUtf8(b64: string): string {
  const bin = atob(b64.replace(/\n/g, ''))
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

function headers(): HeadersInit {
  const token = getRoutingToken()
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

function repoBase(): string {
  const repo = getRoutingRepo()
  if (!repo) throw new Error('No routing repo configured (VITE_ROUTING_REPO).')
  return `${API}/repos/${repo}/contents`
}

interface DirEntry {
  name: string
  path: string
  type: 'file' | 'dir'
  sha: string
}

/** List a directory; returns [] if the path does not exist yet. */
export async function listDir(path: string): Promise<DirEntry[]> {
  const url = `${repoBase()}/${path}?ref=${encodeURIComponent(getRoutingBranch())}`
  const res = await fetch(url, { headers: headers() })
  if (res.status === 404) return []
  if (!res.ok) throw new Error(`GitHub listDir ${path} failed: ${res.status} ${await res.text()}`)
  const data = (await res.json()) as DirEntry[] | DirEntry
  return Array.isArray(data) ? data : [data]
}

/** Read + decode a file; null if it does not exist. */
export async function getFile(path: string): Promise<{ text: string; sha: string } | null> {
  const url = `${repoBase()}/${path}?ref=${encodeURIComponent(getRoutingBranch())}`
  const res = await fetch(url, { headers: headers() })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`GitHub getFile ${path} failed: ${res.status} ${await res.text()}`)
  const data = (await res.json()) as { content: string; sha: string }
  return { text: base64ToUtf8(data.content), sha: data.sha }
}

/** Create or update a file (idempotent on path). */
export async function putFile(path: string, text: string, message: string): Promise<void> {
  const existing = await getFile(path)
  const res = await fetch(`${repoBase()}/${path}`, {
    method: 'PUT',
    headers: { ...headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      content: utf8ToBase64(text),
      branch: getRoutingBranch(),
      ...(existing ? { sha: existing.sha } : {}),
    }),
  })
  if (!res.ok) throw new Error(`GitHub putFile ${path} failed: ${res.status} ${await res.text()}`)
}
