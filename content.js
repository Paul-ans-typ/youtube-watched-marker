'use strict';

/*
 * Content script (isolated world). Loads the imported watch history, dims and
 * badges watched thumbnails, records newly watched videos, and keeps all of it
 * scoped to the account the history was imported for.
 *
 * The signed-in account is read from the page's world through account-bridge.js.
 */

(() => {
  // Firefox exposes `browser`; Chrome uses `chrome`. Both return promises.
  const api = globalThis.browser ?? globalThis.chrome;

  const IDS_KEY = 'watchedIds';
  const BOUND_KEY = 'account';
  const SCOPE_KEY = 'scope';
  const REPORT_KEY = 'currentAccount';

  const BRIDGE_REQUEST = 'YTWM_GET_ACCOUNT';
  const BRIDGE_RESPONSE = 'YTWM_ACCOUNT';
  const POPUP_GET_ACCOUNT = 'ytwm:getAccount';

  const THUMBNAIL_SELECTOR = 'a#thumbnail[href*="/watch?v="]';
  const CARD_SELECTOR = [
    'ytd-rich-item-renderer',
    'ytd-video-renderer',
    'ytd-compact-video-renderer',
    'ytd-grid-video-renderer',
  ].join(', ');

  const DIM_CLASS = 'yt-watched-dim';
  const THUMB_CLASS = 'yt-watched-thumb';
  const BADGE_CLASS = 'yt-watched-badge';
  const MARK_ATTR = 'data-custom-watched';

  const VIDEO_ID_IN_URL = /[?&]v=([a-zA-Z0-9_-]{11})/;
  const VIDEO_ID = /^[a-zA-Z0-9_-]{11}$/;

  let watchedSet = new Set();
  let boundAccount = null;   // account the imported history belongs to
  let scope = 'single';      // 'single' | 'all'
  let currentAccount = null; // account signed in right now
  let marksEnabled = null;   // last applied marking decision

  // Coalesce bursts of mutations / navigations into one scan per frame.
  let scanScheduled = false;
  let scanEverything = false;
  const scanRoots = new Set();

  /* ---------------------------------------------------------------- marking */

  function extractVideoId(href) {
    if (!href) return null;
    const match = href.match(VIDEO_ID_IN_URL);
    return match ? match[1] : null;
  }

  function buildBadge() {
    const badge = document.createElement('span');
    badge.className = BADGE_CLASS;
    badge.textContent = 'WATCHED';
    return badge;
  }

  function markThumbnail(link) {
    // Already processed — never inject a second badge.
    if (link.getAttribute(MARK_ATTR) === 'true') return;

    const id = extractVideoId(link.getAttribute('href'));
    if (!id || !watchedSet.has(id)) return;

    const card = link.closest(CARD_SELECTOR);
    if (card) card.classList.add(DIM_CLASS);

    link.classList.add(THUMB_CLASS);
    link.appendChild(buildBadge());
    link.setAttribute(MARK_ATTR, 'true');
  }

  function scan(root) {
    if (watchedSet.size === 0 || !shouldMark()) return;
    const scopeNode = root && root.querySelectorAll ? root : document;
    for (const link of scopeNode.querySelectorAll(THUMBNAIL_SELECTOR)) {
      markThumbnail(link);
    }
  }

  function requestScan(root) {
    if (root) scanRoots.add(root);
    else scanEverything = true;
    if (scanScheduled) return;
    scanScheduled = true;
    requestAnimationFrame(runScheduledScans);
  }

  function runScheduledScans() {
    scanScheduled = false;
    if (scanEverything) {
      scanEverything = false;
      scanRoots.clear();
      scan(document);
      return;
    }
    for (const root of scanRoots) scan(root);
    scanRoots.clear();
  }

  function clearMarks() {
    for (const link of document.querySelectorAll(`[${MARK_ATTR}="true"]`)) {
      link.removeAttribute(MARK_ATTR);
      link.classList.remove(THUMB_CLASS);
      const badge = link.querySelector(`:scope > .${BADGE_CLASS}`);
      if (badge) badge.remove();
    }
    for (const card of document.querySelectorAll(`.${DIM_CLASS}`)) {
      card.classList.remove(DIM_CLASS);
    }
  }

  /* --------------------------------------------------------------- accounts */

  /**
   * Should watched videos be marked in the account that's signed in right now?
   *   - scope "all": always.
   *   - scope "single": only when it matches the imported account. If we cannot
   *     tell (nothing imported yet, or account undetectable) we mark rather
   *     than silently showing nothing.
   */
  function shouldMark() {
    if (scope === 'all') return true;
    if (!boundAccount || !boundAccount.key) return true;
    if (!currentAccount || !currentAccount.key) return true;
    return currentAccount.key === boundAccount.key;
  }

  function refreshMarks() {
    const enabled = shouldMark();
    if (enabled !== marksEnabled) {
      marksEnabled = enabled;
      clearMarks();
    }
    if (enabled) requestScan(null);
  }

  /** Ask the main-world bridge for the signed-in account. */
  function requestAccount() {
    return new Promise((resolve) => {
      const onMessage = (event) => {
        if (event.source !== window) return;
        const data = event.data;
        if (!data || data.type !== BRIDGE_RESPONSE) return;
        window.removeEventListener('message', onMessage);
        clearTimeout(timer);
        resolve(data.account || null);
      };
      const timer = setTimeout(() => {
        window.removeEventListener('message', onMessage);
        resolve(null);
      }, 1000);
      window.addEventListener('message', onMessage);
      window.postMessage({ type: BRIDGE_REQUEST }, '*');
    });
  }

  /** Cache the account for the popup, writing only when it actually changes. */
  function reportCurrentAccount(account) {
    api.storage.local
      .get(REPORT_KEY)
      .then((stored) => {
        const previous = stored[REPORT_KEY];
        if (previous && previous.key === account.key && previous.label === account.label) return;
        return api.storage.local.set({ [REPORT_KEY]: account });
      })
      .catch(() => {});
  }

  async function refreshAccount() {
    const account = await requestAccount();
    if (!account) return;
    const changed = !currentAccount || currentAccount.key !== account.key;
    currentAccount = account;
    reportCurrentAccount(account);
    if (changed) refreshMarks();
  }

  /* --------------------------------------------------------------- tracking */

  /** Record the video currently open on /watch so it is marked next time. */
  function trackCurrentVideo() {
    if (location.pathname !== '/watch') return;
    if (!shouldMark()) return;
    const id = new URLSearchParams(location.search).get('v');
    if (!id || !VIDEO_ID.test(id) || watchedSet.has(id)) return;

    watchedSet.add(id);
    api.storage.local.set({ [IDS_KEY]: Array.from(watchedSet) }).catch(() => {});
  }

  /* -------------------------------------------------------------- lifecycle */

  function applyStoredIds(ids) {
    watchedSet = new Set(Array.isArray(ids) ? ids : []);
  }

  async function onNavigate() {
    await refreshAccount();
    refreshMarks();
    trackCurrentVideo();
  }

  function startObserver() {
    new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) requestScan(node);
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  async function init() {
    const stored = await api.storage.local.get([IDS_KEY, BOUND_KEY, SCOPE_KEY]);
    applyStoredIds(stored[IDS_KEY]);
    boundAccount = stored[BOUND_KEY] || null;
    scope = stored[SCOPE_KEY] === 'all' ? 'all' : 'single';

    await refreshAccount();
    refreshMarks();
    trackCurrentVideo();

    startObserver();
    window.addEventListener('yt-navigate-finish', onNavigate);

    // The popup asks for the live account when it opens.
    api.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message && message.type === POPUP_GET_ACCOUNT) {
        requestAccount().then((account) => sendResponse({ account }));
        return true; // keep the channel open for the async reply
      }
      return undefined;
    });

    // Reflect imports / scope / binding changes made from the popup live.
    api.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes[IDS_KEY]) applyStoredIds(changes[IDS_KEY].newValue);
      if (changes[BOUND_KEY]) boundAccount = changes[BOUND_KEY].newValue || null;
      if (changes[SCOPE_KEY]) scope = changes[SCOPE_KEY].newValue === 'all' ? 'all' : 'single';
      marksEnabled = null; // force a clear + re-evaluation
      refreshMarks();
    });
  }

  init();
})();
