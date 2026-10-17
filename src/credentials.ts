// Data source credentials (passwords, API keys, tokens), encrypted with the operating system's
// secure storage and kept on this computer only, never in the .pawpaw file.
// Stored at userData/credentials/<project id>/<source id>.bin.
import { app, safeStorage } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';

const SAFE_ID = /^[a-z0-9]{1,32}$/;

function credentialsPath(projectId: string, sourceId: string) {
  // Both IDs become part of a path, so refuse anything that isn't a plain ID.
  if (!SAFE_ID.test(projectId) || !SAFE_ID.test(sourceId))
    throw new Error('Invalid ID.');
  return path.join(
    app.getPath('userData'),
    'credentials',
    projectId,
    `${sourceId}.bin`,
  );
}

export async function readSecrets(
  projectId: string,
  sourceId: string,
): Promise<Record<string, string>> {
  let encrypted: Buffer;
  try {
    encrypted = await fs.readFile(credentialsPath(projectId, sourceId));
  } catch {
    return {};
  }
  return JSON.parse(safeStorage.decryptString(encrypted));
}

export async function writeSecrets(
  projectId: string,
  sourceId: string,
  secrets: Record<string, string>,
) {
  const filePath = credentialsPath(projectId, sourceId);
  if (Object.keys(secrets).length === 0) {
    await fs.rm(filePath, { force: true });
    return;
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      "This computer's secure storage isn't available, so credentials can't be saved.",
    );
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    safeStorage.encryptString(JSON.stringify(secrets)),
  );
}

export async function deleteSecrets(projectId: string, sourceId: string) {
  await fs.rm(credentialsPath(projectId, sourceId), { force: true });
}
