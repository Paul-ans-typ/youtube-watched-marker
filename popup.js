// Popup: the small control panel. The actual import happens on import.html,
// opened in a tab, because a file picker closes a browser-action popup on
// Firefox/Zen (and sometimes Chrome), which would cancel the import.

import {
  api,
  IDS_KEY,
  BOUND_KEY,
  SCOPE_KEY,
  REPORT_KEY,
  readStoredIds,
  accountName,
} from './history.js';

const els = {
  count: document.getElementById('count'),
  boundLabel: document.getElementById('boundLabel'),
  currentLabel: document.getElementById('currentLabel'),
  scopeSingle: document.getElementById('scopeSingle'),
  scopeAll: document.getElementById('scopeAll'),
  openImport: document.getElementById('openImport'),
  clear: document.getElementById('clear'),
  message: document.getElementById('message'),
};

function setMessage(text, isError = false) {
  els.message.textContent = text;
  els.message.classList.toggle('error', isError);
}

/**
 * The signed-in account, preferring a live read from the active YouTube tab and
 * falling back to whatever the content script last reported.
 */
async function detectActiveAccount() {
  try {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id != null) {
      const response = await api.tabs.sendMessage(tab.id, { type: 'ytwm:getAccount' });
      if (response && response.account) return response.account;
    }
  } catch (_) {
    // No YouTube content script on this tab — fall through to storage.
  }
  const stored = await api.storage.local.get(REPORT_KEY);
  return stored[REPORT_KEY] || null;
}

async function refresh() {
  const [ids, boundStored, scopeStored, active] = await Promise.all([
    readStoredIds(),
    api.storage.local.get(BOUND_KEY),
    api.storage.local.get(SCOPE_KEY),
    detectActiveAccount(),
  ]);

  const bound = boundStored[BOUND_KEY] || null;
  const scope = scopeStored[SCOPE_KEY] === 'all' ? 'all' : 'single';

  els.count.textContent = ids.length.toLocaleString();
  els.clear.disabled = ids.length === 0;

  els.boundLabel.textContent = accountName(bound) || 'not set';
  els.boundLabel.title = bound && bound.key ? `account key ${bound.key}` : '';

  const mismatch = Boolean(bound && active && bound.key && active.key && bound.key !== active.key);
  els.currentLabel.textContent = accountName(active) || 'not detected';
  els.currentLabel.classList.toggle('mismatch', mismatch);
  els.currentLabel.title = mismatch ? 'Different from the account the data belongs to' : '';

  els.scopeSingle.checked = scope === 'single';
  els.scopeAll.checked = scope === 'all';

  setMessage(mismatch && scope === 'single'
    ? 'Signed in as a different account — videos are not being marked.'
    : '');
}

async function onScopeChange() {
  const scope = els.scopeAll.checked ? 'all' : 'single';
  await api.storage.local.set({ [SCOPE_KEY]: scope });
  setMessage(scope === 'all'
    ? 'Marking watched videos in every signed-in account.'
    : 'Marking watched videos in the imported account only.');
}

function onOpenImport() {
  api.tabs.create({ url: api.runtime.getURL('import.html') });
  window.close();
}

async function onClear() {
  els.clear.disabled = true;
  await api.storage.local.remove([IDS_KEY, BOUND_KEY]);
  await refresh();
  setMessage('Database cleared.');
}

els.openImport.addEventListener('click', onOpenImport);
els.clear.addEventListener('click', onClear);
els.scopeSingle.addEventListener('change', onScopeChange);
els.scopeAll.addEventListener('change', onScopeChange);
refresh();
