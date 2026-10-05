# Browser tests for the interfaces

These tests open the desktop and web interfaces in a real (headless) Chrome
and check what a user would see: layout, menus, what is clipped or covered.
They exist because such bugs are invisible to the logic tests in `shared/`
and to the Rust and Python tests.

## Run

```bash
cd tests/ui
npm install        # once; installs playwright-core (no browser download)
npm test           # all tests
node --test desktop-header.test.mjs   # one file
```

Needs an installed Chrome or Chromium (set `CHROME_PATH` if it is not in a
usual place; without one the tests skip). The web tests also need the Python
environment in `.venv` (see the main README).

Ports used while the tests run: 5199 (desktop interface), 3000 (web app) and
8007 (backend). Stop `scripts/sandbox-web.sh` first; it uses 3000 and 8007.

## How it works

- **Desktop:** the interface from `desktop/` runs in Chrome with
  `tauri-mock.js`, an in-memory stand-in for the Rust side. This tests layout
  and wiring only. The Rust code has its own tests (`cargo test`).
- **Web:** the real backend starts on a throwaway database with a seeded test
  account (the same seeding as `scripts/sandbox-web.sh`). Nothing touches
  tracksuite.work or real data.
- `helpers.mjs` has the shared pieces: starting the servers, opening a page,
  `isFullyOnTop()` (is an element really visible, not clipped or covered) and
  `pixel()` (compare colours on screen).

## Adding a test

When a visual bug is fixed, add a test here that fails without the fix.
