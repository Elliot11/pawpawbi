# Maintenance guides

Step-by-step instructions for recurring jobs. Before any of them, read [CLAUDE.md](../CLAUDE.md)
for the conventions, and finish with `npm run typecheck` and `npm test`.

**Picking versions (applies throughout).** Use an exact version that was released **at least 14
days ago**. Check the release date on npm (`npm view <pkg> time --json`) or PyPI
(`https://pypi.org/pypi/<pkg>/json`, `upload_time_iso_8601`), and that it has a Windows wheel for
CPython 3.12 (or is pure Python).

---

## Add a connector

Connectors live in `python/sidecar/connectors/`. Each is a `Connector(...)` entry describing its
form and a `build(settings)` function that returns a dlt source, a resource, or a list of resources.
Read the docstring at the top of `connectors/base.py` first.

1. **Pick the file.** Files go in `files.py`, cloud storage in `storage.py`, databases in
   `databases.py`, generic APIs in `apis.py`, and business apps in `apps/<category>.py`.
2. **Write `build(settings)`.**
   - Convert form values with the helpers in `base.py` (`required`, `text`, `integer`, `boolean`,
     `lines`, `date`, `json_object`, `gcp_service_account`).
   - Import connector-specific packages _inside_ the function.
   - Pass every argument explicitly: never rely on dlt's config or secrets files.
   - Only pass optional arguments the user filled in, so the source's defaults apply otherwise.
3. **Describe the form** with `Field(...)`s:
   - Clear labels, and `help` text saying where to find each credential.
   - `secret=True` with `type="password"` (or `textarea` for JSON keys) for anything sensitive.
   - `advanced=True` for rarely needed options.
4. **Set `packages`** to exact pins of whatever the connector needs beyond the bundled packages
   (check `python/constraints.txt` for what's already there). Leave it empty if nothing is needed.
5. **Fill in `docs_url`, `keywords` and a one-sentence `description`.**
6. **Register it** if you made a new module: add it to `connectors/__init__.py`, or to
   `connectors/apps/__init__.py` for apps.
7. **Test.**
   - `npm run test:python`: the catalog tests check that every entry is well formed.
   - Then use the connector in the app against a real account.
   - Record the result in [connectors.md](connectors.md).

For a dlt verified source that isn't vendored yet, first copy it in (see the next section), then
write its connector in `connectors/apps/`.

## Update the vendored dlt verified sources

1. Pick a commit of [dlt-hub/verified-sources](https://github.com/dlt-hub/verified-sources) that's at
   least 14 days old and compatible with our dlt version.
2. Download it as an archive (`https://codeload.github.com/dlt-hub/verified-sources/tar.gz/<sha>`)
   into a temporary folder.
3. Replace the folders in `python/sidecar/verified_sources/` with `sources/<name>/` from the
   archive. Don't edit them; adapt in `connectors/apps/` instead.
4. Update the commit and date in `python/sidecar/verified_sources/README.md`.
5. Diff each source's `__init__.py` signatures against its connector in `connectors/apps/`:
   parameters get renamed and added. Check each `requirements.txt` against the connector's
   `packages` pins.
6. Run `npm run test:python`, then try the changed connectors in the app.

## Update a bundled Python package (dlt, DuckDB, pyarrow, …)

1. Stop the app (the next step deletes `python/runtime/`).
2. Edit the pin in `python/requirements.txt`.
3. Run `npm run lock:python`. It reinstalls everything and rewrites `python/constraints.txt` with
   the new transitive versions. It only considers releases at least 14 days old
   (`--uploaded-prior-to P14D`), so the whole lock file follows the rule, not just the direct pins.
4. Review the `constraints.txt` diff for surprising jumps.
5. If you changed **dlt**, also update `DLT_VERSION` in `connectors/storage.py`, and check the
   verified sources still import (`npm run test:python`).
6. If you changed **DuckDB**, run the sandbox tests and re-read [security.md](security.md).
7. Run `npm test` and `npm start`, then commit `requirements.txt` and `constraints.txt` together.

Connector environments rebuild themselves on next use because the constraints changed.

## Update the Python runtime itself

1. Choose a [python-build-standalone release](https://github.com/astral-sh/python-build-standalone/releases)
   at least 14 days old.
2. In `scripts/setup-python.mjs`, update `RELEASE`, `PYTHON_VERSION` and the `sha256` of each
   platform's `cpython-<version>+<release>-<triple>-install_only_stripped.tar.gz` (the release's
   GitHub API lists each asset's `digest`).
3. For a new minor version (e.g. 3.13), check every package has wheels for it first.
4. Then follow "Update a bundled Python package" from step 3.

## Update npm dependencies or Electron

1. `npm outdated` to see what's behind. Choose versions at least 14 days old.
2. Install exact versions, e.g. `npm install --save-exact electron@<version>`.
3. **Electron:** read the release notes' breaking changes, especially around `safeStorage`,
   sandboxing, IPC and `webContents`. Packaging must still produce a working app.
4. Run `npm run typecheck`, `npm test`, `npm start` and `npm run package`, then try the packaged
   app (`out/PawpawBI-win32-x64/PawpawBI.exe`).
5. Check `npm audit`, but don't run `npm audit fix --force` (it can break the Forge template).

## Change the assistant

Adding a provider or a tool, and what the model is told, are in [assistant.md](assistant.md).
`docs/report-pages.md` is bundled into the app as the assistant's report guide, so changes to
it change the assistant's behaviour; `src/report-template/` is copied into every new project.

## Change the `.pawpaw` file format

1. Additive changes (new optional files, folders or fields) don't need a new format version:
   older versions ignore and preserve them.
2. Breaking changes need `FORMAT_VERSION` bumped in `src/workspace.ts`, plus code that upgrades
   older projects when they're opened.
3. Update [pawpaw-file-format.md](pawpaw-file-format.md) in the same change.

## Release a new version

Not set up end to end yet; code signing is outstanding ([TODO.md](../TODO.md)).

1. Bump `version` in `package.json`.
2. `npm ci`, `npm run typecheck`, `npm test`.
3. `npm run make`. The installer is in `out/make/squirrel.windows/x64/`.
4. Install it on a clean Windows machine or VM. Then:
   - Create a project.
   - Load a CSV.
   - Use one connector that downloads packages.
   - Run a transform.
   - Add a chart to the report page and export the report.
   - Chat once with each provider you have a key for; check `PAWPAW_*_API` has no effect in the
     packaged app.
   - Save, reopen, and check the data, report and conversation are there.
5. **Signing** (once set up): sign the app executable, the installer, and the bundled Python
   `.exe`/`.dll` files. Setup options are in
   [Electron Forge's Windows signing guide](https://www.electronforge.io/guides/code-signing/code-signing-windows)
   and [Microsoft's code-signing options](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options).
6. Check [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) still matches what's shipped (see
   below), then tag the commit (`git tag v<version>`).

## Keep the third-party notices current

When a bundled dependency is added or changed, update [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
To list the Python packages' licences:

```powershell
python\runtime\python.exe -E -s -c "import importlib.metadata as m; [print(d.metadata['Name'], d.version, d.metadata.get('License-Expression') or d.metadata.get('License','')[:40]) for d in m.distributions()]"
```

For npm, only `dependencies` (not `devDependencies`) ship, plus their own dependencies.
