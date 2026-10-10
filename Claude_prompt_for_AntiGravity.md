# Task: Build a minimal, offline-first Android PWA for personal daily-event time-stamping

## Goal
A personal app, used by one person on an Android phone (Chrome), installable to the home screen. I tap a button, and the current timestamp is stored in a local database. Later I view graphs of the data.

## Hard constraints (read first)
- **Simplicity is the top priority.** Write the shortest, simplest code that works. Before finishing each phase, re-read every file and remove anything that can be removed (dead code, unused CSS, needless abstractions, unneeded dependencies). If a file can be simpler, simplify it.
- **No backend, no accounts, no build step, no framework.** Plain HTML + CSS + vanilla JavaScript (ES modules are fine). No React/Vue/npm/bundlers.
- **Storage:** IndexedDB, directly in the browser, with a tiny wrapper (~30 lines). Call `navigator.storage.persist()` on first load so the browser doesn't evict the data.
- **Fully offline** after the first load, via a service worker that precaches all app files.
- **Hosting:** the app must be deployable as static files on GitHub Pages (HTTPS is required for PWA install). Use relative paths only, so it works from a subpath like `/myrepo/`.
- Target: Android Chrome, mobile-first, portrait, large touch targets (min 56px height).

## Files (keep it to these)
```
index.html      # UI + inline or linked CSS
app.js          # all logic
sw.js           # service worker (cache-first precache)
manifest.webmanifest
icon-192.png, icon-512.png   # simple generated icons (maskable-safe)
```
In Phase 2, vendor Chart.js locally as `chart.min.js` (a downloaded copy, NOT a CDN link, so it works offline) and add it to the service worker precache list.

## Data model
Use a **long (event-log) format**, not one column per button. This is what lets buttons be added later without changing the schema.

- Object store `buttons`: `{ id (autoincrement), label, order, archived (bool) }`
- Object store `events`: `{ id (autoincrement), buttonId, ts }`
  - `ts` = ISO 8601 string with local timezone offset (e.g. `2026-10-09T23:41:05+05:30`). Also keep an index on `buttonId` and on `ts`.

Seed `buttons` on first run with exactly these, in this order:
1. Going to bed
2. Woke up
3. Going to gym
4. Going to college
5. Returned from college

## PHASE 1: minimal working version (build and stop here)
1. Home screen: a vertical list of big full-width buttons, one per non-archived button, in order.
2. Tapping a button writes an event with the current time, then gives clear feedback: a brief toast such as "Going to gym saved, 18:32" plus `navigator.vibrate(50)` if available. Show the last-recorded time under each button label (e.g. "last: today 18:32").
3. Prevent accidental double-taps: ignore a second tap on the same button within 2 seconds.
4. An **Undo last entry** control (shown for ~10 s after a tap in the toast, and available in a small "History" screen).
5. A minimal **History** screen: a reverse-chronological list of the last 100 events (label + local date/time) with a delete icon per row.
6. **Export CSV** button: a wide-format CSV with one row per event and columns `timestamp, button`, plus a second download option that gives one column per button label (each cell holding that button's timestamps for that date, `;`-separated, one row per date). Use a Blob download.
7. PWA requirements: valid manifest (name, short_name, `display: standalone`, `start_url: "./"`, `scope: "./"`, theme/background colors, icons 192/512 incl. maskable), registered service worker, installable on Android Chrome.
8. Dark-friendly, minimal styling. No animations beyond the toast.

### Phase 1 acceptance tests (verify and report each as pass/fail)
- Lighthouse PWA audit: installable, no errors.
- Tapping a button creates exactly one event in IndexedDB, with a correct local-timezone ISO timestamp.
- Turn off the network (DevTools offline), reload: app still loads and still records events.
- Data persists after closing and reopening the browser.
- Double-tap guard works; undo removes only the most recent event.
- CSV exports open correctly with the right columns.
- Total JS (excluding vendored libs) is under ~200 lines. If it's over, simplify.

**STOP after Phase 1. Summarize what was built, list the file sizes, and wait for my confirmation before starting Phase 2.**

## PHASE 2: only after I confirm Phase 1 works

### A) Graphs
- Add a **Graphs** button on the home screen, opening a Graphs screen with a chart-type selector and a button/event selector (populated from the `buttons` store, so new buttons appear automatically) and a date-range selector (7 days / 30 days / 90 days / all).
- Use the locally vendored Chart.js. Charts: 
  1. **Time-of-day histogram** for the selected button (30-minute bins). Example: histogram of "Going to bed" times. For events that cross midnight (e.g. bed time), plot hours on an axis that starts at 18:00 so that 23:30 and 00:30 sit next to each other, not at opposite ends. Apply this shift whenever the median event time falls between 18:00 and 06:00.
  2. **Events vs date** (daily count or time-of-day scatter per date) for the selected button. Example: "Going to gym" vs date.
  3. **Sleep duration** per night, computed by pairing each "Going to bed" with the next "Woke up" event after it, plus a histogram of the durations. Ignore unpaired events, and ignore pairs more than 16 hours apart.
- Charts must be responsive, with readable axis labels on a phone and axis titles including units.

### B) Add custom buttons
- A **Manage buttons** screen: add a button (text label, e.g. "Going to groceries"), rename, reorder (up/down arrows are enough, no drag-and-drop), and **archive** (hide from home but keep historical events and graphs). Never hard-delete a button that has events.
- Reject empty or duplicate labels.
- New buttons immediately appear on the home screen and in the Graphs selectors.

### Phase 2 acceptance tests
- Adding "Going to groceries" creates a working button and it appears in the graph selector.
- Sleep-duration chart is correct on test data that includes a bed time after midnight (generate ~30 days of fake data via a hidden dev function, `seedDemoData()`, callable only from the console, and remove it or keep it under 15 lines).
- Everything still works offline, and the service worker precache list includes `chart.min.js`.
- Bump the service-worker cache version so installed copies update.

## Deliverables
1. All source files in a single folder, ready to push to GitHub Pages.
2. A short README (max 15 lines): how to deploy to GitHub Pages, how to install on Android ("Add to Home screen"), how to export data.
3. A final self-review: list what you removed or simplified, and confirm no unused code or dependencies remain.

## Things not to do
- No localStorage for the event data (IndexedDB only).
- No CDN links, analytics, or external network calls of any kind.
- No extra features beyond those listed (no notifications, auth, cloud sync, or settings pages) unless I ask.
- Don't silently change the data model. If you think a change is needed, tell me first.
````

I chose the long-format log because "one column per button" means a schema change every time you add a button (like "Going to groceries"). The wide-column view you described is still available through the second CSV export. IndexedDB keeps everything on the phone, so there's no server to host or pay for. The tradeoff is that data lives only on that device (and in your CSV exports). If you later want to sync across devices, tell me and I can write a Phase 3 prompt for that.