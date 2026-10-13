'use strict';

/*
 * Content script (isolated world). Marks watched thumbnails, shows a badge on
 * the video you are currently looking at, records a video only after it has
 * actually been playing for a while, and keeps everything scoped to the account
 * the history was imported for.
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

  // Thumbnail links, across feed, search, subscriptions, channel and sidebar
  // layouts. The `:has(img)` fallback covers any container naming we haven't
  // seen; title links never contain an image, so they are not matched.
  const THUMBNAIL_SELECTOR = [
    'a#thumbnail[href*="/watch?v="]',
    'ytd-thumbnail a[href*="/watch?v="]',
    'ytd-playlist-thumbnail a[href*="/watch?v="]',
    'a[href*="/watch?v="]:has(img)',
  ].join(', ');
  const THUMBNAIL_CONTAINER = 'ytd-thumbnail, ytd-playlist-thumbnail, .yt-lockup-view-model__content-image';
  const PLAYER_SELECTOR = '#movie_player, #shorts-player, ytd-player, #player';

  // Feed cards. Used to recognise the muted hover-preview players, which must
  // never count as "watching" a video.
  const FEED_SELECTOR = [
    'ytd-rich-item-renderer',
    'ytd-video-renderer',
    'ytd-compact-video-renderer',
    'ytd-grid-video-renderer',
    'ytd-playlist-video-renderer',
    'ytd-playlist-panel-video-renderer',
    'ytd-reel-item-renderer',
    'ytd-rich-grid-media',
    'ytd-thumbnail',
    'ytd-miniplayer',
    'ytd-reel-video-renderer',
  ].join(', ');

  const THUMB_CLASS = 'yt-watched-thumb';
  const BADGE_CLASS = 'yt-watched-badge';
  const MARK_ATTR = 'data-custom-watched';
  const INDICATOR_ID = 'yt-watched-indicator';
  const PLAYER_CLASS = 'yt-watched-player';

  const VIDEO_ID_IN_URL = /[?&]v=([a-zA-Z0-9_-]{11})/;
  const VIDEO_ID = /^[a-zA-Z0-9_-]{11}$/;
  const SHORTS_ID = /^\/shorts\/([a-zA-Z0-9_-]{11})/;

  // A video only counts as watched after this much continuous playback.
  const PLAY_THRESHOLD_MS = 5000;

  let watchedSet = new Set();
  let boundAccount = null;   // account the imported history belongs to
  let scope = 'single';      // 'single' | 'all'
  let currentAccount = null; // account signed in right now
  let marksEnabled = null;   // last applied marking decision

  let indicatorState = null; // 'watched' | 'unwatched' | null (absent)
  let indicatorHost = null;

  let playTimer = null;
  let pendingId = null;

  // Coalesce bursts of mutations / navigations into one frame of work.
  let frameScheduled = false;
  let scanEverything = false;
  const scanRoots = new Set();
  let indicatorRequested = false;

  /* ---------------------------------------------------------------- marking */

  function extractVideoId(href) {
    if (!href) return null;
    const match = href.match(VIDEO_ID_IN_URL);
    return match ? match[1] : null;
  }

  function buildBadge() {
    const badge = document.createElement('span');
    badge.className = BADGE_CLASS;
    badge.textContent = 'Watched';
    badge.setAttribute('aria-hidden', 'true');
    return badge;
  }

  function markThumbnail(link) {
    const id = extractVideoId(link.getAttribute('href'));
    if (!id || !watchedSet.has(id)) return false;

    // If we matched a title link by accident, ignore it: only image links count.
    if (!link.querySelector('img') && !link.closest(THUMBNAIL_CONTAINER)) return false;

    const container = link.closest(THUMBNAIL_CONTAINER) || link;

    // YouTube re-renders thumbnails in place, which can wipe the badge while the
    // anchor survives. Re-add it instead of trusting the marker attribute.
    if (container.querySelector(`.${BADGE_CLASS}`)) {
      link.setAttribute(MARK_ATTR, 'true');
      return false;
    }

    container.classList.add(THUMB_CLASS);
    container.appendChild(buildBadge());
    link.setAttribute(MARK_ATTR, 'true');
    return true;
  }

  function scan(root) {
    if (watchedSet.size === 0 || !shouldMark()) return;
    const scopeNode = root && root.querySelectorAll ? root : document;
    let marked = 0;
    for (const link of scopeNode.querySelectorAll(THUMBNAIL_SELECTOR)) {
      if (markThumbnail(link)) marked += 1;
    }
    if (marked > 0) console.debug(`[watched-marker] marked ${marked} thumbnail(s)`);
  }

  function clearMarks() {
    for (const badge of document.querySelectorAll(`.${BADGE_CLASS}`)) badge.remove();
    for (const el of document.querySelectorAll(`.${THUMB_CLASS}`)) el.classList.remove(THUMB_CLASS);
    for (const el of document.querySelectorAll(`[${MARK_ATTR}]`)) el.removeAttribute(MARK_ATTR);
  }

  /* ------------------------------------------- badge on the current video */

  function playerHost() {
    if (location.pathname !== '/watch' && !SHORTS_ID.test(location.pathname)) return null;
    return document.querySelector(PLAYER_SELECTOR);
  }

  function removeIndicator() {
    const el = document.getElementById(INDICATOR_ID);
    if (el) el.remove();
    for (const player of document.querySelectorAll(`.${PLAYER_CLASS}`)) {
      player.classList.remove(PLAYER_CLASS);
    }
    indicatorState = null;
    indicatorHost = null;
  }

  /** Show "Watched" / "Not watched" over the video you are looking at. */
  function updateWatchIndicator() {
    const host = playerHost();
    const id = host ? currentVideoId() : null;

    if (!id || !host || !shouldMark()) {
      if (indicatorState !== null) removeIndicator();
      return;
    }

    const watched = watchedSet.has(id);
    const next = watched ? 'watched' : 'unwatched';
    const existing = document.getElementById(INDICATOR_ID);

    if (next === indicatorState && host === indicatorHost && existing && existing.parentElement === host) {
      return;
    }

    let el = existing;
    if (!el || el.parentElement !== host) {
      if (el) el.remove();
      el = document.createElement('div');
      el.id = INDICATOR_ID;
      el.setAttribute('aria-hidden', 'true');
      host.appendChild(el);
    }

    el.className = `yt-watched-indicator ${watched ? 'is-watched' : 'is-new'}`;
    el.textContent = watched ? 'Watched' : 'Not watched';
    host.classList.toggle(PLAYER_CLASS, watched);

    indicatorState = next;
    indicatorHost = host;
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
      if (!enabled) console.debug('[watched-marker] marking disabled: signed-in account differs from the imported one');
      clearMarks();
    }
    if (enabled) requestScan(null);
    requestIndicator();
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

  /** The video ID of the page we're on, for /watch and /shorts URLs. */
  function currentVideoId() {
    const fromQuery = new URLSearchParams(location.search).get('v');
    if (fromQuery && VIDEO_ID.test(fromQuery)) return fromQuery;
    const shorts = location.pathname.match(SHORTS_ID);
    return shorts ? shorts[1] : null;
  }

  /**
   * Re-read and merge before writing, so a large import happening in another
   * page can never be clobbered by this script's in-memory set.
   */
  async function persistWatched() {
    try {
      const stored = await api.storage.local.get(IDS_KEY);
      const merged = new Set(Array.isArray(stored[IDS_KEY]) ? stored[IDS_KEY] : []);
      for (const id of watchedSet) merged.add(id);
      await api.storage.local.set({ [IDS_KEY]: Array.from(merged) });
    } catch (_) {
      // Storage may be full or unavailable; tracking is best-effort.
    }
  }

  function recordWatched(id) {
    if (!id || watchedSet.has(id) || !VIDEO_ID.test(id)) return;
    watchedSet.add(id);
    console.debug('[watched-marker] recorded', id);
    persistWatched();
    requestIndicator();
  }

  function cancelPendingPlay() {
    if (playTimer) clearTimeout(playTimer);
    playTimer = null;
    pendingId = null;
  }

  /**
   * A video counts as watched only after PLAY_THRESHOLD_MS of continuous
   * playback. Navigating to a /watch URL, or hovering a feed thumbnail whose
   * muted preview player fires `play`, does not count.
   */
  function maybeTrack(video) {
    if (!shouldMark()) return;
    const id = currentVideoId();
    if (!id || watchedSet.has(id)) return;
    if (playTimer && pendingId === id) return; // already counting this one

    cancelPendingPlay();
    pendingId = id;
    playTimer = setTimeout(() => {
      playTimer = null;
      const stillOnSameVideo = pendingId === id;
      pendingId = null;
      if (!stillOnSameVideo) return;
      if (video.paused || video.ended) return;   // paused before the threshold
      if (currentVideoId() !== id) return;       // navigated away
      recordWatched(id);
    }, PLAY_THRESHOLD_MS);
  }

  // `play`/`pause` do not bubble, so these are capture listeners.
  function onVideoPlay(event) {
    const video = event.target;
    if (!(video instanceof HTMLVideoElement)) return;
    if (video.closest(FEED_SELECTOR)) return; // hover previews / miniplayer
    maybeTrack(video);
  }

  function onVideoPause(event) {
    const video = event.target;
    if (!(video instanceof HTMLVideoElement)) return;
    if (video.closest(FEED_SELECTOR)) return;
    cancelPendingPlay();
  }

  /** Catch the case where playback already passed the threshold on load. */
  function recordIfAlreadyPlaying() {
    if (!shouldMark()) return;
    const video = document.querySelector('#movie_player video, #shorts-player video, video.html5-main-video');
    if (!video || video.paused || video.ended) return;
    if (video.currentTime < PLAY_THRESHOLD_MS / 1000) return;
    recordWatched(currentVideoId());
  }

  /* -------------------------------------------------------------- lifecycle */

  function scheduleFrame() {
    if (frameScheduled) return;
    frameScheduled = true;
    requestAnimationFrame(runFrame);
  }

  function requestScan(root) {
    if (root) scanRoots.add(root);
    else scanEverything = true;
    scheduleFrame();
  }

  function requestIndicator() {
    indicatorRequested = true;
    scheduleFrame();
  }

  function runFrame() {
    frameScheduled = false;

    if (scanEverything) {
      scanEverything = false;
      scanRoots.clear();
      scan(document);
    } else if (scanRoots.size > 0) {
      for (const root of scanRoots) scan(root);
      scanRoots.clear();
    }

    if (indicatorRequested) {
      indicatorRequested = false;
      updateWatchIndicator();
    }
  }

  function applyStoredIds(ids) {
    watchedSet = new Set(Array.isArray(ids) ? ids : []);
  }

  async function onNavigate() {
    cancelPendingPlay();
    await refreshAccount();
    refreshMarks();
    recordIfAlreadyPlaying();
  }

  function startObserver() {
    new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) requestScan(node);
        }
      }
      // The player is created asynchronously after navigation, so re-check the
      // indicator on DOM churn (updateWatchIndicator is a no-op when unchanged).
      requestIndicator();
    }).observe(document.body, { childList: true, subtree: true });
  }

  async function init() {
    const stored = await api.storage.local.get([IDS_KEY, BOUND_KEY, SCOPE_KEY]);
    applyStoredIds(stored[IDS_KEY]);
    boundAccount = stored[BOUND_KEY] || null;
    scope = stored[SCOPE_KEY] === 'all' ? 'all' : 'single';

    await refreshAccount();
    refreshMarks();
    recordIfAlreadyPlaying();

    console.info(`[watched-marker] active — ${watchedSet.size} watched id(s), scope "${scope}", marking ${shouldMark() ? 'ON' : 'OFF'}`);

    startObserver();
    document.addEventListener('play', onVideoPlay, true);
    document.addEventListener('pause', onVideoPause, true);
    window.addEventListener('yt-navigate-finish', onNavigate);

    // The popup asks for the live account when it opens.
    api.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message && message.type === POPUP_GET_ACCOUNT) {
        requestAccount().then((account) => sendResponse({ account }));
        return true; // keep the channel open for the async reply
      }
      return undefined;
    });

    // Reflect imports / scope / binding changes made elsewhere, live.
    api.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (!changes[IDS_KEY] && !changes[BOUND_KEY] && !changes[SCOPE_KEY]) return;
      if (changes[IDS_KEY]) applyStoredIds(changes[IDS_KEY].newValue);
      if (changes[BOUND_KEY]) boundAccount = changes[BOUND_KEY].newValue || null;
      if (changes[SCOPE_KEY]) scope = changes[SCOPE_KEY].newValue === 'all' ? 'all' : 'single';
      marksEnabled = null; // force a clear + re-evaluation
      refreshMarks();
    });
  }

  init();
})();
