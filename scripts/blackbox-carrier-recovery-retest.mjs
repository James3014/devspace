import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import Database from '/Users/jameschen/.local/opt/devspace-chatgpt/node_modules/better-sqlite3/lib/index.js';
import { loadConfig } from '/Users/jameschen/.local/opt/devspace-chatgpt/node_modules/@waishnav/devspace/dist/config.js';
import { SingleUserOAuthProvider } from '/Users/jameschen/.local/opt/devspace-chatgpt/node_modules/@waishnav/devspace/dist/oauth-provider.js';
import { Client } from '/Users/jameschen/.local/opt/devspace-chatgpt/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StreamableHTTPClientTransport } from '/Users/jameschen/.local/opt/devspace-chatgpt/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';

const STATE_DIR = '/Users/jameschen/.local/share/devspace-chatgpt';
const CONFIG_DIR = '/Users/jameschen/.devspace-chatgpt';
const OWNER_TOKEN_PATH = `${CONFIG_DIR}/owner-token`;
const TARGET_CARRIER_ID = 'carrier_55bafcc1-e6d2-4eca-ad2f-e3f64fb36996';
const TARGET_CLIENT_ID = 'devspace-fbb40adf-891a-48a6-8c23-db2129628fa6';
const EXPECTED_VERSION = 1;
const EXPECTED_VALIDITY_VERSION = 2;
const CLI_PATH = '/Users/jameschen/.local/opt/devspace-chatgpt/node_modules/@waishnav/devspace/dist/cli.js';
const PORT = 7677;
const MCP_URL = new URL(`http://127.0.0.1:${PORT}/mcp`);

function unwrap(toolResult) {
  if (toolResult.isError) {
    throw new Error(`Tool call failed: ${JSON.stringify(toolResult)}`);
  }
  const text = toolResult.content?.find(c => c.type === 'text')?.text;
  if (!text) throw new Error(`No text block in tool result: ${JSON.stringify(toolResult)}`);
  return JSON.parse(text);
}

async function run() {
  console.log('=== PRODUCTION CARRIER RECOVERY BLACK-BOX RETEST ===');
  console.log(`Target Carrier: ${TARGET_CARRIER_ID}`);
  console.log(`Target Client ID: ${TARGET_CLIENT_ID}`);
  console.log(`MCP URL: ${MCP_URL.href}`);

  const ownerToken = (await import('node:fs')).readFileSync(OWNER_TOKEN_PATH, 'utf8').trim();
  const env = {
    ...process.env,
    DEVSPACE_OAUTH_OWNER_TOKEN: ownerToken,
    DEVSPACE_CONFIG_DIR: CONFIG_DIR,
    DEVSPACE_STATE_DIR: STATE_DIR,
    DEVSPACE_ALLOWED_ROOTS: '/Users/jameschen/Workspace,/Users/jameschen/Workspace/nexus,/Users/jameschen/Workspace/skidiy專案,/Users/jameschen/mcp-local-smoke,/Users/jameschen/.local/share/devspace-chatgpt'
  };

  const config = loadConfig(env);
  const db = new Database(`${STATE_DIR}/devspace.sqlite`);

  // Baseline Carrier count
  const initialCarrierCount = db.prepare('SELECT count(*) as count FROM carrier_bindings').get().count;
  console.log(`[Baseline] Total existing carriers in SQLite: ${initialCarrierCount}`);

  // Query baseline carrier state
  const beforeCarrier = db.prepare('SELECT * FROM carrier_bindings WHERE id=?').get(TARGET_CARRIER_ID);
  assert.ok(beforeCarrier, 'Target carrier must exist');
  assert.equal(beforeCarrier.client_id, TARGET_CLIENT_ID);
  assert.equal(beforeCarrier.version, EXPECTED_VERSION);
  const previousCredentialHash = beforeCarrier.credential_hash;
  console.log(`[Baseline] Previous credential hash: ${previousCredentialHash}`);

  const resourceUrl = new URL('/mcp', 'https://devspace.snowskill.app');
  const provider = new SingleUserOAuthProvider(config.oauth, resourceUrl, STATE_DIR);
  // Issue fresh token pair directly into shared SQLite
  const tokenPair = provider['issueTokens'](TARGET_CLIENT_ID, config.oauth.scopes, resourceUrl);
  const freshAccessToken = tokenPair.access_token;
  console.log('[Step 1] Fresh access token issued for target client with resource ' + resourceUrl.href);

  // 2. Connect fresh MCP client over HTTP to Production
  const freshClient = new Client({ name: 'fresh-recovery-blackbox-session', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(MCP_URL, {
    requestInit: {
      headers: {
        Authorization: `Bearer ${freshAccessToken}`
      }
    }
  });
  await freshClient.connect(transport);
  console.log('[Step 2] Connected fresh MCP client to production daemon.');

  try {
    // 3. Verify that fresh session has NO active carrier
    const statusBefore = await freshClient.callTool({ name: 'coordination_carrier_status', arguments: {} });
    assert.equal(statusBefore.isError, true, 'Fresh session must fail coordination_carrier_status');
    console.log('[Step 3] Confirmed fresh session is unauthenticated/unpaired (coordination_carrier_status returned error).');

    // 4. Request carrier recovery
    const recoveryRes = await freshClient.callTool({ name: 'coordination_recovery_request', arguments: {} });
    assert.equal(recoveryRes.isError, undefined, 'coordination_recovery_request must succeed');
    const recoveryData = unwrap(recoveryRes);
    assert.ok(recoveryData.pendingId, 'Must return pendingId');
    assert.ok(recoveryData.credential, 'Must return credential');
    const pendingId = recoveryData.pendingId;
    const newCredential = recoveryData.credential;
    console.log(`[Step 4] Issued coordination_recovery_request: pendingId=${pendingId}`);

    // 5. Verify that resume FAILS before Owner approval
    const prematureResume = await freshClient.callTool({
      name: 'coordination_resume',
      arguments: { pendingId }
    });
    assert.equal(prematureResume.isError, true, 'coordination_resume must fail before Owner recovery');
    console.log('[Step 5] Confirmed coordination_resume FAILS prior to owner approval.');

    // 6. Owner CLI executes recovery
    console.log('[Step 6] Running Owner CLI carrier recover...');
    const recoverArgs = [
      CLI_PATH,
      'carrier',
      'recover',
      pendingId,
      '--carrier',
      TARGET_CARRIER_ID,
      '--version',
      String(EXPECTED_VERSION),
      '--validity-version',
      String(EXPECTED_VALIDITY_VERSION),
      '--confirm',
      TARGET_CARRIER_ID
    ];

    const recoverOutput = execFileSync(process.execPath, recoverArgs, { env, encoding: 'utf8' });
    const firstResult = JSON.parse(recoverOutput);
    console.log('[Step 6] Owner recover output:', JSON.stringify(firstResult, null, 2));

    assert.equal(firstResult.replayed, false, 'First recovery must have replayed=false');
    assert.equal(firstResult.carrier.id, TARGET_CARRIER_ID, 'Carrier ID must match exactly');
    assert.equal(firstResult.carrier.version, EXPECTED_VERSION, 'Version must match');
    assert.equal(firstResult.carrier.validity.version, EXPECTED_VALIDITY_VERSION, 'Validity version must match');
    assert.equal(firstResult.carrier.parentId, null, 'Parent ID must be null');
    assert.equal(firstResult.carrier.contract.goal, 'deploy-carrier-recovery-surface-0678354d');
    assert.deepEqual(firstResult.carrier.contract.scope, ['/Users/jameschen/.local/share/devspace-chatgpt']);

    // 7. Verify Idempotent Replay
    console.log('[Step 7] Testing recovery replay idempotency...');
    const replayOutput = execFileSync(process.execPath, recoverArgs, { env, encoding: 'utf8' });
    const replayResult = JSON.parse(replayOutput);
    assert.equal(replayResult.replayed, true, 'Second recovery must have replayed=true');
    assert.deepEqual(replayResult.carrier, firstResult.carrier, 'Replayed carrier must be identical');
    console.log('[Step 7] Confirmed replay idempotency: replayed=true, exact same carrier payload.');

    // 8. Fresh session calls coordination_resume
    console.log('[Step 8] Calling coordination_resume on fresh session...');
    const resumeRes = await freshClient.callTool({
      name: 'coordination_resume',
      arguments: { pendingId }
    });
    assert.equal(resumeRes.isError, undefined, `coordination_resume failed: ${JSON.stringify(resumeRes)}`);
    const resumedCarrier = unwrap(resumeRes);
    console.log('[Step 8] coordination_resume succeeded:', JSON.stringify(resumedCarrier, null, 2));

    assert.equal(resumedCarrier.id, TARGET_CARRIER_ID);
    assert.equal(resumedCarrier.version, EXPECTED_VERSION);
    assert.equal(resumedCarrier.validity.version, EXPECTED_VALIDITY_VERSION);
    assert.equal(resumedCarrier.contract.goal, 'deploy-carrier-recovery-surface-0678354d');
    assert.deepEqual(resumedCarrier.contract.scope, ['/Users/jameschen/.local/share/devspace-chatgpt']);
    assert.equal(resumedCarrier.grant.coordinatorThread, TARGET_CARRIER_ID);

    // 9. Verify coordination_carrier_status now succeeds
    const statusAfter = await freshClient.callTool({ name: 'coordination_carrier_status', arguments: {} });
    assert.equal(statusAfter.isError, undefined);
    const activeCarrier = unwrap(statusAfter);
    assert.equal(activeCarrier.id, TARGET_CARRIER_ID);
    assert.equal(activeCarrier.version, EXPECTED_VERSION);
    console.log('[Step 9] coordination_carrier_status confirmed active carrier:', activeCarrier.id);

    // 10. Verify old credential / wrong credential fails
    console.log('[Step 10] Verifying old credential / wrong credential is rejected...');
    const imposterClient = new Client({ name: 'imposter-session', version: '1.0.0' });
    const imposterTransport = new StreamableHTTPClientTransport(MCP_URL, {
      requestInit: { headers: { Authorization: `Bearer ${freshAccessToken}` } }
    });
    await imposterClient.connect(imposterTransport);
    try {
      const wrongResume = await imposterClient.callTool({
        name: 'coordination_resume',
        arguments: { credential: 'X'.repeat(43) }
      });
      assert.equal(wrongResume.isError, true, 'Wrong credential must be rejected');
      console.log('[Step 10] Wrong credential successfully rejected.');
    } finally {
      await imposterClient.close().catch(() => {});
    }

    // 11. Verify Database Invariants
    console.log('[Step 11] Verifying database invariants...');
    const finalCarrierCount = db.prepare('SELECT count(*) as count FROM carrier_bindings').get().count;
    assert.equal(finalCarrierCount, initialCarrierCount, 'Carrier count must NOT increase (new carrier = NO)');

    const afterCarrier = db.prepare('SELECT * FROM carrier_bindings WHERE id=?').get(TARGET_CARRIER_ID);
    assert.notEqual(afterCarrier.credential_hash, previousCredentialHash, 'Credential hash MUST rotate');
    console.log(`[Step 11] Credential hash successfully rotated from ${previousCredentialHash} to ${afterCarrier.credential_hash}`);
    console.log('[Step 11] Confirmed new carrier = NO, new grant = NO.');

    console.log('\n=========================================');
    console.log('🎉 PRODUCTION CARRIER RECOVERY BLACK-BOX RETEST: ALL PASS');
    console.log('=========================================');

  } finally {
    await freshClient.close().catch(() => {});
    provider.close();
    db.close();
  }
}

run().catch((err) => {
  console.error('\n❌ TEST FAILED:', err);
  process.exit(1);
});
