// Import page (opened in a tab). Lives outside the browser-action popup so the
// native file picker cannot destroy it mid-import.

import {
  api,
  BOUND_KEY,
  REPORT_KEY,
  readStoredIds,
  mergeAndStore,
  extractIdsFromFile,
  accountName,
  initTheme,
} from './history.js';

const els = {
  count: document.getElementById('count'),
  boundLabel: document.getElementById('boundLabel'),
  dropzone: document.getElementById('dropzone'),
  file: document.getElementById('file'),
  progress: document.getElementById('progress'),
  progressFill: document.getElementById('progressFill'),
  progressText: document.getElementById('progressText'),
  message: document.getElementById('message'),
};

let busy = false;

function setMessage(text, isError = false) {
  els.message.textContent = text;
  els.message.classList.toggle('error', isError);
}

function showProgress(done, total) {
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  els.progress.hidden = false;
  els.progressFill.style.width = `${percent}%`;
  els.progressText.textContent = `Reading… ${percent}% (${(done / 1048576).toFixed(0)} / ${(total / 1048576).toFixed(0)} MB)`;
}

function hideProgress() {
  els.progress.hidden = true;
  els.progressFill.style.width = '0%';
}

async function refreshSummary() {
  const ids = await readStoredIds();
  els.count.textContent = ids.length.toLocaleString();
  const bound = (await api.storage.local.get(BOUND_KEY))[BOUND_KEY];
  els.boundLabel.textContent = accountName(bound) || 'not set';
}

/** Live read from a YouTube tab when possible, else the last reported account. */
async function detectAccount() {
  try {
    const tabs = await api.tabs.query({ url: '*://*.youtube.com/*' });
    for (const tab of tabs) {
      if (tab.id == null) continue;
      try {
        const response = await api.tabs.sendMessage(tab.id, { type: 'ytwm:getAccount' });
        if (response && response.account) return response.account;
      } catch (_) {
        // That tab has no content script yet — try the next one.
      }
    }
  } catch (_) {
    // URL filtering may be unavailable without granted host access.
  }
  const stored = await api.storage.local.get(REPORT_KEY);
  return stored[REPORT_KEY] || null;
}

async function importFile(file) {
  if (busy) return;
  busy = true;
  els.file.disabled = true;
  setMessage(`Reading ${file.name} (${(file.size / 1048576).toFixed(1)} MB)…`);

  try {
    const ids = await extractIdsFromFile(file, showProgress);
    hideProgress();

    if (ids.size === 0) {
      setMessage('No video IDs found in that file. Is it a Takeout watch-history file?', true);
      return;
    }

    const result = await mergeAndStore(ids);

    const account = await detectAccount();
    if (account && account.key) {
      await api.storage.local.set({ [BOUND_KEY]: account });
    }

    await refreshSummary();

    const boundNote = account && account.key
      ? ` Bound to ${accountName(account)}.`
      : ' No signed-in account detected — open YouTube and reload this page to bind one.';

    setMessage(
      `Found ${result.found.toLocaleString()} IDs in the file, ` +
      `${result.added.toLocaleString()} new. Total stored: ${result.total.toLocaleString()}.${boundNote}`
    );
  } catch (err) {
    hideProgress();
    setMessage(`Import failed: ${err.message}`, true);
  } finally {
    busy = false;
    els.file.disabled = false;
    els.file.value = '';
  }
}

els.file.addEventListener('change', (event) => {
  const file = event.target.files && event.target.files[0];
  if (file) importFile(file);
});

for (const type of ['dragenter', 'dragover']) {
  els.dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    els.dropzone.classList.add('dragover');
  });
}
for (const type of ['dragleave', 'drop']) {
  els.dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    els.dropzone.classList.remove('dragover');
  });
}
els.dropzone.addEventListener('drop', (event) => {
  const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
  if (file) importFile(file);
});

initTheme();
refreshSummary();
