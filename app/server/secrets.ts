// Secrets store: the OS keychain when available, session memory otherwise.
// Service `kinetic-migrate`, account `<projectId>/<env>/<scope>/<name>`.
// Values are passed to keychain tools on stdin (never argv), are never logged,
// and keychain errors never include tool output (it can echo the input).
import { execFile } from 'node:child_process';

export interface SecretStore {
  get(account: string): Promise<string | undefined>;
  set(account: string, value: string): Promise<void>;
  delete(account: string): Promise<void>;
  has(account: string): Promise<boolean>;
  // True when backed by the OS keychain rather than session memory.
  readonly persistent?: boolean;
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

class KeychainError extends Error {
  constructor(action: string, code: number) {
    super(`The system keychain could not ${action} the secret (exit ${code}).`);
    this.name = 'KeychainError';
  }
}

// `security -i` reads commands from stdin; arguments are double-quoted.
const quoteForSecurity = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

const PS_PRELUDE = [
  "$ErrorActionPreference = 'Stop'",
  '[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]',
  '$vault = New-Object Windows.Security.Credentials.PasswordVault',
  '$in = [Console]::In.ReadToEnd() | ConvertFrom-Json',
  `$resource = '${SERVICE}'`,
].join('; ');

const PS = {
  probe: PS_PRELUDE,
  set: `${PS_PRELUDE}; try { $vault.Remove($vault.Retrieve($resource, $in.account)) } catch {}; $vault.Add((New-Object Windows.Security.Credentials.PasswordCredential($resource, $in.account, $in.value)))`,
  get: `${PS_PRELUDE}; try { $c = $vault.Retrieve($resource, $in.account) } catch { exit 44 }; $c.RetrievePassword(); [Console]::Out.Write($c.Password)`,
  delete: `${PS_PRELUDE}; try { $vault.Remove($vault.Retrieve($resource, $in.account)) } catch { exit 44 }`,
};

const psArgs = (script: string) => ['-NoProfile', '-NonInteractive', '-Command', script];

export interface KeychainOptions {
  platform?: NodeJS.Platform | string;
  run?: CommandRunner;
  service?: string;
}

export class KeychainStore implements SecretStore {
  readonly persistent = true;
  private platform: string;
  private run: CommandRunner;
  private service: string;

  constructor(opts: KeychainOptions = {}) {
    this.platform = opts.platform ?? process.platform;
    this.run = opts.run ?? execFileRunner;
    this.service = opts.service ?? SERVICE;
  }

  async available(): Promise<boolean> {
    try {
      switch (this.platform) {
        case 'darwin': return (await this.run('security', ['list-keychains'])).code === 0;
        case 'linux': await this.run('secret-tool', ['--help']); return true;
        case 'win32': return (await this.run('powershell.exe', psArgs(PS.probe), '{}')).code === 0;
        default: return false;
      }
    } catch {
      return false;
    }
  }

  private noValueControl(value: string): void {
    if (/[\r\n\x00]/.test(value)) throw new Error('Secrets cannot contain line breaks.');
  }

  async set(account: string, value: string): Promise<void> {
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
        r = await this.run('powershell.exe', psArgs(PS.set), JSON.stringify({ account, value }));
        break;
      default:
        throw new Error('No system keychain on this platform.');
    }
    if (r.code !== 0) throw new KeychainError('store', r.code);
  }

  async get(account: string): Promise<string | undefined> {
    let r: CommandResult;
    switch (this.platform) {
      case 'darwin':
        r = await this.run('security', ['find-generic-password', '-s', this.service, '-a', account, '-w']);
        if (r.code !== 0) return undefined;
        return r.stdout.replace(/\n$/, '');
      case 'linux':
        r = await this.run('secret-tool', ['lookup', 'service', this.service, 'account', account]);
        if (r.code !== 0 || r.stdout === '') return undefined;
        return r.stdout;
      case 'win32':
        r = await this.run('powershell.exe', psArgs(PS.get), JSON.stringify({ account }));
        return r.code === 0 ? r.stdout : undefined;
      default:
        return undefined;
    }
  }

  async has(account: string): Promise<boolean> {
    if (this.platform === 'darwin') {
      return (await this.run('security', ['find-generic-password', '-s', this.service, '-a', account])).code === 0;
    }
    return (await this.get(account)) !== undefined;
  }

  async delete(account: string): Promise<void> {
    switch (this.platform) {
      case 'darwin':
        await this.run('security', ['delete-generic-password', '-s', this.service, '-a', account]);
        return;
      case 'linux':
        await this.run('secret-tool', ['clear', 'service', this.service, 'account', account]);
        return;
      case 'win32':
        await this.run('powershell.exe', psArgs(PS.delete), JSON.stringify({ account }));
    }
  }
}

// The OS keychain when its tool works, otherwise session memory.
export async function createDefaultStore(): Promise<SecretStore> {
  const keychain = new KeychainStore();
  return (await keychain.available()) ? keychain : new MemoryStore();
}
