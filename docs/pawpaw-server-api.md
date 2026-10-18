# PawpawBI server API

The PawpawBI server holds accounts and hosts published reports. The app publishes a project's
report to it and later uploads fresh data. This is the contract the app is built against
(`src/pawpaw-server.ts`); `scripts/pawpaw-server-stub.mjs` implements it in memory for development
and tests. The real server isn't built yet ([TODO.md](../TODO.md)).

## Basics

- Base URL: `https://<host>/v1`. All paths below are under it.
- Requests and responses are JSON (`Content-Type: application/json`), except uploads, which are
  ZIP files (`Content-Type: application/zip`).
- Signed-in requests send `Authorization: Bearer <token>`. Tokens don't expire on their own; signing
  out revokes them.
- Errors: an HTTP status and `{ "error": { "message": "…" } }`, with a message fit to show the
  user. `401` means the token is missing or no longer valid: the app asks the user to sign in
  again. `404` is also what a report that belongs to another account returns.

## Accounts

An account is an email address with a password, or a Google or Microsoft sign-in.

| Request               | Body                  | Response                                      |
| --------------------- | --------------------- | --------------------------------------------- |
| `POST /auth/sign-up`  | `{ email, password }` | `201 { token, account }`; `409` email in use  |
| `POST /auth/sign-in`  | `{ email, password }` | `200 { token, account }`; `401` wrong details |
| `POST /auth/sign-out` |                       | `204`; the token stops working                |
| `GET /account`        |                       | `200 { account }`                             |

`account` is `{ id, email }`. Passwords are at least 8 characters (`400` otherwise).

**Google and Microsoft** (`<provider>` is `google` or `microsoft`) use the server as the OAuth
client, and a loopback redirect to the app ([RFC 8252](https://www.rfc-editor.org/rfc/rfc8252)):

1. The app listens on `http://127.0.0.1:<random port>/callback` and opens the user's browser at
   `GET /auth/<provider>/start?redirect_uri=<that address>&state=<random>`.
2. The server signs the user in with the provider, creating the account on first use, then
   redirects the browser to `redirect_uri?code=<one-time code>&state=<same state>`, or
   `?error=<message>&state=…` if it failed. `redirect_uri` must be `http://127.0.0.1:<port>/…`.
3. The app checks `state`, then `POST /auth/<provider>/token` with `{ code, redirect_uri }` and
   gets `200 { token, account }`. A code works once, for a few minutes.

## Reports

A published report is a copy of a project's report site, hosted by the server at `url`. Anyone
with the link can see it (access control comes later: row-level security in TODO.md).

| Request                  | Body                             | Response                                 |
| ------------------------ | -------------------------------- | ---------------------------------------- |
| `POST /reports`          | `{ title }`                      | `201 { report }`, nothing hosted yet     |
| `GET /reports`           |                                  | `200 { reports: [report…] }`             |
| `PUT /reports/<id>/site` | ZIP: the whole site              | `200 { report }`, replaces the site      |
| `PUT /reports/<id>/data` | ZIP: `data/<dataset>.json` files | `200 { report }`, replaces only the data |

`report` is `{ id, title, url, publishedAt, refreshedAt }`: `id` is letters, digits, `-` and `_`
(at most 64); `url` is where it's hosted (`https:`); `publishedAt` is when the site was last
uploaded and `refreshedAt` when its data was (ISO timestamps, or `null`).

The site ZIP is what Publish to a folder writes (the report folder with the menu in every page,
[report-pages.md](report-pages.md)), with paths relative to the site's root, such as
`index.html` and `pages/<guid>.html`. The server must check every path in a ZIP (no `..`, no
absolute paths) and serve the site as static files only. A data upload may only contain
`data/*.json`.
