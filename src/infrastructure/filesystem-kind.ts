import { execFile } from "node:child_process";
import { realpathSync, statfsSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** Whether write commands may trust the filesystem this path lives on. */
export type FilesystemKind = "local" | "network" | "unknown";

/** Platform mechanism that produced the classification, for diagnostics. */
export type FilesystemEvidenceSource =
  | "linux-statfs"
  | "darwin-mount"
  | "windows-unc-path"
  | "windows-drive-type"
  | "unsupported-platform"
  | "probe-failure";

export interface FilesystemKindProbeResult {
  readonly kind: FilesystemKind;
  readonly source: FilesystemEvidenceSource;
  /** Normalized filesystem type token when the platform named one. */
  readonly filesystemType: string | null;
  readonly detail: string | null;
}

/**
 * The single platform seam. Everything above it consumes classified evidence,
 * so tests never touch the host's real mounts and a probe failure degrades to
 * `unknown` instead of being mistaken for a local filesystem.
 */
export type FilesystemKindProbe = (
  path: string,
) => Promise<FilesystemKindProbeResult>;

export interface FilesystemKindReport extends FilesystemKindProbeResult {}

interface FilesystemClassification {
  readonly kind: FilesystemKind;
  readonly filesystemType: string | null;
  readonly detail: string | null;
}

const NETWORK_TYPE_TOKENS = new Set([
  "nfs",
  "nfs2",
  "nfs3",
  "nfs4",
  "smb",
  "smb2",
  "smb3",
  "cifs",
  "smbfs",
  "afs",
  "9p",
  "ceph",
  "webdav",
  "davfs",
  "davfs2",
  "sshfs",
]);

const LOCAL_TYPE_TOKENS = new Set([
  "apfs",
  "hfs",
  "hfsplus",
  "ufs",
  "ext",
  "ext2",
  "ext3",
  "ext4",
  "xfs",
  "btrfs",
  "zfs",
  "f2fs",
  "tmpfs",
  "ramfs",
  "overlay",
  "overlayfs",
  "squashfs",
  "iso9660",
  "udf",
  "vfat",
  "msdos",
  "exfat",
  "ntfs",
  "ntfs3",
  "devfs",
]);

/**
 * Linux `statfs` f_type magic numbers. A magic missing from both tables stays
 * `unknown`: absence from the local list is not evidence of a local disk.
 */
const LINUX_NETWORK_MAGIC = new Map<bigint, string>([
  [0x6969n, "nfs"],
  [0xff534d42n, "cifs"],
  [0xfe534d42n, "smb2"],
  [0x5346414fn, "afs"],
  [0x01021997n, "9p"],
  [0x00c36400n, "ceph"],
]);

const LINUX_LOCAL_MAGIC = new Map<bigint, string>([
  [0xef53n, "ext"],
  [0x58465342n, "xfs"],
  [0x9123683en, "btrfs"],
  [0x01021994n, "tmpfs"],
  [0x858458f6n, "ramfs"],
  [0x794c7630n, "overlayfs"],
  [0x2fc12fc1n, "zfs"],
  [0xf2f52010n, "f2fs"],
  [0x73717368n, "squashfs"],
  [0x9660n, "iso9660"],
  [0x5346544en, "ntfs"],
  [0x4d44n, "vfat"],
  [0x2011bab0n, "exfat"],
]);

const COMMAND_TIMEOUT_MS = 5_000;
const DARWIN_MOUNT_LINE = /^(.*) on (.*) \(([^,)]+)(?:,[^)]*)?\)$/u;
const DARWIN_MOUNT_ESCAPE = /\\040/gu;

/** Classify a normalized filesystem type token reported by the platform. */
export function classifyFilesystemTypeToken(token: string): FilesystemKind {
  const normalized = token.trim().toLowerCase();
  if (NETWORK_TYPE_TOKENS.has(normalized)) return "network";
  if (LOCAL_TYPE_TOKENS.has(normalized)) return "local";
  return "unknown";
}

export function classifyLinuxStatfsType(
  type: bigint,
): FilesystemClassification {
  const magic = BigInt.asUintN(32, type);
  const network = LINUX_NETWORK_MAGIC.get(magic);
  if (network !== undefined) {
    return { kind: "network", filesystemType: network, detail: null };
  }
  const local = LINUX_LOCAL_MAGIC.get(magic);
  if (local !== undefined) {
    return { kind: "local", filesystemType: local, detail: null };
  }
  return {
    kind: "unknown",
    filesystemType: null,
    detail: `unrecognized statfs f_type 0x${magic.toString(16)}`,
  };
}

/**
 * Match a canonical path against `mount` output, choosing the longest mount
 * point so a network mount nested below a local one is not hidden by it.
 */
export function classifyDarwinMounts(
  mountOutput: string,
  canonicalPath: string,
): FilesystemClassification {
  let matched: { readonly mountPoint: string; readonly type: string } | null =
    null;
  for (const line of mountOutput.split("\n")) {
    const parts = DARWIN_MOUNT_LINE.exec(line);
    if (parts === null) continue;
    const mountPoint = parts[2]!.replace(DARWIN_MOUNT_ESCAPE, " ");
    if (!mountPointCovers(canonicalPath, mountPoint)) continue;
    if (matched === null || mountPoint.length > matched.mountPoint.length) {
      matched = { mountPoint, type: parts[3]! };
    }
  }
  if (matched === null) {
    return {
      kind: "unknown",
      filesystemType: null,
      detail: "no mount entry covers the path",
    };
  }
  const normalized = matched.type.toLowerCase();
  return {
    kind: classifyFilesystemTypeToken(normalized),
    filesystemType: normalized,
    detail: null,
  };
}

export function classifyWindowsDriveType(
  driveType: number,
): FilesystemClassification {
  switch (driveType) {
    case 4:
      return { kind: "network", filesystemType: "mapped-drive", detail: null };
    case 2:
    case 3:
    case 5:
    case 6:
      return { kind: "local", filesystemType: "local-disk", detail: null };
    default:
      return {
        kind: "unknown",
        filesystemType: null,
        detail: `unrecognized Win32_LogicalDisk DriveType ${driveType}`,
      };
  }
}

/**
 * UNC evidence alone settles a path; drive-letter paths need the system drive
 * table. `\\?\` extended paths are unwrapped rather than trusted by prefix.
 */
export function classifyWindowsUncPath(
  path: string,
): FilesystemKindProbeResult | null {
  const normalized = path.replace(/\//gu, "\\");
  if (/^\\\\\?\\unc\\/iu.test(normalized)) {
    return {
      kind: "network",
      source: "windows-unc-path",
      filesystemType: "unc",
      detail: null,
    };
  }
  if (/^\\\\\?\\[a-z]:\\/iu.test(normalized)) return null;
  if (/^\\\\\.\\/u.test(normalized)) {
    return {
      kind: "unknown",
      source: "windows-unc-path",
      filesystemType: null,
      detail: "device namespace paths have no filesystem identity",
    };
  }
  if (/^\\\\[^\\?]/u.test(normalized)) {
    return {
      kind: "network",
      source: "windows-unc-path",
      filesystemType: "unc",
      detail: null,
    };
  }
  return null;
}

function mountPointCovers(canonicalPath: string, mountPoint: string): boolean {
  if (canonicalPath === mountPoint) return true;
  const prefix = mountPoint.endsWith("/") ? mountPoint : `${mountPoint}/`;
  return canonicalPath.startsWith(prefix);
}

/**
 * Resolve the nearest existing ancestor so a probe for a not-yet-created store
 * still observes the filesystem the store would be created on.
 */
function nearestExistingCanonicalPath(path: string): string {
  let candidate = resolve(path);
  for (;;) {
    try {
      return realpathSync(candidate);
    } catch {
      const parent = dirname(candidate);
      if (parent === candidate) return resolve(path);
      candidate = parent;
    }
  }
}

function runFile(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolveRun, rejectRun) => {
    execFile(
      command,
      [...args],
      { encoding: "utf8", timeout: timeoutMs, windowsHide: true },
      (error, stdout) => {
        if (error !== null) {
          rejectRun(error);
          return;
        }
        resolveRun(String(stdout));
      },
    );
  });
}

async function linuxFilesystemKind(
  path: string,
): Promise<FilesystemKindProbeResult> {
  const stats = statfsSync(nearestExistingCanonicalPath(path), {
    bigint: true,
  });
  const classification = classifyLinuxStatfsType(BigInt(stats.type));
  return { ...classification, source: "linux-statfs" };
}

async function darwinFilesystemKind(
  path: string,
): Promise<FilesystemKindProbeResult> {
  const canonical = nearestExistingCanonicalPath(path);
  const mountOutput = await runFile("/sbin/mount", [], COMMAND_TIMEOUT_MS);
  const classification = classifyDarwinMounts(mountOutput, canonical);
  return { ...classification, source: "darwin-mount" };
}

function windowsDriveRoot(path: string): string | null {
  const normalized = path.replace(/\//gu, "\\");
  const match = /^([A-Za-z]):(?:\\|$)/u.exec(normalized);
  return match === null ? null : `${match[1]!.toUpperCase()}:`;
}

async function windowsFilesystemKind(
  path: string,
): Promise<FilesystemKindProbeResult> {
  const unc = classifyWindowsUncPath(path);
  if (unc !== null) return unc;
  const drive = windowsDriveRoot(path);
  if (drive === null) {
    return {
      kind: "unknown",
      source: "windows-drive-type",
      filesystemType: null,
      detail: "path has no drive letter to resolve",
    };
  }
  const output = await runFile(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${drive}'").DriveType`,
    ],
    COMMAND_TIMEOUT_MS,
  );
  const driveType = Number.parseInt(output.trim(), 10);
  if (!Number.isInteger(driveType)) {
    return {
      kind: "unknown",
      source: "windows-drive-type",
      filesystemType: null,
      detail: "the system drive table did not report a numeric drive type",
    };
  }
  const classification = classifyWindowsDriveType(driveType);
  return { ...classification, source: "windows-drive-type" };
}

export const defaultFilesystemKindProbe: FilesystemKindProbe = async (path) => {
  try {
    switch (process.platform) {
      case "linux":
        return await linuxFilesystemKind(path);
      case "darwin":
        return await darwinFilesystemKind(path);
      case "win32":
        return await windowsFilesystemKind(path);
      default:
        return {
          kind: "unknown",
          source: "unsupported-platform",
          filesystemType: null,
          detail: `no filesystem kind probe for platform ${process.platform}`,
        };
    }
  } catch (error) {
    return {
      kind: "unknown",
      source: "probe-failure",
      filesystemType: null,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
};

/** Observe one path; classification is total and never throws on its own. */
export async function observeFilesystemKind(
  path: string,
  probe: FilesystemKindProbe = defaultFilesystemKindProbe,
): Promise<FilesystemKindReport> {
  const result = await probe(resolve(path));
  return Object.freeze({ ...result });
}
