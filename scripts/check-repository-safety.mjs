import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const trackedFiles = execFileSync("git", ["ls-files", "-z"], {
  cwd: repositoryRoot,
  encoding: "utf8"
})
  .split("\0")
  .filter(Boolean)
  .map((file) => file.replaceAll("\\", "/"));

const violations = [];
const forbiddenPathSegments = new Set([
  ".cache",
  ".typecheck",
  "coverage",
  "dist",
  "build",
  "library",
  "outputs",
  "playwright-report",
  "test-results"
]);
const rasterExtensions = new Set([
  ".bmp",
  ".gif",
  ".jpeg",
  ".jpg",
  ".png",
  ".tif",
  ".tiff",
  ".webp"
]);
const allowedRasterRoots = [".codex-plugin/", "assets/", "packages/studio/public/"];
const syntheticMarkers = [
  "redacted",
  "dummy",
  "example",
  "fixture",
  "mock",
  "placeholder",
  "synthetic",
  "test"
];

function report(file, rule) {
  violations.push({ file, rule });
}

function looksSynthetic(value) {
  const normalized = value.toLowerCase();
  return (
    syntheticMarkers.some((marker) => normalized.includes(marker)) ||
    /^[A-Za-z_$][A-Za-z0-9_$.[\]-]*$/u.test(value) ||
    normalized.includes("${") ||
    normalized.includes("<redacted>") ||
    normalized.includes("***") ||
    /^x+$/u.test(normalized)
  );
}

function inspectCredentialAssignments(file, text) {
  const pattern = /\b(authorization|proxy[-_ ]?authorization|x[-_ ]?api[-_ ]?key|api[-_ ]?key|apiKey|access[-_ ]?token|refresh[-_ ]?token|session[-_ ]?token|x[-_ ]?routego[-_ ]?session|password|client[-_ ]?secret)\b\s*[:=]\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|`([^`\r\n]+)`|((?:Bearer\s+)?[^\s,;}\]]{8,}))/giu;
  for (const match of text.matchAll(pattern)) {
    const value = match[2] ?? match[3] ?? match[4] ?? match[5];
    if (value !== undefined && !looksSynthetic(value)) {
      report(file, `possible credential assignment (${match[1]})`);
    }
  }
}

function inspectCredentialUrls(file, text) {
  const pattern = /https?:\/\/([^:\s/@]+):([^@\s/]+)@([^\s/]+)/giu;
  for (const match of text.matchAll(pattern)) {
    const username = match[1] ?? "";
    const password = match[2] ?? "";
    const hostname = match[3] ?? "";
    if (
      !looksSynthetic(`${username}:${password}@${hostname}`) &&
      !(username === "user" && password === "password" && hostname.includes("example"))
    ) {
      report(file, "credential-bearing URL");
    }
  }
}

for (const file of trackedFiles) {
  const segments = file.split("/");
  const basename = segments.at(-1)?.toLowerCase() ?? "";
  const extension = path.posix.extname(file).toLowerCase();

  if (
    segments.some((segment, index) => {
      const normalized = segment.toLowerCase();
      const exactLibraryPackageSegment =
        normalized === "library" &&
        index === 1 &&
        segments[0]?.toLowerCase() === "packages";
      return forbiddenPathSegments.has(normalized) && !exactLibraryPackageSegment;
    })
  ) {
    report(file, "generated output, local library, cache, or report path");
  }
  if (
    basename === ".env" ||
    (basename.startsWith(".env.") && basename !== ".env.example") ||
    basename === "routego-image-config.json" ||
    /(^|\/)routego-image\/config\.json$/iu.test(file)
  ) {
    report(file, "local configuration or environment file");
  }
  if (
    rasterExtensions.has(extension) &&
    !allowedRasterRoots.some((root) => file.startsWith(root))
  ) {
    report(file, "unapproved tracked raster image");
  }

  const absolutePath = path.join(repositoryRoot, ...segments);
  if (statSync(absolutePath).size > 5 * 1024 * 1024) {
    report(file, "tracked file exceeds the repository safety size limit");
    continue;
  }
  const buffer = readFileSync(absolutePath);
  if (buffer.includes(0)) {
    continue;
  }
  const text = buffer.toString("utf8");

  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(text)) {
    report(file, "private key material");
  }
  if (/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/gu.test(text)) {
    report(file, "OpenAI-style secret key");
  }
  if (/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=_-]{4096,}/giu.test(text)) {
    report(file, "large embedded image payload");
  }
  inspectCredentialAssignments(file, text);
  inspectCredentialUrls(file, text);
}

if (violations.length > 0) {
  console.error("Repository safety check failed:");
  for (const violation of violations) {
    console.error(`- ${violation.file}: ${violation.rule}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Repository safety check passed (${trackedFiles.length} tracked files).`);
}
