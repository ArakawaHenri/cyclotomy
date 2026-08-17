/** Add every strict slash-delimited ancestor of a canonical workspace path. */
export function addWorkspacePathAncestors(
  path: string,
  into: Set<string>,
): void {
  let separator = path.lastIndexOf("/");
  while (separator !== -1) {
    const ancestor = path.slice(0, separator);
    into.add(ancestor);
    separator = ancestor.lastIndexOf("/");
  }
}

/** Whether a canonical workspace path is the root itself or its descendant. */
export function workspacePathIsAtOrBelow(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

/** Whether a set contains the path itself or one of its strict ancestors. */
export function workspacePathSetHasAtOrAbove(
  path: string,
  paths: ReadonlySet<string>,
): boolean {
  let candidate = path;
  while (true) {
    if (paths.has(candidate)) return true;
    const separator = candidate.lastIndexOf("/");
    if (separator === -1) return false;
    candidate = candidate.slice(0, separator);
  }
}
