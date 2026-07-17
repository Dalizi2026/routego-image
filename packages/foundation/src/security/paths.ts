import path from "node:path";

export type PathPlatform = "win32" | "posix";
export type PathOperation = "read" | "create" | "overwrite" | "delete";

export interface ResolveContainedPathOptions {
  readonly root: string;
  readonly candidate: string;
  readonly platform?: PathPlatform;
  readonly operation?: PathOperation;
  readonly protectedRoots?: readonly string[];
}

function pathImplementation(platform: PathPlatform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function normalizedForComparison(value: string, platform: PathPlatform): string {
  const implementation = pathImplementation(platform);
  const parsed = implementation.parse(value);
  let normalized = implementation.normalize(value);
  while (normalized.length > parsed.root.length && normalized.endsWith(implementation.sep)) {
    normalized = normalized.slice(0, -implementation.sep.length);
  }
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isContained(root: string, candidate: string, platform: PathPlatform): boolean {
  const implementation = pathImplementation(platform);
  const relative = implementation.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${implementation.sep}`) &&
      relative !== ".." &&
      !implementation.isAbsolute(relative))
  );
}

function overlaps(left: string, right: string, platform: PathPlatform): boolean {
  return isContained(left, right, platform) || isContained(right, left, platform);
}

export function createProtectedLegacyRoots(
  homeDirectory: string,
  platform: PathPlatform
): readonly string[] {
  if (homeDirectory.includes("\0")) {
    throw new Error("Home directory cannot contain NUL characters");
  }
  const implementation = pathImplementation(platform);
  const home = implementation.resolve(homeDirectory);
  return [
    implementation.join(home, "plugins", "routego-image"),
    implementation.join(home, ".codex", "routego-image-config.json"),
    implementation.join(home, "Pictures", "routego-image")
  ];
}

export function resolveContainedPath(options: ResolveContainedPathOptions): string {
  const platform = options.platform ?? (process.platform === "win32" ? "win32" : "posix");
  const operation = options.operation ?? "read";
  const implementation = pathImplementation(platform);

  if (options.root.includes("\0") || options.candidate.includes("\0")) {
    throw new Error("Paths cannot contain NUL characters");
  }
  if (!implementation.isAbsolute(options.root)) {
    throw new Error("The approved root must be absolute for the selected platform");
  }

  const resolvedRoot = implementation.resolve(options.root);
  const resolvedCandidate =
    implementation.isAbsolute(options.candidate)
      ? implementation.resolve(options.candidate)
      : implementation.resolve(resolvedRoot, options.candidate);
  const root = normalizedForComparison(resolvedRoot, platform);
  const candidate = normalizedForComparison(resolvedCandidate, platform);

  if (!isContained(root, candidate, platform)) {
    throw new Error("The candidate path escapes the approved root");
  }

  if (operation === "overwrite" || operation === "delete") {
    for (const protectedRoot of options.protectedRoots ?? []) {
      if (protectedRoot.includes("\0") || !implementation.isAbsolute(protectedRoot)) {
        throw new Error("Protected roots must be absolute and contain no NUL characters");
      }
      const normalizedProtected = normalizedForComparison(
        implementation.resolve(protectedRoot),
        platform
      );
      if (overlaps(candidate, normalizedProtected, platform)) {
        throw new Error("Destructive access to a protected legacy path is forbidden");
      }
    }
  }

  return resolvedCandidate;
}
