# CUM - Claude Usage Meter

Firefox WebExtension that adds a compact Claude-style usage meter directly under the message composer on `claude.ai`.

<img width="780" height="203" alt="image" src="https://github.com/user-attachments/assets/5143f3d0-90b5-4ea5-ab1d-d985193a7680" /> <img width="781" height="207" alt="image" src="https://github.com/user-attachments/assets/64c446a5-8d6b-478a-82db-b726f146bd64" /><img width="774" height="199" alt="image" src="https://github.com/user-attachments/assets/f64f71c3-f05f-4b76-8c2d-dbfd872fe050" />




It shows:

- Current 5-hour/session usage percentage and reset timing after the usage page has been opened once.
- Chat and today message counts as `8 • 12`.
- Today token usage. This starts as a local estimate from sent prompts and is replaced if Claude exposes an exact token total on the usage page.
- Click-through to `https://claude.ai/settings/usage`.

## Install In Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on...**.
3. Select `manifest.json` from this directory.
4. Open or refresh `https://claude.ai`.

The extension stores counts locally with `browser.storage.local`. It does not send data to any external service.

## Usage Sync Notes

Claude does not document a public browser API for usage limits. This extension uses the visible text on `https://claude.ai/settings/usage` as its source, then keeps that synced value cached locally. It does not render fake usage percentages.

If the meter says `open usage to sync`, click it once, let Claude's usage page load, then return to chat.
