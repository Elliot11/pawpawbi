# Connectors

Every connector in the catalog (`python/sidecar/connectors/`), how far it's been tested, and known
limitations. **Update this when you test a connector against a real account or find a problem.**
How to add one: [maintenance.md](maintenance.md).

**Status key**

| Status | Meaning |
|---|---|
| ✅ Tested | Real data loaded end to end through the runner. |
| 🟡 Partly | Some of the path verified (e.g. driver installs and attempts to connect), but no real load yet. |
| ⚪ Builds | Form and `build()` checked with dummy settings, offline. Never run against a real account. |
| ⬜ Untested | Written from the source's code; never run. |

"Extra packages" are downloaded the first time the connector is used (see
[decisions.md](decisions.md) #7). Connectors with none work offline straight away.

## Files

| Connector | ID | Extra packages | Status | Notes |
|---|---|---|---|---|
| Files on this computer | `local_files` | — | ✅ | CSV/TSV (read by DuckDB, which detects the delimiter and column types such as dates), Excel (`.xlsx`/`.xlsm`, read with openpyxl; one table per sheet; first row is the header; formulas give the value last calculated in Excel), JSON, JSON Lines, Parquet. Old `.xls` isn't supported. Whole JSON files are read into memory. |
| Folder of files | `folder` | — | ✅ | Combines matching files into one table (CSV, JSON Lines or Parquet). |
| File from a web address | `url` | — | ✅ | Format from the extension, then `Content-Type`, then the content. JSON wrappers like `{"data": [...]}` are unwrapped. Downloads the whole file into memory. |

## Cloud storage

| Connector | ID | Extra packages | Status | Notes |
|---|---|---|---|---|
| Amazon S3 | `s3` | `dlt[s3]`, `s3fs` | ⬜ | Also S3-compatible services via the custom endpoint. |
| Google Cloud Storage | `gcs` | `dlt[gs]`, `gcsfs` | ⬜ | Service account JSON key. |
| Azure Blob Storage | `azure_blob` | `dlt[az]`, `adlfs` | ⬜ | Account key or SAS token. |
| SFTP server | `sftp` | `dlt[sftp]`, `paramiko` | ⬜ | Password or private key file. |

## Databases

All but MongoDB use dlt's `sql_database` source. Connecting lists the tables, which also tests the connection.

| Connector | ID | Extra packages | Status | Notes |
|---|---|---|---|---|
| SQLite | `sqlite` | — | ✅ | Discover, load and reload (no duplicated rows) tested. |
| MySQL / MariaDB | `mysql` | `pymysql` | 🟡 | Environment creation and driver install verified; connection attempted against no server. Not run against a real database. |
| PostgreSQL | `postgres` | `psycopg2-binary` | ⬜ | |
| Microsoft SQL Server | `sqlserver` | `pymssql` | ⬜ | Uses pymssql, so no ODBC driver needed. |
| Oracle Database | `oracle` | `oracledb` | ⬜ | Thin mode: no Oracle client needed. The Database field takes the service name. |
| Snowflake | `snowflake` | `snowflake-sqlalchemy` | ⬜ | Username and password only (no key-pair or SSO yet). |
| Google BigQuery | `bigquery` | `sqlalchemy-bigquery` | ⬜ | Service account JSON key. |
| Amazon Redshift | `redshift` | `sqlalchemy-redshift`, `psycopg2-binary` | ⬜ | |
| Databricks | `databricks` | `databricks-sqlalchemy` | ⬜ | Personal access token. |
| ClickHouse | `clickhouse` | `clickhouse-connect` | ⬜ | HTTP(S) interface, default port 8443. |
| Trino / Starburst | `trino` | `trino[sqlalchemy]` | ⬜ | |
| CockroachDB | `cockroachdb` | `sqlalchemy-cockroachdb`, `psycopg2-binary` | ⬜ | |
| MongoDB | `mongodb` | `pymongo` | ⬜ | Verified source. Connection string; optional collections, limit and JSON filter. Connects when "Connect" is clicked. |

## Sales & CRM

| Connector | ID | Extra packages | Status | Notes |
|---|---|---|---|---|
| Salesforce | `salesforce` | `simple-salesforce` | ⬜ | Username, password and security token. Built against a stub only. **Sandbox orgs aren't supported** (the source only sets the sandbox domain through dlt config). Logs in when "Connect" is clicked. |
| HubSpot | `hubspot` | — | ⚪ | Private app access token. Web analytics events are left out (they need specific object IDs). |
| Pipedrive | `pipedrive` | — | ⚪ | Personal API token. Uses the v1 source, so custom field names are mapped. |

## Marketing & analytics

| Connector | ID | Extra packages | Status | Notes |
|---|---|---|---|---|
| Google Ads | `google_ads` | `google-ads`, `google-api-python-client` | ⬜ | Service account plus developer token. Builds its own `GoogleAdsClient` because the source's `get_client` breaks on Windows (temporary-file reopen). **The constructor wasn't checked against google-ads 33.0.0.** The upstream source is community-maintained and thin (e.g. campaigns only has IDs and labels). |
| Google Analytics | `google_analytics` | `google-analytics-data` + 3 more | ⬜ | Service account. Ships three default reports (traffic sources, pages, countries and devices), editable as JSON under advanced settings. |
| Facebook Ads | `facebook_ads` | `facebook-business` | ⬜ | Access token with `ads_read`. `leads` needs `leads_retrieval`. Calls the API when "Connect" is clicked. |
| Bing Webmaster Tools | `bing_webmaster` | — | ⚪ | API key and sites. Query stats only when page URLs are given. |
| Matomo | `matomo` | — | ⚪ | Reports and visits. With no start date, reports go back to 2000, which can be slow with the daily period. |

## Finance & commerce

| Connector | ID | Extra packages | Status | Notes |
|---|---|---|---|---|
| Stripe | `stripe_analytics` | `stripe` | ⬜ | Restricted read-only key recommended. Stripe keeps Events for 30 days only; `Account` only returns data for Connect platforms. |
| Shopify | `shopify_dlt` | — | ⚪ | Admin API token. **The source's default API version (2023-10) is no longer supported by Shopify**: set a newer one under advanced settings if loads fail. The REST Admin API is legacy. Partner GraphQL is left out. |

## Productivity

| Connector | ID | Extra packages | Status | Notes |
|---|---|---|---|---|
| Airtable | `airtable` | `pyairtable` | ⬜ | Personal access token. Calls the API when "Connect" is clicked. |
| Asana | `asana` | `asana` | ⬜ | Personal access token. Built against a stub only. |
| Notion | `notion` | — | ⚪ | Integration secret; pages must be shared with the integration. `notion_pages` can be slow on large workspaces. Calls the API when "Connect" is clicked. |
| Google Sheets | `google_sheets` | `google-api-python-client` | ⬜ | Service account; share the sheet with its email. Loads every tab and named range by default. |
| Jira | `jira` | — | ⚪ | Site, email and API token. Optional JQL replaces the issues table. |
| Slack | `slack` | — | ⚪ | Bot token. `access_logs` needs a paid plan. Calls the API when "Connect" is clicked. |
| Email inbox (IMAP) | `inbox` | — | ⚪ | Use an app password. Attachments table includes raw file bytes. |

## Support & HR

| Connector | ID | Extra packages | Status | Notes |
|---|---|---|---|---|
| Zendesk | `zendesk` | — | ⚪ | Agent email and API token. Talk is optional. **Zendesk Chat isn't included** (OAuth only). |
| Freshdesk | `freshdesk` | — | ⚪ | API key. Overrides the source's built-in 2022-01-01 start date so older tickets aren't dropped. |
| Personio | `personio` | — | ⬜ | Client ID and secret. Requests a token as soon as it's built, so it couldn't be checked offline. |
| Workable | `workable` | — | ⚪ | Optional job and candidate details. |

## Developer & streaming

| Connector | ID | Extra packages | Status | Notes |
|---|---|---|---|---|
| REST API | `rest_api` | — | ⬜ | Generic: base URL, endpoints, bearer / API key / basic auth. Pagination auto-detected. |
| GitHub | `github` | — | ⬜ | Token needed for issues, pull requests and private repositories. |
| Strapi | `strapi` | — | ⚪ | API token and collection names. |
| Mux | `mux` | — | ⚪ | The source loads only the first 100 assets and yesterday's views. |
| Kafka | `kafka` | `confluent-kafka` | ⬜ | Reads up to the offsets that exist when the load starts, so loads finish. |
| Amazon Kinesis | `kinesis` | `botocore` | ⚪ | Reads everything still retained when there's no start date. Upstream pagination bug with more than 1,000 shards. |

## Not included

From dlt's verified sources: `chess` and `pokemon` (demos), `scraping` (web scraping),
`unstructured_data` (AI document pipeline) and `pg_replication` (Postgres change data capture; needs
database-side setup). Zendesk Chat (OAuth only).
