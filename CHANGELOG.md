# Changelog

## 2026-04-04

### Improved

- Added an "Error Diagnostics" panel with refresh, clear, and copy-latest actions.
- Copy payload now includes error id, module, action, stage, bookmark info, URL, and stack snippet for fast triage.
- Added popup-side error reporting for key user flows (start organize, folder load, pending load, AI search, manual classify, init).
- Added background message handlers: `getErrorDiagnostics`, `clearErrorDiagnostics`, and `reportClientError`.
- Added global background fallback capture for `unhandledrejection` and `error` events.
- Added diagnostics tracing in AI search and real-time bookmark classification flows.

## 2026-04-03

### Fixed

- Fixed false positives in full organize: bookmarks under any known category path segment are treated as already categorized.
- Fixed batch-failure reporting in full organize to show partial failures explicitly.
- Added timeout control for DeepSeek API calls to avoid long hangs on unstable networks.
- Reduced recent log loss risk by using serialized writes.

## 2026-04-02

### Fixed

- Fixed intermittent `Can't find bookmark for id.` errors in pending manual classification.
- Added backend fallback handling for stale/missing bookmark IDs after move/delete.
- Hardened manual classify `move/update` error handling to avoid raw Chrome error leakage.
- Popup now auto-removes stale pending entries and refreshes the pending list.