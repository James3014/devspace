import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  COMPOSITION_ROOT_MODULES,
  CONTROL_SUBSTRATE_KERNEL_MODULES,
  DEVELOPMENT_BOUNDARY_DEBT,
  DEVELOPMENT_BOUNDARY_RULES,
  REPLACEABLE_EDGE_SPECIFIER_PREFIXES,
} from "./development-boundaries.js";

const srcRoot = dirname(fileURLToPath(import.meta.url));

function staticRelativeImports(source: string): string[] {
  const specifiers: string[] = [];
  const pattern = /(?:from\s+|import\s*)["'](\.[^"']+)["']/g;
  for (const match of source.matchAll(pattern)) {
    if (match[1]) specifiers.push(match[1]);
  }
  return specifiers;
}

const kernel = new Set<string>(CONTROL_SUBSTRATE_KERNEL_MODULES);
assert.equal(kernel.size, CONTROL_SUBSTRATE_KERNEL_MODULES.length, "control kernel contains duplicates");
assert.equal(DEVELOPMENT_BOUNDARY_RULES.controlSubstrateMayImportReplaceableEdges, false);

for (const moduleName of CONTROL_SUBSTRATE_KERNEL_MODULES) {
  const path = join(srcRoot, moduleName);
  assert.ok(existsSync(path), `declared control-substrate module is missing: ${moduleName}`);
  const source = readFileSync(path, "utf8");
  for (const specifier of staticRelativeImports(source)) {
    const forbidden = REPLACEABLE_EDGE_SPECIFIER_PREFIXES.find((prefix) =>
      specifier.startsWith(prefix),
    );
    assert.equal(
      forbidden,
      undefined,
      `${moduleName} imports replaceable edge ${specifier}; control substrate must depend only on neutral control/infrastructure contracts`,
    );
  }
}

for (const moduleName of COMPOSITION_ROOT_MODULES) {
  assert.ok(existsSync(join(srcRoot, moduleName)), `declared composition root is missing: ${moduleName}`);
}

for (const debt of DEVELOPMENT_BOUNDARY_DEBT) {
  assert.ok(existsSync(join(srcRoot, debt.module)), `declared boundary debt is missing: ${debt.module}`);
  assert.ok(!kernel.has(debt.module), `${debt.module} cannot be control kernel while boundary debt remains`);
  assert.equal(debt.role, "MIXED_DEBT");
  assert.ok(debt.reason.length > 40, `${debt.module} boundary debt needs an actionable reason`);
}

console.log(
  `development boundary fence passed for ${CONTROL_SUBSTRATE_KERNEL_MODULES.length} control modules`,
);
