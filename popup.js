'use strict';

/*
 * Popup: imports a Google Takeout watch history (JSON or HTML), extracts the
 * 11-character YouTube video IDs, merges them with whatever is already stored,
 * and persists the result in chrome.storage.local under "watchedIds".
 *
 * It also binds that history to the Google account signed in at import time and
 * lets the user choose whether marking applies to that account only or to every
 * account signed in to YouTube.
 */

const IDS_KEY = 'watchedIds';
const BOUND_KEY = 'account';
const SCOPE_KEY = 'scope';
const REPORT_KEY = 'currentAccount';

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
  boundLabel: document.getElementById('boundLabel'),
  currentLabel: document.getElementById('currentLabel'),
  scopeSingle: document.getElementById('scopeSingle'),
  scopeAll: document.getElementById('scopeAll'),
  file: document.getElementById('file'),
  clear: document.getElementById('clear'),
  message: document.getElementById('message'),
};

let activeAccount = null;

function setMessage(text, isError = false) {
  els.message.textContent = text;
  els.message.classList.toggle('error', isError);
}

async function getStoredIds() {
  const stored = await chrome.storage.local.get(IDS_KEY);
  return Array.isArray(stored[IDS_KEY]) ? stored[IDS_KEY] : [];
}

/**
 * The signed-in account, preferring a live read from the active YouTube tab and
 * falling back to whatever the content script last reported.
 */
async function detectActiveAccount() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id != null) {
      const response = await chrome.tabs.sendMessage(tab.id, { type: 'ytwm:getAccount' });
      if (response && response.account) return response.account;
    }
  } catch (_) {
    // No YouTube content script on this tab — fall through to storage.
  }
  const stored = await chrome.storage.local.get(REPORT_KEY);
  return stored[REPORT_KEY] || null;
}

function accountName(account) {
  return account && account.label ? account.label : null;
}

async function refresh() {
  const [ids, boundStored, scopeStored, active] = await Promise.all([
    getStoredIds(),
    chrome.storage.local.get(BOUND_KEY),
    chrome.storage.local.get(SCOPE_KEY),
    detectActiveAccount(),
  ]);

  const bound = boundStored[BOUND_KEY] || null;
  const scope = scopeStored[SCOPE_KEY] === 'all' ? 'all' : 'single';
  activeAccount = active;

  els.count.textContent = ids.length.toLocaleString();
  els.clear.disabled = ids.length === 0;

  els.boundLabel.textContent = accountName(bound) || 'not set';
  els.boundLabel.title = bound && bound.key ? `account key ${bound.key}` : '';

  const signedIn = accountName(active);
  const mismatch = Boolean(bound && active && bound.key && active.key && bound.key !== active.key);
  els.currentLabel.textContent = signedIn || 'not detected';
  els.currentLabel.classList.toggle('mismatch', mismatch);
  els.currentLabel.title = mismatch ? 'Different from the account the data belongs to' : '';

  els.scopeSingle.checked = scope === 'single';
  els.scopeAll.checked = scope === 'all';

  if (mismatch && scope === 'single') {
    setMessage('Signed in as a different account — videos are not being marked.');
  }
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

    await chrome.storage.local.set({ [IDS_KEY]: Array.from(merged) });

    // Bind the history to the account that is signed in right now.
    if (activeAccount && activeAccount.key) {
      await chrome.storage.local.set({ [BOUND_KEY]: activeAccount });
    }

    await refresh();
    const boundNote = activeAccount && activeAccount.key
      ? ` Bound to ${accountName(activeAccount)}.`
      : ' No signed-in account detected — open YouTube to bind one.';
    setMessage(
      `Found ${imported.size.toLocaleString()} IDs in file, ` +
      `${added.toLocaleString()} new. Total stored: ${merged.size.toLocaleString()}.${boundNote}`
    );
  } catch (err) {
    setMessage(`Import failed: ${err.message}`, true);
  } finally {
    els.file.disabled = false;
    els.file.value = '';
  }
}

async function onScopeChange() {
  const scope = els.scopeAll.checked ? 'all' : 'single';
  await chrome.storage.local.set({ [SCOPE_KEY]: scope });
  setMessage(
    scope === 'all'
      ? 'Marking watched videos in every signed-in account.'
      : 'Marking watched videos in the imported account only.'
  );
}

async function onClear() {
  els.clear.disabled = true;
  await chrome.storage.local.remove([IDS_KEY, BOUND_KEY]);
  await refresh();
  setMessage('Database cleared.');
}

els.file.addEventListener('change', onFileSelected);
els.clear.addEventListener('click', onClear);
els.scopeSingle.addEventListener('change', onScopeChange);
els.scopeAll.addEventListener('change', onScopeChange);
refresh();
