import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { migrateDatabase } from "./migrations.js";

test("migration lineage keeps v21 immutable and advances rebind schema at v22", () => {
  const sqlite = new Database(":memory:");
  try {
    migrateDatabase(sqlite);
    const migrations = sqlite.prepare(
      "select version, name from devspace_schema_migrations where version in (21, 22) order by version",
    ).all() as Array<{ version: number; name: string }>;
    assert.deepEqual(migrations, [
      { version: 21, name: "core-mutation-caller-rebinds" },
      { version: 22, name: "core-mutation-session-rebinds" },
    ]);
    const tables = sqlite.prepare(
      "select name from sqlite_master where type = 'table' and name in ('core_mutation_caller_rebinds', 'core_mutation_session_rebinds') order by name",
    ).all() as Array<{ name: string }>;
    assert.deepEqual(tables.map((row) => row.name), [
      "core_mutation_caller_rebinds",
      "core_mutation_session_rebinds",
    ]);
  } finally {
    sqlite.close();
  }
});

test("v22 repairs a database that already recorded the legacy v21 migration", () => {
  const sqlite = new Database(":memory:");
  try {
    migrateDatabase(sqlite);
    sqlite.exec(`
      drop table core_mutation_session_rebinds;
      delete from devspace_schema_migrations where version = 22;

      insert into workspace_sessions (
        id, root, status, mode, managed, created_at, last_used_at
      ) values (
        'ws_legacy', '/tmp/ws_legacy', 'active', 'checkout', 'false',
        '2026-09-24T13:00:00.000Z', '2026-09-24T14:01:00.000Z'
      );

      insert into core_mutation_sessions (
        id, workspace_session_id, actor_key, binding_id, operation_id, attempt_id,
        binding_hash, binding_json, source_head, source_tree, status,
        freshness_state, rebind_state, writer_reconciliation_state,
        writer_domains_json, created_at, updated_at
      ) values (
        'cms_legacy',
        'ws_legacy',
        'openai:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        'binding-legacy',
        'operation-legacy',
        'attempt-legacy',
        'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        '{}',
        '1111111111111111111111111111111111111111',
        '2222222222222222222222222222222222222222',
        'ACTIVE',
        'FRESH',
        'BOUND_CURRENT',
        'CLEAR',
        '[]',
        '2026-09-24T13:00:00.000Z',
        '2026-09-24T14:01:00.000Z'
      );

      insert into core_mutation_caller_rebinds values (
        'legacy-r1',
        'cms_legacy',
        'ws_legacy',
        'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'openai:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        'openai:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        '2026-09-24T14:00:00.000Z',
        '2026-09-24T14:01:00.000Z',
        1,
        1,
        '2026-09-24T14:01:00.000Z'
      );
    `);

    migrateDatabase(sqlite);

    const v22 = sqlite.prepare(
      "select name from devspace_schema_migrations where version = 22",
    ).get() as { name: string };
    assert.equal(v22.name, "core-mutation-session-rebinds");

    const migrated = sqlite.prepare(
      "select rebind_id, session_id, from_actor_key, to_actor_key, binding_hash, evidence, created_at from core_mutation_session_rebinds where rebind_id = 'legacy-r1'",
    ).get() as {
      rebind_id: string;
      session_id: string;
      from_actor_key: string;
      to_actor_key: string;
      binding_hash: string;
      evidence: string;
      created_at: string;
    };
    assert.equal(migrated.rebind_id, "legacy-r1");
    assert.equal(migrated.session_id, "cms_legacy");
    assert.match(migrated.from_actor_key, /^openai:b+$/);
    assert.match(migrated.to_actor_key, /^openai:c+$/);
    assert.equal(
      migrated.binding_hash,
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    assert.match(migrated.evidence, /Migrated legacy caller rebind audit/);
    assert.match(migrated.evidence, /workspace_session_id=ws_legacy/);
    assert.equal(migrated.created_at, "2026-09-24T14:01:00.000Z");

    migrateDatabase(sqlite);
    const count = sqlite.prepare(
      "select count(*) as count from core_mutation_session_rebinds where rebind_id = 'legacy-r1'",
    ).get() as { count: number };
    assert.equal(count.count, 1);
  } finally {
    sqlite.close();
  }
});
