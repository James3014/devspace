import { readFileSync, writeFileSync } from "node:fs";

const path = "src/server.ts";
const source = readFileSync(path, "utf8");
const importLine = 'import { registerPhysicalHostRegistryTools } from "./physical-host-registry.js";';
const importAnchor = `import {\n  runRepositoryIntelligenceOperation,\n  type RepositoryIntelligenceOperation,\n} from "./repository-intelligence.js";`;
const registrationAnchor = `  registerRepositoryIntelligenceTools(server, config, workspaces);\n  if (cutoverControl) registerCutoverMcpTools(server, cutoverControl, durableOperations);`;

if (source.includes(importLine) || source.includes("registerPhysicalHostRegistryTools(server")) {
  throw new Error("Issue #123 server wiring is already present; refusing a second application.");
}

if (source.split(importAnchor).length !== 2) {
  throw new Error("Expected exactly one repository-intelligence import anchor.");
}
if (source.split(registrationAnchor).length !== 2) {
  throw new Error("Expected exactly one repository-intelligence registration anchor.");
}

const withImport = source.replace(importAnchor, `${importAnchor}\n${importLine}`);
const wired = withImport.replace(
  registrationAnchor,
  `  registerRepositoryIntelligenceTools(server, config, workspaces);\n  registerPhysicalHostRegistryTools(server, {\n    registryPath: process.env.DEVSPACE_PHYSICAL_HOST_REGISTRY,\n    allowedRoots: config.allowedRoots,\n  });\n  if (cutoverControl) registerCutoverMcpTools(server, cutoverControl, durableOperations);`,
);

writeFileSync(path, wired, "utf8");
