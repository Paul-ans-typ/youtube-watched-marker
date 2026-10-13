'use strict';

/*
 * Account bridge — runs in the PAGE's "main world".
 *
 * Content scripts live in an isolated JS world and cannot see window.ytcfg,
 * which is where YouTube keeps the signed-in account identity. This tiny script
 * bridges that gap: the isolated content script asks for the account over
 * window.postMessage and this answers.
 *
 * The raw ids (DATASYNC_ID embeds a session id) are hashed before they leave
 * this world, so the page never sees anything more than it already knows.
 */

(() => {
  const REQUEST = 'YTWM_GET_ACCOUNT';
  const RESPONSE = 'YTWM_ACCOUNT';

  function get(key) {
    try {
      return window.ytcfg && typeof window.ytcfg.get === 'function'
        ? window.ytcfg.get(key)
        : undefined;
    } catch (_) {
      return undefined;
    }
  }

  /** FNV-1a — stable, collision-shy enough for comparing a handful of accounts. */
  function hash(value) {
    let h = 0x811c9dc5;
    for (let i = 0; i < value.length; i += 1) {
      h ^= value.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }

  /** Best-effort e-mail label from the identity token (fully offline). */
  function decodeEmail(token) {
    try {
      const segment = token.split('.')[1];
      if (!segment) return null;
      const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
      const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
      const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
      const payload = JSON.parse(new TextDecoder().decode(bytes));
      return typeof payload.email === 'string' ? payload.email : null;
    } catch (_) {
      return null;
    }
  }

  function readAccount() {
    const loggedIn = get('LOGGED_IN') === true;
    const dataSyncId = get('DATASYNC_ID') || null;
    const delegated = get('DELEGATED_SESSION_ID') || null;
    const userSession = get('USER_SESSION_ID') || null;
    const sessionIndex = get('SESSION_INDEX');

    if (!dataSyncId && !userSession && !delegated && !loggedIn) return null;

    // DATASYNC_ID is "<brand-page-id>||<google-account-id>" and is the most
    // reliable, page-independent identity signal.
    const rawKey =
      dataSyncId ||
      [delegated || '-', userSession || '-', sessionIndex ?? '-'].join('|');

    const channelId = get('CHANNEL_ID') || null;
    const idToken = get('ID_TOKEN');
    const email = typeof idToken === 'string' ? decodeEmail(idToken) : null;

    return {
      key: hash(rawKey),
      label:
        email ||
        channelId ||
        (sessionIndex != null ? `Account ${Number(sessionIndex) + 1}` : 'signed-in account'),
      loggedIn,
    };
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.type !== REQUEST) return;
    window.postMessage({ type: RESPONSE, account: readAccount() }, '*');
  });
})();
