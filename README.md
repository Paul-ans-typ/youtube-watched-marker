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

## Usage

### 1. Export your watch history from Google Takeout

- Go to <https://takeout.google.com>.
- Deselect all, then select **YouTube and YouTube Music** → **history**.
- Export, download the archive, and unzip it.
- You will find `watch-history.json` **and** `watch-history.html` in
  `Takeout/YouTube and YouTube Music/history/`.

Either file works — import whichever you have.

### 2. Import it

1. Click the extension icon in the toolbar.
2. Choose `watch-history.json` (or `watch-history.html`) in the file picker.
3. The popup shows how many watched video IDs are stored.

### 3. Browse YouTube

Open YouTube and previously watched videos appear dimmed with a **WATCHED**
badge. This covers home, subscriptions, search, and channel feeds, and keeps
working as you scroll (infinite loading) and navigate between pages.

Videos you watch after installing are recorded automatically.

**Clear database** removes every stored ID.

## How it works

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest. Only the `storage` permission and a `*://*.youtube.com/*` host permission. |
| `popup.html` / `popup.css` / `popup.js` | Import UI, parsing, merge, and persistence. |
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

## Privacy

All processing happens locally in your browser. The extension makes no network
requests and sends your watch history nowhere.

## Notes

- `chrome.storage.local` is typically capped at ~10 MB, which comfortably holds
  hundreds of thousands of IDs (each ID is 11 characters).
- Built and tested against Chromium-based browsers (Chrome, Edge, Brave).
