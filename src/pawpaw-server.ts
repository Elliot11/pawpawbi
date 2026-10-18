// Talking to the PawpawBI server: accounts and published reports. The server hands out presigned
// S3 URLs; report files go straight to S3, gzipped. The API is in docs/pawpaw-server-api.md.
// No Electron imports, so this is tested with plain Node against the stand-in server
// (scripts/pawpaw-server-stub.mjs, tests/node/pawpaw-server.test.ts).
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

export interface ServerAccount {
  id: string;
  email: string;
}

export interface ServerReport {
  id: string;
  title: string;
  url: string;
  publishedAt: string | null;
  refreshedAt: string | null;
}

/** A file to upload, as the server is told about it. */
export interface UploadFile {
  path: string;
  contentType: string;
  /** Bytes, gzipped. */
  size: number;
  /** SHA-256 of the gzipped bytes, base64. */
  sha256: string;
}

/** Where to PUT one file, and the headers the URL is signed with. */
export interface Upload {
  path: string;
  url: string;
  headers: Record<string, string>;
}

/** A report's current files: a presigned download URL for each. */
export interface ReportFiles {
  report: ServerReport;
  files: { path: string; url: string }[];
  expiresAt: string;
}

/** A report ID from the server, safe to put in a URL path. */
export const REPORT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The server said the token is missing or no longer valid: sign in again. */
/** upload_complete found files of the version missing from S3: upload them again. */
export class MissingFilesError extends Error {
  readonly missing: string[];

  constructor(message: string, missing: string[]) {
    super(message);
    this.name = 'MissingFilesError';
    this.missing = missing;
  }
}

export class SignedOutError extends Error {
  constructor(message = 'Sign in to PawpawBI again.') {
    super(message);
    this.name = 'SignedOutError';
  }
}

/** A web address the app may open, show or send to: https, or loopback (the stand-in). */
export function isReportUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' ||
      (url.protocol === 'http:' &&
        (url.hostname === '127.0.0.1' || url.hostname === 'localhost'))
    );
  } catch {
    return false;
  }
}

/** A site file ready to upload: what the server is told, and the gzipped body to PUT. */
export function packFile(
  path: string,
  contents: Uint8Array,
  contentType: string,
): { file: UploadFile; body: Buffer } {
  const body = gzipSync(contents);
  return {
    file: {
      path,
      contentType,
      size: body.length,
      sha256: createHash('sha256').update(body).digest('base64'),
    },
    body,
  };
}

const bad = (what: string) =>
  new Error(`PawpawBI sent ${what} the app doesn’t understand.`);

function cleanAccount(value: unknown): ServerAccount {
  const a = value as Partial<ServerAccount> | null;
  if (typeof a?.id !== 'string' || typeof a?.email !== 'string') {
    throw bad('an account');
  }
  return { id: a.id, email: a.email };
}

function cleanReport(value: unknown): ServerReport {
  const r = value as Partial<ServerReport> | null;
  if (!REPORT_ID.test(String(r?.id ?? '')) || !isReportUrl(r?.url)) {
    throw bad('a report');
  }
  const time = (t: unknown) => (typeof t === 'string' ? t : null);
  return {
    id: String(r!.id),
    title: String(r!.title ?? ''),
    url: r!.url!,
    publishedAt: time(r!.publishedAt),
    refreshedAt: time(r!.refreshedAt),
  };
}

/** The uploads for `files`: one each, to an https URL, with only string headers. */
function cleanUploads(value: unknown, files: UploadFile[]): Upload[] {
  const uploads = Array.isArray(value) ? value : [];
  return files.map((file) => {
    const u = uploads.find((x) => x?.path === file.path);
    if (!u || !isReportUrl(u.url)) throw bad('an upload');
    const headers = Object.fromEntries(
      Object.entries((u.headers ?? {}) as Record<string, unknown>).filter(
        (h): h is [string, string] => typeof h[1] === 'string',
      ),
    );
    return { path: file.path, url: u.url, headers };
  });
}

export function pawpawServer(
  baseUrl: string,
  token: string | null = null,
  fetchImpl: typeof fetch = fetch,
) {
  const base = baseUrl.replace(/\/+$/, '');

  async function call(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Record<string, unknown> | null> {
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error(
        'Couldn’t reach PawpawBI. Check your internet connection and try again.',
      );
    }
    if (response.status === 204) return null;
    let json: Record<string, unknown> | null = null;
    try {
      json = await response.json();
    } catch {
      // Not JSON: described by the status below.
    }
    if (!response.ok) {
      const message = (json?.error as { message?: unknown } | undefined)
        ?.message;
      const text =
        typeof message === 'string' && message
          ? message
          : `PawpawBI had a problem (${response.status}). Try again in a moment.`;
      if (response.status === 401) throw new SignedOutError(text);
      const missing = (json?.error as { missing?: unknown } | undefined)
        ?.missing;
      if (response.status === 409 && Array.isArray(missing)) {
        throw new MissingFilesError(
          text,
          missing.filter((m): m is string => typeof m === 'string'),
        );
      }
      throw new Error(text);
    }
    return json;
  }

  const signedIn = async (request: Promise<Record<string, unknown> | null>) => {
    const body = await request;
    if (typeof body?.token !== 'string' || !body.token) {
      throw new Error('PawpawBI didn’t send a sign-in token.');
    }
    return { token: body.token, account: cleanAccount(body.account) };
  };

  const checkedId = (id: string) => {
    if (!REPORT_ID.test(id)) throw new Error('Invalid report ID.');
    return id;
  };

  const withUploads = (
    body: Record<string, unknown> | null,
    files: UploadFile[],
  ) => ({
    report: cleanReport(body?.report),
    version: checkedId(String(body?.version ?? '')),
    uploads: cleanUploads(body?.uploads, files),
  });

  return {
    signUp: (email: string, password: string) =>
      signedIn(call('POST', '/auth/sign-up', { email, password })),
    signIn: (email: string, password: string) =>
      signedIn(call('POST', '/auth/sign-in', { email, password })),
    signOut: async () => {
      await call('POST', '/auth/sign-out');
    },
    account: async () => cleanAccount((await call('GET', '/account'))?.account),

    /** Creates a report, with upload URLs for its site's files. */
    createReport: async (title: string, files: UploadFile[]) =>
      withUploads(await call('POST', '/reports', { title, files }), files),

    /** A new version of a report: the whole site, or only its data files. */
    updateReport: async (
      id: string,
      scope: 'site' | 'data',
      files: UploadFile[],
    ) =>
      withUploads(
        await call('POST', `/reports/${checkedId(id)}`, { scope, files }),
        files,
      ),

    /**
     * Tells the server every file of `version` is uploaded: it checks they're all in S3 and makes
     * it the report's current version. Throws MissingFilesError if some aren't there.
     */
    completeUpload: async (id: string, version: string) =>
      cleanReport(
        (
          await call('POST', `/reports/${checkedId(id)}/upload_complete`, {
            version: checkedId(version),
          })
        )?.report,
      ),

    /** The report's current version, with a download URL per file. */
    getReport: async (id: string): Promise<ReportFiles> => {
      const body = await call('GET', `/reports/${checkedId(id)}`);
      const files = Array.isArray(body?.files) ? body.files : [];
      return {
        report: cleanReport(body?.report),
        files: files.filter(
          (f): f is { path: string; url: string } =>
            typeof f?.path === 'string' && isReportUrl(f?.url),
        ),
        expiresAt: String(body?.expiresAt ?? ''),
      };
    },

    /** PUTs one gzipped file to its presigned URL (S3: no sign-in token is sent). */
    putFile: async (upload: Upload, body: Uint8Array) => {
      let response: Response;
      try {
        response = await fetchImpl(upload.url, {
          method: 'PUT',
          headers: upload.headers,
          body: new Uint8Array(body),
          signal: AbortSignal.timeout(300_000),
        });
      } catch {
        throw new Error(
          `Couldn’t upload ${upload.path}. Check your internet connection and try again.`,
        );
      }
      if (!response.ok) {
        throw new Error(
          `Uploading ${upload.path} failed (${response.status}). Try publishing again.`,
        );
      }
    },
  };
}

export type PawpawServer = ReturnType<typeof pawpawServer>;

/**
 * PUTs every file of `uploads` (the files in `packed`) to its presigned URL, a few at a time,
 * reporting the bytes sent so far as each file finishes.
 */
export async function uploadFiles(
  server: PawpawServer,
  packed: { file: UploadFile; body: Uint8Array }[],
  uploads: Upload[],
  onProgress: (sent: number, total: number) => void = () => {},
  concurrency = 4,
) {
  const bodies = new Map(packed.map((p) => [p.file.path, p.body]));
  const queue = [...uploads];
  const total = queue.reduce((sum, u) => sum + bodies.get(u.path)!.length, 0);
  let sent = 0;
  onProgress(0, total);
  const worker = async () => {
    for (let upload = queue.shift(); upload; upload = queue.shift()) {
      const body = bodies.get(upload.path)!;
      await server.putFile(upload, body);
      sent += body.length;
      onProgress(sent, total);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
}
