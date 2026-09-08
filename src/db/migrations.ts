import type Database from "better-sqlite3";

interface Migration {
  version: number;
  name: string;
  up(sqlite: Database.Database): void;
}

const migrations: Migration[] = [
  {
    version: 1,
    name: "workspace-state",
    up: migrateWorkspaceState,
  },
  {
    version: 2,
    name: "oauth-state",
    up: migrateOAuthState,
  },
  {
    version: 3,
    name: "local-agent-sessions",
    up: migrateLocalAgentSessions,
  },
  {
    version: 4,
    name: "workspace-conversation-bindings",
    up: migrateWorkspaceConversationBindings,
  },
  {
    version: 5,
    name: "local-agent-structured-errors",
    up: migrateLocalAgentStructuredErrors,
  },
  {
    version: 6,
    name: "local-agent-effort-rename",
    up: migrateLocalAgentEffortRename,
  },
  {
    version: 7,
    name: "local-agent-worker-ownership",
    up: migrateLocalAgentWorkerOwnership,
  },
  {
    version: 8,
    name: "local-agent-execution-contract",
    up: migrateLocalAgentExecutionContract,
  },
  {
    version: 9,
    name: "local-agent-lifecycle-state",
    up: migrateLocalAgentLifecycleState,
  },
  {
    version: 10,
    name: "local-agent-error-details",
    up: migrateLocalAgentErrorDetails,
  },
  {
    version: 11,
    name: "local-agent-execution-generation",
    up: migrateLocalAgentExecutionGeneration,
  },
  {
    version: 12,
    name: "durable-operations",
    up: migrateDurableOperations,
  },
  {
    version: 13,
    name: "chat-swarm-core",
    up: migrateChatSwarmCore,
  },
  {
    version: 14,
    name: "chat-swarm-runtime-owner",
    up: migrateChatSwarmRuntimeOwner,
  },
];

export function migrateDatabase(sqlite: Database.Database): void {
  const migrate = sqlite.transaction(() => {
    sqlite.exec(`
      create table if not exists devspace_schema_migrations (
        version integer primary key,
        name text not null,
        applied_at text not null
      );
    `);

    const applied = new Set(
      (
        sqlite.prepare("select version from devspace_schema_migrations").all() as Array<{
          version: number;
        }>
      ).map((row) => row.version),
    );
    const recordMigration = sqlite.prepare(
      "insert into devspace_schema_migrations (version, name, applied_at) values (?, ?, ?)",
    );

    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      migration.up(sqlite);
      recordMigration.run(migration.version, migration.name, new Date().toISOString());
    }
  });

  migrate.immediate();
}

function migrateWorkspaceState(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists workspace_sessions (
      id text primary key,
      root text not null,
      status text not null default 'active',
      mode text not null default 'checkout',
      source_root text,
      base_ref text,
      base_sha text,
      managed text not null default 'false',
      created_at text not null,
      last_used_at text not null
    );

    create index if not exists workspace_sessions_root_idx
      on workspace_sessions(root, last_used_at desc);

    create index if not exists workspace_sessions_status_idx
      on workspace_sessions(status, last_used_at desc);

    create table if not exists loaded_agent_files (
      workspace_session_id text not null,
      path text not null,
      content_hash text not null,
      content text not null,
      loaded_at text not null,
      last_seen_at text not null,
      primary key (workspace_session_id, path),
      foreign key (workspace_session_id)
        references workspace_sessions(id)
        on delete cascade
    );

    create index if not exists loaded_agent_files_path_idx
      on loaded_agent_files(path);
  `);

  addColumnIfMissing(sqlite, "workspace_sessions", "mode", "text not null default 'checkout'");
  addColumnIfMissing(sqlite, "workspace_sessions", "source_root", "text");
  addColumnIfMissing(sqlite, "workspace_sessions", "base_ref", "text");
  addColumnIfMissing(sqlite, "workspace_sessions", "base_sha", "text");
  addColumnIfMissing(sqlite, "workspace_sessions", "managed", "text not null default 'false'");
}

function migrateOAuthState(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists oauth_clients (
      client_id text primary key,
      client_json text not null,
      issued_at integer not null
    );

    create index if not exists oauth_clients_issued_at_idx
      on oauth_clients(issued_at desc);

    create table if not exists oauth_access_tokens (
      token_hash text primary key,
      client_id text not null,
      scopes_json text not null,
      expires_at integer not null,
      resource text,
      foreign key (client_id) references oauth_clients(client_id) on delete cascade
    );

    create index if not exists oauth_access_tokens_client_id_idx
      on oauth_access_tokens(client_id);

    create index if not exists oauth_access_tokens_expires_at_idx
      on oauth_access_tokens(expires_at);

    create table if not exists oauth_refresh_tokens (
      token_hash text primary key,
      client_id text not null,
      scopes_json text not null,
      expires_at integer not null,
      resource text,
      foreign key (client_id) references oauth_clients(client_id) on delete cascade
    );

    create index if not exists oauth_refresh_tokens_client_id_idx
      on oauth_refresh_tokens(client_id);

    create index if not exists oauth_refresh_tokens_expires_at_idx
      on oauth_refresh_tokens(expires_at);
  `);
}

function migrateLocalAgentSessions(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists local_agent_sessions (
      id text primary key,
      workspace_id text,
      workspace_root text not null,
      profile_name text not null,
      provider text not null,
      model text,
      effort text,
      provider_session_id text,
      status text not null,
      latest_response text,
      error text,
      created_at text not null,
      updated_at text not null
    );

    create index if not exists local_agent_sessions_workspace_id_idx
      on local_agent_sessions(workspace_id, updated_at desc);

    create index if not exists local_agent_sessions_workspace_root_idx
      on local_agent_sessions(workspace_root, updated_at desc);

    create index if not exists local_agent_sessions_provider_session_id_idx
      on local_agent_sessions(provider_session_id);
  `);

  addColumnIfMissing(sqlite, "local_agent_sessions", "effort", "text");
}

function migrateLocalAgentWorkerOwnership(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "local_agent_sessions", "worker_pid", "integer");
  addColumnIfMissing(sqlite, "local_agent_sessions", "worker_token", "text");
}

function migrateLocalAgentExecutionContract(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "local_agent_sessions", "execution_contract", "text");
  addColumnIfMissing(sqlite, "local_agent_sessions", "terminal_reason", "text");
  addColumnIfMissing(sqlite, "local_agent_sessions", "scope_state", "text");
  addColumnIfMissing(sqlite, "local_agent_sessions", "scope_baseline", "text");
}

function migrateLocalAgentLifecycleState(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "local_agent_sessions", "lifecycle_state", "text");
}

function migrateWorkspaceConversationBindings(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists workspace_conversation_bindings (
      conversation_scope_id text not null,
      target_key text not null,
      workspace_session_id text not null,
      created_at text not null,
      last_used_at text not null,
      primary key (conversation_scope_id, target_key),
      foreign key (workspace_session_id)
        references workspace_sessions(id)
        on delete cascade
    );

    create index if not exists workspace_conversation_bindings_workspace_idx
      on workspace_conversation_bindings(workspace_session_id);
  `);
}

function migrateLocalAgentStructuredErrors(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "local_agent_sessions", "error_code", "text");
  addColumnIfMissing(sqlite, "local_agent_sessions", "error_retryable", "text");
}

function migrateLocalAgentErrorDetails(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "local_agent_sessions", "error_details", "text");
}

function migrateLocalAgentExecutionGeneration(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "local_agent_sessions", "execution_generation", "text");
}

function migrateDurableOperations(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists durable_operations (
      operation_id text primary key,
      attempt_key text not null,
      request_hash text not null,
      kind text not null,
      authority_mode text not null,
      scope_root text not null,
      workspace_id text,
      status text not null,
      retry_safe text not null,
      request_json text not null,
      receipt_json text,
      error_code text,
      error_message text,
      created_at text not null,
      updated_at text not null
    );

    create unique index if not exists durable_operations_attempt_idx
      on durable_operations(scope_root, attempt_key);

    create index if not exists durable_operations_status_idx
      on durable_operations(status, updated_at desc);
  `);
}

function migrateChatSwarmCore(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists chat_swarms (
      id text primary key,
      status text not null,
      owner_identity_fingerprint text not null,
      worker_limit integer not null,
      invite_credential_hash text,
      metadata_json text not null,
      created_at text not null,
      updated_at text not null
    );
    create index if not exists chat_swarms_status_idx on chat_swarms(status, updated_at desc);

    create table if not exists chat_swarm_workers (
      id text primary key,
      swarm_id text not null references chat_swarms(id) on delete cascade,
      label text not null,
      runtime_kind text not null,
      session_identity_fingerprint text,
      carrier_conversation_fingerprint text,
      lifecycle_state text not null,
      current_task_id text,
      lease_json text,
      checkpoint_json text,
      continuation_epoch integer not null,
      created_at text not null,
      updated_at text not null
      ,foreign key (current_task_id) references chat_swarm_tasks(id)
    );
    create index if not exists chat_swarm_workers_swarm_idx on chat_swarm_workers(swarm_id, updated_at desc);
    create index if not exists chat_swarm_workers_task_idx on chat_swarm_workers(current_task_id);

    create table if not exists chat_swarm_tasks (
      id text primary key,
      swarm_id text not null references chat_swarms(id) on delete cascade,
      task_key text not null,
      request_hash text not null,
      prompt text not null,
      payload_json text not null,
      preferred_worker_id text,
      assigned_worker_id text,
      lifecycle_state text not null,
      result text,
      error_code text,
      error_message text,
      retry_safe text not null,
      reconciliation_json text,
      created_at text not null,
      updated_at text not null,
      completed_at text,
      collected_at text,
      unique (swarm_id, task_key),
      foreign key (preferred_worker_id) references chat_swarm_workers(id),
      foreign key (assigned_worker_id) references chat_swarm_workers(id)
    );
    create index if not exists chat_swarm_tasks_swarm_state_idx on chat_swarm_tasks(swarm_id, lifecycle_state, updated_at desc);
    create index if not exists chat_swarm_tasks_worker_state_idx on chat_swarm_tasks(assigned_worker_id, lifecycle_state);
    create unique index if not exists chat_swarm_tasks_replay_idx on chat_swarm_tasks(swarm_id, task_key);
    create unique index if not exists chat_swarm_tasks_one_active_worker_idx
      on chat_swarm_tasks(assigned_worker_id)
      where assigned_worker_id is not null and lifecycle_state in ('CLAIMED', 'RUNNING', 'CANCEL_REQUESTED', 'RECONCILE_REQUIRED');

    create table if not exists chat_swarm_attempts (
      id text primary key,
      task_id text not null references chat_swarm_tasks(id) on delete cascade,
      attempt_number integer not null,
      runtime_kind text not null,
      effect_state text not null,
      runtime_receipt_json text,
      started_at text,
      acknowledged_at text,
      finished_at text,
      created_at text not null,
      unique (task_id, attempt_number)
    );
    create index if not exists chat_swarm_attempts_task_idx on chat_swarm_attempts(task_id, attempt_number);
    create index if not exists chat_swarm_attempts_effect_idx on chat_swarm_attempts(effect_state);
    create unique index if not exists chat_swarm_attempts_ordinal_idx on chat_swarm_attempts(task_id, attempt_number);
  `);
}

function migrateChatSwarmRuntimeOwner(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists chat_swarm_runtime_owner (
      singleton_id integer primary key check (singleton_id = 1),
      owner_token text not null,
      pid integer not null,
      state_dir text not null,
      acquired_at text not null
    );
  `);
}

function migrateLocalAgentEffortRename(sqlite: Database.Database): void {
  const columns = sqlite.prepare("pragma table_info(local_agent_sessions)").all() as Array<{
    name: string;
  }>;
  const names = new Set(columns.map((column) => column.name));
  if (names.has("effort")) {
    if (names.has("thinking")) {
      sqlite.exec(`
        update local_agent_sessions
        set effort = thinking
        where effort is null and thinking is not null
      `);
    }
    return;
  }
  if (!names.has("thinking")) {
    addColumnIfMissing(sqlite, "local_agent_sessions", "effort", "text");
    return;
  }
  sqlite.exec("alter table local_agent_sessions rename column thinking to effort");
}

function addColumnIfMissing(
  sqlite: Database.Database,
  table: "workspace_sessions" | "local_agent_sessions",
  column: string,
  definition: string,
): void {
  const columns = sqlite.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((existingColumn) => existingColumn.name === column)) return;

  sqlite.exec(`alter table ${table} add column ${column} ${definition}`);
}
