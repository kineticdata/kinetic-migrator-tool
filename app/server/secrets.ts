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

// Windows: generic credentials in the Windows Credential Manager (target
// `kinetic-migrate:<account>`), through CredWriteW / CredReadW / CredDeleteW
// in advapi32 called from the built-in Windows PowerShell 5.1 (Add-Type
// compiles the small P/Invoke class with the .NET Framework that ships with
// Windows 10 and 11; no module or download). Persisted per user on this
// machine (CRED_PERSIST_LOCAL_MACHINE: never roamed). Not the WinRT
// PasswordVault: it holds at most 20 credentials per app and roams them with
// a Microsoft account.
//
// The script is fixed and passed with -EncodedCommand (UTF-16LE base64), so no
// quoting rules apply. The request ({ op, target, account, value }) goes on
// stdin as one line of ASCII-only JSON (non-ASCII as \u escapes), so the
// console code page cannot change it; the value is `b64:` + base64 anyway.
// stdout carries only the stored ASCII value. Exit codes: 0 ok, 44 not found
// (as macOS `security`), 1 any other failure.
export const WIN_TARGET_PREFIX = `${SERVICE}:`;
// CRED_MAX_CREDENTIAL_BLOB_SIZE: the stored (encoded) value, in bytes.
export const WIN_MAX_STORED = 5 * 512;

export const WIN_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
trap { exit 1 }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class KineticMigrateCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
    public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredWriteW(ref CREDENTIAL credential, int flags);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredReadW(string target, int type, int flags, out IntPtr credential);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredDeleteW(string target, int type, int flags);
  [DllImport("advapi32.dll")]
  static extern void CredFree(IntPtr buffer);
  public static int LastError;
  public static int Write(string target, string user, string value) {
    byte[] bytes = Encoding.UTF8.GetBytes(value);
    CREDENTIAL c = new CREDENTIAL();
    c.Type = 1; c.TargetName = target; c.UserName = user; c.Persist = 2;
    c.CredentialBlobSize = bytes.Length;
    c.CredentialBlob = Marshal.AllocHGlobal(Math.Max(bytes.Length, 1));
    try {
      Marshal.Copy(bytes, 0, c.CredentialBlob, bytes.Length);
      return CredWriteW(ref c, 0) ? 0 : Marshal.GetLastWin32Error();
    } finally {
      Marshal.FreeHGlobal(c.CredentialBlob);
    }
  }
  public static string Read(string target) {
    IntPtr p;
    LastError = 0;
    if (!CredReadW(target, 1, 0, out p)) { LastError = Marshal.GetLastWin32Error(); return null; }
    try {
      CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      byte[] bytes = new byte[c.CredentialBlobSize];
      if (bytes.Length > 0) Marshal.Copy(c.CredentialBlob, bytes, 0, bytes.Length);
      return Encoding.UTF8.GetString(bytes);
    } finally {
      CredFree(p);
    }
  }
  public static int Delete(string target) {
    return CredDeleteW(target, 1, 0) ? 0 : Marshal.GetLastWin32Error();
  }
}
'@
$req = [Console]::In.ReadToEnd() | ConvertFrom-Json
switch ($req.op) {
  'probe' { [void][KineticMigrateCred]::Read($req.target); if ([KineticMigrateCred]::LastError -eq 0 -or [KineticMigrateCred]::LastError -eq 1168) { exit 0 }; exit 1 }
  'set' { if ([KineticMigrateCred]::Write($req.target, $req.account, $req.value) -eq 0) { exit 0 }; exit 1 }
  'get' {
    $v = [KineticMigrateCred]::Read($req.target)
    if ($null -eq $v) { if ([KineticMigrateCred]::LastError -eq 1168) { exit 44 }; exit 1 }
    [Console]::Out.Write($v); exit 0
  }
  'delete' { $e = [KineticMigrateCred]::Delete($req.target); if ($e -eq 0) { exit 0 }; if ($e -eq 1168) { exit 44 }; exit 1 }
}
exit 1`;

export const winPowerShell = (env: Record<string, string | undefined> = process.env): string => {
  // The system copy by full path: a powershell.exe earlier on PATH (or in the
  // current folder) is never run.
  const root = env.SystemRoot ?? env.SYSTEMROOT;
  return root ? `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` : 'powershell.exe';
};

export const winArgs = (): string[] => [
  '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WIN_SCRIPT, 'utf16le').toString('base64'),
];

// JSON with every non-ASCII character as a \u escape.
export const asciiJson = (value: unknown): string => JSON.stringify(value).replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

// PowerShell output may carry a byte-order mark or a trailing newline.
const cleanOutput = (s: string) => s.replace(/^﻿/, '').replace(/\r?\n$/, '');

export interface KeychainOptions {
  platform?: NodeJS.Platform | string;
  run?: CommandRunner;
  service?: string;
  // Windows: the powershell.exe to run (defaults to the system copy).
  powershell?: string;
}

export class KeychainStore implements SecretStore {
  readonly persistent = true;
  private platform: string;
  private run: CommandRunner;
  private service: string;
  private powershell: string;

  constructor(opts: KeychainOptions = {}) {
    this.platform = opts.platform ?? process.platform;
    this.run = opts.run ?? execFileRunner;
    this.service = opts.service ?? SERVICE;
    this.powershell = opts.powershell ?? winPowerShell();
  }

  private win(op: 'probe' | 'set' | 'get' | 'delete', account: string, value?: string): Promise<CommandResult> {
    const target = `${this.service}:${account}`;
    // The user name is only a label in Credential Manager (at most 513 characters).
    const req = { op, target, account: account.slice(0, 256), ...(value === undefined ? {} : { value }) };
    return this.run(this.powershell, winArgs(), asciiJson(req));
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
        // some service or remote sessions).
        case 'win32': return (await this.win('probe', `${this.service}-probe`)).code === 0;
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
        if (Buffer.byteLength(value) > WIN_MAX_STORED) throw new Error('This secret is too long for Windows Credential Manager.');
        r = await this.win('set', account, value);
        break;
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
      case 'win32':
        r = await this.win('get', account);
        if (r.code === NOT_FOUND) return undefined;
        if (r.code !== 0) throw new KeychainError('read', r.code);
        return decodeStored(cleanOutput(r.stdout));
      default:
        throw new Error('No system keychain on this platform.');
    }
  }

  async has(account: string): Promise<boolean> {
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
        r = await this.win('delete', account);
        if (r.code !== 0 && r.code !== NOT_FOUND) throw new KeychainError('delete', r.code);
        return;
      default:
        throw new Error('No system keychain on this platform.');
    }
  }
}

// The OS keychain when its tool works, otherwise session memory.
export async function createDefaultStore(): Promise<SecretStore> {
  const keychain = new KeychainStore();
  return (await keychain.available()) ? keychain : new MemoryStore();
}
