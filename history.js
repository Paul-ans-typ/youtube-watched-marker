// Shared parsing + storage helpers for the popup and the import page.

// Firefox exposes `browser`; Chrome uses `chrome`. Both return promises.
export const api = globalThis.browser ?? globalThis.chrome;

export const IDS_KEY = 'watchedIds';
export const BOUND_KEY = 'account';
export const SCOPE_KEY = 'scope';
export const REPORT_KEY = 'currentAccount';

// Matches "...watch?v=XXXXXXXXXXX" and captures the 11-char ID.
const VIDEO_ID_IN_URL = /watch\?v=([a-zA-Z0-9_-]{11})/;
const VIDEO_ID_GLOBALLY = /watch\?v=([a-zA-Z0-9_-]{11})/g;

// HTML files can be 50-200 MB. Read them in chunks instead of handing the whole
// thing to DOMParser, which would spike memory (a full DOM per file). 64 chars
// of overlap make sure a match split across two chunks is never missed.
const CHUNK_BYTES = 8 * 1024 * 1024;
const OVERLAP_CHARS = 64;

export async function readStoredIds() {
  const stored = await api.storage.local.get(IDS_KEY);
  return Array.isArray(stored[IDS_KEY]) ? stored[IDS_KEY] : [];
}

/** watch-history.json: a top-level array whose items carry a `titleUrl`. */
export async function extractIdsFromJson(file) {
  const data = JSON.parse(await file.text());
  const items = Array.isArray(data) ? data : (Array.isArray(data && data.items) ? data.items : []);
  const ids = new Set();
  for (const item of items) {
    const url = item && item.titleUrl;
    if (typeof url !== 'string') continue;
    const match = url.match(VIDEO_ID_IN_URL);
    if (match) ids.add(match[1]);
  }
  return ids;
}

/** watch-history.html: streamed in chunks and regex-matched (no DOMParser). */
export async function extractIdsFromHtml(file, onProgress) {
  const ids = new Set();
  let carry = '';
  for (let offset = 0; offset < file.size; offset += CHUNK_BYTES) {
    const chunk = await file.slice(offset, offset + CHUNK_BYTES).text();
    const text = carry + chunk;
    VIDEO_ID_GLOBALLY.lastIndex = 0;
    let match;
    while ((match = VIDEO_ID_GLOBALLY.exec(text)) !== null) ids.add(match[1]);
    carry = text.slice(-OVERLAP_CHARS);
    if (onProgress) onProgress(Math.min(offset + CHUNK_BYTES, file.size), file.size);
  }
  return ids;
}

export function extractIdsFromFile(file, onProgress) {
  return file.name.toLowerCase().endsWith('.json')
    ? extractIdsFromJson(file)
    : extractIdsFromHtml(file, onProgress);
}

/** Merge ids into storage, deduplicated. Returns counts for the UI. */
export async function mergeAndStore(incoming) {
  const existing = await readStoredIds();
  const merged = new Set(existing);
  for (const id of incoming) merged.add(id);
  const list = Array.from(merged);
  await api.storage.local.set({ [IDS_KEY]: list });
  return { found: incoming.size, added: merged.size - existing.length, total: merged.size };
}

export function accountName(account) {
  return account && account.label ? account.label : null;
}
