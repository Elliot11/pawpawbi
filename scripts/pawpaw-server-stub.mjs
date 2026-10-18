// A stand-in for the PawpawBI server (docs/pawpaw-server-api.md), for development and tests.
// Everything is kept in memory and lost when it stops. Not for real use: no rate limits, and
// Google and Microsoft sign-in are faked with a page that signs you in as a test user.
//
//   npm run server:stub          listens on http://127.0.0.1:8790 (PAWPAW_STUB_PORT to change)
//   then start the app with      PAWPAW_SERVER=http://127.0.0.1:8790/v1
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import yauzl from 'yauzl';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const REPORT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const newId = () => randomBytes(9).toString('base64url');

/** The files in a ZIP, by path; rejects unsafe paths. */
function unzip(buffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, zip) => {
      if (error) return reject(error);
      const files = new Map();
      zip.on('entry', (entry) => {
        const name = entry.fileName;
        if (name.endsWith('/')) return zip.readEntry();
        if (
          name.startsWith('/') ||
          name.includes('\\') ||
          name.split('/').some((part) => part === '..' || part === '')
        ) {
          zip.close();
          return reject(new Error(`Unsafe path in the upload: ${name}`));
        }
        zip.openReadStream(entry, (err, stream) => {
          if (err) return reject(err);
          const chunks = [];
          stream.on('data', (c) => chunks.push(c));
          stream.on('end', () => {
            files.set(name, Buffer.concat(chunks));
            zip.readEntry();
          });
        });
      });
      zip.on('end', () => resolve(files));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

const hash = (password, salt) => scryptSync(password, salt, 32);

export function startStubServer(port = 0) {
  const users = new Map(); // email -> { id, email, salt, hash }
  const tokens = new Map(); // token -> email
  const codes = new Map(); // code -> { email, redirectUri }
  const reports = new Map(); // id -> { owner, report, files }
  let origin = '';

  const signIn = (email) => {
    const token = randomBytes(24).toString('hex');
    tokens.set(token, email);
    const user = users.get(email);
    return { token, account: { id: user.id, email } };
  };
  const ensureUser = (email) => {
    if (!users.has(email)) users.set(email, { id: newId(), email });
    return users.get(email);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, origin);
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, { 'Content-Type': type });
      res.end(type === 'application/json' ? JSON.stringify(body) : body);
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
    const me = () =>
      tokens.get((req.headers.authorization ?? '').replace(/^Bearer /, ''));

    try {
      // Hosted reports: /r/<id>/<path>
      const hosted = /^\/r\/([^/]+)\/(.*)$/.exec(url.pathname);
      if (req.method === 'GET' && hosted) {
        const file = reports
          .get(hosted[1])
          ?.files.get(hosted[2] || 'index.html');
        if (!file) return fail(404, 'Not found.');
        return send(
          200,
          file,
          TYPES[path.extname(hosted[2] || 'index.html')] ??
            'application/octet-stream',
        );
      }

      const route = url.pathname.replace(/^\/v1/, '');
      if (req.method === 'POST' && route === '/auth/sign-up') {
        const { email, password } = await json();
        if (typeof email !== 'string' || !/^\S+@\S+\.\S+$/.test(email))
          return fail(400, 'Enter a valid email address.');
        if (typeof password !== 'string' || password.length < 8)
          return fail(400, 'Use a password of at least 8 characters.');
        if (users.get(email)?.hash)
          return fail(409, 'There’s already an account with that email.');
        const salt = randomBytes(16);
        users.set(email, {
          ...ensureUser(email),
          salt,
          hash: hash(password, salt),
        });
        return send(201, signIn(email));
      }
      if (req.method === 'POST' && route === '/auth/sign-in') {
        const { email, password } = await json();
        const user = users.get(email);
        if (
          !user?.hash ||
          typeof password !== 'string' ||
          !timingSafeEqual(user.hash, hash(password, user.salt))
        )
          return fail(401, 'That email and password don’t match an account.');
        return send(200, signIn(email));
      }
      const start = /^\/auth\/(google|microsoft)\/start$/.exec(route);
      if (req.method === 'GET' && start) {
        const redirect = url.searchParams.get('redirect_uri') ?? '';
        const state = url.searchParams.get('state') ?? '';
        if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(redirect))
          return fail(400, 'redirect_uri must be a loopback address.');
        const email = `test.user@${start[1]}.example`;
        const code = newId();
        codes.set(code, { email, redirectUri: redirect });
        const next =
          `${redirect}?${new URLSearchParams({ code, state })}`.replace(
            /[&<>"']/g,
            (c) => `&#${c.charCodeAt(0)};`,
          );
        return send(
          200,
          `<!doctype html><meta charset="utf-8"><title>Sign in</title><body style="font-family:system-ui;padding:40px"><h1>Stand-in ${start[1]} sign-in</h1><p><a href="${next}">Continue as ${email}</a></p>`,
          'text/html; charset=utf-8',
        );
      }
      const exchange = /^\/auth\/(google|microsoft)\/token$/.exec(route);
      if (req.method === 'POST' && exchange) {
        const { code, redirect_uri } = await json();
        const grant = codes.get(code);
        codes.delete(code);
        if (!grant || grant.redirectUri !== redirect_uri)
          return fail(400, 'That sign-in has expired. Try again.');
        ensureUser(grant.email);
        return send(200, signIn(grant.email));
      }

      const email = me();
      if (!email) return fail(401, 'Sign in to PawpawBI again.');
      if (req.method === 'POST' && route === '/auth/sign-out') {
        tokens.delete((req.headers.authorization ?? '').slice(7));
        res.writeHead(204).end();
        return;
      }
      if (req.method === 'GET' && route === '/account') {
        return send(200, { account: { id: users.get(email).id, email } });
      }
      if (req.method === 'POST' && route === '/reports') {
        const { title } = await json();
        const id = newId();
        const report = {
          id,
          title: String(title ?? 'Report').slice(0, 200),
          url: `${origin}/r/${id}/`,
          publishedAt: null,
          refreshedAt: null,
        };
        reports.set(id, { owner: email, report, files: new Map() });
        return send(201, { report });
      }
      if (req.method === 'GET' && route === '/reports') {
        return send(200, {
          reports: [...reports.values()]
            .filter((r) => r.owner === email)
            .map((r) => r.report),
        });
      }
      const upload = /^\/reports\/([^/]+)\/(site|data)$/.exec(route);
      if (req.method === 'PUT' && upload) {
        const entry = reports.get(upload[1]);
        if (!REPORT_ID.test(upload[1]) || !entry || entry.owner !== email)
          return fail(404, 'There’s no report with that ID in your account.');
        const files = await unzip(await body());
        const now = new Date().toISOString();
        if (upload[2] === 'site') {
          entry.files = files;
          entry.report.publishedAt = now;
        } else {
          for (const name of files.keys()) {
            if (!/^data\/[^/]+\.json$/.test(name))
              return fail(400, `Only data files can be refreshed: ${name}`);
          }
          for (const [name, file] of files) entry.files.set(name, file);
        }
        entry.report.refreshedAt = now;
        return send(200, { report: entry.report });
      }
      return fail(404, 'Not found.');
    } catch (error) {
      return fail(400, error.message);
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
