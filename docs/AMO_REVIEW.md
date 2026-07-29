# AMO review notes for 0.2.0

The extension's own JavaScript and CSS are shipped as readable source and have
no project build step. The runtime ZIP contains `manifest.json`, `icons/`, and
`src/`.

## Bundled third-party tokenizer

`src/lib/tokenizer.js` is based on the `dist/o200k_base.js` UMD browser bundle
from the MIT-licensed `gpt-tokenizer` package version 3.4.0. The matching
official npm source package is included with the AMO source submission as
`gpt-tokenizer-3.4.0.tgz`.

The vendored file differs from the official bundle in only two ways:

1. Its final `sourceMappingURL` comment is omitted because the map is not loaded
   by the extension.
2. A short adapter is appended to expose `encode` and `countTokens` to the
   background script as `globalThis.__gptTokenizerEncode` and
   `globalThis.__gptTokenizerCount`.

The upstream package can be rebuilt using its own `package.json` scripts. No
network requests or runtime code are loaded from npm or a CDN by the extension.

## Functional test

1. Load `manifest.json` as a temporary Firefox add-on.
2. Sign in to Claude.ai and open a chat.
3. Confirm that the meter appears near the composer.
4. Click the meter to inspect detailed usage and select a theme.
5. Hover over a value to inspect its explanation and use the refresh button to
   request a fresh usage sync.

The extension uses authenticated, same-origin GET requests to Claude.ai and
stores usage samples, theme preference, and token estimates in
`browser.storage.local`. It has no analytics or developer-operated service.
