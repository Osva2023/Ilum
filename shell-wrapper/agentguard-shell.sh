#!/bin/sh
# agentguard-shell — POSIX fallback wrapper for AgentGuard.
#
# Used when the prebuilt Go binary at shell-wrapper/agentguard-shell is not
# available.  Same contract: forward `sh -c <cmd>` invocations to the
# AgentGuard daemon over a Unix socket; exec /bin/sh on approved, exit 126
# on denied.
#
# Portability caveats (this fallback is best-effort):
#   • Requires `nc -U` with `-N` (close-on-EOF).  This is BSD nc — ships by
#     default on macOS and FreeBSD.  On Linux distributions that ship `ncat`
#     (nmap) instead of BSD nc, replace `nc -U -N` with `ncat -U`.
#   • Requires `python3` for JSON encoding/decoding.  Ships with macOS 12+
#     (Xcode CLT) and most Linux distributions.
# If you hit either of these on your platform, build the Go binary instead
# (./build.sh in this directory).

set -u

# ── locate the -c flag in argv ───────────────────────────────────────────────
cmd=""
i=1
for arg in "$@"; do
  if [ "$arg" = "-c" ]; then
    next=$((i + 1))
    eval "cmd=\${$next:-}"
    break
  fi
  i=$((i + 1))
done

# ── pass-through cases ───────────────────────────────────────────────────────
# - Not a -c invocation (interactive shell, script file, etc.)
# - No active AgentGuard session
if [ -z "$cmd" ] || [ -z "${AGENTGUARD_SESSION_ID:-}" ]; then
  exec /bin/sh "$@"
fi

# ── misconfiguration: session active but no socket ───────────────────────────
if [ -z "${AGENTGUARD_SOCKET:-}" ]; then
  echo "[AgentGuard] AGENTGUARD_SESSION_ID set but AGENTGUARD_SOCKET missing — blocking command." >&2
  exit 126
fi

# ── build JSON request via python3 ───────────────────────────────────────────
req=$(python3 - "$cmd" "$PPID" <<'PY'
import json, os, sys
print(json.dumps({"v": 1, "cmd": sys.argv[1], "cwd": os.getcwd(), "ppid": int(sys.argv[2])}))
PY
) || {
  echo "[AgentGuard] python3 unavailable — falling back to pass-through (UNSAFE in active session)." >&2
  exit 126
}

# ── send request, read response ──────────────────────────────────────────────
# nc -U: Unix-domain socket. -N: close socket after EOF on stdin (BSD nc).
resp=$(printf '%s\n' "$req" | nc -U -N "$AGENTGUARD_SOCKET" 2>/dev/null) || resp=""

if [ -z "$resp" ]; then
  echo "[AgentGuard] adjudication daemon unreachable — blocking command." >&2
  exit 126
fi

# ── parse outcome ────────────────────────────────────────────────────────────
outcome=$(printf '%s' "$resp" | python3 -c '
import json, sys
try: print(json.load(sys.stdin).get("outcome", ""))
except Exception: print("")
')

case "$outcome" in
  approved)
    exec /bin/sh "$@"
    ;;
  denied)
    reason=$(printf '%s' "$resp" | python3 -c '
import json, sys
try: print(json.load(sys.stdin).get("reason", ""))
except Exception: print("")
')
    if [ -n "$reason" ]; then
      echo "[AgentGuard] Command blocked: $reason" >&2
    else
      echo "[AgentGuard] Command blocked." >&2
    fi
    exit 126
    ;;
  *)
    echo "[AgentGuard] daemon returned unexpected outcome — blocking command." >&2
    exit 126
    ;;
esac
