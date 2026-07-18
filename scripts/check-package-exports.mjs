import { builtinModules } from "node:module";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const packages = [
  {
    directory: "packages/contracts",
    expectedExports: [
      "imageOperationRequestSchema",
      "providerEndpointSetSchema",
      "routegoOperationDefinitions"
    ],
    browserSafe: true
  },
  {
    directory: "packages/foundation",
    expectedExports: ["redactDiagnostic", "selectProviderRoute"],
    browserSafe: false
  },
  {
    directory: "packages/mock-relay",
    expectedExports: ["createMockRelay", "createMockRoutegoService"],
    browserSafe: false
  },
  {
    directory: "packages/creation",
    expectedExports: ["ROUTEGO_CREATION_PACKAGE_VERSION"],
    browserSafe: false
  },
  {
    directory: "packages/library",
    expectedExports: ["ROUTEGO_LIBRARY_PACKAGE_VERSION"],
    browserSafe: false
  },
  {
    directory: "packages/integration",
    expectedExports: ["ROUTEGO_INTEGRATION_PACKAGE_VERSION", "createStudioCreationStreamRoute"],
    browserSafe: false
  },
  {
    directory: "packages/studio",
    expectedExports: ["ROUTEGO_STUDIO_PACKAGE_VERSION"],
    browserSafe: true
  }
];
const builtinSpecifiers = new Set(
  builtinModules.flatMap((specifier) => [specifier, `node:${specifier}`])
);

function importSpecifiers(source) {
  const specifiers = [];
  const patterns = [
    /(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/gu,
    /import\(\s*["']([^"']+)["']\s*\)/gu
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1] !== undefined) {
        specifiers.push(match[1]);
      }
    }
  }
  return specifiers;
}

function sourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(absolute));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(absolute);
    }
  }
  return files;
}

for (const packageDefinition of packages) {
  const packageRoot = path.join(repositoryRoot, packageDefinition.directory);
  const manifest = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  const rootExport = manifest.exports?.["."];
  if (typeof rootExport?.import !== "string" || typeof rootExport?.types !== "string") {
    throw new Error(`${manifest.name} must publish import and types entries at the package root`);
  }
  if (rootExport.development !== "./src/index.ts") {
    throw new Error(`${manifest.name} must expose its source entry only under the development condition`);
  }
  for (const target of [rootExport.import, rootExport.types]) {
    if (!target.startsWith("./dist/")) {
      throw new Error(`${manifest.name} package root export must resolve inside dist`);
    }
    if (!existsSync(path.resolve(packageRoot, target))) {
      throw new Error(`${manifest.name} export target is missing: ${target}. Run pnpm build first.`);
    }
  }

  const module = await import(pathToFileURL(path.resolve(packageRoot, rootExport.import)).href);
  for (const exportName of packageDefinition.expectedExports) {
    if (!(exportName in module)) {
      throw new Error(`${manifest.name} is missing package root export: ${exportName}`);
    }
  }

  if (packageDefinition.browserSafe) {
    for (const sourceFile of sourceFiles(path.join(packageRoot, "src"))) {
      const source = readFileSync(sourceFile, "utf8");
      const forbidden = importSpecifiers(source).filter(
        (specifier) => specifier.startsWith("node:") || builtinSpecifiers.has(specifier)
      );
      if (forbidden.length > 0) {
        throw new Error(
          `${manifest.name} browser surface imports Node built-ins in ${path.relative(packageRoot, sourceFile)}: ${forbidden.join(", ")}`
        );
      }
    }
  }
}

console.log("Package export smoke check passed for all seven workspace packages.");
