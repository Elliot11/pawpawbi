// A stand-in for the PawpawBI server (docs/pawpaw-server-api.md), for development and tests. It
// also stands in for S3: it signs its own upload and download URLs (/s3/...), checks the signed
// headers and checksum on uploads, makes a version current on upload_complete once all its files
// are there, and serves a report's files at its viewer address (/r/<id>/)
// directly, which the real viewer does with a service worker. Everything is kept in memory and
// lost when it stops. Not for real use.
//
//   npm run server:stub          listens on http://127.0.0.1:8790 (PAWPAW_STUB_PORT to change)
//   then start the app with      PAWPAW_SERVER=http://127.0.0.1:8790/v1
import {
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const REPORT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const URL_LIFETIME = 15 * 60_000;
const newId = () => randomBytes(9).toString('base64url');
const hash = (password, salt) => scryptSync(password, salt, 32);

/** A path relative to the site's root: no leading slash, backslash, "." or ".." parts. */
const safePath = (path) =>
  typeof path === 'string' &&
  path.length > 0 &&
  !path.startsWith('/') &&
  !path.includes('\\') &&
  path.split('/').every((part) => part && part !== '.' && part !== '..');

/** A file's object name: the version before its extension (data/sales.json -> data/sales.<v>.json). */
const versionedName = (path, version) =>
  path.replace(/(\.[^./]+)?$/, (extension) => `.${version}${extension}`);

export function startStubServer(port = 0) {
  const secret = randomBytes(32);
  const users = new Map(); // email -> { id, salt, hash }
  const tokens = new Map(); // token -> email
  const objects = new Map(); // S3 key -> { body (gzipped), contentType }
  const reports = new Map(); // id -> { owner, title, versions, current, publishedAt, refreshedAt }
  let origin = '';

  const sign = (method, key, expires, extra = '') =>
    createHmac('sha256', secret)
      .update(`${method}\n${key}\n${expires}\n${extra}`)
      .digest('base64url');
  const presign = (method, key, extra = '') => {
    const expires = Date.now() + URL_LIFETIME;
    return `${origin}/s3/${encodeURIComponent(key)}?${new URLSearchParams({
      expires: String(expires),
      sig: sign(method, key, expires, extra),
    })}`;
  };
  const expiresAt = () => new Date(Date.now() + URL_LIFETIME).toISOString();

  /**
   * upload_complete: makes `version` current if all its new files are in S3. Returns the paths
   * still missing (nothing changes then).
   */
  const complete = (entry, version) => {
    const index = entry.versions.findIndex((v) => v.id === version);
    if (index === -1)
      throw Object.assign(new Error('No such version.'), { status: 404 });
    if (index < entry.current)
      throw Object.assign(new Error('A newer version is already live.'), {
        status: 409,
      });
    const v = entry.versions[index];
    const missing = [...v.table]
      .filter(([, key]) => v.fresh.has(key) && !objects.has(key))
      .map(([path]) => path);
    if (missing.length) return missing;
    if (index > entry.current) {
      const now = new Date().toISOString();
      if (v.scope === 'site') entry.publishedAt = now;
      entry.refreshedAt = now;
      entry.current = index;
    }
    return [];
  };
  const reportOf = (id, entry) => ({
    id,
    title: entry.title,
    url: `${origin}/r/${id}/`,
    publishedAt: entry.publishedAt ?? null,
    refreshedAt: entry.refreshedAt ?? null,
  });

  /** Adds a version: its file table (path -> key), and the uploads for its new files. */
  const newVersion = (id, entry, scope, files) => {
    if (!Array.isArray(files) || files.length === 0)
      throw new Error('List the files to upload.');
    if (files.length > 1000)
      throw new Error('At most 1,000 files per version.');
    const version = newId();
    const table = new Map(
      scope === 'data' ? entry.versions[entry.current].table : [],
    );
    const fresh = new Set();
    const uploads = [];
    for (const f of files) {
      if (!safePath(f?.path)) throw new Error(`Unsafe path: ${f?.path}`);
      if (scope === 'data' && !/^data\/[^/]+\.json$/.test(f.path))
        throw new Error(`Only data files can be refreshed: ${f.path}`);
      if (typeof f.sha256 !== 'string' || typeof f.contentType !== 'string')
        throw new Error(`Give a content type and checksum for ${f.path}.`);
      if (!(f.size > 0 && f.size <= 25 * 1024 * 1024))
        throw new Error(`${f.path} is too big.`);
      const key = `reports/${id}/${versionedName(f.path, version)}`;
      table.set(f.path, key);
      fresh.add(key);
      uploads.push({
        path: f.path,
        url: presign('PUT', key, `${f.contentType}\n${f.sha256}`),
        headers: {
          'Content-Type': f.contentType,
          'Content-Encoding': 'gzip',
          'x-amz-checksum-sha256': f.sha256,
        },
      });
    }
    entry.versions.push({ id: version, scope, table, fresh });
    return { version, uploads };
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, origin);
    const send = (
      status,
      body,
      headers = { 'Content-Type': 'application/json' },
    ) => {
      res.writeHead(status, headers);
      res.end(Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    const fail = (status, message) => send(status, { error: { message } });
    const body = async () => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      return Buffer.concat(chunks);
    };
    const json = async () => {
      try {
        return JSON.parse((await body()).toString('utf8') || '{}');
      } catch {
        return {};
      }
    };
    const serveObject = (object) =>
      send(200, object.body, {
        'Content-Type': object.contentType,
        'Content-Encoding': 'gzip',
      });

    try {
      // --- The stand-in for S3 --------------------------------------------------------------
      const s3 = /^\/s3\/(.+)$/.exec(url.pathname);
      if (s3) {
        const key = decodeURIComponent(s3[1]);
        const expires = Number(url.searchParams.get('expires'));
        if (!(expires > Date.now())) return fail(403, 'Request has expired.');
        if (req.method === 'PUT') {
          const type = req.headers['content-type'] ?? '';
          const sha = req.headers['x-amz-checksum-sha256'] ?? '';
          if (
            url.searchParams.get('sig') !==
            sign('PUT', key, expires, `${type}\n${sha}`)
          )
            return fail(403, 'Signature does not match.');
          if (req.headers['content-encoding'] !== 'gzip')
            return fail(400, 'Content-Encoding must be gzip.');
          const data = await body();
          if (createHash('sha256').update(data).digest('base64') !== sha)
            return fail(400, 'Checksum does not match.');
          objects.set(key, { body: data, contentType: type });
          return send(200, Buffer.alloc(0), {});
        }
        if (req.method === 'GET') {
          if (url.searchParams.get('sig') !== sign('GET', key, expires))
            return fail(403, 'Signature does not match.');
          const object = objects.get(key);
          return object ? serveObject(object) : fail(404, 'No such key.');
        }
      }

      // --- The viewer: /r/<id>/<path>, served straight from the current version -------------
      const viewed = /^\/r\/([^/]+)\/(.*)$/.exec(url.pathname);
      if (req.method === 'GET' && viewed) {
        const entry = reports.get(viewed[1]);
        const key =
          entry && entry.current >= 0
            ? entry.versions[entry.current].table.get(viewed[2] || 'index.html')
            : undefined;
        const object = key && objects.get(key);
        return object ? serveObject(object) : fail(404, 'Not found.');
      }

      // --- The API --------------------------------------------------------------------------
      const route = url.pathname.replace(/^\/v1/, '');
      const signIn = (email) => {
        const token = randomBytes(24).toString('hex');
        tokens.set(token, email);
        return { token, account: { id: users.get(email).id, email } };
      };
      if (req.method === 'POST' && route === '/auth/sign-up') {
        const { email, password } = await json();
        if (typeof email !== 'string' || !/^\S+@\S+\.\S+$/.test(email))
          return fail(400, 'Enter a valid email address.');
        if (typeof password !== 'string' || password.length < 8)
          return fail(400, 'Use a password of at least 8 characters.');
        if (users.has(email))
          return fail(409, 'There’s already an account with that email.');
        const salt = randomBytes(16);
        users.set(email, { id: newId(), salt, hash: hash(password, salt) });
        return send(201, signIn(email));
      }
      if (req.method === 'POST' && route === '/auth/sign-in') {
        const { email, password } = await json();
        const user = users.get(email);
        if (
          !user ||
          typeof password !== 'string' ||
          !timingSafeEqual(user.hash, hash(password, user.salt))
        )
          return fail(401, 'That email and password don’t match an account.');
        return send(200, signIn(email));
      }

      const reportRoute = /^\/reports\/([^/]+)$/.exec(route);
      // Anyone with the ID can read a report.
      if (req.method === 'GET' && reportRoute) {
        const entry = reports.get(reportRoute[1]);
        if (!entry || entry.current < 0)
          return fail(404, 'There’s no published report with that ID.');
        return send(200, {
          report: reportOf(reportRoute[1], entry),
          files: [...entry.versions[entry.current].table].map(
            ([path, key]) => ({
              path,
              url: presign('GET', key),
            }),
          ),
          expiresAt: expiresAt(),
        });
      }

      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      const email = tokens.get(token);
      if (!email) return fail(401, 'Sign in to PawpawBI again.');
      if (req.method === 'POST' && route === '/auth/sign-out') {
        tokens.delete(token);
        res.writeHead(204).end();
        return;
      }
      if (req.method === 'GET' && route === '/account') {
        return send(200, { account: { id: users.get(email).id, email } });
      }
      if (req.method === 'POST' && route === '/reports') {
        const { title, files } = await json();
        const id = newId();
        const entry = {
          owner: email,
          title: String(title ?? 'Report').slice(0, 200),
          versions: [],
          current: -1,
        };
        const { version, uploads } = newVersion(id, entry, 'site', files);
        reports.set(id, entry);
        return send(201, {
          report: reportOf(id, entry),
          version,
          uploads,
          expiresAt: expiresAt(),
        });
      }
      if (req.method === 'POST' && reportRoute) {
        const entry = reports.get(reportRoute[1]);
        if (!REPORT_ID.test(reportRoute[1]) || !entry || entry.owner !== email)
          return fail(404, 'There’s no report with that ID in your account.');
        const { scope, files } = await json();
        if (scope !== 'site' && scope !== 'data')
          return fail(400, 'scope must be "site" or "data".');
        if (scope === 'data' && entry.current < 0)
          return fail(400, 'Publish the site before refreshing its data.');
        const { version, uploads } = newVersion(
          reportRoute[1],
          entry,
          scope,
          files,
        );
        return send(200, {
          report: reportOf(reportRoute[1], entry),
          version,
          uploads,
          expiresAt: expiresAt(),
        });
      }
      const completeRoute = /^\/reports\/([^/]+)\/upload_complete$/.exec(route);
      if (req.method === 'POST' && completeRoute) {
        const entry = reports.get(completeRoute[1]);
        if (!entry || entry.owner !== email)
          return fail(404, 'There’s no report with that ID in your account.');
        const { version } = await json();
        const missing = complete(entry, version);
        if (missing.length) {
          return send(409, {
            error: {
              message: `${missing.length} ${missing.length === 1 ? 'file hasn’t' : 'files haven’t'} been uploaded yet.`,
              missing,
            },
          });
        }
        return send(200, { report: reportOf(completeRoute[1], entry) });
      }
      return fail(404, 'Not found.');
    } catch (error) {
      return fail(error.status ?? 400, error.message);
    }
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      origin = `http://127.0.0.1:${server.address().port}`;
      resolve({
        url: `${origin}/v1`,
        origin,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { url } = await startStubServer(
    Number(process.env.PAWPAW_STUB_PORT ?? 8790),
  );
  console.log(`Stand-in PawpawBI server: ${url}`);
  console.log(`Start the app with PAWPAW_SERVER=${url}`);
}
