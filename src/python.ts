// Main-process manager for the bundled Python sidecar (python/sidecar/main.py).
// Requests and responses are JSON, one per line, over the process's stdin/stdout.
import { app, ipcMain } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import type { PythonInfo } from './shared/types';

const pythonRoot = app.isPackaged
  ? path.join(process.resourcesPath, 'python')
  : path.join(app.getAppPath(), 'python');

const pythonExe =
  process.platform === 'win32'
    ? path.join(pythonRoot, 'runtime', 'python.exe')
    : path.join(pythonRoot, 'runtime', 'bin', 'python3');

const sidecarScript = path.join(pythonRoot, 'sidecar', 'main.py');

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

class PythonSidecar {
  private process: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;

  call<T>(method: string, params?: unknown): Promise<T> {
    const proc = this.process ?? this.start();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      proc.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  stop() {
    this.process?.kill();
  }

  private start() {
    // -E/-s ignore the user's PYTHON* env vars and user site-packages, -B avoids writing
    // .pyc files into the app folder, -u disables output buffering, -X utf8 fixes encoding.
    const proc = spawn(pythonExe, ['-E', '-s', '-B', '-u', '-X', 'utf8', sidecarScript], {
      windowsHide: true,
      env: {
        ...process.env,
        // Keep dlt's pipeline state in the app's data folder rather than ~/.dlt,
        // and don't send dlt's anonymous usage telemetry.
        DLT_DATA_DIR: path.join(app.getPath('userData'), 'dlt'),
        RUNTIME__DLTHUB_TELEMETRY: 'false',
      },
    });

    readline.createInterface({ input: proc.stdout }).on('line', (line) => this.onLine(line));
    proc.stderr.on('data', (data) => console.error(`[python] ${String(data).trimEnd()}`));
    proc.on('error', (error) => this.failAll(error));
    proc.on('exit', (code) => {
      this.process = null;
      this.failAll(new Error(`Python sidecar exited with code ${code}`));
    });

    this.process = proc;
    return proc;
  }

  private onLine(line: string) {
    let message: { id: number; result?: unknown; error?: string };
    try {
      message = JSON.parse(line);
    } catch {
      console.warn(`[python] ignoring non-JSON output: ${line}`);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error !== undefined) {
      pending.reject(new Error(message.error));
    } else {
      pending.resolve(message.result);
    }
  }

  private failAll(error: Error) {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }
}

const sidecar = new PythonSidecar();

export function registerPythonHandlers() {
  ipcMain.handle('python:info', () => sidecar.call<PythonInfo>('info'));
  app.on('will-quit', () => sidecar.stop());
}
