import type Database from "better-sqlite3";

export type OwnerApprovalReceiptStatus =
  | "PENDING_OWNER_APPROVAL"
  | "APPROVED"
  | "REJECTED"
  | "EXPIRED"
  | "CONTRACT_MISMATCH";

export interface OwnerApprovalPairingProjection {
  pendingId: string;
  clientId: string;
  sessionId: string;
  expiresAtMs: number;
  carrierId?: string;
}

export interface OwnerApprovalReceiptProjection {
  pendingId: string;
  clientId: string;
  sessionId: string;
  contractHash: string;
  contractJson: string;
  expiresAtMs: number;
  status: OwnerApprovalReceiptStatus;
  carrierId?: string;
  createdAt: string;
  updatedAt: string;
  decidedAt?: string;
}

interface ReceiptRow {
  pending_id: string;
  client_id: string;
  session_id: string;
  contract_hash: string;
  contract_json: string;
  expires_at: number;
  status: "PENDING" | "APPROVED" | "REJECTED";
  carrier_id: string | null;
  created_at: string;
  updated_at: string;
  decided_at: string | null;
}

interface PairingRow {
  id: string;
  client_id: string;
  session_id: string;
  expires_at: number;
  binding_id: string | null;
}

export class OwnerCarrierApprovalReceiptStore {
  constructor(
    private readonly sqlite: Database.Database,
    private readonly now: () => number = Date.now,
  ) {}

  pairing(pendingId: string): OwnerApprovalPairingProjection | undefined {
    const row = this.sqlite.prepare(
      "select id,client_id,session_id,expires_at,binding_id from carrier_pairings where id=?",
    ).get(pendingId) as PairingRow | undefined;
    if (!row) return undefined;
    return {
      pendingId: row.id,
      clientId: row.client_id,
      sessionId: row.session_id,
      expiresAtMs: row.expires_at,
      ...(row.binding_id ? { carrierId: row.binding_id } : {}),
    };
  }

  read(pendingId: string): OwnerApprovalReceiptProjection | undefined {
    const row = this.sqlite.prepare(
      "select pending_id,client_id,session_id,contract_hash,contract_json,expires_at,status,carrier_id,created_at,updated_at,decided_at from carrier_owner_approval_receipts where pending_id=?",
    ).get(pendingId) as ReceiptRow | undefined;
    return row ? this.project(row) : undefined;
  }

  ensurePending(input: {
    pendingId: string;
    clientId: string;
    sessionId: string;
    contractHash: string;
    contractJson: string;
    expiresAtMs: number;
  }): OwnerApprovalReceiptProjection {
    return this.sqlite.transaction(() => {
      const existing = this.read(input.pendingId);
      if (existing) {
        if (
          existing.clientId !== input.clientId ||
          existing.sessionId !== input.sessionId ||
          existing.contractHash !== input.contractHash ||
          existing.contractJson !== input.contractJson
        ) {
          return { ...existing, status: "CONTRACT_MISMATCH" as const };
        }
        return existing;
      }
      const now = new Date(this.now()).toISOString();
      this.sqlite.prepare(
        "insert into carrier_owner_approval_receipts(pending_id,client_id,session_id,contract_hash,contract_json,expires_at,status,carrier_id,created_at,updated_at,decided_at) values(?,?,?,?,?,?,'PENDING',null,?,?,null)",
      ).run(
        input.pendingId,
        input.clientId,
        input.sessionId,
        input.contractHash,
        input.contractJson,
        input.expiresAtMs,
        now,
        now,
      );
      return this.read(input.pendingId)!;
    }).immediate();
  }

  markRejected(input: {
    pendingId: string;
    clientId: string;
    sessionId: string;
    contractHash: string;
  }): OwnerApprovalReceiptProjection {
    return this.sqlite.transaction(() => {
      const current = this.requireExact(input);
      if (current.status === "APPROVED" || current.status === "REJECTED" || current.status === "EXPIRED") return current;
      const decidedAt = new Date(this.now()).toISOString();
      const changed = this.sqlite.prepare(
        "update carrier_owner_approval_receipts set status='REJECTED',updated_at=?,decided_at=? where pending_id=? and status='PENDING' and client_id=? and session_id=? and contract_hash=?",
      ).run(decidedAt, decidedAt, input.pendingId, input.clientId, input.sessionId, input.contractHash);
      if (changed.changes !== 1) return this.requireExact(input);
      return this.read(input.pendingId)!;
    }).immediate();
  }

  markApproved(input: {
    pendingId: string;
    clientId: string;
    sessionId: string;
    contractHash: string;
    carrierId: string;
  }): OwnerApprovalReceiptProjection {
    return this.sqlite.transaction(() => {
      const current = this.requireExact(input);
      if (current.status === "APPROVED") {
        if (current.carrierId !== input.carrierId) {
          return { ...current, status: "CONTRACT_MISMATCH" as const };
        }
        return current;
      }
      if (current.status === "REJECTED" || current.status === "EXPIRED") return current;
      const decidedAt = new Date(this.now()).toISOString();
      const changed = this.sqlite.prepare(
        "update carrier_owner_approval_receipts set status='APPROVED',carrier_id=?,updated_at=?,decided_at=? where pending_id=? and status='PENDING' and client_id=? and session_id=? and contract_hash=?",
      ).run(input.carrierId, decidedAt, decidedAt, input.pendingId, input.clientId, input.sessionId, input.contractHash);
      if (changed.changes !== 1) return this.requireExact(input);
      return this.read(input.pendingId)!;
    }).immediate();
  }

  reconcileApproved(input: {
    pendingId: string;
    clientId: string;
    sessionId: string;
    contractHash: string;
    contractJson: string;
    expiresAtMs: number;
    carrierId: string;
  }): OwnerApprovalReceiptProjection {
    return this.sqlite.transaction(() => {
      const existing = this.read(input.pendingId);
      if (!existing) {
        const now = new Date(this.now()).toISOString();
        this.sqlite.prepare(
          "insert into carrier_owner_approval_receipts(pending_id,client_id,session_id,contract_hash,contract_json,expires_at,status,carrier_id,created_at,updated_at,decided_at) values(?,?,?,?,?,?,'APPROVED',?,?,?,?)",
        ).run(
          input.pendingId,
          input.clientId,
          input.sessionId,
          input.contractHash,
          input.contractJson,
          input.expiresAtMs,
          input.carrierId,
          now,
          now,
          now,
        );
        return this.read(input.pendingId)!;
      }
      if (
        existing.clientId !== input.clientId ||
        existing.sessionId !== input.sessionId ||
        existing.contractHash !== input.contractHash ||
        existing.contractJson !== input.contractJson
      ) {
        return { ...existing, status: "CONTRACT_MISMATCH" as const };
      }
      if (existing.status === "APPROVED" && existing.carrierId === input.carrierId) return existing;
      const decidedAt = new Date(this.now()).toISOString();
      this.sqlite.prepare(
        "update carrier_owner_approval_receipts set status='APPROVED',carrier_id=?,updated_at=?,decided_at=? where pending_id=?",
      ).run(input.carrierId, decidedAt, decidedAt, input.pendingId);
      return this.read(input.pendingId)!;
    }).immediate();
  }

  private requireExact(input: {
    pendingId: string;
    clientId: string;
    sessionId: string;
    contractHash: string;
  }): OwnerApprovalReceiptProjection {
    const current = this.read(input.pendingId);
    if (!current) throw new Error("OWNER_APPROVAL_RECEIPT_MISSING");
    if (
      current.clientId !== input.clientId ||
      current.sessionId !== input.sessionId ||
      current.contractHash !== input.contractHash
    ) {
      return { ...current, status: "CONTRACT_MISMATCH" as const };
    }
    return current;
  }

  private project(row: ReceiptRow): OwnerApprovalReceiptProjection {
    const status: OwnerApprovalReceiptStatus =
      row.status === "PENDING" && row.expires_at <= this.now()
        ? "EXPIRED"
        : row.status === "PENDING"
          ? "PENDING_OWNER_APPROVAL"
          : row.status;
    return {
      pendingId: row.pending_id,
      clientId: row.client_id,
      sessionId: row.session_id,
      contractHash: row.contract_hash,
      contractJson: row.contract_json,
      expiresAtMs: row.expires_at,
      status,
      ...(row.carrier_id ? { carrierId: row.carrier_id } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.decided_at ? { decidedAt: row.decided_at } : {}),
    };
  }
}
