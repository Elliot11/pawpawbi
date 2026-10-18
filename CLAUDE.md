# PawpawBI: notes for AI coding assistants

Read [README.md](README.md) for what the app is, and [docs/architecture.md](docs/architecture.md)
before changing how processes talk to each other. These are the rules and traps that aren't
obvious from the code. Keep this file current when a convention changes.

## Environment

- Windows, PowerShell 5.1 (no `&&`, `||` or `?:` in PowerShell commands; `npm` scripts run in
  cmd.exe, where `&&` is fine). Git Bash is also available.
- **Never use the system `python`.** The machine has an unrelated Python install. Use the bundled
  one: `python/runtime/python.exe`, always with `-E -s -B` (add `-u -X utf8` when piping JSON)
  and env `RUNTIME__DLTHUB_TELEMETRY=false`. Running the sidecar directly: `cd python/sidecar`
  then `..\runtime\python.exe -E -s -B main.py`.
- PowerShell adds a UTF-8 byte-order mark when piping text into a process. The sidecar and runner
  tolerate it, but prefer Git Bash (`printf ... | ...`) when testing them by hand.
- Antivirus can briefly lock freshly written files (`EPERM` on rename/delete). Code that renames
  or deletes new files retries (`maxRetries`, `replaceFile`); keep doing that.

## Commands

- `npm run typecheck` after every TypeScript or Vue change. `npm test` for anything touching
  connectors, the runner, transforms, datasets, the archive format, the report site or
  `charts.js`, or the assistant.
- `npm start` runs the app. Renderer (Vue) changes hot-reload; **main-process changes
  (`src/*.ts`, `src/assistant/`, and anything bundled into it with `?raw`: `src/report-template/`
  and `docs/report-pages.md`) and Python sidecar changes need the app restarted**
  (stop `electron.exe` whose path contains `PawpawBI`, then `npm start`). Connector jobs run in a
  fresh Python process each time, so `runner.py` and `connectors/` changes apply immediately.
- After editing `python/requirements.txt`: `npm run lock:python` (reinstalls the runtime and
  rewrites `constraints.txt`). Stop the app first: it deletes `python/runtime/`.

## Rules

- **Pin every dependency to an exact version released at least 14 days ago** (npm, PyPI,
  connector `packages`, the Python build, the vendored sources commit). Check release dates;
  don't take "latest". Applies to version bumps too.
- **IPC:** the page reaches the main process only through `window.api` (`src/preload.ts`), whose
  types live in `src/shared/types.ts`. Adding a call means: handler in the main process, entry in
  `preload.ts`, type in `shared/types.ts`. Never enable `nodeIntegration` or turn off
  `contextIsolation`.
- **Wrap Vue state in `plain()` (`src/plain.ts`) before passing it to `window.api`.** Reactive
  proxies fail with "An object could not be cloned".
- **Show errors from `window.api` with `errorMessage()` (`src/errors.ts`)**, which strips
  Electron's "Error invoking remote method…" prefix.
- **Secrets never go in the project.** Connector fields marked `secret=True` are stored with
  `src/credentials.ts` (OS encryption), never in `sources/*.json` or anywhere in the `.pawpaw` file.
  The assistant's API keys are stored the same way by `src/assistant/settings.ts`, and the
  PawpawBI account's sign-in token by `src/account.ts`.
- **All reading of loaded data goes through `python/sidecar/engine.py`**: one locked-down,
  in-memory DuckDB over the Parquet files (table info, previews, transforms, report datasets;
  later relationships). Don't read tables any other way, and don't loosen `engine.connect()`,
  `engine.select()` (every query must be one read-only SELECT) or `engine.time_limit()`; see
  [docs/security.md](docs/security.md). The sandbox tests in `python/tests/` must keep passing.
- **pandas isn't bundled**, deliberately (decision 4 in [docs/decisions.md](docs/decisions.md)). Use DuckDB, pyarrow or plain Python instead of adding
  it back.
- **Anything read from a `.pawpaw` file is untrusted** (projects are shared). Validate IDs and
  names before using them in paths (`SAFE_ID`, `SAFE_TABLE`, `GUID` and `NAME` in
  `src/shared/ids.ts`; `engine.table_dir` on the Python side); never execute stored code, except the report in its
  sandbox.
- **The report (`report/`) is a static website** that must work hosted on its own (e.g. S3 + CDN):
  plain HTML, CSS and JavaScript, no Vue or framework, nothing loaded from outside the folder, no
  dependency on PawpawBI. Pages read data only from `data/<dataset>.json`, written by the app from
  the datasets' queries. Page IDs are GUIDs. New projects get `src/report-template/`. The chart
  library is `src/report-template/assets/charts.js`; its API is
  [docs/report-pages.md](docs/report-pages.md) (update both together) and keeps the series colour
  order and mark rules described there. Spec: [docs/pawpaw-file-format.md](docs/pawpaw-file-format.md).
  `docs/report-pages.md` is also bundled into the app as the assistant's report guide, so keep it a
  precise contract: what it says is what the model does. Existing projects keep their own copy of
  `src/report-template/`; changing the template only affects new projects.
- **The assistant** (`src/assistant/`, [docs/assistant.md](docs/assistant.md)) runs on the user's
  own Anthropic or OpenAI key, or a local Ollama model, called with plain `fetch` from the main
  process (no SDKs). Keep its conversation, tools and prompts provider-neutral (`types.ts`) and
  usable by small local models; provider specifics stay in `anthropic.ts` / `openai.ts` /
  `ollama.ts`, each tested with streams in the API's format. Keys never reach the
  renderer, logs or prompts. Tool results go to the provider: never include secrets. A tool that
  changes the project sets `change: true` (so the user is asked, by default) and makes its change
  inside `ctx.change(...)` with targets covering every file it may touch (so it can be undone).
  Anything that changes where a data source connects or what it reads sets `alwaysAsk`. The
  assistant never handles secret settings.
- **The report is untrusted HTML in the app.** It's shown only in the `sandbox="allow-scripts"`
  frame in `ReportCanvas.vue`, served by `src/report.ts` with `SITE_CSP`, with all web requests
  blocked (`lockDownNetwork`). Don't loosen any of these, and don't add web requests to the
  renderer. See [docs/security.md](docs/security.md).
- **The `.pawpaw` format is specified in [docs/pawpaw-file-format.md](docs/pawpaw-file-format.md).**
  Update the spec in the same change as the code.
- **Python stdout is a message channel.** In `main.py` and `runner.py`, log to stderr, never
  `print()` to stdout.
- **Connectors:** import connector-specific packages inside `build()`, not at module level (they're
  installed on first use). Don't edit `python/sidecar/verified_sources/` (vendored, unmodified);
  adapt in `python/sidecar/connectors/apps/` instead. How-to: [docs/maintenance.md](docs/maintenance.md).
- The user has said **don't load data into DuckDB**. DuckDB is only a query engine over Parquet
  files; data lives as Parquet in `data/raw` and `data/model`.
- Data loads are full refreshes (`write_disposition="replace"`, `refresh="drop_resources"`).
- **Background work must be tracked.** A new IPC handler that changes the open project goes
  through `tracked(label, …)` from `src/projects.ts`. A process it starts registers with
  `work.onCancel` (see `stoppable` in `data.ts`). Multi-step work calls `work.checkCancelled()`
  between steps and rethrows when stopped instead of recording an error. Otherwise saving can
  zip half-written data, and closing can delete the folder the work is writing to.
- **Two kinds of table**: loaded (with optional in-place transforms, which read original data
  only) and transformed (built by SQL from any tables). Names are unique across both. Anything
  that changes a table must trigger rebuilds of what depends on it, in order
  (`rebuildDerived` / `rebuildDownstream` in `src/data.ts`, ordering in
  `src/shared/dependencies.ts`, tested in `tests/node/`). Deleting a table others read is refused.
  Spec: [docs/pawpaw-file-format.md](docs/pawpaw-file-format.md).

## Style

- UI copy: plain English, sentence case, no jargon. Errors say what happened and what to do.
- Visual style: tokens in `src/index.css` (orange accent `--accent`, Archivo 800/900 for titles,
  Inter for text). Reuse them rather than new colours.
- Match the surrounding code's comment density and naming. Format with `npm run lint:fix`.
- Record significant design decisions in [docs/decisions.md](docs/decisions.md) and known
  limitations in [TODO.md](TODO.md) / [docs/connectors.md](docs/connectors.md).
- **Docs describe the current state only.** When something changes, edit the existing text in
  place. No change history, "originally…" or "superseded by…" notes; git has the history.
