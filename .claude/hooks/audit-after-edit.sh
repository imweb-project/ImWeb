#!/bin/bash
# PostToolUse:Edit|Write — run the invariant audits after touching pipeline-critical
# files. These are the audit scripts behind `npm test` (it started as four —
# source resolution, capture base, panel coverage, SDF migration — to catch a
# source appended without every consumer updated; it has grown since).
#
# Stays quiet on pass (one line). Surfaces full output only on failure.
# Exit 2 = feedback to Claude. Exit 0 = silent success.

read -r -d '' INPUT

eval "$(python3 - "$INPUT" <<'PY'
import json, os, shlex, sys
try:
    d = json.loads(sys.argv[1])
except Exception:
    sys.exit(0)
path = (d.get("tool_input") or {}).get("file_path") or ""
root = os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
try:
    rel = os.path.relpath(os.path.realpath(path), os.path.realpath(root))
except Exception:
    rel = path
print("REL=%s" % shlex.quote(rel))
PY
)"

[ -z "$REL" ] && exit 0

case "$REL" in
  src/controls/ParameterSystem.js|src/main.js|src/core/Pipeline.js|src/inputs/*|src/shaders/*) ;;
  *) exit 0 ;;
esac

cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0

# PARALLEL, NOT `npm test`. The script is ~57 `node tests/audit-*.mjs` joined by
# &&, and serially that cold-starts node 57 times — 9s idle, a 19s median and 63s
# worst case in real sessions with Vite and a browser competing, on EVERY edit to
# main.js. No single audit is slow (max <1s); the chain is. They share no state
# (the one that writes, audit-gitignore-banks, stamps its probe names), so they
# run 8 at a time — half the cores, leaving the rest to the dev server.
#
# The list is READ from package.json, never copied here, so a new audit is
# covered the day it is added. If the script ever holds anything besides
# `node tests/audit-*.mjs` steps, the parse refuses and this falls back to
# `npm test` whole — a runner that silently skips steps would be a green lie.
AUDITS=$(node -e '
  const s = require("./package.json").scripts.test || "";
  const steps = s.match(/node\s+tests\/audit-[\w-]+\.mjs/g) || [];
  if (!steps.length || s.replace(/node\s+tests\/audit-[\w-]+\.mjs|&&|\s/g, "")) process.exit(3);
  console.log(steps.map((x) => x.replace(/^node\s+/, "")).join("\n"));
' 2>/dev/null)

# Every way the parallel runner cannot start falls back to `npm test`, never to
# exit 0: this hook's silence reads as "pass", so a skipped run must be loud or
# slow, not quiet.
RUN_WHOLE=
[ -z "$AUDITS" ] && RUN_WHOLE=1
if [ -z "$RUN_WHOLE" ]; then
  TMP=$(mktemp -d 2>/dev/null) || RUN_WHOLE=1
fi

if [ -n "$RUN_WHOLE" ]; then
  OUT=$(npm test 2>&1)
  if [ $? -eq 0 ]; then
    echo "invariant audits: pass ($REL)"
    exit 0
  fi
else
  trap 'rm -rf "$TMP"' EXIT
  printf '%s\n' "$AUDITS" | xargs -P 8 -I{} sh -c \
    'node "$1" >"$2/$(basename "$1").out" 2>&1 || : >"$2/$(basename "$1").fail"' _ {} "$TMP"
  # Pass means every audit RAN and none failed. Counting only failure markers
  # would read a runner that died before starting anything as all-green.
  EXPECTED=$(printf '%s\n' "$AUDITS" | wc -l | tr -d ' ')
  RAN=$(find "$TMP" -name '*.out' | wc -l | tr -d ' ')
  FAILED=$(cd "$TMP" && ls -- *.fail 2>/dev/null | sed 's/\.fail$//')
  if [ -z "$FAILED" ] && [ "$RAN" = "$EXPECTED" ]; then
    echo "invariant audits: pass ($REL)"
    exit 0
  fi
  OUT=
  [ "$RAN" = "$EXPECTED" ] || OUT="audit runner incomplete: $RAN of $EXPECTED audits produced output
"
  OUT="$OUT$(for f in $FAILED; do printf '=== tests/%s ===\n' "$f"; cat "$TMP/$f.out"; echo; done)"
fi

cat >&2 <<EOF
INVARIANT AUDIT FAILED after editing $REL

$OUT

Fix this before continuing. If a source was appended, check the consumption
fixpoint (_srcUsed in src/main.js) and SOURCE_DEFS consumers — CLAUDE.md,
"Source list & mix buses".
EOF
exit 2
