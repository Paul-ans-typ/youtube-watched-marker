# YouTube Watched Marker

A lightweight Manifest V3 Chromium extension that dims the videos you have
already watched on YouTube and stamps a red **WATCHED** badge on their
thumbnails.

It works entirely offline: you import your own Google Takeout watch history, and
the extension stores the video IDs locally in `chrome.storage.local`. Nothing is
sent anywhere.

## Install (unpacked)

1. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this folder.

Requires Chromium 111+ (the account detection uses a `world: "MAIN"` content
script).

## Usage

### 1. Export your watch history from Google Takeout

- Go to <https://takeout.google.com>.
- Deselect all, then select **YouTube and YouTube Music** → **history**.
- Export, download the archive, and unzip it.
- You will find `watch-history.json` **and** `watch-history.html` in
  `Takeout/YouTube and YouTube Music/history/`.

Either file works — import whichever you have.

### 2. Import it

1. **Open YouTube in a tab while signed in to the account you exported.** The
   popup binds the history to the account that is signed in.
2. Click the extension icon in the toolbar.
3. Choose `watch-history.json` (or `watch-history.html`) in the file picker.

The popup shows the account the data belongs to, the account currently signed
in, and how many watched IDs are stored.

### 3. Choose the scope

Watch history belongs to one Google account. The **Mark watched videos in**
toggle controls what happens when you have several Google accounts signed in to
YouTube at once:

- **This account only** (default) — videos are marked only while the account
  the history belongs to is signed in.
- **All signed-in accounts** — videos are marked regardless of which account
  is active (the IDs are shared across accounts).

### 4. Browse YouTube

Open YouTube and previously watched videos appear dimmed with a **WATCHED**
badge. This covers home, subscriptions, search, and channel feeds, and keeps
working as you scroll (infinite loading) and navigate between pages.

Videos you watch are recorded automatically — but only while the active account
matches the imported one (in the default scope).

**Clear database** removes the stored IDs and the account binding.

## How it works

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest. Only the `storage` permission and a `*://*.youtube.com/*` host permission. |
| `popup.html` / `popup.css` / `popup.js` | Import UI, parsing, merge, account binding, and scope toggle. |
| `account-bridge.js` | Runs in the page's **main world** to read the signed-in account from `window.ytcfg`. |
| `content.js` | Marks thumbnails and tracks new videos on YouTube. |
| `content.css` | Dimming and badge styling. |

Parsing details:

- **JSON** — reads the top-level array and extracts the ID from each item's
  `titleUrl` with `watch\?v=([a-zA-Z0-9_-]{11})`.
- **HTML** — regex-matches `watch?v=` links while reading the file in 8 MB
  chunks, so a 50–200 MB archive never materializes a full DOM (no `DOMParser`)
  and memory stays flat. A 64-character overlap between chunks prevents missing
  an ID split across a boundary.

IDs are deduplicated with a `Set`, merged with any existing IDs, and stored as an
array under the `watchedIds` key. The content script loads them into an
in-memory `Set` for O(1) lookups.

## Account detection: how and why

Content scripts run in an **isolated world** and cannot see `window.ytcfg`, which
is where YouTube keeps the signed-in identity. So `account-bridge.js` is
registered with `"world": "MAIN"` and answers a `window.postMessage` request from
`content.js`.

From `ytcfg` it reads:

- `LOGGED_IN` — whether anyone is signed in.
- `DATASYNC_ID` — `"<brand-page-id>||<google-account-id>"`, the most reliable,
  page-independent identity signal.
- `DELEGATED_SESSION_ID`, `USER_SESSION_ID`, `SESSION_INDEX` — fallbacks.
- `CHANNEL_ID` / the identity token — only used as a human-readable label.

The raw ids embed a session id, so they are **hashed (FNV-1a) inside the main
world** before being handed back; only the hash is stored and compared.

### Limitations (worth knowing)

- Account detection relies on YouTube's internal `ytcfg` object. It is not a
  public API and can change; if it breaks, marking falls back to "mark
  everything" rather than showing nothing.
- The label shown may be your e-mail (read from the identity token), your channel
  ID, or `Account N`, depending on what YouTube exposes.
- `chrome.storage.local` is shared by the whole browser profile, so the toggle —
  not the storage layer — is what keeps marking scoped to one account.
- Switching accounts reloads YouTube, and the marks update on the next scan.

## Privacy

All processing happens locally in your browser. The extension makes no network
requests and sends your watch history nowhere.

The only value passed from the page world to the extension is a hashed account
key plus a display label.

## Notes

- `chrome.storage.local` is typically capped at ~10 MB, which comfortably holds
  hundreds of thousands of IDs (each ID is 11 characters).
- Built and tested against Chromium-based browsers (Chrome, Edge, Brave).
