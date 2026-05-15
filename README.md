# CUM - Claude Usage Meter

Firefox WebExtension that adds a compact Claude-style usage meter directly under
the message composer on `claude.ai`.

<img width="780" alt="image" src="https://github.com/user-attachments/assets/5143f3d0-90b5-4ea5-ab1d-d985193a7680" />
<img width="780" alt="image" src="https://github.com/user-attachments/assets/64c446a5-8d6b-478a-82db-b726f146bd64" />
<img width="780" alt="image" src="https://github.com/user-attachments/assets/f64f71c3-f05f-4b76-8c2d-dbfd872fe050" />

It shows:

- Current 5-hour/session usage percentage and reset timing.
- Current conversation token count and daily token total as `conversation • daily`.
- Click-through to `https://claude.ai/settings/usage`.

## How It Works

The extension runs a content script on `claude.ai` and a background script with
access to Claude's same-origin internal API.

- The content script detects the current organization and conversation ID.
- Every 15 seconds at most, it asks the background script to refresh token counts
  for the current conversation.
- The background script fetches Claude's conversation JSON, extracts message text,
  tokenizes it locally with the vendored `gpt-tokenizer` `o200k_base` encoding,
  and stores the result in `browser.storage.local`.
- Daily totals are accumulated from positive per-conversation token deltas.

No completion stream interception is used. The failed `webRequest` and injected
`fetch` interception paths have been removed.

## Install In Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on...**.
3. Select `manifest.json` from this directory.
4. Open or refresh `https://claude.ai`.

The extension stores usage and token counts locally with `browser.storage.local`.
It does not send data to any external service.

## Usage Sync Notes

Claude does not document a public browser API for usage limits. This extension
reads Claude's usage endpoint in the background, falls back to visible text on
`https://claude.ai/settings/usage`, and keeps that synced value cached locally.

If the meter says `open usage to sync`, click it once, let Claude's usage page
load, then return to chat.

Token counts are estimates. They use `gpt-tokenizer`'s `o200k_base` encoding as a
local approximation because Claude's exact tokenizer is not exposed in the page.

## Development

This extension has no bundler. The browser-ready tokenizer is vendored at
`src/lib/tokenizer.js` and loaded before `src/background.js` in `manifest.json`.

Run checks with:

```bash
node --check src/background.js
node --check src/content.js
node --check src/lib/tokenizer.js
node --test tests/usage-meter.test.js
node -e "JSON.parse(require('node:fs').readFileSync('manifest.json','utf8'))"
```
