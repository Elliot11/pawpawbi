# To do

Backlog and known issues. Move items to GitHub issues once the repository has a remote.
Connector-specific limitations are in [docs/connectors.md](docs/connectors.md).

## Before the first release

- **Code signing.** Sign the app, the installer, and the bundled Python `.exe`/`.dll` files.
  Options: Azure Artifact Signing (formerly Trusted Signing) or a certificate from a CA.
  - https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options
  - Microsoft Store and Azure Artifact Signing
  - Electron Forge guide: https://www.electronforge.io/guides/code-signing/code-signing-windows
- **Decide the app's licence.** `package.json` says MIT, inherited from the template. Decide what
  PawpawBI is licensed under (or mark it proprietary) and add a `LICENSE` file.
- **Test the connectors against real accounts.** Only the file connectors and SQLite have loaded
  real data. Status is tracked in [docs/connectors.md](docs/connectors.md).
- **Test the installer** on a clean Windows machine (see the release guide in
  [docs/maintenance.md](docs/maintenance.md)).
- **Add a git remote** so CI (`.github/workflows/ci.yml`) runs.

## Features not built yet

- **Relationships between tables** (joins) on the Model data canvas, saved in
  `model/relationships.json`. The canvas has an SVG layer and column anchors ready for this.
- **Column types and descriptions** in the model (`model/tables/<table>.json`), e.g. marking a
  text column as a date.
- **Visuals** on the Build visuals canvas (currently an empty placeholder), and `report/` in
  the project file.
- **Connect the assistant to an AI model.** Replies are placeholders (`src/workflow.ts`).
- **Project thumbnails** (`thumbnail.png`) for the start screen.
- **Incremental loading**: refresh only new or changed rows instead of reloading everything.
- **A proper SQL editor** in the transform screen: syntax highlighting and autocomplete (e.g.
  CodeMirror) instead of a plain text box.

## Known issues and limitations

- **Every load is a full reload.** Large sources reload everything on each refresh.
- **Deleted tables come back** when their source is refreshed, unless they're unticked in that
  source's Edit screen.
- **Table names can clash** between sources. A load that would overwrite another source's table
  is refused, but nested child tables (`parent__child`) aren't checked before loading.
- **Large files are read into memory** by the web address connector and for JSON files.
- **The Python bundle is about 275 MB unpacked** (mostly pyarrow, DuckDB and SQLAlchemy, plus
  precompiled bytecode kept for start-up speed). Could trim Tcl/Tk, IDLE and test packages.
- **Connector environments don't lock their own dependencies.** Top-level packages are pinned and
  shared packages are constrained, but other dependencies resolve fresh at install time. Add a
  per-connector lock file.
- **Connectors needing extra packages require internet on first use**, which may not work on
  locked-down networks. Consider an offline bundle option.
- **`npm audit`** reports two critical issues in the Forge template's build dependencies. Not yet
  investigated.
- **Opening and saving large projects copies all their data** (unzip and re-zip).
