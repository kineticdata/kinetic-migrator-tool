// Windows keychain: generic credentials in Windows Credential Manager
// (CredWriteW / CredReadW / CredDeleteW in advapi32), reached through one
// long-lived helper process per server: the built-in Windows PowerShell 5.1
// compiles a small P/Invoke class once (Add-Type, with the .NET Framework that
// ships with Windows 10 and 11; no module or download), then answers one
// request per line.
//
// - The script is fixed and passed with -EncodedCommand (UTF-16LE base64): no
//   quoting rules apply and it never contains a secret.
// - Requests ({ op, target, account, value? }) go on stdin and answers
//   ({ code, value? }) come back on stdout, one line of ASCII-only JSON each
//   (non-ASCII as \u escapes), so the console code page cannot change them.
//   Secrets travel only there: never in argv, the environment or a file.
// - Codes: 0 ok, 44 not found (ERROR_NOT_FOUND, as macOS `security`), 1 any
//   other failure. Credentials persist for this user on this machine
//   (CRED_PERSIST_LOCAL_MACHINE), never roamed.
// - A credential holds at most 2560 bytes (CRED_MAX_CREDENTIAL_BLOB_SIZE).
//   Longer values (PEM keys, service-account JSON, the secret index) are split
//   into parts `<target>#1..n` under a header `km-parts:<n>` at `<target>`.
//
// Not the WinRT PasswordVault: it holds at most 20 credentials per app and
// roams them with a Microsoft account.
import { spawn as nodeSpawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

export const WIN_HELPER_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
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
[Console]::Out.WriteLine('{"ready":true}')
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { exit 0 }
  if ($line.Trim() -eq '') { continue }
  $code = 1
  $value = $null
  try {
    $req = $line | ConvertFrom-Json
    switch ($req.op) {
      'probe' { [void][KineticMigrateCred]::Read($req.target); $e = [KineticMigrateCred]::LastError; if ($e -eq 0 -or $e -eq 1168) { $code = 0 } }
      'set' { if ([KineticMigrateCred]::Write($req.target, $req.account, $req.value) -eq 0) { $code = 0 } }
      'get' {
        $v = [KineticMigrateCred]::Read($req.target)
        if ($null -ne $v) { $code = 0; $value = $v } elseif ([KineticMigrateCred]::LastError -eq 1168) { $code = 44 }
      }
      'delete' { $e = [KineticMigrateCred]::Delete($req.target); if ($e -eq 0) { $code = 0 } elseif ($e -eq 1168) { $code = 44 } }
    }
  } catch { $code = 1 }
  $out = @{ code = $code }
  if ($null -ne $value) { $out.value = $value }
  [Console]::Out.WriteLine(($out | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}`;

export const winPowerShell = (env: Record<string, string | undefined> = process.env): string => {
  // The system copy by full path: a powershell.exe earlier on PATH (or in the
  // current folder) is never run.
  const root = env.SystemRoot ?? env.SYSTEMROOT;
  return root ? `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` : 'powershell.exe';
};

export const winArgs = (): string[] => [
  '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WIN_HELPER_SCRIPT, 'utf16le').toString('base64'),
];

// JSON with every non-ASCII character as a \u escape.
export const asciiJson = (value: unknown): string => JSON.stringify(value).replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

export interface HelperChild {
  stdin: Writable;
  stdout: Readable;
  once(event: 'exit', listener: (code: number | null) => void): unknown;
  once(event: 'error', listener: (err: Error) => void): unknown;
  kill(): unknown;
}
export type SpawnHelper = (file: string, args: string[]) => HelperChild;

const defaultSpawn: SpawnHelper = (file, args) => {
  const child = nodeSpawn(file, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  // The helper never keeps the server process alive on its own.
  child.unref();
  (child.stdin as unknown as { unref?: () => void }).unref?.();
  (child.stdout as unknown as { unref?: () => void }).unref?.();
  return child;
};

export interface WinRequest { op: 'probe' | 'set' | 'get' | 'delete'; target: string; account?: string; value?: string }
export interface WinResponse { code: number; value?: string }

export class HelperError extends Error {
  // 'start-timeout': the helper did not get ready in time (a slow first
  // compile); 'timeout': a request got no answer; 'exited': it stopped.
  constructor(readonly reason: 'start-timeout' | 'timeout' | 'exited' | 'spawn', message: string) {
    super(message);
    this.name = 'HelperError';
  }
}

interface Waiter { resolve: (line: string) => void; reject: (err: Error) => void }

export interface HelperOptions {
  powershell?: string;
  spawn?: SpawnHelper;
  // Starting includes compiling the C# (seconds on a cold machine, longer
  // under some antivirus): generous, and separate from each request's limit.
  startTimeoutMs?: number;
  requestTimeoutMs?: number;
}

// One helper process, started on first use, restarted after a crash or a
// timeout. Requests are serialised.
export class PowerShellHelper {
  private opts: Required<HelperOptions>;
  private child: HelperChild | null = null;
  private ready: Promise<void> | null = null;
  private buffer = '';
  private waiter: Waiter | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  starts = 0;

  constructor(opts: HelperOptions = {}) {
    this.opts = {
      powershell: opts.powershell ?? winPowerShell(),
      spawn: opts.spawn ?? defaultSpawn,
      startTimeoutMs: opts.startTimeoutMs ?? 60_000,
      requestTimeoutMs: opts.requestTimeoutMs ?? 20_000,
    };
  }

  request(req: WinRequest): Promise<WinResponse> {
    const run = async (): Promise<WinResponse> => {
      try {
        return await this.once(req);
      } catch (err) {
        // A crashed helper is restarted once; a timeout is not retried.
        if (err instanceof HelperError && err.reason === 'exited') return this.once(req);
        throw err;
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }

  close(): void {
    const child = this.child;
    this.reset();
    child?.kill();
  }

  private reset(): void {
    this.child = null;
    this.ready = null;
    this.buffer = '';
  }

  private nextLine(timeoutMs: number, onTimeout: () => HelperError): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        const child = this.child;
        this.reset();
        child?.kill();
        reject(onTimeout());
      }, timeoutMs);
      (timer as unknown as { unref?: () => void }).unref?.();
      this.waiter = {
        resolve: (line) => { clearTimeout(timer); resolve(line); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      };
      this.drain();
    });
  }

  private drain(): void {
    const i = this.buffer.indexOf('\n');
    if (i < 0 || !this.waiter) return;
    const line = this.buffer.slice(0, i).replace(/\r$/, '');
    this.buffer = this.buffer.slice(i + 1);
    const w = this.waiter;
    this.waiter = null;
    w.resolve(line);
  }

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    let child: HelperChild;
    try {
      child = this.opts.spawn(this.opts.powershell, winArgs());
    } catch {
      return Promise.reject(new HelperError('spawn', 'Windows PowerShell could not be started.'));
    }
    this.starts++;
    this.child = child;
    this.buffer = '';
    child.stdout.setEncoding?.('utf8');
    child.stdout.on('data', (chunk: string | Buffer) => {
      if (this.child !== child) return;
      this.buffer += String(chunk);
      this.drain();
    });
    const gone = (message: string) => {
      if (this.child !== child) return;
      const w = this.waiter;
      this.waiter = null;
      this.reset();
      w?.reject(new HelperError('exited', message));
    };
    child.once('exit', () => gone('The Windows Credential Manager helper stopped.'));
    child.once('error', () => gone('The Windows Credential Manager helper could not run.'));
    child.stdin.on('error', () => {});
    const ready = (async () => {
      for (;;) {
        const line = await this.nextLine(this.opts.startTimeoutMs, () => new HelperError(
          'start-timeout', `The Windows Credential Manager helper did not start within ${Math.round(this.opts.startTimeoutMs / 1000)} s.`,
        ));
        if (/^\s*\{"ready":true\}\s*$/.test(line)) return;
      }
    })();
    this.ready = ready;
    ready.catch(() => { if (this.ready === ready) this.ready = null; });
    return ready;
  }

  private async once(req: WinRequest): Promise<WinResponse> {
    await this.start();
    const child = this.child;
    if (!child) throw new HelperError('exited', 'The Windows Credential Manager helper stopped.');
    const answer = this.nextLine(this.opts.requestTimeoutMs, () => new HelperError('timeout', 'The Windows Credential Manager helper did not answer.'));
    child.stdin.write(`${asciiJson(req)}\n`);
    const line = await answer;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new HelperError('exited', 'The Windows Credential Manager helper gave an unreadable answer.');
    }
    const r = parsed as { code?: unknown; value?: unknown };
    return { code: typeof r.code === 'number' ? r.code : 1, ...(typeof r.value === 'string' ? { value: r.value } : {}) };
  }
}

// CRED_MAX_CREDENTIAL_BLOB_SIZE is 2560 bytes; parts stay well under it.
export const WIN_PART_CHARS = 2000;
const HEADER = /^km-parts:(\d{1,4})$/;
// Leftover parts after the last known one are looked for up to this far.
const MAX_PARTS = 512;

export class WinCredentialError extends Error {
  constructor(action: string, code: number) {
    super(`Windows Credential Manager could not ${action} the secret (code ${code}).`);
    this.name = 'KeychainError';
  }
}

// The user name is only a label in Credential Manager (at most 513
// characters); cut on a whole character.
const label = (account: string) => [...account].slice(0, 256).join('');

// Values on top of the helper, split into parts when longer than one
// credential holds. Values are ASCII (the `b64:` encoding).
export class WinCredentials {
  constructor(private helper: Pick<PowerShellHelper, 'request'>, private service: string) {}

  private target(account: string, part?: number): string {
    return `${this.service}:${account}${part ? `#${part}` : ''}`;
  }

  private call(op: WinRequest['op'], account: string, part?: number, value?: string): Promise<WinResponse> {
    return this.helper.request({ op, target: this.target(account, part), account: label(account), ...(value === undefined ? {} : { value }) });
  }

  async probe(): Promise<'available' | 'unavailable' | 'timeout'> {
    try {
      return (await this.helper.request({ op: 'probe', target: `${this.service}:${this.service}-probe` })).code === 0 ? 'available' : 'unavailable';
    } catch (err) {
      return err instanceof HelperError && err.reason === 'start-timeout' ? 'timeout' : 'unavailable';
    }
  }

  private async partCount(account: string): Promise<{ exists: boolean; parts: number; value?: string }> {
    const r = await this.call('get', account);
    if (r.code === 44) return { exists: false, parts: 0 };
    if (r.code !== 0) throw new WinCredentialError('read', r.code);
    const m = HEADER.exec(r.value ?? '');
    return m ? { exists: true, parts: Number(m[1]) } : { exists: true, parts: 0, value: r.value ?? '' };
  }

  // The stored value, reassembled; undefined when there is none.
  async get(account: string): Promise<string | undefined> {
    const head = await this.partCount(account);
    if (!head.exists) return undefined;
    if (!head.parts) return head.value;
    let out = '';
    for (let i = 1; i <= head.parts; i++) {
      const r = await this.call('get', account, i);
      if (r.code !== 0) throw new WinCredentialError('read', r.code);
      out += r.value ?? '';
    }
    return out;
  }

  async has(account: string): Promise<boolean> {
    return (await this.partCount(account)).exists;
  }

  // Parts first, then the header: a reader never sees a header whose parts
  // are not all written. Parts left from a longer earlier value are removed.
  async set(account: string, value: string): Promise<void> {
    const before = await this.partCount(account).catch(() => ({ exists: false, parts: 0 }));
    let parts = 0;
    if (value.length <= WIN_PART_CHARS) {
      const r = await this.call('set', account, undefined, value);
      if (r.code !== 0) throw new WinCredentialError('store', r.code);
    } else {
      parts = Math.ceil(value.length / WIN_PART_CHARS);
      if (parts > MAX_PARTS) throw new Error('This secret is too long for Windows Credential Manager.');
      for (let i = 1; i <= parts; i++) {
        const r = await this.call('set', account, i, value.slice((i - 1) * WIN_PART_CHARS, i * WIN_PART_CHARS));
        if (r.code !== 0) throw new WinCredentialError('store', r.code);
      }
      const r = await this.call('set', account, undefined, `km-parts:${parts}`);
      if (r.code !== 0) throw new WinCredentialError('store', r.code);
    }
    await this.removeParts(account, parts + 1, before.parts);
  }

  // Parts first, then the header; parts past the header's count (left by an
  // interrupted write) are removed too. Absent is fine.
  async delete(account: string): Promise<void> {
    let known = 0;
    try {
      known = (await this.partCount(account)).parts;
    } catch { /* an unreadable header is still deleted */ }
    await this.removeParts(account, 1, known);
    const r = await this.call('delete', account);
    if (r.code !== 0 && r.code !== 44) throw new WinCredentialError('delete', r.code);
  }

  private async removeParts(account: string, from: number, known: number): Promise<void> {
    for (let i = from; i <= MAX_PARTS; i++) {
      const r = await this.call('delete', account, i);
      if (r.code === 44 && i > known) return;
      if (r.code !== 0 && r.code !== 44) throw new WinCredentialError('delete', r.code);
    }
  }
}
