'use strict';

/*
 * Popup: imports a Google Takeout watch history (JSON or HTML), extracts the
 * 11-character YouTube video IDs, merges them with whatever is already stored,
 * and persists the result in chrome.storage.local under "watchedIds".
 */

const STORAGE_KEY = 'watchedIds';

// Matches "...watch?v=XXXXXXXXXXX" and captures the 11-char ID.
const VIDEO_ID_IN_URL = /watch\?v=([a-zA-Z0-9_-]{11})/;
const VIDEO_ID_GLOBALLY = /watch\?v=([a-zA-Z0-9_-]{11})/g;

// HTML files can be 50-200 MB. We read them in chunks instead of handing the
// whole thing to DOMParser, which would spike memory (a full DOM per file).
const CHUNK_BYTES = 8 * 1024 * 1024;
// An ID needs 21 characters ("watch?v=" + 11). 64 chars of overlap makes sure
// a match split across two chunks is never missed.
const OVERLAP_CHARS = 64;

const els = {
  count: document.getElementById('count'),
  file: document.getElementById('file'),
  clear: document.getElementById('clear'),
  message: document.getElementById('message'),
};

function setMessage(text, isError = false) {
  els.message.textContent = text;
  els.message.classList.toggle('error', isError);
}

async function getStoredIds() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return Array.isArray(stored[STORAGE_KEY]) ? stored[STORAGE_KEY] : [];
}

async function refreshStatus() {
  const ids = await getStoredIds();
  els.count.textContent = ids.length.toLocaleString();
  els.clear.disabled = ids.length === 0;
}

/** Parse watch-history.json: an array whose items carry a `titleUrl`. */
async function extractIdsFromJson(file) {
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

/**
 * Parse watch-history.html by streaming the file in chunks and regex-matching
 * `watch?v=` links. No DOMParser, so memory stays flat on huge archives.
 */
async function extractIdsFromHtml(file) {
  const ids = new Set();
  let carry = '';
  for (let offset = 0; offset < file.size; offset += CHUNK_BYTES) {
    const text = carry + (await file.slice(offset, offset + CHUNK_BYTES).text());
    VIDEO_ID_GLOBALLY.lastIndex = 0;
    let match;
    while ((match = VIDEO_ID_GLOBALLY.exec(text)) !== null) ids.add(match[1]);
    carry = text.slice(-OVERLAP_CHARS);
  }
  return ids;
}

async function onFileSelected(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  els.file.disabled = true;
  setMessage(`Reading ${file.name} (${(file.size / 1048576).toFixed(1)} MB)…`);

  try {
    const imported = file.name.toLowerCase().endsWith('.json')
      ? await extractIdsFromJson(file)
      : await extractIdsFromHtml(file);

    if (imported.size === 0) {
      setMessage('No video IDs found in that file.', true);
      return;
    }

    const existing = await getStoredIds();
    const merged = new Set(existing);
    for (const id of imported) merged.add(id);
    const added = merged.size - existing.length;

    await chrome.storage.local.set({ [STORAGE_KEY]: Array.from(merged) });
    await refreshStatus();
    setMessage(
      `Found ${imported.size.toLocaleString()} IDs in file, ` +
      `${added.toLocaleString()} new. Total stored: ${merged.size.toLocaleString()}.`
    );
  } catch (err) {
    setMessage(`Import failed: ${err.message}`, true);
  } finally {
    els.file.disabled = false;
    els.file.value = '';
  }
}

async function onClear() {
  els.clear.disabled = true;
  await chrome.storage.local.remove(STORAGE_KEY);
  await refreshStatus();
  setMessage('Database cleared.');
}

els.file.addEventListener('change', onFileSelected);
els.clear.addEventListener('click', onClear);
refreshStatus();
