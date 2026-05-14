# Claude Usage Meter

Firefox WebExtension that adds a compact Claude-style usage meter below the message composer on `claude.ai`.

It shows:

- Current 5-hour/session usage percentage and reset timing after the usage page has been opened once.
- Chat and today message counts as `chat:today`, for example `8:20`.
- Today token usage. This starts as a local estimate from sent prompts and is replaced if Claude exposes an exact token total.
- Click-through to `https://claude.ai/settings/usage`.

## Install In Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on...**.
3. Select `manifest.json` from this directory.
4. Open or refresh `https://claude.ai`.

The extension stores counts locally with `browser.storage.local`. It does not send data to any external service.

## Usage Sync Notes

Claude does not document a public browser API for usage limits. This extension uses the visible text on `https://claude.ai/settings/usage` as its source, then keeps that synced value cached locally.

If the meter says `open usage to sync`, click it once, let Claude's usage page load, then return to chat.
