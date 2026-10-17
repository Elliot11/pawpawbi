# Security model

What PawpawBI protects, how, and what to check before changing related code. If a change touches
anything listed under "Rules" in a section below, re-read that section and run `npm test`.

## What we're defending against

1. **A malicious `.pawpaw` file.** Projects are meant to be shared, so opening one must be safe
   even if someone crafted it to attack the person opening it. The file must not be able to
   write outside its working folder, read the user's other files, reach the network, run code,
   or obtain the user's credentials.
2. **Credential leaks.** Passwords, API keys and tokens for data sources must not end up in
   project files, logs, command lines or the UI after they're saved.
3. **A compromised page.** If something injected script into the renderer (say, via a bug that
   rendered untrusted HTML), it should get as little power as possible.
4. **Tampered downloads.** The app downloads Python, Python packages and connectors; these must
   be the expected files.

Out of scope: someone who already controls the user's Windows account, and the security of the
data sources themselves.

## Opening project files

- **Paths inside the archive.** `src/pawpaw-archive.ts` refuses the whole file if any entry has an
  absolute path, a drive letter, a backslash, or a `..` segment, or would resolve outside the
  working folder ("zip slip"). yauzl also rejects most of these (`strictFileNames`); our check is a
  second layer.
- **Identifying the file.** The first entry must be `mimetype` with the exact PawpawBI value;
  anything else is rejected before extraction.
- **IDs and names used in paths.** The project ID (`manifest.json`) must be lowercase letters and
  digits only (`parseManifest`). Source IDs (`SAFE_ID`) and table names (`SAFE_TABLE`) are
  checked before any path is built from them (`data.ts`, `credentials.ts`).
- **Newer formats.** A file with a higher `formatVersion` is refused rather than half-understood.
- **Saving.** Writes go to a temporary file that then replaces the original, so a failed save
  can't corrupt the project.

**Rules:** never build a path from a value read out of a project without validating it first.
Never add a feature that executes code stored in a project; if it's ever needed, it must ask
the user first.

## SQL transforms

A project can contain SQL (`model/transforms.json`), which runs when the project is used. This is
the largest attack surface, so `python/sidecar/transforms.py` locks DuckDB down:

- **One read-only statement.** `_select()` uses DuckDB's own parser (`extract_statements`) and
  allows exactly one statement of type `SELECT`. `COPY`, `ATTACH`, `INSTALL`, `SET`, `PRAGMA`,
  `CREATE` and the rest are refused, as are multiple statements.
- **No file system beyond the project's data.** After creating one view per table, `_connect()`
  sets `allowed_directories` to the project's `data/` folder and `enable_external_access = false`.
  Functions such as `read_csv('C:/…')` and `read_text(…)` fail for any other path, and web URLs fail.
  `temp_directory` is cleared first, because DuckDB otherwise silently adds its temp folder
  (`<working dir>/.tmp`) to the allowed directories; the automated tests caught that. As a
  result, queries can't spill to disk.
- **No extensions.** Automatic installing and loading of DuckDB extensions are off.
- **Settings locked.** `lock_configuration = true`, so a query can't undo any of the above.
- **In memory only.** Each query gets a fresh in-memory DuckDB, which is closed afterwards.

These are covered by the sandbox tests in `python/tests/` (system files, other files in the
project folder, web requests, settings, `COPY`, `DROP`, `INSTALL`, multiple statements).

**Rules:** don't create the views after locking, don't widen `allowed_directories`, don't enable
extensions, and don't run user SQL through any path other than `_select()`. When upgrading DuckDB,
run the sandbox tests: setting names and behaviour can change between versions.

## Credentials

- Connector fields marked `secret=True` are split off when a source is saved (`saveSource` in
  `data.ts`) and stored encrypted with Electron's `safeStorage` (Windows DPAPI), at
  `%APPDATA%\PawpawBI\credentials\<project id>\<source id>.bin`. They're never written to
  `sources/*.json` or anywhere in the project file.
- The renderer never receives saved secrets back, only which fields have one (`savedSecrets`).
  An empty secret field in the form means "keep the saved value".
- Secrets reach a connector job only through its stdin, never its command line (which other
  processes can read).
- Opening a shared project on another computer shows the data but asks for credentials again
  before refreshing.
- If secure storage is unavailable, saving secrets fails rather than falling back to plain text.

**Rules:** never log a job's settings or include secrets in error messages. Any new secret
must be a `secret=True` field, not a regular one.

## The renderer

- Electron defaults are kept: context isolation on, Node integration off, sandboxed renderer.
- `window.api` exposes specific operations, not general ones. There is no "read any file" or
  "run any command". File paths only enter through the native file picker or a connector's
  settings, and reopening from the recent list accepts only paths already in that list.
- Links that try to open a new window are sent to the user's browser instead (`main.ts`).
- Vue templates use text interpolation, which escapes HTML. Don't use `v-html` with data from
  projects, sources or the network.
- Electron fuses (`forge.config.mts`) disable running the app as plain Node, Node options and
  inspector arguments, and enforce ASAR integrity in packaged builds.

## Downloads and dependencies

- **Python runtime:** pinned release and SHA-256 checksum per platform in
  `scripts/setup-python.mjs`. A mismatch aborts setup.
- **Python packages:** exact pins in `requirements.txt` and connector `packages`, plus
  `constraints.txt` locking every transitive version.
- **npm packages:** `package-lock.json`.
- **Policy:** every version must have been public for at least 14 days before we adopt it, so
  that compromised releases are usually caught and pulled first.
- **Vendored connectors:** copied from a pinned commit (`python/sidecar/verified_sources/README.md`)
  and not modified, so they can be diffed against upstream.
- **Telemetry:** dlt's anonymous usage telemetry is turned off (`RUNTIME__DLTHUB_TELEMETRY=false`).

**Known gap:** packages installed into connector environments are pinned at the top level, but
their own dependencies aren't locked per connector; see [TODO.md](../TODO.md).

## Releases

Not signed yet: Windows will show SmartScreen warnings. See the code-signing item in
[TODO.md](../TODO.md) and the release guide in [maintenance.md](maintenance.md). Everything
shipped, including bundled `.exe` and `.dll` files, should be signed.
