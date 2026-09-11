import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  classifyDarwinMounts,
  classifyFilesystemTypeToken,
  classifyLinuxStatfsType,
  classifyWindowsDriveType,
  classifyWindowsUncPath,
  defaultFilesystemKindProbe,
  observeFilesystemKind,
  type FilesystemKindProbe,
  type FilesystemKindProbeResult,
} from "../src/infrastructure/filesystem-kind.ts";

const MOUNT_OUTPUT = [
  "/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)",
  "/dev/disk3s6 on /System/Volumes/VM (apfs, local, noexec, journaled, noatime, nobrowse)",
  "map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)",
  "server:/export on /Volumes/nfs (nfs, nodev, nosuid)",
  "//user@server/share on /Volumes/My\\040Share (smbfs, nodev, nosuid)",
].join("\n");

describe("filesystem kind observation", () => {
  it("reports local evidence from the injected probe", async () => {
    const probe = async (): Promise<FilesystemKindProbeResult> => ({
      kind: "local",
      source: "linux-statfs",
      filesystemType: "ext4",
      detail: null,
    });
    const report = await observeFilesystemKind("/store", probe);

    expect(report).toEqual({
      kind: "local",
      source: "linux-statfs",
      filesystemType: "ext4",
      detail: null,
    });
  });

  it("reports network evidence and preserves its source", async () => {
    const report = await observeFilesystemKind("/store", async () => ({
      kind: "network",
      source: "darwin-mount",
      filesystemType: "nfs",
      detail: null,
    }));

    expect(report.kind).toBe("network");
    expect(report.source).toBe("darwin-mount");
    expect(report.filesystemType).toBe("nfs");
  });

  it("keeps an evidence failure as unknown with a detail", async () => {
    const report = await observeFilesystemKind("/store", async () => ({
      kind: "unknown",
      source: "probe-failure",
      filesystemType: null,
      detail: "statfs failed",
    }));

    expect(report).toEqual({
      kind: "unknown",
      source: "probe-failure",
      filesystemType: null,
      detail: "statfs failed",
    });
  });

  it("passes the resolved path to the probe", async () => {
    const seen: string[] = [];
    const probe: FilesystemKindProbe = async (path) => {
      seen.push(path);
      return {
        kind: "unknown",
        source: "unsupported-platform",
        filesystemType: null,
        detail: null,
      };
    };
    await observeFilesystemKind("relative/path", probe);

    expect(seen).toEqual([resolve("relative/path")]);
  });

  it("probes the host without throwing for a normal directory", async () => {
    const report = await defaultFilesystemKindProbe(tmpdir());

    expect(["local", "network", "unknown"]).toContain(report.kind);
    expect(report.source.length).toBeGreaterThan(0);
  });
});

describe("filesystem type tokens", () => {
  it("classifies known network filesystems", () => {
    for (const token of ["nfs", "NFS4", "cifs", "smb2", "smbfs", "sshfs"]) {
      expect(classifyFilesystemTypeToken(token)).toBe("network");
    }
  });

  it("classifies known local filesystems", () => {
    for (const token of ["apfs", "ext4", "xfs", "btrfs", "tmpfs", "ntfs3"]) {
      expect(classifyFilesystemTypeToken(token)).toBe("local");
    }
  });

  it("never turns an unrecognized token into local", () => {
    for (const token of ["", "autofs", "macfuse", "fuse", "0x1234"]) {
      expect(classifyFilesystemTypeToken(token)).toBe("unknown");
    }
  });
});

describe("linux statfs magic", () => {
  it("classifies known network magics", () => {
    expect(classifyLinuxStatfsType(0x6969n)).toMatchObject({
      kind: "network",
      filesystemType: "nfs",
    });
    expect(classifyLinuxStatfsType(0xff534d42n)).toMatchObject({
      kind: "network",
      filesystemType: "cifs",
    });
    expect(classifyLinuxStatfsType(0xfe534d42n)).toMatchObject({
      kind: "network",
      filesystemType: "smb2",
    });
  });

  it("classifies known local magics", () => {
    expect(classifyLinuxStatfsType(0xef53n)).toMatchObject({
      kind: "local",
      filesystemType: "ext",
    });
    expect(classifyLinuxStatfsType(0x9123683en)).toMatchObject({
      kind: "local",
      filesystemType: "btrfs",
    });
  });

  it("keeps an unknown magic unknown with the observed value", () => {
    const classification = classifyLinuxStatfsType(0x12345678n);

    expect(classification.kind).toBe("unknown");
    expect(classification.detail).toContain("0x12345678");
  });
});

describe("darwin mount parsing", () => {
  it("classifies the mount covering the path", () => {
    expect(classifyDarwinMounts(MOUNT_OUTPUT, "/Users/x/store")).toMatchObject({
      kind: "local",
      filesystemType: "apfs",
    });
    expect(
      classifyDarwinMounts(MOUNT_OUTPUT, "/Volumes/nfs/deep/store"),
    ).toMatchObject({ kind: "network", filesystemType: "nfs" });
  });

  it("matches mount points on path boundaries and unescapes spaces", () => {
    // /Volumes/nfsx must not be attributed to the nested /Volumes/nfs mount;
    // the root mount covers it instead.
    expect(
      classifyDarwinMounts(MOUNT_OUTPUT, "/Volumes/nfsx/store"),
    ).toMatchObject({ kind: "local", filesystemType: "apfs" });
    expect(
      classifyDarwinMounts(MOUNT_OUTPUT, "/Volumes/My Share/store"),
    ).toMatchObject({ kind: "network", filesystemType: "smbfs" });
  });

  it("stays unknown for an automount without refusing or trusting it", () => {
    expect(
      classifyDarwinMounts(MOUNT_OUTPUT, "/System/Volumes/Data/home/user"),
    ).toMatchObject({ kind: "unknown", filesystemType: "autofs" });
  });

  it("stays unknown when no mount entry covers the path", () => {
    const partial = "server:/export on /mnt/nfs (nfs, nodev, nosuid)";
    expect(classifyDarwinMounts(partial, "/Volumes/other")).toMatchObject({
      kind: "unknown",
      detail: "no mount entry covers the path",
    });
  });
});

describe("windows evidence", () => {
  it("classifies UNC paths as network", () => {
    for (const path of [
      "\\\\server\\share\\store",
      "//server/share/store",
      "\\\\?\\UNC\\server\\share\\store",
    ]) {
      expect(classifyWindowsUncPath(path)).toMatchObject({
        kind: "network",
        source: "windows-unc-path",
      });
    }
  });

  it("leaves drive and device paths to the system drive table", () => {
    expect(classifyWindowsUncPath("C:\\store")).toBeNull();
    expect(classifyWindowsUncPath("\\\\?\\C:\\store")).toBeNull();
    expect(classifyWindowsUncPath("\\\\.\\C:")).toMatchObject({
      kind: "unknown",
      source: "windows-unc-path",
    });
  });

  it("classifies mapped drives as network and blanks as unknown", () => {
    expect(classifyWindowsDriveType(4)).toMatchObject({
      kind: "network",
      filesystemType: "mapped-drive",
    });
    for (const code of [2, 3, 5, 6]) {
      expect(classifyWindowsDriveType(code).kind).toBe("local");
    }
    expect(classifyWindowsDriveType(0)).toMatchObject({ kind: "unknown" });
    expect(classifyWindowsDriveType(1)).toMatchObject({ kind: "unknown" });
  });
});
