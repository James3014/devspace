import { access, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const MANAGED_MARKER = ".devspace-managed";
const MANAGED_SKILLS = ["subagents", "dynamic-workflows"] as const;

export type ManagedSkillName = (typeof MANAGED_SKILLS)[number];

export interface InstallManagedSkillsInput {
  destination: string;
  subagents: boolean;
  workflows: boolean;
  sourceRoot?: string;
}

export interface ManagedSkillInstallResult {
  name: ManagedSkillName;
  status: "installed" | "updated" | "preserved";
  path: string;
}

export async function installManagedSkills(
  input: InstallManagedSkillsInput,
): Promise<ManagedSkillInstallResult[]> {
  const sourceRoot = input.sourceRoot ?? bundledSkillsRoot();
  const enabled = new Set<ManagedSkillName>([
    ...(input.subagents ? ["subagents" as const] : []),
    ...(input.workflows ? ["dynamic-workflows" as const] : []),
  ]);
  if (enabled.size === 0) return [];

  await mkdir(input.destination, { recursive: true });
  const results: ManagedSkillInstallResult[] = [];
  for (const name of MANAGED_SKILLS) {
    if (!enabled.has(name)) continue;
    results.push(await installOneManagedSkill(sourceRoot, input.destination, name));
  }
  return results;
}

export function bundledSkillsRoot(): string {
  return fileURLToPath(new URL("../skills", import.meta.url));
}

async function installOneManagedSkill(
  sourceRoot: string,
  destinationRoot: string,
  name: ManagedSkillName,
): Promise<ManagedSkillInstallResult> {
  const source = join(sourceRoot, name);
  const destination = join(destinationRoot, name);
  const marker = join(destination, MANAGED_MARKER);
  const exists = await pathExists(destination);
  if (exists && !(await pathExists(marker))) {
    return { name, status: "preserved", path: destination };
  }

  await cp(source, destination, { recursive: true, force: true });
  await writeFile(marker, "Managed by DevSpace.\n", { encoding: "utf8", mode: 0o600 });
  return {
    name,
    status: exists ? "updated" : "installed",
    path: destination,
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function readManagedSkillMarker(path: string): Promise<string | undefined> {
  try {
    return await readFile(join(path, MANAGED_MARKER), "utf8");
  } catch {
    return undefined;
  }
}
