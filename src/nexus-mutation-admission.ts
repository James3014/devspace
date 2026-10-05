import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  centralAdmissionCheck,
  type ResumableWorkPointer,
  type WorkResumeStore,
  type WriterAdmissionReceipt,
} from "./work-resume.js";

export const NEXUS_ENROLLMENT_CONFIG = join(".nexus-core", "config.toml");

export function repositoryRequiresNexusAdmission(workspaceRoot: string): boolean {
  return existsSync(join(workspaceRoot, NEXUS_ENROLLMENT_CONFIG));
}

export function enforceNexusWriterAdmission(input: {
  workspaceRoot: string;
  pointer?: ResumableWorkPointer;
  store?: WorkResumeStore;
  ownerContext: unknown;
  operation: string;
}): WriterAdmissionReceipt | undefined {
  const enrolled = repositoryRequiresNexusAdmission(input.workspaceRoot);
  if (!enrolled && !input.pointer) return undefined;

  if (!input.store) {
    throw new Error(
      "[NEXUS_ADMISSION_UNAVAILABLE] Nexus-enrolled repository mutation requires the durable work-resume admission store.",
    );
  }
  if (enrolled && !input.pointer) {
    throw new Error(
      "[NEXUS_ADMISSION_REQUIRED] Nexus-enrolled repository mutation requires a current resumableWork pointer prepared from the canonical carrier before the first effect.",
    );
  }

  return centralAdmissionCheck({
    store: input.store,
    pointer: input.pointer,
    ownerContext: input.ownerContext,
    worktreeRealpath: input.workspaceRoot,
    operation: input.operation,
  });
}
