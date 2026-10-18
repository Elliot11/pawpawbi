// The user's PawpawBI account: signing in (email and password, or Google or Microsoft in the
// browser), and the sign-in token, stored encrypted on this computer (like the assistant's API
// keys), never in a project. Server API: docs/pawpaw-server-api.md
import { app, ipcMain, safeStorage, shell } from 'electron';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { removePath } from './fs-json';
import {
  pawpawServer,
  SignedOutError,
  type ServerAccount,
} from './pawpaw-server';
import type { AccountState, SignInProvider } from './shared/types';

/**
 * The PawpawBI server. There's none yet, so publishing to PawpawBI is unavailable in packaged
 * builds until this is set (TODO.md). In development, PAWPAW_SERVER points the app at one, such
 * as the stand-in (npm run server:stub).
 */
const SERVER_URL = '';

export function serverUrl(): string | null {
  const local = app.isPackaged ? undefined : process.env.PAWPAW_SERVER;
  return local || SERVER_URL || null;
}

interface Saved {
  token: string;
  account: ServerAccount;
}

const accountPath = () => path.join(app.getPath('userData'), 'account.bin');

async function readSaved(): Promise<Saved | null> {
  try {
    const saved = JSON.parse(
      safeStorage.decryptString(await fs.readFile(accountPath())),
    );
    return typeof saved?.token === 'string' && saved.account?.email
      ? saved
      : null;
  } catch {
    return null;
  }
}

async function save(saved: Saved): Promise<AccountState> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      "This computer's secure storage isn't available, so you can't stay signed in.",
    );
  }
  await fs.mkdir(path.dirname(accountPath()), { recursive: true });
  await fs.writeFile(
    accountPath(),
    safeStorage.encryptString(JSON.stringify(saved)),
  );
  return state();
}

async function state(): Promise<AccountState> {
  return {
    available: serverUrl() !== null,
    email: (await readSaved())?.account.email ?? null,
  };
}

function requireServerUrl(): string {
  const url = serverUrl();
  if (!url) {
    throw new Error(
      "Publishing to PawpawBI isn't available in this version yet. Publish to a folder instead.",
    );
  }
  return url;
}

/**
 * The server, signed in, for publishing. A rejected token signs the user out on this computer
 * too, so the app asks them to sign in again.
 */
export async function signedInServer() {
  const saved = await readSaved();
  if (!saved) throw new SignedOutError('Sign in to PawpawBI first.');
  return { server: pawpawServer(requireServerUrl(), saved.token), saved };
}

/** Forgets the saved sign-in if `error` says it's no longer valid; rethrows it either way. */
export async function forgetIfSignedOut(error: unknown): Promise<never> {
  if (error instanceof SignedOutError) await removePath(accountPath());
  throw error;
}

function checkDetails(email: unknown, password: unknown) {
  if (typeof email !== 'string' || !/^\S+@\S+\.\S+$/.test(email.trim())) {
    throw new Error('Enter your email address.');
  }
  if (typeof password !== 'string' || !password) {
    throw new Error('Enter your password.');
  }
  return email.trim();
}

/**
 * Signs in with Google or Microsoft: the browser goes to the server, which signs the user in
 * with the provider and sends the browser back to a one-off address on this computer with a
 * code, which is swapped for a token (RFC 8252).
 */
async function signInWith(provider: SignInProvider): Promise<AccountState> {
  if (provider !== 'google' && provider !== 'microsoft') {
    throw new Error('Unknown sign-in provider.');
  }
  const server = pawpawServer(requireServerUrl());
  const state = randomBytes(16).toString('hex');
  const listener = http.createServer();
  await new Promise<void>((resolve) =>
    listener.listen(0, '127.0.0.1', resolve),
  );
  const port = (listener.address() as { port: number }).port;
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  try {
    const code = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Signing in took too long. Try again.')),
        5 * 60_000,
      );
      listener.on('request', (req, res) => {
        const url = new URL(req.url ?? '/', redirectUri);
        if (url.pathname !== '/callback') {
          res.writeHead(404).end();
          return;
        }
        const done = (message: string) => {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(
            `<!doctype html><meta charset="utf-8"><title>PawpawBI</title><body style="font-family:system-ui;padding:48px"><h1>${message}</h1><p>You can close this tab and go back to PawpawBI.</p>`,
          );
        };
        if (url.searchParams.get('state') !== state) {
          done('That sign-in link has expired');
          return;
        }
        clearTimeout(timer);
        const received = url.searchParams.get('code');
        if (received) {
          done('Signed in');
          resolve(received);
        } else {
          done('Signing in didn’t work');
          reject(
            new Error(
              url.searchParams.get('error') || 'Signing in was cancelled.',
            ),
          );
        }
      });
      shell
        .openExternal(server.providerStartUrl(provider, redirectUri, state))
        .catch(reject);
    });
    return save(await server.providerToken(provider, code, redirectUri));
  } finally {
    listener.close();
  }
}

export function registerAccountHandlers() {
  ipcMain.handle('account:get', () => state());
  ipcMain.handle('account:sign-up', async (_event, email, password) => {
    const clean = checkDetails(email, password);
    return save(await pawpawServer(requireServerUrl()).signUp(clean, password));
  });
  ipcMain.handle('account:sign-in', async (_event, email, password) => {
    const clean = checkDetails(email, password);
    return save(await pawpawServer(requireServerUrl()).signIn(clean, password));
  });
  ipcMain.handle('account:sign-in-with', (_event, provider: SignInProvider) =>
    signInWith(provider),
  );
  ipcMain.handle('account:sign-out', async () => {
    const saved = await readSaved();
    const url = serverUrl();
    // Revoke the token if the server can be reached; forget it here either way.
    if (saved && url) {
      await pawpawServer(url, saved.token)
        .signOut()
        .catch(() => {});
    }
    await removePath(accountPath());
    return state();
  });
}
