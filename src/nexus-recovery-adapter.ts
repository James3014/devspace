import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DurableOperationError,
  type DurableOperationKind,
  type DurableOperationRecord,
  type DurableOperationStore,
  hashJson,
  stableOperationId,
} from "./durable-operations.js";
import type { ExecutionAuthorityMode } from "./execution-protocol.js";

const HEX64 = /^[0-9a-f]{64}$/;
const SAFE_NEXUS_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const NEXUS_DEPLOYMENT_ID = /^r1-[0-9a-f]{40}$/;

export const NEXUS_GATEWAY_RECOVERY_SCHEMA = "nexus.gateway.durable_recovery_request.v2" as const;
export const NEXUS_GATEWAY_INTERPRETER = "/Users/jameschen/Workspace/Nexus-new/.venv/bin/python";
export const NEXUS_GATEWAY_ACCEPTED_MANAGER_SHA256 = "3f0c34204bef175fcfad7150c5919d96f6b3735813cea5258bdcd51e37d4baeb";
export const NEXUS_GATEWAY_ACCEPTED_CONTRACT_SHA256 = "3cd032639f69349bd44e61dec41551957e9034157febfff83e7fb3c89b5ef798";
export const NEXUS_GATEWAY_RECOVERY_MATERIALIZATION_SCHEMA = "nexus.gateway.durable_recovery_materialization_request.v1" as const;
export const NEXUS_GATEWAY_RECOVERY_MATERIALIZATION_RECEIPT_SCHEMA = "nexus.gateway.durable_recovery_materialization_receipt.v1" as const;
export const NEXUS_GATEWAY_STATE_ROOT = join(homedir(), "Library", "Application Support", "Nexus", "gateway-direct");

export interface NexusGatewayRecoveryRequest {
  request_id: string;
  idempotency_fence: string;
  operation: "gateway-recover";
  effect_class: "GATEWAY_DURABLE_RECOVERY";
  recovery_authority_id: string;
  recovery_authority_hash: string;
  desired_manifest_id: string;
  desired_manifest_hash: string;
  predecessor_manifest_id: string;
  predecessor_manifest_hash: string;
  request_hash: string;
  schema: typeof NEXUS_GATEWAY_RECOVERY_SCHEMA;
  [key: string]: unknown;
}

export interface NexusGatewayRecoveryMaterializationRequest {
  request_id: string;
  idempotency_fence: string;
  operation: "gateway-recovery-materialize";
  effect_class: "GATEWAY_RECOVERY_MATERIALIZATION";
  recovery_authority_id: string;
  recovery_authority_hash: string;
  request_hash: string;
  schema: typeof NEXUS_GATEWAY_RECOVERY_MATERIALIZATION_SCHEMA;
  [key: string]: unknown;
}

export interface NexusGatewayRecoveryBridgeResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface NexusGatewayRecoveryReceipt {
  result: "VERIFIED";
  evidence_hash: string;
  [key: string]: unknown;
}

export interface NexusGatewayRecoveryMaterializationReceipt {
  request_id: string;
  idempotency_fence: string;
  operation: "gateway-recovery-materialize";
  effect_class: "GATEWAY_RECOVERY_MATERIALIZATION";
  recovery_authority_id: string;
  recovery_authority_hash: string;
  materialization_request_hash: string;
  fresh_main: string;
  fresh_main_tree: string;
  materialized_authority_sha256: string;
  materialized_request_sha256: string;
  predecessor_artifact_sha256: string;
  predecessor_artifact_size: number;
  effect_started: false;
  schema: typeof NEXUS_GATEWAY_RECOVERY_MATERIALIZATION_RECEIPT_SCHEMA;
  receipt_hash: string;
  [key: string]: unknown;
}

export interface NexusGatewayRecoveryInput {
  attemptKey: string;
  request: NexusGatewayRecoveryRequest;
}

export interface NexusGatewayRecoveryMaterializationInput {
  attemptKey: string;
  request: NexusGatewayRecoveryMaterializationRequest;
}

export interface NexusGatewayPreflightResult {
  status: "passed" | "error";
  effectStarted: boolean;
  readiness: string[];
  outcome?: Record<string, unknown>;
  errorMessage?: string;
}

export type NexusGatewayRecoveryPreflightResult = NexusGatewayPreflightResult;

export type NexusGatewayRecoveryRunner = (
  request: NexusGatewayRecoveryRequest,
) => Promise<NexusGatewayRecoveryBridgeResult>;

export type NexusGatewayRecoveryMaterializationRunner = (
  request: NexusGatewayRecoveryMaterializationRequest,
) => Promise<NexusGatewayRecoveryBridgeResult>;

export function assertAttemptKey(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value)) {
    throw new DurableOperationError("INVALID_ATTEMPT_KEY", "attemptKey must be a bounded stable operation identity.");
  }
}

export function assertNexusGatewayRecoveryRequest(value: unknown): asserts value is NexusGatewayRecoveryRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DurableOperationError("NEXUS_GATEWAY_REQUEST_INVALID", "Nexus Gateway recovery request must be an object.");
  }
  const request = value as Record<string, unknown>;
  const expectedKeys = new Set([
    "request_id",
    "idempotency_fence",
    "operation",
    "effect_class",
    "recovery_authority_id",
    "recovery_authority_hash",
    "desired_manifest_id",
    "desired_manifest_hash",
    "predecessor_manifest_id",
    "predecessor_manifest_hash",
    "request_hash",
    "schema",
  ]);
  const actualKeys = Object.keys(request);
  if (actualKeys.length !== expectedKeys.size || actualKeys.some((key) => !expectedKeys.has(key))) {
    throw new DurableOperationError("NEXUS_GATEWAY_REQUEST_INVALID", "Nexus Gateway recovery request schema mismatch.");
  }
  for (const key of ["request_id", "idempotency_fence", "recovery_authority_id"] as const) {
    if (typeof request[key] !== "string" || !SAFE_NEXUS_ID.test(request[key] as string)) {
      throw new DurableOperationError("NEXUS_GATEWAY_REQUEST_INVALID", `Invalid Nexus Gateway recovery ${key}.`);
    }
  }
  for (const key of ["desired_manifest_id", "predecessor_manifest_id"] as const) {
    if (typeof request[key] !== "string" || !NEXUS_DEPLOYMENT_ID.test(request[key] as string)) {
      throw new DurableOperationError("NEXUS_GATEWAY_REQUEST_INVALID", `Invalid Nexus Gateway recovery ${key}.`);
    }
  }
  for (const key of [
    "recovery_authority_hash",
    "desired_manifest_hash",
    "predecessor_manifest_hash",
    "request_hash",
  ] as const) {
    if (typeof request[key] !== "string" || !HEX64.test(request[key] as string)) {
      throw new DurableOperationError("NEXUS_GATEWAY_REQUEST_INVALID", `Invalid Nexus Gateway recovery ${key}.`);
    }
  }
  if (request.operation !== "gateway-recover" || request.effect_class !== "GATEWAY_DURABLE_RECOVERY") {
    throw new DurableOperationError("NEXUS_GATEWAY_REQUEST_INVALID", "Nexus Gateway recovery operation/effect mismatch.");
  }
  if (request.schema !== NEXUS_GATEWAY_RECOVERY_SCHEMA) {
    throw new DurableOperationError("NEXUS_GATEWAY_REQUEST_INVALID", "Nexus Gateway recovery schema mismatch.");
  }
  const expectedRequestHash = hashJson({
    request_id: request.request_id,
    idempotency_fence: request.idempotency_fence,
    operation: request.operation,
    effect_class: request.effect_class,
    recovery_authority_id: request.recovery_authority_id,
    recovery_authority_hash: request.recovery_authority_hash,
    desired_manifest_id: request.desired_manifest_id,
    desired_manifest_hash: request.desired_manifest_hash,
    predecessor_manifest_id: request.predecessor_manifest_id,
    predecessor_manifest_hash: request.predecessor_manifest_hash,
  });
  if (request.request_hash !== expectedRequestHash) {
    throw new DurableOperationError("NEXUS_GATEWAY_REQUEST_INVALID", "Nexus Gateway recovery request hash mismatch.");
  }
}

export function assertNexusGatewayRecoveryMaterializationRequest(value: unknown): asserts value is NexusGatewayRecoveryMaterializationRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DurableOperationError("NEXUS_GATEWAY_REQUEST_INVALID", "Nexus Gateway recovery materialization request must be an object.");
  }
  const request = value as Record<string, unknown>;
  const expectedKeys = new Set([
    "request_id",
    "idempotency_fence",
    "operation",
    "effect_class",
    "recovery_authority_id",
    "recovery_authority_hash",
    "request_hash",
    "schema",
  ]);
  const actualKeys = Object.keys(request);
  if (actualKeys.length !== expectedKeys.size || actualKeys.some((key) => !expectedKeys.has(key))) {
    throw new DurableOperationError("NEXUS_GATEWAY_REQUEST_INVALID", "Nexus Gateway recovery materialization request schema mismatch.");
  }
  for (const key of ["request_id", "idempotency_fence", "recovery_authority_id"] as const) {
    if (typeof request[key] !== "string" || !SAFE_NEXUS_ID.test(request[key] as string)) {
      throw new DurableOperationError("NEXUS_GATEWAY_REQUEST_INVALID", `Invalid Nexus Gateway recovery materialization ${key}.`);
    }
  }
  for (const key of ["recovery_authority_hash", "request_hash"] as const) {
    if (typeof request[key] !== "string" || !HEX64.test(request[key] as string)) {
      throw new DurableOperationError("NEXUS_GATEWAY_REQUEST_INVALID", `Invalid Nexus Gateway recovery materialization ${key}.`);
    }
  }
  if (
    request.operation !== "gateway-recovery-materialize"
    || request.effect_class !== "GATEWAY_RECOVERY_MATERIALIZATION"
  ) {
    throw new DurableOperationError("NEXUS_GATEWAY_REQUEST_INVALID", "Nexus Gateway recovery materialization operation/effect mismatch.");
  }
  if (request.schema !== NEXUS_GATEWAY_RECOVERY_MATERIALIZATION_SCHEMA) {
    throw new DurableOperationError("NEXUS_GATEWAY_REQUEST_INVALID", "Nexus Gateway recovery materialization schema mismatch.");
  }
  const expectedRequestHash = hashJson({
    request_id: request.request_id,
    idempotency_fence: request.idempotency_fence,
    operation: request.operation,
    effect_class: request.effect_class,
    recovery_authority_id: request.recovery_authority_id,
    recovery_authority_hash: request.recovery_authority_hash,
  });
  if (request.request_hash !== expectedRequestHash) {
    throw new DurableOperationError("NEXUS_GATEWAY_REQUEST_INVALID", "Nexus Gateway recovery materialization request hash mismatch.");
  }
}



export function validateNexusGatewayPreflightReceipt(outcome: Record<string, unknown>): {
  effectStarted: boolean;
  readiness: string[];
} {
  const effectStarted = outcome.effect_started === true;
  const readinessRaw = outcome.readiness;
  const readiness = Array.isArray(readinessRaw)
    ? readinessRaw.filter((item): item is string => typeof item === "string")
    : [];
  return { effectStarted, readiness };
}

export function validateNexusGatewayRecoveryReceipt(outcome: Record<string, unknown>): NexusGatewayRecoveryReceipt {
  if (outcome.result !== "VERIFIED" || typeof outcome.evidence_hash !== "string" || !HEX64.test(outcome.evidence_hash)) {
    throw new Error("Fixed Nexus Gateway recovery receipt format invalid.");
  }
  return {
    result: "VERIFIED",
    evidence_hash: outcome.evidence_hash,
    ...outcome,
  };
}

export function validateNexusGatewayMaterializationReceipt(
  outcome: Record<string, unknown>,
  expectedRequest: NexusGatewayRecoveryMaterializationRequest,
): NexusGatewayRecoveryMaterializationReceipt {
  if (
    outcome.schema !== NEXUS_GATEWAY_RECOVERY_MATERIALIZATION_RECEIPT_SCHEMA
    || outcome.operation !== "gateway-recovery-materialize"
    || outcome.effect_class !== "GATEWAY_RECOVERY_MATERIALIZATION"
    || outcome.request_id !== expectedRequest.request_id
    || outcome.idempotency_fence !== expectedRequest.idempotency_fence
    || outcome.materialization_request_hash !== expectedRequest.request_hash
    || outcome.recovery_authority_id !== expectedRequest.recovery_authority_id
    || outcome.recovery_authority_hash !== expectedRequest.recovery_authority_hash
    || outcome.effect_started !== false
    || typeof outcome.fresh_main !== "string"
    || typeof outcome.fresh_main_tree !== "string"
    || typeof outcome.materialized_authority_sha256 !== "string"
    || typeof outcome.materialized_request_sha256 !== "string"
    || typeof outcome.receipt_hash !== "string"
  ) {
    throw new Error("Fixed Nexus Gateway recovery materialization receipt format invalid.");
  }
  return outcome as unknown as NexusGatewayRecoveryMaterializationReceipt;
}

export function buildNexusGatewayRecoveryBridgeCode(
  acceptedManagerSha256: string,
  acceptedContractSha256: string,
): string {
  if (!HEX64.test(acceptedManagerSha256) || !HEX64.test(acceptedContractSha256)) {
    throw new Error("Nexus Gateway bridge trust-root hashes must be lowercase SHA-256 values.");
  }
  return String.raw`
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import stat
import subprocess
import sys

STATE = pathlib.Path.home() / "Library" / "Application Support" / "Nexus" / "gateway-direct"
AUTHORITY = STATE / "recovery-authority.json"
MANAGER = STATE / "manager.py"
DEPLOYMENTS = STATE / "deployments"
HEX64 = re.compile(r"^[0-9a-f]{64}$")
HEX40 = re.compile(r"^[0-9a-f]{40}$")
DEPLOYMENT_ID = re.compile(r"^r1-[0-9a-f]{40}$")
REMOTE = "https://github.com/James3014/Nexus-new.git"
ACCEPTED_MANAGER_SHA256 = "${acceptedManagerSha256}"
ACCEPTED_CONTRACT_SHA256 = "${acceptedContractSha256}"


def fail(message):
    raise RuntimeError(message)


def secure_file(path, label):
    if path.is_symlink():
        fail(label + " must not be a symlink")
    info = os.lstat(path)
    if not stat.S_ISREG(info.st_mode):
        fail(label + " must be a regular file")
    if info.st_uid != os.getuid() or (stat.S_IMODE(info.st_mode) & 0o022):
        fail(label + " ownership/mode invalid")


def git(root, *args):
    result = subprocess.run(
        ["/usr/bin/git", "-C", str(root), *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=10,
        check=False,
        env={"PATH": "/usr/bin:/bin:/usr/sbin:/sbin"},
    )
    if result.returncode != 0:
        fail("deployment git verification failed")
    return result.stdout.strip()


try:
    request = json.load(sys.stdin)
    if not isinstance(request, dict):
        fail("recovery request must be an object")
    secure_file(AUTHORITY, "recovery authority")
    secure_file(MANAGER, "manager artifact")
    authority = json.loads(AUTHORITY.read_text(encoding="utf-8"))
    if not isinstance(authority, dict) or authority.get("schema") != "nexus.gateway.durable_recovery_authority.v2":
        fail("recovery authority schema mismatch")
    if authority.get("revocation_state") != "NOT_REVOKED":
        fail("recovery authority is not active")
    manager_hash = authority.get("final_manager_sha256")
    if manager_hash != ACCEPTED_MANAGER_SHA256:
        fail("recovery authority accepted manager hash mismatch")
    if hashlib.sha256(MANAGER.read_bytes()).hexdigest() != ACCEPTED_MANAGER_SHA256:
        fail("manager artifact hash mismatch")

    binding_pairs = (
        ("request_id", "request_id"),
        ("idempotency_fence", "idempotency_fence"),
        ("recovery_authority_id", "receipt_id"),
        ("recovery_authority_hash", "receipt_hash"),
        ("desired_manifest_id", "desired_manifest_id"),
        ("desired_manifest_hash", "desired_manifest_sha256"),
        ("predecessor_manifest_id", "predecessor_manifest_id"),
        ("predecessor_manifest_hash", "predecessor_manifest_sha256"),
    )
    for request_key, authority_key in binding_pairs:
        if request.get(request_key) != authority.get(authority_key):
            fail("request/authority binding mismatch")
    if request.get("operation") != "gateway-recover" or request.get("effect_class") != "GATEWAY_DURABLE_RECOVERY":
        fail("recovery operation/effect mismatch")
    if request.get("schema") != "nexus.gateway.durable_recovery_request.v2":
        fail("recovery request schema mismatch")

    desired_id = authority.get("desired_manifest_id")
    desired_manifest = authority.get("desired_manifest")
    if not isinstance(desired_id, str) or DEPLOYMENT_ID.fullmatch(desired_id) is None:
        fail("desired deployment id invalid")
    if not isinstance(desired_manifest, dict) or desired_manifest.get("deployment_id") != desired_id:
        fail("desired deployment manifest binding mismatch")
    desired_commit = desired_manifest.get("commit")
    desired_tree = desired_manifest.get("tree")
    if not isinstance(desired_commit, str) or HEX40.fullmatch(desired_commit) is None:
        fail("desired deployment commit invalid")
    if not isinstance(desired_tree, str) or HEX40.fullmatch(desired_tree) is None:
        fail("desired deployment tree invalid")

    deployments_root = DEPLOYMENTS.resolve(strict=True)
    desired_root_path = DEPLOYMENTS / desired_id
    if desired_root_path.is_symlink():
        fail("desired deployment root must not be a symlink")
    desired_root = desired_root_path.resolve(strict=True)
    if desired_root.parent != deployments_root or not desired_root.is_dir():
        fail("desired deployment root escaped fixed deployments directory")
    root_info = os.lstat(desired_root)
    if root_info.st_uid != os.getuid() or (stat.S_IMODE(root_info.st_mode) & 0o022):
        fail("desired deployment root ownership/mode invalid")
    if git(desired_root, "rev-parse", "--show-toplevel") != str(desired_root):
        fail("desired deployment toplevel mismatch")
    if git(desired_root, "remote", "get-url", "origin") != REMOTE:
        fail("desired deployment remote mismatch")
    if git(desired_root, "status", "--porcelain"):
        fail("desired deployment is dirty")
    if git(desired_root, "rev-parse", "HEAD") != desired_commit:
        fail("desired deployment commit mismatch")
    if git(desired_root, "rev-parse", "HEAD^{tree}") != desired_tree:
        fail("desired deployment tree mismatch")
    contract_path = desired_root / "nexus" / "contracts" / "gateway_deployment.py"
    secure_file(contract_path, "gateway deployment authority contract")
    if hashlib.sha256(contract_path.read_bytes()).hexdigest() != ACCEPTED_CONTRACT_SHA256:
        fail("gateway deployment authority contract hash mismatch")

    sys.path.insert(0, str(desired_root))
    spec = importlib.util.spec_from_file_location("nexus_gateway_stable_manager", MANAGER)
    if spec is None or spec.loader is None:
        fail("manager import spec unavailable")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    outcome = module._gateway_recover_live(request)
    print(json.dumps(outcome.model_dump(mode="json"), sort_keys=True, separators=(",", ":")))
except Exception as exc:
    print("NEXUS_GATEWAY_BRIDGE_ERROR:" + type(exc).__name__ + ":" + str(exc), file=sys.stderr)
    raise SystemExit(1)
`;
}

export const NEXUS_GATEWAY_RECOVERY_BRIDGE_CODE = buildNexusGatewayRecoveryBridgeCode(
  NEXUS_GATEWAY_ACCEPTED_MANAGER_SHA256,
  NEXUS_GATEWAY_ACCEPTED_CONTRACT_SHA256,
);

export function buildNexusGatewayRecoveryPreflightBridgeCode(
  acceptedManagerSha256: string,
  acceptedContractSha256: string,
): string {
  return String.raw `
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import stat
import subprocess
import sys


STATE = pathlib.Path.home() / "Library" / "Application Support" / "Nexus" / "gateway-direct"
AUTHORITY = STATE / "recovery-authority.json"
MANAGER = STATE / "manager.py"
DEPLOYMENTS = STATE / "deployments"
HEX64 = re.compile(r"^[0-9a-f]{64}$")
HEX40 = re.compile(r"^[0-9a-f]{40}$")
DEPLOYMENT_ID = re.compile(r"^r1-[0-9a-f]{40}$")
REMOTE = "https://github.com/James3014/Nexus-new.git"
ACCEPTED_MANAGER_SHA256 = "${acceptedManagerSha256}"
ACCEPTED_CONTRACT_SHA256 = "${acceptedContractSha256}"


def fail(message):
    raise RuntimeError(message)


def secure_file(path, label):
    if path.is_symlink():
        fail(label + " must not be a symlink")
    info = os.lstat(path)
    if not stat.S_ISREG(info.st_mode):
        fail(label + " must be a regular file")
    if info.st_uid != os.getuid() or (stat.S_IMODE(info.st_mode) & 0o022):
        fail(label + " ownership/mode invalid")


def git(root, *args):
    result = subprocess.run(
        ["/usr/bin/git", "-C", str(root), *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=10,
        check=False,
        env={"PATH": "/usr/bin:/bin:/usr/sbin:/sbin"},
    )
    if result.returncode != 0:
        fail("deployment git verification failed")
    return result.stdout.strip()


try:
    request = json.load(sys.stdin)
    if not isinstance(request, dict):
        fail("recovery request must be an object")
    secure_file(AUTHORITY, "recovery authority")
    secure_file(MANAGER, "manager artifact")
    authority = json.loads(AUTHORITY.read_text(encoding="utf-8"))
    if not isinstance(authority, dict) or authority.get("schema") != "nexus.gateway.durable_recovery_authority.v2":
        fail("recovery authority schema mismatch")
    if authority.get("revocation_state") != "NOT_REVOKED":
        fail("recovery authority is not active")
    manager_hash = authority.get("final_manager_sha256")
    if manager_hash != ACCEPTED_MANAGER_SHA256:
        fail("recovery authority accepted manager hash mismatch")
    if hashlib.sha256(MANAGER.read_bytes()).hexdigest() != ACCEPTED_MANAGER_SHA256:
        fail("manager artifact hash mismatch")

    binding_pairs = (
        ("request_id", "request_id"),
        ("idempotency_fence", "idempotency_fence"),
        ("recovery_authority_id", "receipt_id"),
        ("recovery_authority_hash", "receipt_hash"),
        ("desired_manifest_id", "desired_manifest_id"),
        ("desired_manifest_hash", "desired_manifest_sha256"),
        ("predecessor_manifest_id", "predecessor_manifest_id"),
        ("predecessor_manifest_hash", "predecessor_manifest_sha256"),
    )
    for request_key, authority_key in binding_pairs:
        if request.get(request_key) != authority.get(authority_key):
            fail("request/authority binding mismatch")
    if request.get("operation") != "gateway-recover" or request.get("effect_class") != "GATEWAY_DURABLE_RECOVERY":
        fail("recovery operation/effect mismatch")
    if request.get("schema") != "nexus.gateway.durable_recovery_request.v2":
        fail("recovery request schema mismatch")

    desired_id = authority.get("desired_manifest_id")
    desired_manifest = authority.get("desired_manifest")
    if not isinstance(desired_id, str) or DEPLOYMENT_ID.fullmatch(desired_id) is None:
        fail("desired deployment id invalid")
    if not isinstance(desired_manifest, dict) or desired_manifest.get("deployment_id") != desired_id:
        fail("desired deployment manifest binding mismatch")
    desired_commit = desired_manifest.get("commit")
    desired_tree = desired_manifest.get("tree")
    if not isinstance(desired_commit, str) or HEX40.fullmatch(desired_commit) is None:
        fail("desired deployment commit invalid")
    if not isinstance(desired_tree, str) or HEX40.fullmatch(desired_tree) is None:
        fail("desired deployment tree invalid")

    deployments_root = DEPLOYMENTS.resolve(strict=True)
    desired_root_path = DEPLOYMENTS / desired_id
    if desired_root_path.is_symlink():
        fail("desired deployment root must not be a symlink")
    desired_root = desired_root_path.resolve(strict=True)
    if desired_root.parent != deployments_root or not desired_root.is_dir():
        fail("desired deployment root escaped fixed deployments directory")
    root_info = os.lstat(desired_root)
    if root_info.st_uid != os.getuid() or (stat.S_IMODE(root_info.st_mode) & 0o022):
        fail("desired deployment root ownership/mode invalid")
    if git(desired_root, "rev-parse", "--show-toplevel") != str(desired_root):
        fail("desired deployment toplevel mismatch")
    if git(desired_root, "remote", "get-url", "origin") != REMOTE:
        fail("desired deployment remote mismatch")
    if git(desired_root, "status", "--porcelain"):
        fail("desired deployment is dirty")
    if git(desired_root, "rev-parse", "HEAD") != desired_commit:
        fail("desired deployment commit mismatch")
    if git(desired_root, "rev-parse", "HEAD^{tree}") != desired_tree:
        fail("desired deployment tree mismatch")
    contract_path = desired_root / "nexus" / "contracts" / "gateway_deployment.py"
    secure_file(contract_path, "gateway deployment authority contract")
    if hashlib.sha256(contract_path.read_bytes()).hexdigest() != ACCEPTED_CONTRACT_SHA256:
        fail("gateway deployment authority contract hash mismatch")

    sys.path.insert(0, str(desired_root))
    spec = importlib.util.spec_from_file_location("nexus_gateway_stable_manager", MANAGER)
    if spec is None or spec.loader is None:
        fail("manager import spec unavailable")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    outcome = module.gateway_recover(request)
    print(json.dumps(outcome.model_dump(mode="json"), sort_keys=True, separators=(",", ":")))
except Exception as exc:
    print("NEXUS_GATEWAY_BRIDGE_ERROR:" + type(exc).__name__ + ":" + str(exc), file=sys.stderr)
    raise SystemExit(1)
`;
}

export const NEXUS_GATEWAY_RECOVERY_PREFLIGHT_BRIDGE_CODE = buildNexusGatewayRecoveryPreflightBridgeCode(
  NEXUS_GATEWAY_ACCEPTED_MANAGER_SHA256,
  NEXUS_GATEWAY_ACCEPTED_CONTRACT_SHA256,
);

export async function spawnNexusGatewayRecovery(
  request: NexusGatewayRecoveryRequest,
): Promise<NexusGatewayRecoveryBridgeResult> {
  const maxOutputBytes = 1024 * 1024;
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(NEXUS_GATEWAY_INTERPRETER, ["-I", "-B", "-c", NEXUS_GATEWAY_RECOVERY_BRIDGE_CODE], {
      cwd: homedir(),
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        HOME: homedir(),
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        PYTHONNOUSERSITE: "1",
        PYTHONDONTWRITEBYTECODE: "1",
      },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      rejectPromise(error);
    };
    const appendBounded = (target: "stdout" | "stderr", chunk: unknown) => {
      const next = String(chunk);
      if (Buffer.byteLength((target === "stdout" ? stdout : stderr) + next, "utf8") > maxOutputBytes) {
        rejectOnce(new Error("Fixed Nexus Gateway recovery bridge exceeded bounded output."));
        return;
      }
      if (target === "stdout") stdout += next;
      else stderr += next;
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => appendBounded("stdout", chunk));
    child.stderr.on("data", (chunk) => appendBounded("stderr", chunk));
    child.on("error", (error) => rejectOnce(error));
    child.stdin.on("error", (error) => rejectOnce(error));
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      resolvePromise({ exitCode, stdout, stderr });
    });
    child.stdin.end(JSON.stringify(request));
  });
}

export async function spawnNexusGatewayRecoveryPreflight(
  request: NexusGatewayRecoveryRequest,
): Promise<NexusGatewayRecoveryBridgeResult> {
  const maxOutputBytes = 1024 * 1024;
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(NEXUS_GATEWAY_INTERPRETER, ["-I", "-B", "-c", NEXUS_GATEWAY_RECOVERY_PREFLIGHT_BRIDGE_CODE], {
      cwd: homedir(),
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        HOME: homedir(),
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        PYTHONNOUSERSITE: "1",
        PYTHONDONTWRITEBYTECODE: "1",
      },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      rejectPromise(error);
    };
    const appendBounded = (target: "stdout" | "stderr", chunk: unknown) => {
      const next = String(chunk);
      if (Buffer.byteLength((target === "stdout" ? stdout : stderr) + next, "utf8") > maxOutputBytes) {
        rejectOnce(new Error("Fixed Nexus Gateway recovery preflight bridge exceeded bounded output."));
        return;
      }
      if (target === "stdout") stdout += next;
      else stderr += next;
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => appendBounded("stdout", chunk));
    child.stderr.on("data", (chunk) => appendBounded("stderr", chunk));
    child.on("error", (error) => rejectOnce(error));
    child.stdin.on("error", (error) => rejectOnce(error));
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      resolvePromise({ exitCode, stdout, stderr });
    });
    child.stdin.end(JSON.stringify(request));
  });
}

export function buildNexusGatewayRecoveryMaterializationBridgeCode(): string {
  return String.raw`
import importlib.util
import json
import os
import pathlib
import re
import stat
import sys

STATE = pathlib.Path.home() / "Library" / "Application Support" / "Nexus" / "gateway-direct"
MANAGER = STATE / "manager.py"
AUTHORITY_SOURCE_ROOT = pathlib.Path("/Users/jameschen/Workspace/Nexus-new-authority-main")
SCHEMA = "nexus.gateway.durable_recovery_materialization_request.v1"


def fail(message):
    raise RuntimeError(message)


def secure_file(path, label):
    if path.is_symlink():
        fail(label + " must not be a symlink")
    info = os.lstat(path)
    if not stat.S_ISREG(info.st_mode):
        fail(label + " must be a regular file")
    if info.st_uid != os.getuid() or (stat.S_IMODE(info.st_mode) & 0o022):
        fail(label + " ownership/mode invalid")


try:
    request = json.load(sys.stdin)
    if not isinstance(request, dict):
        fail("materialization request must be an object")
    if request.get("schema") != SCHEMA:
        fail("materialization request schema mismatch")
    if request.get("operation") != "gateway-recovery-materialize" or request.get("effect_class") != "GATEWAY_RECOVERY_MATERIALIZATION":
        fail("materialization operation/effect mismatch")
    for key in ("request_id", "idempotency_fence", "recovery_authority_id"):
        if not isinstance(request.get(key), str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:\-]{0,127}", request[key]):
            fail("materialization " + key + " invalid")
    for key in ("recovery_authority_hash", "request_hash"):
        if not isinstance(request.get(key), str) or not re.fullmatch(r"[0-9a-f]{64}", request[key]):
            fail("materialization " + key + " invalid")
    secure_file(MANAGER, "manager artifact")
    if not AUTHORITY_SOURCE_ROOT.is_dir():
        fail("materialization authority source root unavailable")

    sys.path.insert(0, str(AUTHORITY_SOURCE_ROOT))
    spec = importlib.util.spec_from_file_location("nexus_gateway_stable_manager", MANAGER)
    if spec is None or spec.loader is None:
        fail("manager import spec unavailable")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    outcome = module.gateway_recovery_materialize(request)
    if isinstance(outcome, dict):
        print(json.dumps(outcome, sort_keys=True, separators=(",", ":")))
    elif hasattr(outcome, "model_dump"):
        print(json.dumps(outcome.model_dump(mode="json"), sort_keys=True, separators=(",", ":")))
    else:
        fail("materialization outcome must be a mapping")
except Exception as exc:
    print("NEXUS_GATEWAY_BRIDGE_ERROR:" + type(exc).__name__ + ":" + str(exc), file=sys.stderr)
    raise SystemExit(1)
`;
}

export const NEXUS_GATEWAY_RECOVERY_MATERIALIZATION_BRIDGE_CODE = buildNexusGatewayRecoveryMaterializationBridgeCode();

export async function spawnNexusGatewayRecoveryMaterialize(
  request: NexusGatewayRecoveryMaterializationRequest,
): Promise<NexusGatewayRecoveryBridgeResult> {
  const maxOutputBytes = 1024 * 1024;
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(NEXUS_GATEWAY_INTERPRETER, ["-I", "-B", "-c", NEXUS_GATEWAY_RECOVERY_MATERIALIZATION_BRIDGE_CODE], {
      cwd: homedir(),
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        HOME: homedir(),
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        PYTHONNOUSERSITE: "1",
        PYTHONDONTWRITEBYTECODE: "1",
      },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      rejectPromise(error);
    };
    const appendBounded = (target: "stdout" | "stderr", chunk: unknown) => {
      const next = String(chunk);
      if (Buffer.byteLength((target === "stdout" ? stdout : stderr) + next, "utf8") > maxOutputBytes) {
        rejectOnce(new Error("Fixed Nexus Gateway recovery materialization bridge exceeded bounded output."));
        return;
      }
      if (target === "stdout") stdout += next;
      else stderr += next;
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => appendBounded("stdout", chunk));
    child.stderr.on("data", (chunk) => appendBounded("stderr", chunk));
    child.on("error", (error) => rejectOnce(error));
    child.stdin.on("error", (error) => rejectOnce(error));
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      resolvePromise({ exitCode, stdout, stderr });
    });
    child.stdin.end(JSON.stringify(request));
  });
}

function replayResult(record: DurableOperationRecord): DurableOperationRecord {
  if (record.status === "started") {
    throw new DurableOperationError("OPERATION_IN_PROGRESS", `Operation ${record.operationId} is already started.`, record);
  }
  if (record.status === "outcome_unknown") {
    throw new DurableOperationError(
      "OPERATION_OUTCOME_UNKNOWN",
      `Operation ${record.operationId} has uncertain physical effects; reconcile it instead of replaying mutation.`,
      record,
    );
  }
  return record;
}


function redactSecrets(value: string): string {
  return value
    .replace(/(https?:\/\/)[^/@\s]+@/gi, "$1[redacted]@")
    .replace(/([?&](?:token|access_token|password|secret)=)[^&\s]+/gi, "$1[redacted]");
}

export class NexusRecoveryAdapter {
  private readonly stateRoot: string;
  private readonly runRecoveryRunner: NexusGatewayRecoveryRunner;
  private readonly runPreflightRunner: NexusGatewayRecoveryRunner;
  private readonly runMaterializeRunner: NexusGatewayRecoveryMaterializationRunner;

  constructor(
    private readonly store: DurableOperationStore,
    options?: {
      runRecovery?: NexusGatewayRecoveryRunner;
      runPreflight?: NexusGatewayRecoveryRunner;
      runMaterialize?: NexusGatewayRecoveryMaterializationRunner;
      stateRoot?: string;
    },
  ) {
    this.stateRoot = options?.stateRoot ?? NEXUS_GATEWAY_STATE_ROOT;
    this.runRecoveryRunner = options?.runRecovery ?? spawnNexusGatewayRecovery;
    this.runPreflightRunner = options?.runPreflight ?? spawnNexusGatewayRecoveryPreflight;
    this.runMaterializeRunner = options?.runMaterialize ?? spawnNexusGatewayRecoveryMaterialize;
  }

  async readManagerMaterializationReceipt(
    requestHash: string,
  ): Promise<NexusGatewayRecoveryMaterializationReceipt | null> {
    const receiptPath = join(this.stateRoot, "recovery-materializations", `${requestHash}.json`);
    try {
      const data = await readFile(receiptPath, "utf8");
      const parsed = JSON.parse(data) as Record<string, unknown>;
      if (
        parsed.schema === NEXUS_GATEWAY_RECOVERY_MATERIALIZATION_RECEIPT_SCHEMA
        && parsed.materialization_request_hash === requestHash
      ) {
        return parsed as unknown as NexusGatewayRecoveryMaterializationReceipt;
      }
      return null;
    } catch {
      return null;
    }
  }

  async recover(input: {
    attemptKey: string;
    request: NexusGatewayRecoveryRequest;
  }): Promise<DurableOperationRecord> {
    assertAttemptKey(input.attemptKey);
    assertNexusGatewayRecoveryRequest(input.request);

    const request = {
      recoveryRequest: input.request,
      scopeRoot: this.stateRoot,
      authorityMode: "NEXUS_GOVERNED" as const,
    };
    const requestHash = hashJson(request);
    const operationId = stableOperationId("nexus_gateway_recover", this.stateRoot, input.attemptKey);
    const existing = this.store.getByAttempt(this.stateRoot, input.attemptKey);
    if (existing) {
      if (existing.requestHash !== requestHash || existing.kind !== "nexus_gateway_recover") {
        throw new DurableOperationError(
          "OPERATION_REPLAY_CONFLICT",
          `attemptKey '${input.attemptKey}' is already bound to a materially different ${existing.kind} request.`,
          existing,
        );
      }
      return replayResult(existing);
    }

    const { record, created } = this.store.createOrReplay({
      operationId,
      attemptKey: input.attemptKey,
      requestHash,
      kind: "nexus_gateway_recover",
      authorityMode: "NEXUS_GOVERNED",
      scopeRoot: this.stateRoot,
      request,
    });
    if (!created) return replayResult(record);
    return await this.executeRecovery(operationId, input.request, false);
  }

  async preflight(input: {
    attemptKey: string;
    request: NexusGatewayRecoveryRequest;
  }): Promise<NexusGatewayPreflightResult> {
    assertAttemptKey(input.attemptKey);
    assertNexusGatewayRecoveryRequest(input.request);

    let bridge: NexusGatewayRecoveryBridgeResult;
    try {
      bridge = await this.runPreflightRunner(input.request);
    } catch (error) {
      return {
        status: "error",
        effectStarted: false,
        readiness: [],
        errorMessage: redactSecrets(error instanceof Error ? error.message : String(error)),
      };
    }

    if (bridge.exitCode !== 0) {
      return {
        status: "error",
        effectStarted: false,
        readiness: [],
        errorMessage: redactSecrets(
          bridge.stderr.trim() || `Preflight bridge exited ${String(bridge.exitCode)}.`,
        ),
      };
    }

    let outcome: Record<string, unknown>;
    try {
      const parsed = JSON.parse(bridge.stdout);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("outcome must be an object");
      outcome = parsed as Record<string, unknown>;
    } catch (error) {
      return {
        status: "error",
        effectStarted: false,
        readiness: [],
        errorMessage: `Preflight bridge returned malformed outcome JSON: ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
      };
    }

    const effectStarted = Boolean(outcome.effect_started);
    const result = String(outcome.result ?? "");
    const physicalObservation = (outcome.physical_observation ?? {}) as Record<string, unknown>;
    const readiness = Array.isArray(physicalObservation.readiness)
      ? (physicalObservation.readiness as unknown[]).map(String)
      : [];

    if (effectStarted) {
      return {
        status: "error",
        effectStarted: true,
        readiness,
        errorMessage: "Preflight must not start effects; gateway_recover() started an effect.",
      };
    }

    if (result !== "BLOCKED") {
      return {
        status: "error",
        effectStarted,
        readiness,
        errorMessage: `Preflight expected result=BLOCKED, got '${redactSecrets(result)}'.`,
      };
    }

    return {
      status: "passed",
      effectStarted: false,
      readiness,
      outcome,
    };
  }

  async preflightStart(input: {
    attemptKey: string;
    request: NexusGatewayRecoveryRequest;
  }): Promise<DurableOperationRecord> {
    assertAttemptKey(input.attemptKey);
    assertNexusGatewayRecoveryRequest(input.request);

    const request = {
      recoveryRequest: input.request,
      scopeRoot: this.stateRoot,
      authorityMode: "NEXUS_GOVERNED" as const,
    };
    const requestHash = hashJson(request);
    const operationId = stableOperationId(
      "nexus_gateway_recovery_preflight",
      this.stateRoot,
      input.attemptKey,
    );
    const existing = this.store.getByAttempt(this.stateRoot, input.attemptKey);
    if (existing) {
      if (
        existing.requestHash !== requestHash
        || existing.kind !== "nexus_gateway_recovery_preflight"
      ) {
        throw new DurableOperationError(
          "OPERATION_REPLAY_CONFLICT",
          `attemptKey '${input.attemptKey}' is already bound to a materially different ${existing.kind} request.`,
          existing,
        );
      }
      return existing;
    }

    const { record, created } = this.store.createOrReplay({
      operationId,
      attemptKey: input.attemptKey,
      requestHash,
      kind: "nexus_gateway_recovery_preflight",
      authorityMode: "NEXUS_GOVERNED",
      scopeRoot: this.stateRoot,
      request,
    });
    if (created) {
      void this.executePreflight(
        operationId,
        input.request,
        false,
      ).catch((error) => {
        try {
          const current = this.store.getByOperationId(operationId);
          if (current?.status !== "started") return;
          this.store.finish(operationId, {
            status: "outcome_unknown",
            retrySafe: false,
            errorCode: "RECONCILIATION_REQUIRED",
            errorMessage:
              `Durable Gateway preflight background execution was interrupted: ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
          });
        } catch {
          // ignore background store finish errors
        }
      });
    }
    return record;
  }

  async materialize(input: {
    attemptKey: string;
    request: NexusGatewayRecoveryMaterializationRequest;
  }): Promise<DurableOperationRecord> {
    assertAttemptKey(input.attemptKey);
    assertNexusGatewayRecoveryMaterializationRequest(input.request);

    const request = {
      materializationRequest: input.request,
      scopeRoot: this.stateRoot,
      authorityMode: "NEXUS_GOVERNED" as const,
    };
    const requestHash = hashJson(request);
    const operationId = stableOperationId(
      "nexus_gateway_recovery_materialize",
      this.stateRoot,
      input.attemptKey,
    );
    const existing = this.store.getByAttempt(this.stateRoot, input.attemptKey);
    if (existing) {
      if (
        existing.requestHash !== requestHash
        || existing.kind !== "nexus_gateway_recovery_materialize"
      ) {
        throw new DurableOperationError(
          "OPERATION_REPLAY_CONFLICT",
          `attemptKey '${input.attemptKey}' is already bound to a materially different ${existing.kind} request.`,
          existing,
        );
      }
      return replayResult(existing);
    }

    const { record, created } = this.store.createOrReplay({
      operationId,
      attemptKey: input.attemptKey,
      requestHash,
      kind: "nexus_gateway_recovery_materialize",
      authorityMode: "NEXUS_GOVERNED",
      scopeRoot: this.stateRoot,
      request,
    });
    if (!created) return replayResult(record);
    return await this.executeMaterialize(operationId, input.request, false);
  }

  async reconcile(record: DurableOperationRecord): Promise<DurableOperationRecord> {
    if (
      record.kind === "nexus_gateway_recovery_preflight"
      && record.status === "started"
    ) {
      throw new DurableOperationError(
        "OPERATION_IN_PROGRESS",
        `Gateway preflight ${record.operationId} is still running; read operation_status instead of starting a second preflight.`,
        record,
      );
    }
    if (record.status !== "outcome_unknown" && record.status !== "started") return record;

    if (record.kind === "nexus_gateway_recovery_preflight") {
      const recoveryRequest = record.request.recoveryRequest;
      assertNexusGatewayRecoveryRequest(recoveryRequest);
      return await this.executePreflight(
        record.operationId,
        recoveryRequest,
        true,
      );
    }

    if (record.kind === "nexus_gateway_recover") {
      const recoveryRequest = record.request.recoveryRequest;
      assertNexusGatewayRecoveryRequest(recoveryRequest);
      return await this.executeRecovery(record.operationId, recoveryRequest, true);
    }

    if (record.kind === "nexus_gateway_recovery_materialize") {
      const materializationRequest = record.request.materializationRequest;
      assertNexusGatewayRecoveryMaterializationRequest(materializationRequest);
      return await this.executeMaterialize(
        record.operationId,
        materializationRequest,
        true,
      );
    }

    throw new DurableOperationError("RECONCILIATION_REQUIRED", `Unsupported recovery operation kind: ${record.kind}`);
  }

  private async executeRecovery(
    operationId: string,
    request: NexusGatewayRecoveryRequest,
    reconciled: boolean,
  ): Promise<DurableOperationRecord> {
    let bridge: NexusGatewayRecoveryBridgeResult;
    try {
      bridge = await this.runRecoveryRunner(request);
    } catch (error) {
      return this.store.finish(operationId, {
        status: "outcome_unknown",
        retrySafe: false,
        errorCode: "NEXUS_GATEWAY_RECOVERY_UNCERTAIN",
        errorMessage: redactSecrets(error instanceof Error ? error.message : String(error)),
        receipt: { reconciled, bridge: "transport_error" },
      });
    }

    if (bridge.exitCode !== 0) {
      return this.store.finish(operationId, {
        status: "outcome_unknown",
        retrySafe: false,
        errorCode: "NEXUS_GATEWAY_RECOVERY_UNCERTAIN",
        errorMessage: redactSecrets(
          bridge.stderr.trim() || `Fixed Nexus Gateway recovery bridge exited ${String(bridge.exitCode)}.`,
        ),
        receipt: { reconciled, exitCode: bridge.exitCode },
      });
    }

    let outcome: Record<string, unknown>;
    try {
      const parsed = JSON.parse(bridge.stdout);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("outcome must be an object");
      outcome = parsed as Record<string, unknown>;
    } catch (error) {
      return this.store.finish(operationId, {
        status: "outcome_unknown",
        retrySafe: false,
        errorCode: "NEXUS_GATEWAY_RECOVERY_UNCERTAIN",
        errorMessage: `Nexus Gateway recovery bridge returned malformed outcome JSON: ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
        receipt: { reconciled, exitCode: bridge.exitCode },
      });
    }

    const result = String(outcome.result ?? "");
    const receipt = { reconciled, exitCode: bridge.exitCode, nexusOutcome: outcome };
    if (result === "VERIFIED") {
      return this.store.finish(operationId, { status: "succeeded", retrySafe: false, receipt });
    }
    if (result === "BLOCKED" || result === "ROLLED_BACK") {
      return this.store.finish(operationId, {
        status: "failed",
        retrySafe: false,
        errorCode: "NEXUS_GATEWAY_RECOVERY_FAILED",
        errorMessage: `Nexus Gateway recovery ended ${result}.`,
        receipt,
      });
    }
    return this.store.finish(operationId, {
      status: "outcome_unknown",
      retrySafe: false,
      errorCode: "NEXUS_GATEWAY_RECOVERY_UNCERTAIN",
      errorMessage: result === "UNCERTAIN_EFFECT"
        ? "Nexus Gateway recovery reported UNCERTAIN_EFFECT; reconcile the same durable request before any replay."
        : `Nexus Gateway recovery returned unrecognized result '${redactSecrets(result)}'.`,
      receipt,
    });
  }

  private async executePreflight(
    operationId: string,
    request: NexusGatewayRecoveryRequest,
    reconciled: boolean,
  ): Promise<DurableOperationRecord> {
    const preflight = await this.preflight({
      attemptKey: operationId,
      request,
    });
    const receipt = {
      reconciled,
      requestHash: request.request_hash,
      preflight,
    };
    if (preflight.status === "passed") {
      return this.store.finish(operationId, {
        status: "succeeded",
        retrySafe: false,
        receipt,
      });
    }
    return this.store.finish(operationId, {
      status: "failed",
      retrySafe: false,
      errorCode: "NEXUS_GATEWAY_PREFLIGHT_FAILED",
      errorMessage: preflight.errorMessage
        ?? "Nexus Gateway recovery preflight failed closed.",
      receipt,
    });
  }

  private async executeMaterialize(
    operationId: string,
    request: NexusGatewayRecoveryMaterializationRequest,
    reconciled: boolean,
  ): Promise<DurableOperationRecord> {
    // Check manager-owned durable state first (R2 — manager-owned replay & reconciliation)
    const existingManagerReceipt = await this.readManagerMaterializationReceipt(request.request_hash);
    if (existingManagerReceipt) {
      if (
        existingManagerReceipt.schema === NEXUS_GATEWAY_RECOVERY_MATERIALIZATION_RECEIPT_SCHEMA
        && existingManagerReceipt.effect_started === false
        && typeof existingManagerReceipt.receipt_hash === "string"
        && HEX64.test(existingManagerReceipt.receipt_hash)
      ) {
        const receipt = {
          reconciled: true,
          exitCode: 0,
          nexusOutcome: existingManagerReceipt,
        };
        return this.store.finish(operationId, {
          status: "succeeded",
          retrySafe: false,
          receipt,
        });
      }
    }

    let bridge: NexusGatewayRecoveryBridgeResult;
    try {
      bridge = await this.runMaterializeRunner(request);
    } catch (error) {
      // Check if manager finished writing the receipt before the crash
      const postCrashReceipt = await this.readManagerMaterializationReceipt(request.request_hash);
      if (postCrashReceipt) {
        if (
          postCrashReceipt.schema === NEXUS_GATEWAY_RECOVERY_MATERIALIZATION_RECEIPT_SCHEMA
          && postCrashReceipt.effect_started === false
          && typeof postCrashReceipt.receipt_hash === "string"
          && HEX64.test(postCrashReceipt.receipt_hash)
        ) {
          const receipt = {
            reconciled: true,
            exitCode: 0,
            nexusOutcome: postCrashReceipt,
          };
          return this.store.finish(operationId, {
            status: "succeeded",
            retrySafe: false,
            receipt,
          });
        }
      }
      return this.store.finish(operationId, {
        status: "outcome_unknown",
        retrySafe: false,
        errorCode: "NEXUS_GATEWAY_MATERIALIZATION_UNCERTAIN",
        errorMessage: redactSecrets(error instanceof Error ? error.message : String(error)),
        receipt: { reconciled, bridge: "transport_error" },
      });
    }

    if (bridge.exitCode !== 0) {
      const postFailReceipt = await this.readManagerMaterializationReceipt(request.request_hash);
      if (postFailReceipt) {
        if (
          postFailReceipt.schema === NEXUS_GATEWAY_RECOVERY_MATERIALIZATION_RECEIPT_SCHEMA
          && postFailReceipt.effect_started === false
          && typeof postFailReceipt.receipt_hash === "string"
          && HEX64.test(postFailReceipt.receipt_hash)
        ) {
          const receipt = {
            reconciled: true,
            exitCode: 0,
            nexusOutcome: postFailReceipt,
          };
          return this.store.finish(operationId, {
            status: "succeeded",
            retrySafe: false,
            receipt,
          });
        }
      }
      return this.store.finish(operationId, {
        status: "outcome_unknown",
        retrySafe: false,
        errorCode: "NEXUS_GATEWAY_MATERIALIZATION_UNCERTAIN",
        errorMessage: redactSecrets(
          bridge.stderr.trim() || `Fixed Nexus Gateway recovery materialization bridge exited ${String(bridge.exitCode)}.`,
        ),
        receipt: { reconciled, exitCode: bridge.exitCode },
      });
    }

    let outcome: Record<string, unknown>;
    try {
      const parsed = JSON.parse(bridge.stdout);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("outcome must be an object");
      outcome = parsed as Record<string, unknown>;
    } catch (error) {
      return this.store.finish(operationId, {
        status: "outcome_unknown",
        retrySafe: false,
        errorCode: "NEXUS_GATEWAY_MATERIALIZATION_UNCERTAIN",
        errorMessage: `Nexus Gateway recovery materialization bridge returned malformed outcome JSON: ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
        receipt: { reconciled, exitCode: bridge.exitCode },
      });
    }

    const receipt = {
      reconciled,
      exitCode: bridge.exitCode,
      nexusOutcome: outcome,
    };
    if (
      outcome.schema === NEXUS_GATEWAY_RECOVERY_MATERIALIZATION_RECEIPT_SCHEMA
      && outcome.effect_started === false
      && typeof outcome.receipt_hash === "string"
      && HEX64.test(outcome.receipt_hash)
    ) {
      return this.store.finish(operationId, { status: "succeeded", retrySafe: false, receipt });
    }
    return this.store.finish(operationId, {
      status: "failed",
      retrySafe: false,
      errorCode: "NEXUS_GATEWAY_MATERIALIZATION_FAILED",
      errorMessage: "Nexus Gateway recovery materialization failed closed: receipt must be typed, effect-free, and hash-bound.",
      receipt,
    });
  }
}
