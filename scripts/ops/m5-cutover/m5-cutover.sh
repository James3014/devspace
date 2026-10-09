#!/usr/bin/env bash
# m5-cutover.sh <full-sha|origin/main> [--skip-build]
# Governed DevSpace cutover orchestrator. Run ON Dev M5 as the service user. Re-running resumes; it never
# re-issues cutover_start for an existing generation (the sidecar decides, see README.md).
set -Eeuo pipefail
export PATH="/opt/homebrew/bin:$HOME/.npm-global/bin:/usr/local/bin:$PATH"

SRC_REPO="${DEVSPACE_BUILD_READY_SRC:-$HOME/Workspace/devspace}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
W="$HOME/.devspace/worktrees"
EV_DIR="$HOME/.devspace/build-ready"
# Overridable: DEVSPACE_BUILD_READY_ROOT, DEVSPACE_SERVICE_ROOT, DEVSPACE_STATE_DIR, DEVSPACE_LAUNCHD_LABEL.
CURRENT_ROOT="${DEVSPACE_BUILD_READY_ROOT:-$W/devspace-build-ready-current}"
SVC="${DEVSPACE_SERVICE_ROOT:-$HOME/.local/share/devspace-service}"
STATE_DIR="${DEVSPACE_STATE_DIR:-${STATE_DIR:-$HOME/.local/share/devspace}}"
LAUNCHD_LABEL="${DEVSPACE_LAUNCHD_LABEL:-com.james.devspace-serve}"
BIN="${DEVSPACE_OPS_BIN:-$SCRIPT_DIR}"
CONFIG_JSON="$HOME/.devspace/config.json"
HEALTH_URL="http://127.0.0.1:7676/healthz"
PUBLIC_URL="https://devmini.snowskill.app"
WITNESS_WORKSPACE_ID="${WITNESS_WORKSPACE_ID:-ws_2a861da43e}"
WITNESS_AGENT_ID="${WITNESS_AGENT_ID:-agt_c58e7609}"

say() { printf '[m5-cutover %s] %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
STAGE="init"
SHA=""; SHA8=""; R=""; CID=""; CVER="1"; CKPT=""
declare -a SUMMARY=()
row() { SUMMARY+=("$(printf '%-22s %s' "$1" "$2")"); }
ckpt() { STAGE="$1"; say "step: $1"; [ -z "$CKPT" ] || printf '%s %s\n' "$(date -u +%FT%TZ)" "$1" >> "$CKPT"; }

# Active generation summary: prints "none" or "phase|activation(0/1)|cutoverId|expSha|expBuild|expManifest".
active_summary() {
  python3 - "$R" "$CONFIG_JSON" "$SVC" "$STATE_DIR" <<'PY'
import json, os, subprocess, sys, glob
r, cfgp, svc, default_sd = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
out = subprocess.run(["node", f"{r}/dist/cli.js", "cutover", "status", "--json"], capture_output=True, text=True,
                     cwd=svc)
try:
    a = (json.loads(out.stdout) or {}).get("active")
except Exception:
    print("unknown"); sys.exit(0)
if not a or a.get("phase") in (None, "closed"):
    print("none"); sys.exit(0)
exp = a.get("expectedNewIdentity")
act = bool(a.get("activationBinding"))
if exp is None:
    try:
        cfg = json.load(open(cfgp))
    except Exception:
        cfg = {}
    sd = os.path.expanduser(cfg.get("stateDir", default_sd))
    try:
        exp = json.load(open(f"{sd}/cutover/active/created.json")).get("expectedNewIdentity", {})
    except Exception:
        exp = {}
    act = act or os.path.exists(f"{sd}/cutover/active/activation-binding.json")
print("|".join([a.get("phase", "?"), "1" if act else "0", a.get("cutoverId", "?"),
                exp.get("sourceCommit", ""), exp.get("buildId", ""), exp.get("capabilityManifestSha256", "")]))
PY
}

health_field() { # health_field <python expr over h>
  curl -fsS --max-time 8 -H 'Connection: close' "$HEALTH_URL" | python3 -c "import sys,json;h=json.load(sys.stdin);b=h['build'];m=h['mcp'];print($1)"
}

hint() {
  local rc="${1:-1}"
  trap - ERR
  say "FAILED at stage '$STAGE' (rc=$rc)"
  local s; s="$(active_summary 2>/dev/null || echo unknown)"
  say "active generation: $s"
  case "$s" in
    none) say "HINT: no active generation. Safe to re-run: m5-cutover.sh ${SHA:-<sha>}" ;;
    prepared*) say "HINT: prepared. If expired: node \$R/dist/cli.js cutover abort-expired-prepared --cutover-id <id> --carrier ${CID:-<cid>} --version ${CVER} --validity-version 1 --confirm <id>; else wait for expiry. Use a new attemptKey afterwards." ;;
    drained\|0*) say "HINT: drained, no activation. Do NOT rerun the sidecar. Expired: recover-expired-drained. Unexpired: carrier rotate-credential + cutover restart-bound (runbook s8)." ;;
    drained\|1*) say "HINT: drained with activation. Re-run this script: it resumes at restart (old live) or finish (target live). Never cutover_start." ;;
    *) say "HINT: inspect 'node \$R/dist/cli.js cutover status --json' and the runbook section 8 recovery matrix." ;;
  esac
  [ -z "$SHA8" ] || [ ! -f "$W/m5-cutover-$SHA8-sidecar.log" ] || { say "sidecar log tail:"; tail -n 8 "$W/m5-cutover-$SHA8-sidecar.log" | cut -c1-400; }
  exit "$rc"
}
trap 'hint $?' ERR
die() { say "ERROR: $*"; hint 1; }

# ---------- args ----------
SKIP_BUILD=0; ARG=""
for a in "$@"; do
  case "$a" in
    --skip-build) SKIP_BUILD=1 ;;
    -*) die "unknown option $a" ;;
    *) [ -z "$ARG" ] || die "only one sha argument allowed"; ARG="$a" ;;
  esac
done
[ -n "$ARG" ] || { echo "usage: $0 <full-sha|origin/main> [--skip-build]" >&2; exit 64; }

# ---------- 1. resolve target ----------
ckpt "1-resolve-sha"
if [ "$ARG" = "origin/main" ]; then
  git -C "$SRC_REPO" rev-parse --git-dir >/dev/null 2>&1 || die "$SRC_REPO is not a git repo"
  SHA="$(git -C "$SRC_REPO" ls-remote origin refs/heads/main | awk 'NR==1{print $1}')"
else
  SHA="$ARG"
fi
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || die "target is not a 40-hex sha: '$SHA'"
SHA8="${SHA:0:8}"
CKPT="$W/m5-cutover-$SHA8.ckpt"
CONTRACT="$W/m5-cutover-$SHA8-contract.json"
PENDING_FILE="$W/m5-cutover-$SHA8-pending.id"
CARRIER_FILE="$W/m5-cutover-$SHA8-carrier.id"
RECEIPT="$W/m5-cutover-$SHA8-receipt.json"
SIDECAR_LOG="$W/m5-cutover-$SHA8-sidecar.log"
row "target" "$SHA"

R="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["releasePath"])' "$SVC/current-release.json")"
[ -f "$R/dist/cli.js" ] || die "active release root has no dist/cli.js: $R"
cd "$SVC"

# ---------- resume detection (never re-issue cutover_start) ----------
RESUME=0
ASUM="$(active_summary)"
say "active generation: $ASUM"
if [ "$ASUM" = "unknown" ]; then
  die "cannot read 'cutover status --json'; refusing to guess"
elif [ "$ASUM" != "none" ]; then
  IFS='|' read -r A_PHASE A_ACT A_ID A_SHA _A_BUILD _A_MAN <<<"$ASUM"
  if [ "$A_PHASE" = "drained" ] && [ "$A_ACT" = "1" ] && [ "$A_SHA" = "$SHA" ] && [ -f "$CONTRACT" ] && [ -f "$CARRIER_FILE" ]; then
    RESUME=1; row "mode" "RESUME cutover ${A_ID:0:8}"
  else
    die "active generation $A_ID phase=$A_PHASE activation=$A_ACT expects ${A_SHA:0:8}; not resumable from here"
  fi
else
  row "mode" "fresh"
fi

if [ "$RESUME" = 0 ]; then
  # ---------- 2. build-ready ----------
  ckpt "2-build-ready"
  EVID="$EV_DIR/$SHA.json"
  ev_ok() {
    [ -f "$EVID" ] && [ -f "$CURRENT_ROOT/generated/build-identity.json" ] && python3 - "$EVID" "$CURRENT_ROOT/generated/build-identity.json" "$SHA" <<'PY'
import json, sys
ev, bi = json.load(open(sys.argv[1])), json.load(open(sys.argv[2]))
sys.exit(0 if ev["sourceCommit"] == sys.argv[3] and bi["source_commit"] == sys.argv[3] and bi["build_id"] == ev["buildId"] else 1)
PY
  }
  if [ "$SKIP_BUILD" = 1 ] && ev_ok; then
    say "build-ready evidence present and matching; skipping build"
  else
    "$BIN/devspace-build-ready.sh" "$SHA" >&2
    ev_ok || die "build-ready evidence/root do not match $SHA after build"
  fi
  BUILD_ID="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["buildId"])' "$EVID")"
  row "buildId" "$BUILD_ID"

  # ---------- 3. already live? ----------
  ckpt "3-live-check"
  LIVE_SHA="$(health_field "b['source_commit']")"
  if [ "$LIVE_SHA" = "$SHA" ]; then say "already live ($SHA)"; exit 0; fi
  row "live before" "$LIVE_SHA"

  # ---------- 4. exact target capabilityManifestSha256 ----------
  ckpt "4-capability-manifest"
  if curl -fsS --max-time 2 "http://127.0.0.1:7699/healthz" >/dev/null 2>&1; then die "port 7699 already in use"; fi
  TMP="$(mktemp -d "${TMPDIR:-/tmp}/m5-manifest.XXXXXX")"
  mkdir -p "$TMP/.devspace" "$TMP/state" "$TMP/worktrees" "$TMP/agent"
  cp "$CONFIG_JSON" "$TMP/.devspace/config.json"
  OWNER_TOKEN="$(openssl rand -hex 24)"
  ( cd "$TMP" && HOME="$TMP" DEVSPACE_CONFIG_DIR="$TMP/.devspace" DEVSPACE_STATE_DIR="$TMP/state" \
      DEVSPACE_WORKTREE_ROOT="$TMP/worktrees" DEVSPACE_AGENT_DIR="$TMP/agent" PORT=7699 \
      DEVSPACE_PUBLIC_BASE_URL="http://127.0.0.1:7699" DEVSPACE_OAUTH_OWNER_TOKEN="$OWNER_TOKEN" \
      exec node "$CURRENT_ROOT/dist/cli.js" serve >"$TMP/serve.log" 2>&1 ) &
  TPID=$!
  TARGET_MANIFEST=""
  for _ in $(seq 1 40); do
    kill -0 "$TPID" 2>/dev/null || break
    if H="$(curl -fsS --max-time 2 "http://127.0.0.1:7699/healthz" 2>/dev/null)"; then
      TARGET_MANIFEST="$(printf '%s' "$H" | python3 -c 'import sys,json;print(json.load(sys.stdin)["capabilityManifest"]["manifestSha256"])' 2>/dev/null || true)"
      [ -z "$TARGET_MANIFEST" ] || break
    fi
    sleep 1
  done
  kill "$TPID" 2>/dev/null || true; sleep 1; kill -9 "$TPID" 2>/dev/null || true
  wait "$TPID" 2>/dev/null || true
  [[ "$TARGET_MANIFEST" =~ ^[0-9a-f]{64}$ ]] || { tail -n 5 "$TMP/serve.log" >&2 || true; rm -rf "$TMP"; die "could not read target capabilityManifestSha256 (fail closed)"; }
  rm -rf "$TMP"
  row "target manifest" "${TARGET_MANIFEST:0:16}..."

  # ---------- 5. contract ----------
  ckpt "5-contract"
  # A leftover approved carrier from an earlier attempt that never started a generation is revoked first.
  if [ -f "$CARRIER_FILE" ]; then
    node "$R/dist/cli.js" carrier revoke "$(cat "$CARRIER_FILE")" --version 1 >/dev/null 2>&1 || true
    rm -f "$CARRIER_FILE"
  fi
  STAMP="$(date -u +%Y%m%dT%H%MZ)"
  ATTEMPT_KEY="m5-$SHA8-deploy-$STAMP"
  SHA="$SHA" EVID="$EVID" TARGET_MANIFEST="$TARGET_MANIFEST" ATTEMPT_KEY="$ATTEMPT_KEY" CONTRACT="$CONTRACT" \
  WS="$WITNESS_WORKSPACE_ID" AG="$WITNESS_AGENT_ID" HEALTH_URL="$HEALTH_URL" STATE_ROOT="$STATE_DIR" LAUNCHD_LABEL="$LAUNCHD_LABEL" LAUNCHD_UID="$(id -u)" python3 - <<'PY'
import json, os, urllib.request, datetime as dt
e = os.environ
h = json.load(urllib.request.urlopen(e["HEALTH_URL"]))
b, m = h["build"], h["mcp"]
ev = json.load(open(e["EVID"]))
assert ev["sourceCommit"] == e["SHA"]
now = dt.datetime.now(dt.timezone.utc)
iso = lambda t: t.strftime("%Y-%m-%dT%H:%M:%S.000Z")
state_root = e["STATE_ROOT"]
cur = {"serverInstanceId": m["serverInstanceId"], "sourceCommit": b["source_commit"], "buildId": b["build_id"],
       "capabilityManifestSha256": h["capabilityManifest"]["manifestSha256"]}
for k, v in (("releaseSha256", b.get("release_sha256")), ("releasePath", b.get("release_path")),
             ("activationCutoverId", b.get("activation_cutover_id"))):
    if v: cur[k] = v
c = {"repository": "James3014/devspace", "goal": f"m5-{e['SHA'][:8]}-main-cutover", "role": "controller",
     "scope": [state_root], "baseRevision": cur["sourceCommit"], "operations": ["cutover_start"],
     "expiresAt": iso(now + dt.timedelta(minutes=40)),
     "cutover": {"stateRoot": state_root, "attemptKey": e["ATTEMPT_KEY"], "currentIdentity": cur,
       "expectedIdentity": {"sourceCommit": ev["sourceCommit"], "buildId": ev["buildId"],
                            "capabilityManifestSha256": e["TARGET_MANIFEST"]},
       "expiresAt": iso(now + dt.timedelta(minutes=35)),
       "restart": {"buildReady": {"verifiedBy": ev["verifiedBy"], "verifiedAt": ev["verifiedAt"], "evidence": ev["evidence"]},
                   "actuator": "launchd-self", "serviceLabel": e["LAUNCHD_LABEL"],
                   "launchdTarget": f"gui/{e['LAUNCHD_UID']}/{e['LAUNCHD_LABEL']}"},
       "finish": {"workspaceId": e["WS"], "agentId": e["AG"]}}}
fd = os.open(e["CONTRACT"], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f: f.write(json.dumps(c, indent=2) + "\n")
print("contract", e["ATTEMPT_KEY"], "predecessor", cur["serverInstanceId"])
PY
  row "attemptKey" "$ATTEMPT_KEY"
fi

# ---------- 6. pairing ----------
ckpt "6-pairing"
request_pairing() { # request_pairing <suffix>; prints pendingId
  R_ROOT="$R" CLIENT="m5-owner-sidecar-$SHA8" SESS="m5-owner-sidecar-$SHA8-$1-$(date +%s)" node --input-type=module - <<'NODE'
const R = process.env.R_ROOT;
const { loadConfig } = await import(`file://${R}/dist/config.js`);
const { CarrierBindingStore } = await import(`file://${R}/dist/carrier-binding.js`);
const s = new CarrierBindingStore(loadConfig().stateDir);
const p = s.requestPairing({ clientId: process.env.CLIENT, sessionId: process.env.SESS });
console.log(p.pendingId);
s.close();
NODE
}
json_field() { # json_field <python expr over d> ; reads (possibly noisy) JSON from stdin
  python3 -c "
import sys, json
t = sys.stdin.read(); d = json.JSONDecoder().raw_decode(t[t.index('{'):])[0]
print($1)"
}
PENDING="$(request_pairing "$([ "$RESUME" = 1 ] && echo r || echo p)")"
[[ "$PENDING" =~ ^pair_ ]] || die "unexpected pendingId '$PENDING'"
printf '%s\n' "$PENDING" > "$PENDING_FILE"
row "pending" "$PENDING"

# ---------- 7. owner approval (or carrier recover when resuming) ----------
if [ "$RESUME" = 0 ]; then
  ckpt "7-approve"
  node "$R/dist/cli.js" carrier inspect "$PENDING" >/dev/null
  APPROVED="$(node "$R/dist/cli.js" carrier approve "$PENDING" --contract "$CONTRACT" --confirm "$PENDING")"
  CID="$(printf '%s' "$APPROVED" | json_field "d['id']")"
  CVER="$(printf '%s' "$APPROVED" | json_field "d.get('version', 1)")"
  CVV="$(printf '%s' "$APPROVED" | json_field "d.get('validity', {}).get('version', 1)")"
  [[ "$CID" =~ ^carrier_ ]] || die "approve did not return a carrier id"
  printf '%s\n' "$CID" > "$CARRIER_FILE"
  say "approved carrier $CID (version $CVER, validity $CVV)"
else
  ckpt "7-carrier-recover"
  CID="$(cat "$CARRIER_FILE")"
  SHOWN="$(node "$R/dist/cli.js" carrier show "$CID")"
  CVER="$(printf '%s' "$SHOWN" | json_field "d.get('version', 1)" 2>/dev/null || echo 1)"
  CVV="$(printf '%s' "$SHOWN" | json_field "d.get('validity', {}).get('version', 1)" 2>/dev/null || echo 1)"
  # CLI contract: --confirm must repeat the carrier id (flags[7] === flags[1]), not the pending id.
  node "$R/dist/cli.js" carrier recover "$PENDING" --carrier "$CID" --version "$CVER" --validity-version "$CVV" --confirm "$CID" >/dev/null
  say "rebound pairing to carrier $CID (version $CVER, validity $CVV)"
fi
row "carrier" "$CID v$CVER"

# ---------- 8. sidecar ----------
ckpt "8-sidecar"
rm -f "$RECEIPT"
nohup env DEVSPACE_SERVICE_ROOT="$SVC" PENDING_ID="$PENDING" CONTRACT_PATH="$CONTRACT" RECEIPT_PATH="$RECEIPT" ACTIVE_RELEASE_ROOT="$R" \
  node "$BIN/m5-cutover-sidecar.mjs" > "$SIDECAR_LOG" 2>&1 &
SPID=$!
for _ in $(seq 1 360); do kill -0 "$SPID" 2>/dev/null || break; sleep 1; done
if kill -0 "$SPID" 2>/dev/null; then
  say "sidecar (pid $SPID) still running after 6 min; leaving it alone. Re-run this script to resume once it exits."
  grep '^{"stage"' "$SIDECAR_LOG" | cut -c1-240 || true
  exit 4
fi
set +e; wait "$SPID"; SRC_RC=$?; set -e
grep '^{"stage"' "$SIDECAR_LOG" | cut -c1-240 || true
if [ "$SRC_RC" -ne 0 ]; then
  say "sidecar exit $SRC_RC (2 = refused, state not resumable):"
  tail -n 15 "$SIDECAR_LOG" | cut -c1-400
  exit "$SRC_RC"
fi
row "sidecar" "ok ($(grep -o '"mode": "[a-z_]*"' "$SIDECAR_LOG" | head -1))"

# ---------- 9. verification ----------
ckpt "9-verify"
V="$(health_field "'|'.join(map(str,[b['source_commit'],m['cutoverMode'],m['reconciliationRequired']]))")"
[ "$V" = "$SHA|normal|False" ] || die "healthz not as expected: $V"
ASUM2="$(active_summary)"
[ "$ASUM2" = "none" ] || die "cutover status not closed: $ASUM2"
PUB="$(curl -fsS --max-time 15 "$PUBLIC_URL/identity")"
printf '%s' "$PUB" | python3 -c 'import sys,json
d=json.load(sys.stdin); t=json.dumps(d)
sys.exit(0 if d.get("sourceCommit")==sys.argv[1] or (d.get("sourceCommit") is None and sys.argv[1] in t) else 1)' "$SHA" || die "public /identity sourceCommit != $SHA"
CANARY="$(curl -s -o /dev/null -w '%{http_code}' -X POST --max-time 8 http://127.0.0.1:7676/api/cutover/start || true)"
[ "$CANARY" = "404" ] || die "negative canary POST /api/cutover/start returned $CANARY (want 404)"
row "verify" "healthz normal, closed, public identity, canary 404"

# ---------- 10. hygiene ----------
ckpt "10a-release-lease"
# finishCutover closes the generation but leaves the state-root effect lease un-released; the next
# prepareEffect would then fail with "overlapping resource scope is already leased". Release it now
# with the closed record's terminal hash (cutoverTerminalRecordHash over the stored record).
LEASE_JSON=$(node "$R/dist/cli.js" cutover status --json 2>/dev/null || true)
LEASE_ID=$(printf '%s' "$LEASE_JSON" | python3 -c 'import sys,json;d=json.load(sys.stdin);a=d.get("active") or {};print((a.get("coordinationBinding") or {}).get("leaseId") or "")' 2>/dev/null || true)
CLOSED_ID=$(printf '%s' "$LEASE_JSON" | python3 -c 'import sys,json;d=json.load(sys.stdin);a=d.get("active") or {};print(a.get("cutoverId") or "")' 2>/dev/null || true)
if [ -n "$LEASE_ID" ] && [ -n "$CLOSED_ID" ]; then
  LEASE_VER=$(python3 -c "import sqlite3;c=sqlite3.connect('file:$STATE_DIR/devspace.sqlite?mode=ro',uri=True);r=c.execute('select version,terminal_state from control_plane_resource_leases where lease_id=?',('$LEASE_ID',)).fetchone();print(r[0] if r and not r[1] else '')" 2>/dev/null || true)
  if [ -n "$LEASE_VER" ]; then
    TRH_SCRIPT=$(mktemp /tmp/m5-trh.XXXXXX.mjs)
    cat > "$TRH_SCRIPT" <<NODE
const { loadConfig } = await import("file://$R/dist/config.js");
const { CutoverStateStore } = await import("file://$R/dist/cutover-state.js");
const { cutoverTerminalRecordHash } = await import("file://$R/dist/durable-operations.js");
const s = new CutoverStateStore(loadConfig().stateDir); const f = s.get();
console.log(cutoverTerminalRecordHash(f)); try { s.close?.(); } catch {} process.exit(0);
NODE
    TRH=$(perl -e 'alarm 40; exec @ARGV' node "$TRH_SCRIPT" < /dev/null 2>/dev/null || true); rm -f "$TRH_SCRIPT"
    if [ -n "$TRH" ] && node "$R/dist/cli.js" cutover release-terminal-lease --cutover-id "$CLOSED_ID" --lease-id "$LEASE_ID" --lease-version "$LEASE_VER" --carrier "$CID" --carrier-version "$CVER" --terminal-record-hash "$TRH" --confirm "$CLOSED_ID" --json >/dev/null 2>&1; then
      row "lease released" "$LEASE_ID (v$LEASE_VER)"
    else
      row "lease release" "FAILED: run cutover release-terminal-lease --cutover-id $CLOSED_ID --lease-id $LEASE_ID --lease-version $LEASE_VER --carrier $CID --carrier-version <current> --terminal-record-hash <cutoverTerminalRecordHash> --confirm $CLOSED_ID"
    fi
  else
    row "lease" "already terminal"
  fi
fi

ckpt "10-hygiene"
if node "$R/dist/cli.js" carrier revoke "$CID" --version "$CVER" >/dev/null 2>&1; then row "carrier revoked" "$CID"
else row "carrier revoke" "FAILED (revoke manually: carrier revoke $CID --version $CVER)"; fi

trap - ERR
echo; echo "== m5-cutover summary =="; printf '%s\n' "${SUMMARY[@]}"; echo "receipt: $RECEIPT"
