# To do

Backlog and known issues. These could move to GitHub issues.
Connector-specific limitations are in [docs/connectors.md](docs/connectors.md).

## Before the first release

- **Code signing.** Sign the app, the installer, and the bundled Python `.exe`/`.dll` files.
  Options: Azure Artifact Signing (formerly Trusted Signing) or a certificate from a CA.
  - https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options
  - Microsoft Store and Azure Artifact Signing
  - Electron Forge guide: https://www.electronforge.io/guides/code-signing/code-signing-windows
- **Test the connectors against real accounts.** Only the file connectors and SQLite have loaded
  real data. Status is tracked in [docs/connectors.md](docs/connectors.md).
- **Test the installer** on a clean Windows machine (see the release guide in
  [docs/maintenance.md](docs/maintenance.md)).

## Features not built yet

- **Relationships between tables** (joins) on the Model data canvas, saved in
  `model/relationships.json`. The canvas has an SVG layer and column anchors ready for this.
- **Column types and descriptions** in the model (`model/tables/<table>.json`), e.g. marking a
  text column as a date.
- **A structured `add_chart` tool** (page, chart type, dataset, columns, title) that writes the
  chart's HTML and script itself. Needed before local models can build reports. In live tests
  ("add a bar chart of revenue by region, then a line chart of monthly revenue below it"), Claude
  Haiku 5.5 and gpt-5 both built working pages every time. qwen3 8B through Ollama didn't:
  - it wrote HTML for another chart library;
  - it edited the example code that the page template then carried in an HTML comment;
  - it invented markup and garbled the page.

- **The assistant's guides and evaluation tasks (phase 4).** Guides for adding data, modelling and
  SQL alongside the report guide, a tuned system prompt, and sample tasks run against both
  providers.
- **Put the PawpawBI server live.** The server and the report viewer are built (the PawpawServer
  project, per [docs/pawpaw-server-api.md](docs/pawpaw-server-api.md)) and pass the API checks
  locally. Left to do there: deploy the API at `api.pawpawbi.com`; give the viewer a host of its
  own (e.g. `reports.pawpawbi.com`) with the Cloudflare rewrite rule for `/r/…`; allow that host
  in the reports bucket's CORS and the API's; point the server's `WEB_ORIGIN` (report links) at
  it. Then set `SERVER_URL` in `src/account.ts` to `https://api.pawpawbi.com/v1` (empty until
  then, so packaged builds say publishing to PawpawBI isn't available; development uses
  `PAWPAW_SERVER`) and publish a real report through the app.
- **Publishing to PawpawBI, next steps:** unpublish (delete a hosted report), forgetting a
  project on Published projects, refreshing every project at once or on a schedule.
- **Google and Microsoft sign-in** for PawpawBI accounts, alongside email and password: the
  server as the OAuth client (registered with both), the app signing in through the user's
  browser with a loopback redirect (RFC 8252).
- **Publish to S3 and CloudFront** from the app. Publish to a folder writes the site for now.
- **Row-level security**: different viewers see different rows (e.g. each region manager only
  their region). The report is a static site, so anyone who can reach it can read every
  `data/*.json` file: filtering in the page's JavaScript isn't security. The approach: a copy
  per audience. A rule per dataset (a column, and which values each audience may see); Publish
  writes a copy of the site's data for each audience, filtered by those rules, and each copy sits
  behind its own access control on the host (such as CloudFront signed cookies). No server.
- **More for the report:** stacked bars, area and scatter charts, filters within a page, dark
  mode, printing a page, an editor with syntax highlighting, reordering pages, and updating a
  report's copy of `charts.js` when the app's version improves (each project keeps its own).
- **Project thumbnails** (`thumbnail.png`) for the start screen.
- **Incremental loading**: refresh only new or changed rows instead of reloading everything.
- **A proper SQL editor** in the transform screen: syntax highlighting and autocomplete (e.g.
  CodeMirror) instead of a plain text box.

## Linux compatibility

PawpawBI targets Windows. Before shipping Linux builds:

- **Refuse to save secrets without a real password store.** On Windows, `safeStorage` protects
  secrets with DPAPI (the user's Windows sign-in), and on macOS with the Keychain. On Linux, if no
  password store (GNOME Keyring/libsecret or KWallet) is found, Electron falls back to
  `basic_text`: a fixed built-in password, which is effectively plain text, and
  `isEncryptionAvailable()` doesn't catch it. In `credentials.ts`, `assistant/settings.ts` and
  `account.ts`,
  also check `safeStorage.getSelectedStorageBackend() !== 'basic_text'` before saving, and tell
  the user to set up a password store.

## Known issues and limitations

- **A changed copy of your own project can redirect a saved password.** Secrets are stored by
  project and source ID, not tied to the settings they were entered with. If someone edits a copy
  of your project (e.g. a database host) and you open it, loading that source sends your saved
  password to their host. Fix: store a hash of the connection settings with the secrets, and ask
  for the password again when they differ.
- **Undo across a load.** Loads aren't recorded, so undoing an assistant change made before a
  load (e.g. a source's settings) puts the source's file back but can leave its tables out of
  step with it until it's loaded again. Undo warns first, because the load changed that file.
- **Stop in the chat only interrupts data loads.** Other running tools (a long query, a
  rebuild after a table change) finish before the reply stops.

- **Every load is a full reload.** Large sources reload everything on each refresh.
- **Deleted tables come back** when their source is refreshed, unless they're unticked in that
  source's Edit screen.
- **Table names can clash** between sources. A load that would overwrite another source's table
  is refused, but nested child tables (`parent__child`) aren't checked before loading.
- **Large files are read into memory** by the web address connector and for JSON files.
- **The Python bundle is about 275 MB unpacked** (mostly pyarrow, DuckDB and SQLAlchemy, plus
  precompiled bytecode kept for start-up speed). Could trim Tcl/Tk, IDLE and test packages.
- **Connector environments don't lock their own dependencies.** Top-level packages are pinned,
  shared packages are constrained, and everything is limited to releases at least 14 days old,
  but other dependencies still resolve at install time. Add a per-connector lock file.
- **Every load rebuilds every transform and transformed table**, not only those affected. Fine for
  small models; rebuild only what's downstream of the loaded tables if it gets slow.
- **Connectors needing extra packages require internet on first use**, which may not work on
  locked-down networks. Consider an offline bundle option.
- **`npm audit`** reports two critical issues, both in build tools from the Forge template. What the
  app ships has none (`npm audit --omit=dev`). Not yet investigated.
- **Tables can't be renamed**, and deleting a table can't be undone. Neither can deleting a report
  page or dataset from the Build visuals screen (the assistant's deletions can be undone).
- **Datasets that use a deleted table or a changed column** fail at their next refresh (keeping
  their old data); nothing warns before the change.
- **Unsaved edits in the report's file editor are lost** if the project is closed first.
- **An exported report doesn't work opened straight from disk** (browsers block reading its data
  files from `file://`); it needs a web server or host.
- **ChatGPT (gpt-5) is slow on simple questions:** 5 to 40 seconds per reply, against 2 to 9 for
  Claude Haiku, because gpt-5 reasons before answering. Consider defaulting to a faster OpenAI
  model, or setting a lower reasoning effort.
- **The assistant names screens and buttons from its general instructions**, e.g. "add a dataset"
  rather than Build visuals → Datasets → New dataset. The phase 4 guides should give it the exact
  names.
- **The assistant doesn't show what a reply cost**, though usage is reported by the adapters.
- **Local models through Ollama are much less capable** than Claude or ChatGPT, and thinking is
  turned off for speed. The context window is fixed at 16,384 tokens, so long conversations with
  big tool results may lose earlier detail. Packaged builds use only Ollama at its default
  address (`127.0.0.1:11434`).
- **The Ollama option hasn't been tried on a computer without a capable GPU**, where replies may be
  very slow.
- **Long conversations are cut to the last 80 messages** with no summary of what came before.
- **The report sandbox has no automated test.** The frame, policy and network lockdown were
  checked by hand with a hostile page; an Electron-driven test would catch regressions.
- **The in-place transform editor lists columns as currently shown**, so for a table that already
  has a transform it shows the transformed columns, though the query reads the original ones.
- **Some files outside projects are never cleaned up**: dlt state of deleted projects, saved
  credentials and working folders of projects deleted outside the app, and connector environments
  no longer used. (Deleting a project from Edit project removes its credentials and working
  folder.)
- **Some of the main process's logic has no automated tests**: rebuild orchestration, refusing
  deletes, data sources, the recent list, publishing (`published.ts`, `account.ts`), renaming and
  deleting projects, and the assistant's `reply.ts` (approval wiring), `undo.ts` and its tools,
  which import Electron modules. Tested: the archive format, working folders and crash recovery,
  dependency ordering, background-work tracking, the report site's files and menu, the chart
  library's helpers, the PawpawBI server client against the stand-in, the assistant's tool loop,
  change journal, history, settings checks and provider adapters, and the Python side.
- **Python code isn't linted or formatted.** Add Ruff (development only) and run it from
  `npm run lint`.
- **After choosing Wait when closing during a load**, only the top bar's "Working…" shows that a
  close is pending. Show a clearer "Closing when the load finishes…" message.
- **Opening and saving large projects copies all their data** (unzip and re-zip).
