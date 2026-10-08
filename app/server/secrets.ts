// Secrets store: the OS keychain when available, session memory otherwise.
// Service `kinetic-migrate`, account `<projectId>/<env>/<scope>/<name>`.
// Values are passed to keychain tools on stdin (never argv), are never logged,
// and keychain errors never include tool output (it can echo the input).
import { execFile } from 'node:child_process';
import { PowerShellHelper, WinCredentials } from './secrets-windows.ts';

export interface SecretStore {
  get(account: string): Promise<string | undefined>;
  set(account: string, value: string): Promise<void>;
  delete(account: string): Promise<void>;
  has(account: string): Promise<boolean>;
  // True when backed by the OS keychain rather than session memory.
  readonly persistent?: boolean;
  // Stops any helper process the store runs.
  close?(): void;
}

export const SERVICE = 'kinetic-migrate';

export function accountFor(projectId: string, env: string, scope: string, name: string): string {
  for (const part of [projectId, env, scope, name]) {
    if (!part || part.includes('/') || /[\x00-\x1f]/.test(part)) throw new Error('Invalid secret account part');
  }
  return `${projectId}/${env}/${scope}/${name}`;
}

export class MemoryStore implements SecretStore {
  readonly persistent = false;
  private values = new Map<string, string>();
  async get(account: string) { return this.values.get(account); }
  async set(account: string, value: string) { this.values.set(account, value); }
  async delete(account: string) { this.values.delete(account); }
  async has(account: string) { return this.values.has(account); }
}

export interface CommandResult { code: number; stdout: string; stderr: string }
// Runs a program without a shell; `input` is written to stdin.
export type CommandRunner = (file: string, args: string[], input?: string) => Promise<CommandResult>;

export const execFileRunner: CommandRunner = (file, args, input) => new Promise((resolve, reject) => {
  const child = execFile(file, args, { windowsHide: true, timeout: 20_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
    const e = err as (NodeJS.ErrnoException & { code?: string | number }) | null;
    if (e && typeof e.code === 'string') return reject(Object.assign(new Error(`Could not run ${file}`), { code: e.code }));
    resolve({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
  });
  child.stdin?.on('error', () => {});
  child.stdin?.end(input ?? '');
});

// Keychain values are stored as `b64:` + base64 of the UTF-8 text, so every
// tool only ever sees ASCII (macOS `security -w` prints non-ASCII values as
// hex; console code pages can mangle them on Windows). Values stored before
// the marker existed are read back as they are.
const MARKER = 'b64:';
export const encodeStored = (value: string): string => MARKER + Buffer.from(value, 'utf8').toString('base64');
export const decodeStored = (stored: string): string => (
  stored.startsWith(MARKER) ? Buffer.from(stored.slice(MARKER.length), 'base64').toString('utf8') : stored
);

// `security` exits 44 for a missing item; the Windows scripts use the same code.
const NOT_FOUND = 44;

class KeychainError extends Error {
  constructor(action: string, code: number) {
    super(`The system keychain could not ${action} the secret (exit ${code}).`);
    this.name = 'KeychainError';
  }
}

// `security -i` reads commands from stdin; arguments are double-quoted.
const quoteForSecurity = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

// Windows: see secrets-windows.ts (Credential Manager through one long-lived
// PowerShell helper, values split into parts past the 2560-byte limit).
export { WIN_HELPER_SCRIPT, WIN_PART_CHARS, asciiJson, winArgs, winPowerShell } from './secrets-windows.ts';

export interface KeychainOptions {
  platform?: NodeJS.Platform | string;
  run?: CommandRunner;
  service?: string;
  // Windows: the powershell.exe to run (defaults to the system copy), or a
  // helper to use instead of starting one (tests).
  powershell?: string;
  winHelper?: Pick<PowerShellHelper, 'request'> & { close?: () => void };
}

export class KeychainStore implements SecretStore {
  readonly persistent = true;
  private platform: string;
  private run: CommandRunner;
  private service: string;
  private helper: (Pick<PowerShellHelper, 'request'> & { close?: () => void }) | null = null;
  private winOpts: KeychainOptions;
  private winStore: WinCredentials | null = null;

  constructor(opts: KeychainOptions = {}) {
    this.platform = opts.platform ?? process.platform;
    this.run = opts.run ?? execFileRunner;
    this.service = opts.service ?? SERVICE;
    this.winOpts = opts;
  }

  // Windows: the helper is started on first use and kept for the server's life.
  private get win(): WinCredentials {
    if (!this.winStore) {
      this.helper = this.winOpts.winHelper ?? new PowerShellHelper({ powershell: this.winOpts.powershell });
      this.winStore = new WinCredentials(this.helper, this.service);
    }
    return this.winStore;
  }

  close(): void {
    this.helper?.close?.();
  }

  // 'timeout' (Windows only): the helper is still starting (a slow first
  // compile), which is not the same as no keychain.
  async availability(): Promise<'available' | 'unavailable' | 'timeout'> {
    if (this.platform === 'win32') return this.win.probe();
    return (await this.available()) ? 'available' : 'unavailable';
  }

  async available(): Promise<boolean> {
    try {
      switch (this.platform) {
        case 'darwin': return (await this.run('security', ['list-keychains'])).code === 0;
        // A search that runs proves the tool and a running secret service; a
        // search with no match exits 1 with nothing on stderr.
        case 'linux': {
          const r = await this.run('secret-tool', ['search', 'service', `${this.service}-probe`]);
          return r.code === 0 || (r.code === 1 && r.stderr.trim() === '');
        }
        // Compiles the helper and reads a credential that does not exist: fails
        // where Credential Manager is unusable (no user profile loaded, as in
        // some service or remote sessions, or PowerShell locked down).
        case 'win32': return (await this.win.probe()) === 'available';
        default: return false;
      }
    } catch {
      return false;
    }
  }

  private noValueControl(value: string): void {
    if (/[\r\n\x00]/.test(value)) throw new Error('Secrets cannot contain line breaks.');
  }

  async set(account: string, plain: string): Promise<void> {
    // Encoded, the value is one ASCII line on every platform.
    const value = encodeStored(plain);
    let r: CommandResult;
    switch (this.platform) {
      case 'darwin':
        this.noValueControl(value);
        this.noValueControl(account);
        r = await this.run('security', ['-i'], `add-generic-password -U -s ${quoteForSecurity(this.service)} -a ${quoteForSecurity(account)} -w ${quoteForSecurity(value)}\n`);
        break;
      case 'linux':
        r = await this.run('secret-tool', ['store', `--label=${this.service} ${account}`, 'service', this.service, 'account', account], value);
        break;
      case 'win32':
        await this.win.set(account, value);
        return;
      default:
        throw new Error('No system keychain on this platform.');
    }
    if (r.code !== 0) throw new KeychainError('store', r.code);
  }

  // Only a definite "not found" means absent; any other failure throws.
  async get(account: string): Promise<string | undefined> {
    let r: CommandResult;
    switch (this.platform) {
      case 'darwin':
        r = await this.run('security', ['find-generic-password', '-s', this.service, '-a', account, '-w']);
        if (r.code === NOT_FOUND) return undefined;
        if (r.code !== 0) throw new KeychainError('read', r.code);
        return decodeStored(r.stdout.replace(/\n$/, ''));
      case 'linux':
        r = await this.run('secret-tool', ['lookup', 'service', this.service, 'account', account]);
        if (r.code === 0 && r.stdout !== '') return decodeStored(r.stdout);
        // An empty lookup (exit 0 or 1, no output at all) is "not found".
        if ((r.code === 0 || r.code === 1) && r.stdout === '' && r.stderr.trim() === '') return undefined;
        throw new KeychainError('read', r.code);
      case 'win32': {
        const stored = await this.win.get(account);
        if (stored === undefined) return undefined;
        // Windows never stored values before the b64: marker: anything else
        // is not a value of ours.
        if (!/^b64:[A-Za-z0-9+/=]*$/.test(stored)) throw new KeychainError('read', 1);
        return decodeStored(stored);
      }
      default:
        throw new Error('No system keychain on this platform.');
    }
  }

  async has(account: string): Promise<boolean> {
    if (this.platform === 'win32') return this.win.has(account);
    if (this.platform === 'darwin') {
      const r = await this.run('security', ['find-generic-password', '-s', this.service, '-a', account]);
      if (r.code === NOT_FOUND) return false;
      if (r.code !== 0) throw new KeychainError('read', r.code);
      return true;
    }
    return (await this.get(account)) !== undefined;
  }

  // Deleting an absent secret is fine; any other failure throws.
  async delete(account: string): Promise<void> {
    let r: CommandResult;
    switch (this.platform) {
      case 'darwin':
        r = await this.run('security', ['delete-generic-password', '-s', this.service, '-a', account]);
        if (r.code !== 0 && r.code !== NOT_FOUND) throw new KeychainError('delete', r.code);
        return;
      case 'linux':
        r = await this.run('secret-tool', ['clear', 'service', this.service, 'account', account]);
        if (r.code !== 0 && !(r.code === 1 && r.stderr.trim() === '')) throw new KeychainError('delete', r.code);
        return;
      case 'win32':
        await this.win.delete(account);
        return;
      default:
        throw new Error('No system keychain on this platform.');
    }
  }
}

// The OS keychain when its tool works, otherwise session memory. A Windows
// helper that is only slow to start (a cold compile) keeps the keychain: each
// operation starts it again with the same generous limit. `log` hears which
// way it went (never a secret).
export async function createDefaultStore(log: (message: string) => void = () => {}, opts: KeychainOptions = {}): Promise<SecretStore> {
  const keychain = new KeychainStore(opts);
  const state = await keychain.availability();
  if (state === 'available') return keychain;
  if (state === 'timeout') {
    log('The Windows Credential Manager helper is slow to start; secrets still go to Credential Manager once it is ready.');
    return keychain;
  }
  keychain.close();
  log('The system keychain is not available; secrets are kept in memory until the server stops.');
  return new MemoryStore();
}
