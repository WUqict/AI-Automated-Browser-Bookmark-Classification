# AI MarkMaster Extension

[简体中文 README](README.md)

AI MarkMaster is a Chrome extension that organizes bookmarks with DeepSeek AI. It supports auto-categorization, low-confidence protection, historical re-organization, and semantic search.

## Highlights

- Auto-categorize newly created bookmarks.
- Low-confidence results go to `待二次判断` to avoid wrong moves.
- Fuzzy local search + AI semantic search.
- One-click re-organization for old bookmarks or specific folders.
- Domain rule learning from high-confidence results.

## Screenshots

### Usage Demo

<p align="center">
  <img src="assets/screenshots/usage-demo.gif" alt="Usage Demo 1" width="32%" />
  <img src="assets/screenshots/usage-demo-2.gif" alt="Usage Demo 2" width="32%" />
  <img src="assets/screenshots/usage-demo-3.gif" alt="Usage Demo 3" width="32%" />
</p>

> Note: Demo images are sanitized and reset to an initialized state without personal account/history data.

## Quick Start

1. Clone this repository.
2. Open Chrome and go to `chrome://extensions/`.
3. Enable Developer mode.
4. Click “Load unpacked” and select this project folder.
5. Open the extension popup and set your DeepSeek API key.

## Privacy & Permissions

- Permissions: `bookmarks`, `history`, `storage`, `notifications`.
- Network access: DeepSeek API + public page HTML signals for classification.
- API key is currently stored in `chrome.storage.sync`.
- Auto classify/reorganize sends current bookmark data and minimal page signals.
- AI search sends a local bookmark sample (up to ~1000 title+URL items).

## Development Checks

```bash
node --check background.js
node --check popup.js
node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8')); console.log('manifest ok')"
```

## Contributing

Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a PR.

## License

[MIT](LICENSE)
