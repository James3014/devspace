import { readFileSync, writeFileSync } from "node:fs";

const path = "package.json";
const source = readFileSync(path, "utf8");
const scriptAnchor = '    "test:node-pty-permissions": "node --import tsx --test src/node-pty-postinstall.test.ts",\n    "start": "node dist/cli.js serve",';
const testAnchor = '"test": "npm run test:node-pty-permissions && npm run test:carrier-binding';

if (source.includes('"test:physical-host-registry"')) {
  throw new Error("Issue #123 package wiring is already present; refusing a second application.");
}
if (source.split(scriptAnchor).length !== 2) {
  throw new Error("Expected exactly one node-pty/start script anchor.");
}
if (source.split(testAnchor).length !== 2) {
  throw new Error("Expected exactly one test-chain anchor.");
}

const wired = source
  .replace(
    scriptAnchor,
    '    "test:node-pty-permissions": "node --import tsx --test src/node-pty-postinstall.test.ts",\n    "test:physical-host-registry": "tsx src/physical-host-registry.test.ts",\n    "start": "node dist/cli.js serve",',
  )
  .replace(
    testAnchor,
    '"test": "npm run test:node-pty-permissions && npm run test:physical-host-registry && npm run test:carrier-binding',
  );

writeFileSync(path, wired, "utf8");
