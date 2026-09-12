import { foreignKey, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const workspaceSessions = sqliteTable(
  "workspace_sessions",
  {
    id: text("id").primaryKey(),
    root: text("root").notNull(),
    status: text("status").notNull().default("active"),
    mode: text("mode").notNull().default("checkout"),
    sourceRoot: text("source_root"),
    baseRef: text("base_ref"),
    baseSha: text("base_sha"),
    managed: text("managed").notNull().default("false"),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at").notNull(),
  },
  (table) => [
    index("workspace_sessions_root_idx").on(table.root, table.lastUsedAt),
    index("workspace_sessions_status_idx").on(table.status, table.lastUsedAt),
  ],
);

export const loadedAgentFiles = sqliteTable(
  "loaded_agent_files",
  {
    workspaceSessionId: text("workspace_session_id")
      .notNull()
      .references(() => workspaceSessions.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    contentHash: text("content_hash").notNull(),
    content: text("content").notNull(),
    loadedAt: text("loaded_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceSessionId, table.path] }),
    index("loaded_agent_files_path_idx").on(table.path),
  ],
);

export const workspaceConversationBindings = sqliteTable(
  "workspace_conversation_bindings",
  {
    conversationScopeId: text("conversation_scope_id").notNull(),
    targetKey: text("target_key").notNull(),
    workspaceSessionId: text("workspace_session_id")
      .notNull()
      .references(() => workspaceSessions.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.conversationScopeId, table.targetKey] }),
    index("workspace_conversation_bindings_workspace_idx").on(table.workspaceSessionId),
  ],
);

export const oauthClients = sqliteTable(
  "oauth_clients",
  {
    clientId: text("client_id").primaryKey(),
    clientJson: text("client_json").notNull(),
    issuedAt: integer("issued_at").notNull(),
  },
);

export const oauthAccessTokens = sqliteTable(
  "oauth_access_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    scopesJson: text("scopes_json").notNull(),
    expiresAt: integer("expires_at").notNull(),
    resource: text("resource"),
  },
);

export const oauthRefreshTokens = sqliteTable(
  "oauth_refresh_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    scopesJson: text("scopes_json").notNull(),
    expiresAt: integer("expires_at").notNull(),
    resource: text("resource"),
  },
);

export const localAgentSessions = sqliteTable(
  "local_agent_sessions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id"),
    workspaceRoot: text("workspace_root").notNull(),
    profileName: text("profile_name").notNull(),
    provider: text("provider").notNull(),
    model: text("model"),
    effort: text("effort"),
    providerSessionId: text("provider_session_id"),
    workerPid: integer("worker_pid"),
    workerToken: text("worker_token"),
    executionContract: text("execution_contract"),
    executionGeneration: text("execution_generation"),
    terminalReason: text("terminal_reason"),
    scopeState: text("scope_state"),
    scopeBaseline: text("scope_baseline"),
    status: text("status").notNull(),
    latestResponse: text("latest_response"),
    error: text("error"),
    errorCode: text("error_code"),
    errorRetryable: text("error_retryable"),
    errorDetails: text("error_details"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("local_agent_sessions_workspace_id_idx").on(table.workspaceId, table.updatedAt),
    index("local_agent_sessions_workspace_root_idx").on(table.workspaceRoot, table.updatedAt),
    index("local_agent_sessions_provider_session_id_idx").on(table.providerSessionId),
  ],
);

export type WorkspaceSessionRow = typeof workspaceSessions.$inferSelect;
export type NewWorkspaceSessionRow = typeof workspaceSessions.$inferInsert;
export type LoadedAgentFileRow = typeof loadedAgentFiles.$inferSelect;
export type NewLoadedAgentFileRow = typeof loadedAgentFiles.$inferInsert;
export type WorkspaceConversationBindingRow = typeof workspaceConversationBindings.$inferSelect;
export type NewWorkspaceConversationBindingRow = typeof workspaceConversationBindings.$inferInsert;
export const durableOperations = sqliteTable(
  "durable_operations",
  {
    operationId: text("operation_id").primaryKey(),
    attemptKey: text("attempt_key").notNull(),
    requestHash: text("request_hash").notNull(),
    kind: text("kind").notNull(),
    authorityMode: text("authority_mode").notNull(),
    scopeRoot: text("scope_root").notNull(),
    workspaceId: text("workspace_id"),
    status: text("status").notNull(),
    retrySafe: text("retry_safe").notNull(),
    requestJson: text("request_json").notNull(),
    receiptJson: text("receipt_json"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("durable_operations_status_idx").on(table.status, table.updatedAt),
  ],
);

export const chatSwarms = sqliteTable(
  "chat_swarms",
  {
    id: text("id").primaryKey(),
    status: text("status").notNull(),
    ownerIdentityFingerprint: text("owner_identity_fingerprint").notNull(),
    workerLimit: integer("worker_limit").notNull(),
    inviteCredentialHash: text("invite_credential_hash"),
    metadataJson: text("metadata_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("chat_swarms_status_idx").on(table.status, table.updatedAt)],
);

export const chatSwarmWorkers = sqliteTable(
  "chat_swarm_workers",
  {
    id: text("id").primaryKey(),
    swarmId: text("swarm_id").notNull().references(() => chatSwarms.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    runtimeKind: text("runtime_kind").notNull(),
    sessionIdentityFingerprint: text("session_identity_fingerprint"),
    carrierConversationFingerprint: text("carrier_conversation_fingerprint"),
    lifecycleState: text("lifecycle_state").notNull(),
    currentTaskId: text("current_task_id"),
    leaseJson: text("lease_json"),
    checkpointJson: text("checkpoint_json"),
    continuationEpoch: integer("continuation_epoch").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("chat_swarm_workers_swarm_idx").on(table.swarmId, table.updatedAt),
    index("chat_swarm_workers_task_idx").on(table.currentTaskId),
    foreignKey((): any => ({ columns: [table.currentTaskId], foreignColumns: [chatSwarmTasks.id], name: "chat_swarm_workers_current_task_fk" })),
  ],
);

export const chatSwarmTasks = sqliteTable(
  "chat_swarm_tasks",
  {
    id: text("id").primaryKey(),
    swarmId: text("swarm_id").notNull().references(() => chatSwarms.id, { onDelete: "cascade" }),
    taskKey: text("task_key").notNull(),
    requestHash: text("request_hash").notNull(),
    prompt: text("prompt").notNull(),
    payloadJson: text("payload_json").notNull(),
    preferredWorkerId: text("preferred_worker_id"),
    assignedWorkerId: text("assigned_worker_id"),
    lifecycleState: text("lifecycle_state").notNull(),
    result: text("result"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    retrySafe: text("retry_safe").notNull(),
    reconciliationJson: text("reconciliation_json"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    completedAt: text("completed_at"),
    collectedAt: text("collected_at"),
  },
  (table) => [
    index("chat_swarm_tasks_swarm_state_idx").on(table.swarmId, table.lifecycleState, table.updatedAt),
    index("chat_swarm_tasks_worker_state_idx").on(table.assignedWorkerId, table.lifecycleState),
    uniqueIndex("chat_swarm_tasks_replay_idx").on(table.swarmId, table.taskKey),
    uniqueIndex("chat_swarm_tasks_one_active_worker_idx").on(table.assignedWorkerId).where(sql`${table.assignedWorkerId} is not null and ${table.lifecycleState} in ('CLAIMED', 'RUNNING', 'CANCEL_REQUESTED', 'RECONCILE_REQUIRED')`),
    foreignKey({ columns: [table.preferredWorkerId] as [typeof table.preferredWorkerId], foreignColumns: [chatSwarmWorkers.id] as [typeof chatSwarmWorkers.id], name: "chat_swarm_tasks_preferred_worker_fk" }),
    foreignKey({ columns: [table.assignedWorkerId] as [typeof table.assignedWorkerId], foreignColumns: [chatSwarmWorkers.id] as [typeof chatSwarmWorkers.id], name: "chat_swarm_tasks_assigned_worker_fk" }),
  ],
);

export const chatSwarmAttempts = sqliteTable(
  "chat_swarm_attempts",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull().references(() => chatSwarmTasks.id, { onDelete: "cascade" }),
    attemptNumber: integer("attempt_number").notNull(),
    runtimeKind: text("runtime_kind").notNull(),
    effectState: text("effect_state").notNull(),
    runtimeReceiptJson: text("runtime_receipt_json"),
    startedAt: text("started_at"),
    acknowledgedAt: text("acknowledged_at"),
    finishedAt: text("finished_at"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("chat_swarm_attempts_task_idx").on(table.taskId, table.attemptNumber),
    index("chat_swarm_attempts_effect_idx").on(table.effectState),
    uniqueIndex("chat_swarm_attempts_ordinal_idx").on(table.taskId, table.attemptNumber),
  ],
);

export const chatSwarmCarrierOperations = sqliteTable(
  "chat_swarm_carrier_operations",
  {
    operationId: text("operation_id").primaryKey(),
    operationKey: text("operation_key").notNull(),
    slotKey: text("slot_key").notNull().unique(),
    swarmId: text("swarm_id").notNull().references(() => chatSwarms.id, { onDelete: "cascade" }),
    workerId: text("worker_id").notNull().references(() => chatSwarmWorkers.id, { onDelete: "cascade" }),
    taskId: text("task_id").references(() => chatSwarmTasks.id, { onDelete: "cascade" }),
    attemptId: text("attempt_id").references(() => chatSwarmAttempts.id, { onDelete: "cascade" }),
    carrierKind: text("carrier_kind").notNull(),
    carrierFingerprint: text("carrier_fingerprint").notNull(),
    bindingEpoch: integer("binding_epoch").notNull(),
    adapterConfigHash: text("adapter_config_hash").notNull(),
    kind: text("kind").notNull(),
    state: text("state").notNull(),
    requestJson: text("request_json").notNull(),
    receiptJson: text("receipt_json"),
    version: integer("version").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("chat_swarm_carrier_operations_worker_idx").on(table.workerId, table.bindingEpoch, table.updatedAt)],
);

export type LocalAgentSessionRow = typeof localAgentSessions.$inferSelect;
export type NewLocalAgentSessionRow = typeof localAgentSessions.$inferInsert;
export type DurableOperationRow = typeof durableOperations.$inferSelect;
export type NewDurableOperationRow = typeof durableOperations.$inferInsert;
export type ChatSwarmRow = typeof chatSwarms.$inferSelect;
export type NewChatSwarmRow = typeof chatSwarms.$inferInsert;
export type ChatSwarmWorkerRow = typeof chatSwarmWorkers.$inferSelect;
export type NewChatSwarmWorkerRow = typeof chatSwarmWorkers.$inferInsert;
export type ChatSwarmTaskRow = typeof chatSwarmTasks.$inferSelect;
export type NewChatSwarmTaskRow = typeof chatSwarmTasks.$inferInsert;
export type ChatSwarmAttemptRow = typeof chatSwarmAttempts.$inferSelect;
export type NewChatSwarmAttemptRow = typeof chatSwarmAttempts.$inferInsert;
