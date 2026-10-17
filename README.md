# PawpawBI

A Windows desktop app for building business intelligence reports, with an assistant that guides
you through three steps: **add data** from files, databases and business apps; **model** it
(fix types, transform with SQL, and later define relationships); and **build visuals**.

Built with Electron, Vue and TypeScript, plus a bundled Python that does the data work with
[dlt](https://dlthub.com) (connecting to data) and DuckDB (querying it). Each project is a single `.pawpaw` file: a ZIP of
ordinary files and folders, defined in [docs/pawpaw-file-format.md](docs/pawpaw-file-format.md).

## Status

Early development. Working: projects (create, open, save, crash recovery), 47 data connectors
(the file connectors and SQLite are tested, the rest aren't yet: see
[docs/connectors.md](docs/connectors.md)), the Model data canvas with dependency lines, SQL
transforms of loaded tables, transformed tables built from other tables, refreshing
everything in dependency order, and the report: a static website of charts (bars, lines, headline
numbers, tables) that every new project starts with, fed by datasets and exportable for hosting
anywhere, e.g. S3 ([docs/report-pages.md](docs/report-pages.md)). The assistant chats with Claude or ChatGPT using your own API key, or a local model in Ollama; it
can look at everything in the project and build the report (pages, files and datasets), asking
before each change, with Undo ([docs/assistant.md](docs/assistant.md)). Not built yet: the
assistant's tools for data sources and tables, and relationships between tables. Known issues and
the backlog are in [TODO.md](TODO.md).

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

| Command                     | What it does                                                                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm start`                 | Runs the app in development mode. Edits to Vue files reload instantly; edits to `src/main.ts`, `src/projects.ts`, `src/data.ts`, etc. (the main process) need a restart. |
| `npm run typecheck`         | Type-checks all TypeScript and Vue files.                                                                                                                                |
| `npm test`                  | Runs every automated test (`test:node` then `test:python`).                                                                                                              |
| `npm run test:node`         | Tests for the TypeScript main-process code, e.g. the `.pawpaw` archive format.                                                                                           |
| `npm run test:python`       | Tests for the Python side: connectors, the job runner, SQL transforms and their security lockdown.                                                                       |
| `npm run lint` / `lint:fix` | Lints and checks formatting (oxlint and oxfmt).                                                                                                                          |
| `npm run package`           | Builds the app into `out/` without an installer.                                                                                                                         |
| `npm run make`              | Builds the Windows installer into `out/make/`.                                                                                                                           |
| `npm run setup:python`      | Downloads Python and installs `python/requirements.txt` (runs automatically before start, package and make).                                                             |
| `npm run lock:python`       | Reinstalls Python packages from scratch and rewrites `python/constraints.txt`. Run after editing `requirements.txt`.                                                     |

## Project layout

```
src/                     Electron app (TypeScript)
  main.ts                  Main process: window, app lifecycle
  projects.ts              Open, save, close, recent projects, chat files
  workspace.ts             Working folders and crash recovery
  pawpaw-archive.ts        Reading and writing .pawpaw ZIP files
  background.ts            Tracks background work so saving and closing can wait for it
  data.ts                  Data sources, connector environments, load jobs, transforms,
                           transformed tables and rebuilding them in order
  credentials.ts           Encrypted storage for data sources' passwords and API keys
  assistant/               The chat assistant: providers, tool loop, tools, instructions,
                           the change journal for Undo
  report.ts, report-site.ts  The report site: serving it, datasets, export
  report-template/         The files a new report starts with (charts.js is the chart library)
  report-templates.ts      Bundles those files into the app
  python.ts                Starts and talks to the Python sidecar
  preload.ts               The window.api bridge between the page and the main process
  workflow.ts              The workflow steps and the assistant's welcome message
  shared/                  Types and helpers used by both sides (dependencies.ts: build
                           order and circular-reference checks for transformed tables)
  App.vue, views/, components/   The UI (Vue)
  chat-format.ts, ui-signals.ts, errors.ts, plain.ts   Small renderer helpers
python/
  requirements.txt         Bundled Python packages (exact pins)
  constraints.txt          Locked versions of everything they pull in (generated)
  sidecar/                 Python code shipped with the app
    main.py                  Long-running helper: JSON requests over stdin/stdout
    runner.py                Runs one connector job in its own process
    engine.py                The locked-down DuckDB that all reading of loaded data goes through
    datasets.py              Table info and previews
    transforms.py            SQL transforms
    report_data.py           Writes the report's datasets
    connectors/              The connector catalog: forms and how each one loads data
    verified_sources/        dlt's connectors, vendored unmodified (Apache 2.0)
  tests/                   Python tests
  runtime/                 Downloaded Python (not in git)
tests/node/              TypeScript tests
scripts/                 Setup and test helper scripts
.github/workflows/       CI (type-check and tests on Windows)
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
- [docs/report-pages.md](docs/report-pages.md): writing report pages and datasets, and hosting the report.
- [docs/assistant.md](docs/assistant.md): how the chat assistant works, and how to add a provider or a tool.
- [CLAUDE.md](CLAUDE.md): conventions and gotchas, written for AI coding assistants but useful to anyone.
- [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md): licences of everything the app ships.

## Licence

`package.json` declares MIT (the project template's default). The licence isn't decided yet;
see [TODO.md](TODO.md).
