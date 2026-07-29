# Claude Usage Meter

A lightweight Firefox extension that adds a responsive usage meter to the
Claude.ai message composer.

Release candidate: `0.2.0` · Latest approved build available from Firefox Add-ons

**[Install Claude Usage Meter from Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/cum-claude-usage-meter/)**

## Features

- Shows the active plan, including Free, Pro, Max, Team, Enterprise, and Education.
- Displays five-hour usage, reset timing, weekly usage, and extra usage when available.
- Estimates tokens from sent messages in the current conversation.
- Forecasts whether the current usage pace may reach the five-hour limit.
- Shows sync freshness and errors, with a manual refresh button.
- Supports long prompts and compact browser windows without covering the composer.
- Includes persistent Auto, Light, and Dark themes.
- Explains each metric when you hover over it.

Click the meter to open its detailed view. The detail panel contains the weekly
and extra-usage values, burn forecast, theme selector, and a link to Claude's
usage settings.

## Install

### Firefox Add-ons

1. Open the [official Firefox Add-ons listing](https://addons.mozilla.org/en-US/firefox/addon/cum-claude-usage-meter/).
2. Select **Add to Firefox** and approve the requested permissions.
3. Open or refresh [Claude.ai](https://claude.ai).

### Temporary development build

1. Download or clone this repository.
2. Open `about:debugging#/runtime/this-firefox` in Firefox.
3. Select **Load Temporary Add-on…**.
4. Choose this repository's `manifest.json`.
5. Open or refresh [Claude.ai](https://claude.ai).

Firefox removes manually loaded temporary builds when the browser restarts. The
version installed from Firefox Add-ons remains installed and updates normally.

## Accuracy and Privacy

All extension data stays in Firefox's local extension storage. The extension
does not send conversation or usage data to an external service.

- Usage limits come from Claude's internal website API, which is not a documented
  public API and may change.
- Token counts are local estimates for sent messages in the current chat. They do
  not represent daily usage and exclude the current draft and hidden context.
- Claude's tokenizer is not exposed, so the included `o200k_base` tokenizer is an
  approximation.
- The burn forecast needs measurable usage changes across at least ten minutes in
  the same reset window. A dash means there is not enough data. Forecasts are not
  guaranteed limit times.

## Theme Colors

Auto follows Claude's current page appearance. Usage below 50% is Low, 50–84% is
Medium, and 85% or above is High.

![Light and dark usage color swatches](docs/theme-colors.svg)

## Development

The extension uses plain JavaScript and CSS without a build step. Run its checks
from the repository root:

```bash
node --check src/background.js
node --check src/content.js
node --check src/lib/tokenizer.js
node --test tests/usage-meter.test.js
node -e "JSON.parse(require('node:fs').readFileSync('manifest.json','utf8'))"
```
