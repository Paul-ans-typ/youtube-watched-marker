'use strict';

/*
 * Content script: dims YouTube cards whose video ID appears in the imported
 * watch history, stamps a "WATCHED" badge on the thumbnail, and records the
 * video currently being watched as a single-page navigation happens.
 */

(() => {
  const STORAGE_KEY = 'watchedIds';

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

  // Coalesce bursts of mutations / navigations into one scan per frame.
  let scanScheduled = false;
  let scanEverything = false;
  const scanRoots = new Set();

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
    if (watchedSet.size === 0) return;
    const scope = root && root.querySelectorAll ? root : document;
    for (const link of scope.querySelectorAll(THUMBNAIL_SELECTOR)) {
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

  /** Record the video currently open on /watch so it is marked next time. */
  function trackCurrentVideo() {
    if (location.pathname !== '/watch') return;
    const id = new URLSearchParams(location.search).get('v');
    if (!id || !VIDEO_ID.test(id) || watchedSet.has(id)) return;

    watchedSet.add(id);
    chrome.storage.local.set({ [STORAGE_KEY]: Array.from(watchedSet) }).catch(() => {});
  }

  function applyStoredIds(ids) {
    watchedSet = new Set(Array.isArray(ids) ? ids : []);
  }

  function onNavigate() {
    requestScan(null);
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
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    applyStoredIds(stored[STORAGE_KEY]);

    scan(document);
    trackCurrentVideo();
    startObserver();
    window.addEventListener('yt-navigate-finish', onNavigate);

    // Reflect imports/clears made from the popup without a page reload.
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[STORAGE_KEY]) return;
      applyStoredIds(changes[STORAGE_KEY].newValue);
      clearMarks();
      requestScan(null);
    });
  }

  init();
})();
