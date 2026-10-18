# PawpawBI server API

The PawpawBI server holds accounts and published reports. It never receives a report's files
itself: it hands out presigned S3 URLs, the app uploads each file straight to S3, and browsers
download them from S3. This is the contract the app is built against (`src/pawpaw-server.ts`);
`scripts/pawpaw-server-stub.mjs` implements it in memory for development and tests, standing in
for S3 as well. The real server isn't built yet ([TODO.md](../TODO.md)).

## Basics

- Base URL: `https://<host>/v1`. All paths below are under it.
- Requests and responses are JSON (`Content-Type: application/json`).
- Signed-in requests send `Authorization: Bearer <token>`. Tokens don't expire on their own;
  signing out revokes them.
- Errors: an HTTP status and `{ "error": { "message": "…" } }`, with a message fit to show the
  user. `401` means the token is missing or no longer valid: the app asks the user to sign in
  again. `404` is also what a report that belongs to another account returns.

## Accounts

Accounts are an email address and a password. (Google and Microsoft sign-in are planned:
[TODO.md](../TODO.md).)

| Request               | Body                  | Response                                      |
| --------------------- | --------------------- | --------------------------------------------- |
| `POST /auth/sign-up`  | `{ email, password }` | `201 { token, account }`; `409` email in use  |
| `POST /auth/sign-in`  | `{ email, password }` | `200 { token, account }`; `401` wrong details |
| `POST /auth/sign-out` |                       | `204`; the token stops working                |
| `GET /account`        |                       | `200 { account }`                             |

`account` is `{ id, email }`. Passwords are at least 8 characters (`400` otherwise).

## Reports

| Request                              | Who                  | Body               | Response                                      |
| ------------------------------------ | -------------------- | ------------------ | --------------------------------------------- |
| `POST /reports`                      | Signed in            | `{ title, files }` | `201 { report, version, uploads, expiresAt }` |
| `POST /reports/<id>`                 | Signed in, the owner | `{ scope, files }` | `200 { report, version, uploads, expiresAt }` |
| `POST /reports/<id>/upload_complete` | Signed in, the owner | `{ version }`      | `200 { report }`; `409` files missing         |
| `GET /reports/<id>`                  | Anyone with the ID   |                    | `200 { report, files, expiresAt }`            |

**`report`** is `{ id, title, url, publishedAt, refreshedAt }`:

- `id`: letters, digits, `-` and `_`, at most 64.
- `url`: the report's viewer page (`https:`), to share; see Viewing below.
- `publishedAt`: when the current version's site was uploaded; `refreshedAt`: when its data
  was. ISO timestamps, or `null` before the first upload completes.

**Uploading.** `POST /reports` creates a report and `POST /reports/<id>` uploads a new version
of one. Both list the files to upload, and get a presigned URL for each:

- `files`: `[{ path, contentType, size, sha256 }]`. `path` is relative to the site's root
  (`index.html`, `pages/<guid>.html`, `assets/report.css`, `data/<dataset>.json`): no `..`,
  no leading `/`, no `\`. `contentType` is the file's type. `size` is the length of the
  gzipped file in bytes and `sha256` its SHA-256, base64.
- `scope` (`POST /reports/<id>` only): `site` replaces the whole site with exactly these files;
  `data` replaces only data files (every path must be `data/<name>.json`) and keeps the rest.
  `POST /reports` is always `site`.
- `version`: the new version's ID (letters, digits, `-` and `_`), for `upload_complete`.
- `uploads`: `[{ path, url, headers }]`, one per file. The app gzips each file and sends it
  with `PUT <url>`, the gzipped bytes as the body and exactly the given `headers`:
  `Content-Type`, `Content-Encoding: gzip` and `x-amz-checksum-sha256`, which the URL is signed
  with, so S3 refuses a different file. URLs work until `expiresAt` (at least 15 minutes).

**Versions.** Each upload is a new version of the report: its file list, where `data` keeps the
current version's other files. Viewers keep getting the current version while a new one
uploads, so they never see a half-uploaded report. Once the app has uploaded every file, it
calls `POST /reports/<id>/upload_complete` with the `version`. The server checks that every new
file of that version is in S3 (with the size it was told), then makes it the report's current
version: `publishedAt` (for `site`) and `refreshedAt` are set to now, and the response's `report`
shows them. If any file is missing, it's `409` with `{ error: { message, missing: [path…] } }`
and nothing changes; the app uploads those files again and calls it again. Completing a version
older than the current one is refused (`409`). The server deletes files the current version no
longer uses some time after it becomes current, and abandons a version that's never completed.

**Where files are stored.** Each file is an S3 object named after its path with the version it
was uploaded in added to the file name, before the extension:
`reports/<report id>/<folder>/<name>.<version>.<extension>`, such as
`reports/k3J9xQ2mT/pages/3f2b8c1e-….Xa81Qz.html` or `reports/k3J9xQ2mT/data/sales.Xa81Qz.json`
(a name without an extension just gets `.<version>`). The upload and download URLs point at
these objects. So a new version never overwrites a file the current one is using, an object
never changes once uploaded (it can be cached for good), and the files a `data` version keeps
keep the names they were uploaded with. Pages still link to each other by their plain paths
(`../data/sales.json`); the viewer maps those to the versioned objects.

**Downloading.** `GET /reports/<id>` returns the current version: `files` is
`[{ path, url }]`, a presigned S3 `GET` URL per file, valid until `expiresAt`. The files are
stored gzipped with `Content-Encoding: gzip`, so browsers unzip them as they download. A report
with no complete version yet returns `404`. Anyone with the ID can call it (row-level security
will narrow this: [TODO.md](../TODO.md)).

Limits (the server returns `400` past them): at most 1,000 files per version, 25 MB per
gzipped file.

## Viewing

A report's pages link to each other and to their files by relative paths
(`../assets/report.css`, `../data/sales.json`), which presigned URLs can't serve: each carries
its own signature. So `url` is a viewer page on the PawpawBI website, such as
`https://<web host>/r/<id>/`, which:

1. Registers a service worker scoped to `/r/<id>/`, and calls `GET /reports/<id>`.
2. Answers every request under `/r/<id>/<path>` from `<path>`'s presigned URL, and
   `/r/<id>/` with `index.html`. A path that isn't in `files` is a `404`.
3. Calls `GET /reports/<id>` again when the URLs are about to expire, and on each page load, so
   a refreshed report shows its new data.

The viewer only serves the report's files to the page, with a Content Security Policy like the
app's (`SITE_CSP` in `src/report.ts`): the report's own scripts run, but it can't load anything
from elsewhere.
