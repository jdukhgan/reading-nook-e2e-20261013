# Reading Nook

A personal reading shelf with fictional sample books, title/author/notes editing,
reading status, search and filters. Built with Node 24.14.0, native SQLite and
vanilla browser modules. Fonts are self-hosted under their included SIL OFL licences.
No package installation or build step is needed.

## Run

```sh
node server.mjs --host 127.0.0.1 --port 8767 --db /absolute/private/path/reading-nook.sqlite
```

Open http://127.0.0.1:8767/. The six fictional books seed only a new database;
restarts and deleting every book never reseed. SQLite is experimental in the
selected Node version and emits a startup warning. Keep the database outside
public sources and back it up with SQLite-aware tooling while running.

## Checks

```sh
npm test
npm install --no-save --package-lock=false @playwright/test
npx playwright install chromium
npx playwright test
```

API tests cover committed CRUD, restart/seed-once persistence, Unicode limits,
malformed/oversized JSON, invalid IDs, rollback on SQLite failure and public asset
boundaries. Browser checks require the optional Playwright test tooling;
it starts isolated loopback servers and temporary databases, then closes/removes
them. It never mutates retained preview data. It covers real SQLite failure/retry,
network failure, retained drafts, committed-response state, keyboard focus,
pending geometry/scroll/DOM continuity, search/filter, literal markup, load retry,
empty shelf and responsive light/dark media-query themes. Captures and traces go
under ignored `.kandev/`; they are evidence for their recorded revision and dirty
state, not independent acceptance. Browser and API HTTP checks require a worker
context permitting local sockets.

## API and ownership

`GET /api/books` returns `{books}`. `POST /api/books` returns `201 {book}`;
`PATCH /api/books/:id` returns `200 {book}`; `DELETE` returns `204`.
The shared `web/contract.js` owns input validation and error copy. The server
uses parameterized SQLite transactions. The controller updates from committed
responses before resolving component callbacks, without a follow-up refresh. Writes await the first successful shelf read, so a
delayed startup response cannot replace newly committed data.
Only production `web/` assets on an explicit allowlist are served.

The Designer foundation is cea6ef7523b44abf50cc7f4d480f72bcc1ac26ca.
`web/ui.js`, `web/styles.css`, `web/index.html`, `web/contract.js`, fonts and
`fixtures/books.json` are Designer-owned. `web/app.js`, `server.mjs` and tests
provide integration. The isolated component demo is retired after integration.

## Retaining a private preview

Use a persistent service manager to keep a preview available after terminal
sessions close. Configure an absolute checkout as its working directory, an
absolute Node executable, and a database path outside public sources. For a
systemd user service, use `Restart=on-failure`, `RestartSec=2s` and `UMask=0077`,
enable the unit, and enable user linger when appropriate.

Use the Run command above for a local preview. For an authorized private-network
preview, replace the host with the specific permitted interface address and
record the actual service, route and retained data location privately. Check
`/health` for readiness and verify access from the intended viewing browser.
Readiness from the server alone does not establish that browser's access.

Keep the service and database after delivery when retention is requested.
Publish application sources only; runtime data and private operational evidence
stay outside Git. A retained development preview is separate from a production
deployment.
