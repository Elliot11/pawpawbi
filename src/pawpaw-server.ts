// Talking to the PawpawBI server: accounts and published reports. The API is in
// docs/pawpaw-server-api.md. No Electron imports, so this is tested with plain Node against the
// stand-in server (scripts/pawpaw-server-stub.mjs, tests/node/pawpaw-server.test.ts).

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

export type SignInProvider = 'google' | 'microsoft';

/** A report ID from the server, safe to put in a URL path. */
export const REPORT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The server said the token is missing or no longer valid: sign in again. */
export class SignedOutError extends Error {
  constructor(message = 'Sign in to PawpawBI again.') {
    super(message);
    this.name = 'SignedOutError';
  }
}

/** A web address the app may open or show: https, or a loopback address (the stand-in). */
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

function cleanAccount(value: unknown): ServerAccount {
  const a = value as Partial<ServerAccount> | null;
  if (typeof a?.id !== 'string' || typeof a?.email !== 'string') {
    throw new Error('PawpawBI sent an account the app doesn’t understand.');
  }
  return { id: a.id, email: a.email };
}

function cleanReport(value: unknown): ServerReport {
  const r = value as Partial<ServerReport> | null;
  if (!REPORT_ID.test(String(r?.id ?? '')) || !isReportUrl(r?.url)) {
    throw new Error('PawpawBI sent a report the app doesn’t understand.');
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
    const zip = body instanceof Uint8Array;
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body === undefined
            ? {}
            : {
                'Content-Type': zip ? 'application/zip' : 'application/json',
              }),
        },
        body:
          body === undefined
            ? undefined
            : zip
              ? new Uint8Array(body)
              : JSON.stringify(body),
        signal: AbortSignal.timeout(zip ? 300_000 : 30_000),
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

  return {
    signUp: (email: string, password: string) =>
      signedIn(call('POST', '/auth/sign-up', { email, password })),
    signIn: (email: string, password: string) =>
      signedIn(call('POST', '/auth/sign-in', { email, password })),
    /** Where the browser goes to sign in with Google or Microsoft. */
    providerStartUrl: (
      provider: SignInProvider,
      redirectUri: string,
      state: string,
    ) =>
      `${base}/auth/${provider}/start?${new URLSearchParams({ redirect_uri: redirectUri, state })}`,
    providerToken: (
      provider: SignInProvider,
      code: string,
      redirectUri: string,
    ) =>
      signedIn(
        call('POST', `/auth/${provider}/token`, {
          code,
          redirect_uri: redirectUri,
        }),
      ),
    signOut: async () => {
      await call('POST', '/auth/sign-out');
    },
    account: async () => cleanAccount((await call('GET', '/account'))?.account),
    createReport: async (title: string) =>
      cleanReport((await call('POST', '/reports', { title }))?.report),
    listReports: async () => {
      const reports = (await call('GET', '/reports'))?.reports;
      return Array.isArray(reports) ? reports.map(cleanReport) : [];
    },
    /** Replaces the hosted site with a ZIP of it. */
    uploadSite: async (id: string, zip: Uint8Array) => {
      if (!REPORT_ID.test(id)) throw new Error('Invalid report ID.');
      return cleanReport(
        (await call('PUT', `/reports/${id}/site`, zip))?.report,
      );
    },
    /** Replaces only the hosted report's data with a ZIP of data/*.json. */
    uploadData: async (id: string, zip: Uint8Array) => {
      if (!REPORT_ID.test(id)) throw new Error('Invalid report ID.');
      return cleanReport(
        (await call('PUT', `/reports/${id}/data`, zip))?.report,
      );
    },
  };
}

export type PawpawServer = ReturnType<typeof pawpawServer>;
