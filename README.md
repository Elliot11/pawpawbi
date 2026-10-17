# PawpawBI

A Windows desktop app for building business intelligence reports, with an assistant that guides
you through three steps: **add data** from files, databases and business apps; **model** it
(fix types, transform with SQL, and later define relationships); and **build visuals**.

Built with Electron, Vue and TypeScript, plus a bundled Python that does the data work with
[dlt](https://dlthub.com), pandas and DuckDB. Each project is a single `.pawpaw` file: a ZIP of
ordinary files and folders, defined in [docs/pawpaw-file-format.md](docs/pawpaw-file-format.md).

## Status

Early development. Working: projects (create, open, save, crash recovery), 47 data connectors
(the file connectors and SQLite are tested, the rest aren't yet: see
[docs/connectors.md](docs/connectors.md)), the Model data canvas, and SQL transforms. Not built
yet: relationships between tables, visuals, and connecting the assistant to an AI model (its
replies are placeholders). Known issues and the backlog are in [TODO.md](TODO.md).

## Getting started

Prerequisites: **Windows**, **Node.js 22** and npm. Git is recommended. You don't need Python:
the app downloads its own.

```powershell
npm install
npm start
```

The first `npm start` downloads a portable Python 3.12 (about 22 MB) into `python/runtime/` and
installs the Python packages, which takes a minute or two. Later starts skip this unless the
pinned versions change.

## Scripts

| Command | What it does |
|---|---|
| `npm start` | Runs the app in development mode. Edits to Vue files reload instantly; edits to `src/main.ts`, `src/projects.ts`, `src/data.ts`, etc. (the main process) need a restart. |
| `npm run typecheck` | Type-checks all TypeScript and Vue files. |
| `npm test` | Runs every automated test (`test:node` then `test:python`). |
| `npm run test:node` | Tests for the TypeScript main-process code, e.g. the `.pawpaw` archive format. |
| `npm run test:python` | Tests for the Python side: connectors, the job runner, SQL transforms and their security lockdown. |
| `npm run lint` / `lint:fix` | Lints and checks formatting (oxlint and oxfmt). |
| `npm run package` | Builds the app into `out/` without an installer. |
| `npm run make` | Builds the Windows installer into `out/make/`. |
| `npm run setup:python` | Downloads Python and installs `python/requirements.txt` (runs automatically before start, package and make). |
| `npm run lock:python` | Reinstalls Python packages from scratch and rewrites `python/constraints.txt`. Run after editing `requirements.txt`. |

## Project layout

```
src/                     Electron app (TypeScript)
  main.ts                  Main process: window, app lifecycle
  projects.ts              Open, save, close, crash recovery, recent projects, chat files
  pawpaw-archive.ts        Reading and writing .pawpaw ZIP files
  data.ts                  Data sources, connector environments, load jobs, transforms
  credentials.ts           Encrypted storage for passwords and API keys
  python.ts                Starts and talks to the Python sidecar
  preload.ts               The window.api bridge between the page and the main process
  shared/                  Types and helpers used by both sides
  App.vue, views/, components/   The UI (Vue)
python/
  requirements.txt         Bundled Python packages (exact pins)
  constraints.txt          Locked versions of everything they pull in (generated)
  sidecar/                 Python code shipped with the app
    main.py                  Long-running helper: JSON requests over stdin/stdout
    runner.py                Runs one connector job in its own process
    datasets.py              Reading loaded tables (pandas / pyarrow)
    transforms.py            SQL transforms (DuckDB, locked down)
    connectors/              The connector catalog: forms and how each one loads data
    verified_sources/        dlt's connectors, vendored unmodified (Apache 2.0)
  tests/                   Python tests
  runtime/                 Downloaded Python (not in git)
tests/node/              TypeScript tests
scripts/                 Setup and test helper scripts
docs/                    Documentation (see below)
assets/, public/         App icon and favicon
```

## Documentation

- [docs/architecture.md](docs/architecture.md): how the pieces fit together and how data flows.
- [docs/security.md](docs/security.md): what's protected, how, and what to check when changing it.
- [docs/decisions.md](docs/decisions.md): the major design decisions and why they were made.
- [docs/maintenance.md](docs/maintenance.md): step-by-step guides for adding connectors, updating dependencies and releasing.
- [docs/connectors.md](docs/connectors.md): every connector, whether it's been tested, and known limitations.
- [docs/pawpaw-file-format.md](docs/pawpaw-file-format.md): the `.pawpaw` project file format.
- [CLAUDE.md](CLAUDE.md): conventions and gotchas, written for AI coding assistants but useful to anyone.
- [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md): licences of everything the app ships.

## Licence

`package.json` currently declares MIT, inherited from the project template. This hasn't been
decided yet; see [TODO.md](TODO.md).
