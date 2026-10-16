# The .pawpaw file format

**Format version:** 1
**Status:** Draft. Sections marked *provisional* describe features that aren't built yet and may change before they are.

A `.pawpaw` file is a standard ZIP archive containing one PawpawBI project: its data, its data model, its report and its assistant conversation. Everything inside is an ordinary file (JSON, JSON Lines, Parquet, PNG), so a project can be unzipped and inspected with everyday tools.

## Folder structure

```
Sales report.pawpaw            (ZIP archive)
├── mimetype                   Identifies the archive as a PawpawBI project
├── manifest.json              Project metadata and format version
├── thumbnail.png              Preview image for the start screen (optional)
│
├── sources/                   Where the data came from
│   └── <source-id>.json       One file per data source
│
├── data/                      The data itself, as Parquet
│   ├── raw/                   Exactly as loaded by dlt
│   │   ├── <table>/           One folder per table
│   │   │   └── *.parquet
│   │   └── _dlt_*/            dlt's bookkeeping (load history, pipeline state)
│   └── model/                 Tables produced by processing in pandas
│       └── <table>/
│           └── *.parquet
│
├── model/                     How the data fits together
│   ├── tables/
│   │   └── <table>.json       Column types, names and descriptions for one table
│   ├── relationships.json     How tables join to each other
│   └── transforms.json        Processing steps that build data/model/   (provisional)
│
├── report/                    What the user sees                         (provisional)
│   ├── report.json            Page order and report-wide settings
│   └── pages/
│       └── <page-id>.json     Layout and visuals for one page
│
├── assets/                    Images and other files used by the report  (optional)
│
└── chat/                      The assistant conversation
    ├── session.json           Current workflow stage
    └── messages.jsonl         Message history, one message per line
```

Only `mimetype` and `manifest.json` are required. A brand-new, empty project contains just those two files. Every folder is optional until something is put in it.

## Archive rules

These apply to the ZIP container itself.

1. **`mimetype` comes first and is uncompressed.** It must be the first entry in the archive, stored without compression, and contain exactly this text with no trailing newline:
   ```
   application/vnd.pawpawbi.project+zip
   ```
   This lets PawpawBI (and other tools) identify a project file from its first few bytes without unzipping it. EPUB and OpenDocument files use the same trick.
2. **Paths** use forward slashes, are UTF-8 and are relative to the archive root. Entries with absolute paths, drive letters, `..` segments or backslashes are invalid, and PawpawBI must refuse to open the file rather than skip them. This protects against "zip slip" attacks, where a crafted archive writes files outside the folder it's extracted into.
3. **Compression:** Parquet and PNG files are already compressed, so store them uncompressed. That makes saving faster and costs nothing in size. Compress everything else (JSON, JSONL) with Deflate.
4. **Large projects:** writers must support ZIP64 so archives and individual files can exceed 4 GB.
5. **Unknown files** are preserved. PawpawBI ignores files and folders it doesn't recognise but writes them back unchanged when saving, so newer versions can add things without older versions destroying them.
6. **No secrets.** Passwords, API keys and access tokens are never written into a `.pawpaw` file. See [Data sources](#data-sources).

## Naming rules

- **Table names** are lowercase letters, digits and underscores, starting with a letter (for example `monthly_sales`). This matches how dlt names tables, so a table's folder in `data/raw/`, its file in `model/tables/` and the name used everywhere else are identical.
- **IDs** for sources, pages and visuals are short random strings (lowercase letters and digits, e.g. `k3f9x2`), generated when the item is created and never changed. Renaming a page changes its title, not its ID, so nothing that refers to it breaks.
- **Dates and times** are ISO 8601 in UTC, e.g. `2026-10-17T09:30:00Z`.

## manifest.json

Identifies the project and the format version. Required.

```json
{
  "formatVersion": 1,
  "id": "p7d2m4q8",
  "name": "Sales report",
  "createdAt": "2026-10-17T09:30:00Z",
  "modifiedAt": "2026-10-17T11:02:41Z",
  "createdWith": "PawpawBI 1.0.0",
  "modifiedWith": "PawpawBI 1.0.0"
}
```

| Field | Required | Meaning |
|---|---|---|
| `formatVersion` | Yes | Version of this specification the file follows. See [Versioning](#versioning) |
| `id` | Yes | Permanent unique ID. Stays the same when the file is renamed, copied or moved; used to find the project's working folder |
| `name` | Yes | Display name. Defaults to the file name when the project is created; the user can change it independently |
| `createdAt`, `modifiedAt` | Yes | When the project was created and last saved |
| `createdWith`, `modifiedWith` | Yes | App name and version that created and last saved the file. Useful for diagnosing compatibility problems |

## Data sources

`sources/<source-id>.json` records where data came from, so it can be refreshed later.

```json
{
  "id": "s4h8n1",
  "type": "file",
  "name": "Monthly Sales.csv",
  "options": {
    "path": "C:/Users/Elliot/Documents/Monthly Sales.csv"
  },
  "tables": ["monthly_sales"],
  "lastLoadedAt": "2026-10-17T09:41:12Z"
}
```

| Field | Meaning |
|---|---|
| `type` | Kind of source: `file` now; database and API types (e.g. `postgres`, `salesforce`) later |
| `options` | Type-specific settings needed to reconnect: file path, host, database name, user name and so on |
| `tables` | The tables in `data/raw/` this source produced |
| `lastLoadedAt` | When the data was last loaded |

**Credentials** (passwords, API keys, tokens) are stored in the operating system's secure storage on the user's machine, via Electron's `safeStorage`, keyed by project ID and source ID. They are never in the file. When someone opens a project on another computer, the data and report work immediately; refreshing a source asks them to sign in again.

**File paths** in `options` point to the original location on the computer that loaded them. On another computer that path may not exist. The data already loaded is unaffected; only refreshing needs the user to locate the file again.

## data/

The project's data, stored as Parquet.

- **`data/raw/`** is written only by dlt. Each table is a folder of one or more Parquet files that together make up the table; readers must treat the folder as a single table and never rely on file names. The `_dlt_loads`, `_dlt_pipeline_state` and `_dlt_version` folders are dlt's own records. They include the pipeline state dlt needs for incremental loading (fetching only new rows), so they must be kept.
- **`data/model/`** is written by the pandas processing steps in `model/transforms.json`. It has the same layout as `raw/`. Everything in it can be rebuilt from `raw/` plus the transforms, so a "save without processed data" option could leave it out to make files smaller.

## model/

What the user and the assistant have worked out about the data, typically during the *Model data* step. None of this changes the data in `raw/`; it describes how to interpret it.

### model/tables/&lt;table&gt;.json

One file per table in `data/raw/` or `data/model/`. A table with no file here is used as-is.

```json
{
  "table": "monthly_sales",
  "layer": "raw",
  "displayName": "Monthly sales",
  "description": "One row per order, exported from the sales system.",
  "columns": {
    "order_date": { "type": "date", "displayName": "Order date" },
    "revenue": { "type": "currency", "currency": "AUD", "description": "Excludes GST" },
    "order_id": { "role": "key" }
  }
}
```

| Field | Meaning |
|---|---|
| `layer` | `raw` or `model`: which folder under `data/` the table is in |
| `displayName`, `description` | How the table is labelled in the app and explained to the assistant |
| `columns` | Per-column overrides, by column name. Only columns with something to say need an entry |

Column fields, all optional:
- `type`: how to interpret values, overriding what was stored. One of `text`, `integer`, `decimal`, `currency`, `percentage`, `boolean`, `date`, `datetime`.
- `role`: `key` (uniquely identifies a row), `measure` (a number to add up or average) or `dimension` (something to group by).
- `displayName`, `description`, `hidden` (`true` to keep it out of the report builder), and `format` for display (e.g. `"0.0%"`).

### model/relationships.json

How tables join. The assistant proposes these and the user confirms them.

```json
{
  "relationships": [
    {
      "id": "r2k7d9",
      "from": { "table": "monthly_sales", "column": "customer_id" },
      "to": { "table": "customers", "column": "id" },
      "cardinality": "many-to-one"
    }
  ]
}
```

`cardinality` is `one-to-one`, `many-to-one` or `many-to-many`.

### model/transforms.json (provisional)

The pandas processing steps that build `data/model/`, stored as **data, not code**: an ordered list of steps such as filter, rename, join, group and add-calculated-column, which the sidecar carries out with pandas. Storing Python code here would mean that opening a project someone sent you could run arbitrary code on your computer. If custom code is ever supported, it must require the user's explicit approval before running. The exact step definitions will be specified when processing is built.

## report/ (provisional)

The report the user builds. Outline only; to be specified alongside the report builder.

- **`report/report.json`**: page order (a list of page IDs), report title, and shared settings such as theme and default currency.
- **`report/pages/<page-id>.json`**: the page title and its visuals. Each visual has an `id`, a `type` (`bar`, `line`, `table`, `stat`…), its position and size on the canvas, and its data binding: which table it reads, which columns go on which axis, filters, and how values are aggregated (sum, average, count…). Visuals refer to tables and columns by name, never to file paths.

## chat/

The conversation with the assistant, so it can pick up where it left off.

- **`chat/session.json`** holds where the user is in the workflow:
  ```json
  { "stage": "model" }
  ```
  `stage` is `data`, `model` or `visuals`.
- **`chat/messages.jsonl`** holds one message per line, oldest first, so new messages can be appended without rewriting the whole file:
  ```json
  {"id":"m1","role":"assistant","text":"Hi! Let's build your report together…","createdAt":"2026-10-17T09:30:02Z"}
  {"id":"m2","role":"user","text":"A CSV export of monthly sales","createdAt":"2026-10-17T09:31:15Z"}
  ```
  `role` is `assistant` or `user`.

## Opening and saving

PawpawBI never edits the inside of a ZIP in place.

- **Opening:** check that the first entry is `mimetype` with the expected value, validate every path (see [Archive rules](#archive-rules)), then extract the archive into a working folder in the app's data directory, named after the project's `id` plus a short hash of the file's location (so two copies of the same project never share a folder). All work happens on those ordinary files. dlt writes to `data/raw/` there and pandas reads from it.
- **Saving:** update `modifiedAt` and `modifiedWith`, zip the working folder into a temporary file next to the destination, then replace the original with it in one step. If anything fails partway, the original file is left untouched.
- **Crash recovery:** the working folder survives a crash. When a project is opened and its working folder contains unsaved changes newer than the file, PawpawBI offers to recover them.
- **Closing:** the working folder is deleted once the project is saved or the user discards their changes.

## Versioning

`formatVersion` in `manifest.json` is a whole number that increases only for changes older versions of PawpawBI can't safely read, such as renaming a folder or changing what a field means.

- **Adding things doesn't need a new version.** New optional files, folders or JSON fields can be added at any time; older versions ignore and preserve them (archive rule 5).
- **Opening an older format:** PawpawBI upgrades it in the working folder and writes the new format the next time it's saved.
- **Opening a newer format:** PawpawBI refuses with a message asking the user to update, rather than risk damaging the file.

## Example: a small project

```
Sales report.pawpaw
├── mimetype
├── manifest.json
├── thumbnail.png
├── sources/
│   └── s4h8n1.json
├── data/
│   └── raw/
│       ├── monthly_sales/
│       │   └── 1792192294.0710592.d4920fcdde.parquet
│       ├── _dlt_loads/…
│       ├── _dlt_pipeline_state/…
│       └── _dlt_version/…
├── model/
│   └── tables/
│       └── monthly_sales.json
└── chat/
    ├── session.json
    └── messages.jsonl
```
