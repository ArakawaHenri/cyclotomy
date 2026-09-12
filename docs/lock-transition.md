# Workspace lock protocol

Cyclotomy coordinates writers through the fixed `<store>/workspace.lock` path.

- Releases through 0.2.4 use a directory containing an owner record.
- The current protocol uses a persistent, zero-length, single-link regular file protected by an operating-system lock. `lock-protocol.json` records `{ "format": 1, "protocol": "native-file-v1" }`.

## Acquisition and handover

A writable open binds the physical store directory and obtains its workspace lock before opening metadata. Lock protocol, metadata schema, and tree format have independent commit boundaries.

For a fresh store, the lock file is created exclusively. To convert an old store, Cyclotomy waits for the existing directory to disappear and competes to create the regular file at the same path. If another old client creates the directory first, the new client retries without overwriting it. A file's creation never substitutes for actually acquiring its native lock.

The file and directory protocols exclude each other at the same path. Published 0.2.4 rejects a regular file where it expects a directory. The protocol marker is published only after native acquisition and physical identity verification. Unknown markers and inconsistent path shapes fail closed.

Normal acquisition opens an existing native lock without `O_CREAT`. Releasing it closes the owned handle and leaves the file in place. Process termination releases the operating-system lock.

## Foreground priority

Foreground operations first try the workspace lock normally. A contending operation holds a shared operating-system lock on the persistent empty `foreground.lock` file while it waits and runs. Multiple waiters coexist, and process exit releases their demand automatically.

Automatic GC tries the workspace lock without waiting. While running, it briefly probes the demand file with an exclusive lock every 25 ms and cancels when a waiter appears. The probe is released immediately. GC keeps the workspace lock until its current durable operation and resource cleanup have finished; the demand file never grants write authority. A missing or invalid demand channel postpones maintenance without changing foreground write authorization.

## Authority

The write authority binds the store, parent directory chain and open lock file by their physical identities. Persistent writes and destructive operations revalidate that binding. A mismatch permanently revokes the authority, even if the original path is later restored. Cleanup never deletes a replacement owner's path.

These checks cannot roll back a filesystem call already entered into the kernel. Failures preserve the distinction between completed work, possible workspace changes and unsuccessful cleanup.

## Interrupted state

| State                                      | Behavior                                                       |
| ------------------------------------------ | -------------------------------------------------------------- |
| Existing legacy directory                  | Wait; an old owner record never authorizes stealing it.        |
| No marker and no lock path                 | Compete to initialize the native file.                         |
| Valid native file without marker           | Acquire the file, verify identity and finish the marker.       |
| Native marker and valid file               | Acquire the existing native lock.                              |
| Native marker with missing or invalid file | Reject without recreating the lock.                            |
| Native protocol with V4 metadata           | After acquiring the lock, continue the V4→V5 metadata upgrade. |

An abandoned legacy directory requires an offline filesystem operation: stop every accessing process, back up the store, verify that the path is a directory and that the marker is absent, and move the directory aside. Native lock files are never removed for recovery. User-facing details are in [configuration and storage](configuration.md).

## Verification

`npm run test:lock-protocol` compares the current lock implementation with the published 0.2.4 artifact across seven cross-process scenarios: old-holder exclusion, old-client refusal after activation, exclusive-create races, forced process termination, abandoned old directories, multiple native contenders and physical lock replacement.

`test/pi-lock-integration.test.ts` exercises capture and restore under cross-process contention, then verifies that automatic GC yields to local and external foreground operations and subsequently completes. `test/foreground-demand.test.ts` covers concurrent waiters, cancellation and process termination. Other tests cover ordered multi-store acquisition, permanent authority revocation, cancellation and resource cleanup. CI runs these checks on Linux, macOS and Windows.
