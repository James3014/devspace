#!/usr/bin/env bash
# devspace-build-ready.sh <full-sha|origin/main>
# One-shot: builds an exact DevSpace commit on THIS host and shapes
# <HOME>/.devspace/worktrees/devspace-build-ready-current into the real
# (non-symlink) package root that the cutover path requires
# (src/cutover-activation.ts canonicalDirectory rejects symlinked roots).
# Never touches current-release.json, releases/, launchd, or cutover state.
set -euo pipefail
export PATH="/opt/homebrew/bin:$HOME/.npm-global/bin:/usr/local/bin:$PATH"

die() { echo "devspace-build-ready: $*" >&2; exit 1; }
log() { echo "[build-ready] $*" >&2; }

[ $# -eq 1 ] || die "usage: $0 <full-sha|origin/main>"
ARG="$1"
SRC="${DEVSPACE_BUILD_READY_SRC:-$HOME/Workspace/devspace}"
BHOME="${DEVSPACE_BUILD_READY_HOME:-$HOME}"
WT_ROOT="$BHOME/.devspace/worktrees"
EV_DIR="$BHOME/.devspace/build-ready"
CURRENT="$WT_ROOT/devspace-build-ready-current"

command -v node >/dev/null || die "node not found on PATH"
command -v npm >/dev/null || die "npm not found on PATH"
command -v git >/dev/null || die "git not found on PATH"

# 1. source repo + remote
git -C "$SRC" rev-parse --git-dir >/dev/null 2>&1 || die "$SRC is not a git repo"
ORIGIN_URL="$(git -C "$SRC" remote get-url origin 2>/dev/null || true)"
case "$ORIGIN_URL" in
  *James3014/devspace|*James3014/devspace.git) ;;
  *) die "origin is '$ORIGIN_URL', expected James3014/devspace" ;;
esac
log "fetching origin"
git -C "$SRC" fetch origin --quiet

# 2. resolve + ancestry
if [ "$ARG" = "origin/main" ]; then
  SHA="$(git -C "$SRC" rev-parse --verify --quiet 'origin/main^{commit}')" || die "cannot resolve origin/main"
else
  case "$ARG" in
    [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]*) ;;
    *) die "argument must be a full 40-hex sha or origin/main" ;;
  esac
  [ "${#ARG}" -eq 40 ] || die "argument must be a full 40-hex sha or origin/main"
  SHA="$(git -C "$SRC" rev-parse --verify --quiet "$ARG^{commit}")" || die "unknown commit $ARG"
fi
[ "$SHA" = "$ARG" ] || [ "$ARG" = "origin/main" ] || die "resolved sha $SHA != argument"
git -C "$SRC" merge-base --is-ancestor "$SHA" origin/main || die "$SHA is not an ancestor of origin/main"
SHA12="${SHA:0:12}"
log "target commit $SHA"

# 3. clean detached worktree
WT="$WT_ROOT/devspace-build-ready-$SHA12"
mkdir -p "$WT_ROOT" "$EV_DIR"
if [ -e "$WT" ] || git -C "$SRC" worktree list --porcelain | grep -qx "worktree $WT"; then
  log "removing previous worktree $WT"
  git -C "$SRC" worktree remove --force "$WT" 2>/dev/null || true
  if [ -e "$WT" ]; then rm -rf "$WT"; fi
  git -C "$SRC" worktree prune
fi
git -C "$SRC" worktree add --detach "$WT" "$SHA" >&2
[ -z "$(git -C "$WT" status --porcelain)" ] || die "worktree not clean after checkout"
[ "$(git -C "$WT" rev-parse HEAD)" = "$SHA" ] || die "worktree HEAD != $SHA"

# 4. install + build (prebuild runs scripts/generate-build-identity.mjs)
log "npm ci --include=dev"
( cd "$WT" && npm ci --include=dev >&2 )
log "npm run build"
( cd "$WT" && npm run build >&2 )
[ -z "$(git -C "$WT" status --porcelain)" ] || die "worktree dirty after build (build output must be gitignored)"

ID="$WT/generated/build-identity.json"
[ -f "$ID" ] || die "missing $ID"
idget() { node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=j[process.argv[2]];process.stdout.write(String(v))' "$1" "$2"; }
[ "$(idget "$ID" source_commit)" = "$SHA" ] || die "build-identity source_commit != $SHA"
[ "$(idget "$ID" source_dirty)" = "false" ] || die "build-identity source_dirty is not false"
[ -f "$WT/dist/cli.js" ] || die "missing dist/cli.js"
BUILD_ID="$(idget "$ID" build_id)"
BUILT_AT="$(idget "$ID" built_at)"
[ -n "$BUILD_ID" ] || die "empty build_id"

# 5. assemble a REAL directory (no .git, no symlinked root) with the entries
#    the cutover stager copies (cutover-activation.ts:50-58)
STAGE="$WT_ROOT/devspace-build-ready-stage-$SHA12-$$"
rm -rf "$STAGE"; mkdir "$STAGE"
for e in package.json dist generated node_modules package-lock.json README.md LICENSE docs examples scripts skills; do
  if [ -e "$WT/$e" ]; then cp -RPp "$WT/$e" "$STAGE/$e"; fi
done
for e in package.json dist generated node_modules; do [ -e "$STAGE/$e" ] || die "stage missing $e"; done
[ "$(idget "$STAGE/generated/build-identity.json" source_commit)" = "$SHA" ] || die "staged identity mismatch"
[ -f "$STAGE/dist/cli.js" ] || die "staged dist/cli.js missing"

# 6. swap: rename old root aside (never delete), then rename stage into place
if [ -e "$CURRENT" ] || [ -L "$CURRENT" ]; then
  OLD8="unknown"
  if [ -f "$CURRENT/generated/build-identity.json" ]; then
    OLD8="$(idget "$CURRENT/generated/build-identity.json" source_commit | cut -c1-8)" || OLD8="unknown"
  fi
  PREV="$WT_ROOT/devspace-build-ready-prev-$OLD8-$(date -u +%Y%m%dT%H%M%SZ)"
  log "moving previous root to $PREV"
  mv "$CURRENT" "$PREV"
fi
mv "$STAGE" "$CURRENT"
[ -d "$CURRENT" ] && [ ! -L "$CURRENT" ] || die "current is not a real directory"
[ "$(idget "$CURRENT/generated/build-identity.json" source_commit)" = "$SHA" ] || die "current identity mismatch after swap"

# 7. evidence
VERIFIED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
HOST="$(hostname -s 2>/dev/null || hostname)"
EVIDENCE_FILE="$EV_DIR/$SHA.json"
SHA="$SHA" BUILD_ID="$BUILD_ID" BUILT_AT="$BUILT_AT" VERIFIED_AT="$VERIFIED_AT" HOST="$HOST" \
WT="$WT" CURRENT="$CURRENT" OUT="$EVIDENCE_FILE" node -e '
const e=process.env;
const doc={schema:"devspace.build_ready_evidence.v1",sourceCommit:e.SHA,buildId:e.BUILD_ID,builtAt:e.BUILT_AT,
verifiedBy:"devspace-build-ready.sh@"+e.HOST,verifiedAt:e.VERIFIED_AT,worktree:e.WT,buildReadyRoot:e.CURRENT,
evidence:`${e.HOST} build-ready worktree ${e.WT} is clean at exact main ${e.SHA}; npm ci and production build completed exit 0 on this host; generated build identity ${e.BUILD_ID}; staged as real directory ${e.CURRENT}.`};
const s=JSON.stringify(doc,null,2)+"\n";require("fs").writeFileSync(e.OUT,s);process.stdout.write(s);'
