import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";

export interface PinnedDirectoryIdentity {
  path: string;
  device: string;
  inode: string;
}

export interface PinnedStateBoundary {
  root: PinnedDirectoryIdentity;
  state: PinnedDirectoryIdentity;
}

export class StateDirectoryBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateDirectoryBoundaryError";
  }
}

function boundaryMessage(description: string): string {
  return `${description} changed after Agent HTML Render pinned it. Stop and rerun the operation before writing files.`;
}

function sameIdentity(
  left: Pick<PinnedDirectoryIdentity, "device" | "inode">,
  right: Pick<PinnedDirectoryIdentity, "device" | "inode">,
): boolean {
  return left.device === right.device && left.inode === right.inode;
}

export async function pinDirectoryIdentity(
  path: string,
  description: string,
): Promise<PinnedDirectoryIdentity> {
  try {
    const [details, canonicalPath] = await Promise.all([
      lstat(path, { bigint: true }),
      realpath(path),
    ]);
    if (details.isSymbolicLink() || !details.isDirectory() || canonicalPath !== path) {
      throw new StateDirectoryBoundaryError(
        `${description} must not be a symbolic link and must be a local directory.`,
      );
    }
    return {
      path,
      device: details.dev.toString(),
      inode: details.ino.toString(),
    };
  } catch (error) {
    if (error instanceof StateDirectoryBoundaryError) throw error;
    throw new StateDirectoryBoundaryError(`${boundaryMessage(description)} ${String(error)}`);
  }
}

export async function assertPinnedDirectory(
  expected: PinnedDirectoryIdentity,
  description: string,
): Promise<void> {
  const current = await pinDirectoryIdentity(expected.path, description);
  if (!sameIdentity(current, expected)) {
    throw new StateDirectoryBoundaryError(boundaryMessage(description));
  }
}

export async function assertPinnedDirectories(
  entries: ReadonlyArray<readonly [PinnedDirectoryIdentity, string]>,
): Promise<void> {
  await Promise.all(entries.map(([identity, description]) =>
    assertPinnedDirectory(identity, description)
  ));
}

export async function pinStateBoundary(
  rootPath: string,
  expectedRoot?: Pick<PinnedDirectoryIdentity, "device" | "inode">,
): Promise<PinnedStateBoundary> {
  const root = await pinDirectoryIdentity(rootPath, "The selected project root");
  if (expectedRoot && !sameIdentity(root, expectedRoot)) {
    throw new StateDirectoryBoundaryError(boundaryMessage("The selected project root"));
  }
  const state = await pinDirectoryIdentity(
    join(rootPath, ".agent-html-render"),
    "The .agent-html-render state directory",
  );
  const boundary = { root, state };
  await assertPinnedStateBoundary(boundary);
  return boundary;
}

export async function assertPinnedStateBoundary(boundary: PinnedStateBoundary): Promise<void> {
  await assertPinnedDirectories([
    [boundary.root, "The selected project root"],
    [boundary.state, "The .agent-html-render state directory"],
  ]);
}
