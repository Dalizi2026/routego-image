import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { chmod, mkdir, stat } from "node:fs/promises";

import { LibraryError } from "../errors";

const execFileAsync = promisify(execFile);

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export type CommandRunner = (file: string, args: readonly string[]) => Promise<CommandResult>;

export interface PosixPermissionAdapter {
  chmod(filePath: string, mode: number): Promise<void>;
  stat(filePath: string): Promise<{ readonly mode: number }>;
}

const defaultPosixPermissionAdapter: PosixPermissionAdapter = { chmod, stat };

async function defaultRunner(file: string, args: readonly string[]): Promise<CommandResult> {
  const result = await execFileAsync(file, [...args], {
    windowsHide: true,
    encoding: "utf8"
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

interface WindowsIdentity {
  readonly account?: string;
  readonly sid: string;
}

function parseWindowsIdentity(value: string): WindowsIdentity {
  const sid = value.match(/\bS-\d-(?:\d+-)+\d+\b/u)?.[0];
  if (!sid) throw new LibraryError("access_denied", "The current Windows user SID is unavailable.");
  const csv = value.match(/^\s*"([^"]+)","S-\d-(?:\d+-)+\d+"\s*$/mu);
  return { sid, ...(csv?.[1] ? { account: csv[1] } : {}) };
}

function aclGrantsFullControl(value: string, identity: WindowsIdentity): boolean {
  return [identity.sid, identity.account]
    .filter((principal): principal is string => principal !== undefined)
    .some((principal) => {
      const escaped = principal.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      return new RegExp(`${escaped}[^\\r\\n]*\\(F\\)`, "iu").test(value);
    });
}

export async function ensurePrivateDirectory(
  directory: string,
  platform: NodeJS.Platform = process.platform
): Promise<void> {
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (platform !== "win32") await chmod(directory, 0o700);
  } catch (error) {
    throw new LibraryError("access_denied", "The private data directory could not be protected.", {
      cause: error
    });
  }
}

export async function restrictFileToCurrentUser(options: {
  readonly filePath: string;
  readonly platform?: NodeJS.Platform;
  readonly runner?: CommandRunner;
  readonly posix?: PosixPermissionAdapter;
}): Promise<void> {
  const platform = options.platform ?? process.platform;
  const implementation = platform === "win32" ? path.win32 : path.posix;
  if (options.filePath.includes("\0") || !implementation.isAbsolute(options.filePath)) {
    throw new LibraryError("path_unsafe", "Credential permission enforcement requires an absolute path.");
  }
  if (platform !== "win32") {
    try {
      const posix = options.posix ?? defaultPosixPermissionAdapter;
      await posix.chmod(options.filePath, 0o600);
      if (((await posix.stat(options.filePath)).mode & 0o777) !== 0o600) {
        throw new LibraryError("access_denied", "Credential permission verification failed.");
      }
      return;
    } catch (error) {
      throw new LibraryError("access_denied", "Credential permissions could not be restricted.", {
        cause: error
      });
    }
  }

  const runner = options.runner ?? defaultRunner;
  try {
    const identity = await runner("whoami.exe", ["/user", "/fo", "csv", "/nh"]);
    const parsedIdentity = parseWindowsIdentity(identity.stdout);
    const resolved = path.win32.resolve(options.filePath);
    await runner("icacls.exe", [
      resolved,
      "/inheritance:r",
      "/grant:r",
      `*${parsedIdentity.sid}:(F)`
    ]);
    const verification = await runner("icacls.exe", [resolved]);
    if (!aclGrantsFullControl(verification.stdout, parsedIdentity)) {
      throw new LibraryError("access_denied", "Credential ACL verification failed.");
    }
  } catch (error) {
    if (error instanceof LibraryError) throw error;
    throw new LibraryError("access_denied", "Credential permissions could not be restricted.", {
      cause: error
    });
  }
}
