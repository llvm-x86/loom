# robomp — task runner.
#
#   just                     → list recipes
#   just <group>::<recipe>   → not used; recipes are flat with [group(...)] tags
#
# Container ops assume docker compose v2. Local-dev recipes assume a venv with
# `pip install -e '.[dev]'` already done (see `just install`).

set shell           := ["bash", "-euo", "pipefail", "-c"]
set dotenv-load     := true
set dotenv-required := false

PI_ROOT     := env_var_or_default("PI_ROOT", "/work/pi")
STAGE       := env_var_or_default("STAGE", ".pi-context")
SERVICE     := "robomp"
PORT        := env_var_or_default("ROBOMP_BIND_PORT", "8080")
SQLITE_CONT := "/data/robomp.sqlite"
DATA_DIR    := "./data"

# ───────── default ─────────

[private]
default:
    @just --justfile {{justfile()}} --list --unsorted

# ───────── build ─────────

[group('build')]
[doc('rsync $PI_ROOT into .pi-context/ — the docker build context')]
stage:
    PI_ROOT={{PI_ROOT}} ./bin/stage-pi.sh {{STAGE}}

[group('build')]
[doc('stage + docker compose build')]
build: stage
    docker compose build

[group('build')]
[doc('stage + docker compose build --no-cache')]
rebuild: stage
    docker compose build --no-cache

[group('build')]
[doc('print the image size + layer count for robomp:dev')]
image-info:
    docker image inspect robomp:dev --format \
      'size: {{{{.Size}}}} bytes  layers: {{{{len .RootFS.Layers}}}}  created: {{{{.Created}}}}'

[group('build')]
[confirm('Remove the staged build context directory?')]
[doc('rm -rf .pi-context/')]
clean-stage:
    rm -rf {{STAGE}}

# ───────── lifecycle ─────────

[group('lifecycle')]
[doc('docker compose up -d')]
up:
    docker compose up -d

[group('lifecycle')]
[doc('build → up -d → follow logs (the dev inner loop)')]
dev: build up logs

[group('lifecycle')]
[doc('docker compose down')]
down:
    docker compose down

[group('lifecycle')]
[doc('docker compose restart robomp')]
restart:
    docker compose restart {{SERVICE}}

[group('lifecycle')]
[doc('docker compose ps')]
ps:
    docker compose ps

[group('lifecycle')]
[doc('follow container logs (Ctrl-C to detach)')]
logs:
    docker compose logs -f {{SERVICE}}

[group('lifecycle')]
[doc('tail the last N lines without following (default 200)')]
tail LINES='200':
    docker compose logs --no-color --tail '{{LINES}}' {{SERVICE}}

[group('lifecycle')]
[doc('case-insensitive grep over container logs')]
log-grep PATTERN:
    docker compose logs --no-color {{SERVICE}} | grep -i -- '{{PATTERN}}' || true

[group('lifecycle')]
[doc('exec a bash shell inside the running container')]
sh:
    docker compose exec {{SERVICE}} bash

[group('lifecycle')]
[doc('exec an arbitrary command inside the running container')]
exec +CMD:
    docker compose exec {{SERVICE}} {{CMD}}

# ───────── robomp cli (in-container) ─────────

[group('cli')]
[doc('robomp triage owner/repo#N — drive full pipeline against a live issue')]
triage ISSUE_REF:
    docker compose exec {{SERVICE}} robomp triage '{{ISSUE_REF}}'

[group('cli')]
[doc('robomp replay <delivery_id> — re-enqueue a stored webhook event')]
replay DELIVERY_ID:
    docker compose exec {{SERVICE}} robomp replay '{{DELIVERY_ID}}'

[group('cli')]
[doc('robomp status — issue table dump')]
issue-status:
    docker compose exec {{SERVICE}} robomp status

[group('cli')]
[doc('robomp cleanup owner/repo#N — force workspace removal + state=abandoned')]
cleanup ISSUE_KEY:
    docker compose exec {{SERVICE}} robomp cleanup '{{ISSUE_KEY}}'

# ───────── tests / local dev ─────────

[group('dev')]
[doc("pip install -e '.[dev]' (run inside your venv)")]
install:
    pip install -e '.[dev]'

[group('dev')]
[doc('run the unit suite (fast; pass `-- -k name` for filtering)')]
test *ARGS:
    pytest -x tests/ {{ARGS}}

[group('dev')]
[doc('gated end-to-end against a real omp subprocess (needs omp on PATH)')]
test-integration *ARGS:
    ROBOMP_INTEGRATION=1 pytest -x tests/test_worker_smoke.py {{ARGS}}

[group('dev')]
[doc('run a single test file or path')]
test-file FILE *ARGS:
    pytest -x '{{FILE}}' {{ARGS}}

[group('dev')]
[doc('run robomp serve on the host (skips docker)')]
serve:
    python -m robomp serve

# ───────── inspection (HTTP) ─────────

[group('inspect')]
[doc('GET /healthz')]
healthz:
    curl -fsS 'http://localhost:{{PORT}}/healthz' && echo

[group('inspect')]
[doc('GET /readyz')]
readyz:
    curl -fsS 'http://localhost:{{PORT}}/readyz' && echo

[group('inspect')]
[doc('GET /events?limit=N — recent webhook deliveries (default 50)')]
events LIMIT='50':
    curl -fsS 'http://localhost:{{PORT}}/events?limit={{LIMIT}}' | python -m json.tool

[group('inspect')]
[doc('GET /issues?limit=N — per-issue state (default 100)')]
issues LIMIT='100':
    curl -fsS 'http://localhost:{{PORT}}/issues?limit={{LIMIT}}' | python -m json.tool

# ───────── inspection (sqlite) ─────────

[group('sqlite')]
[doc('open the sqlite REPL inside the container')]
sqlite:
    docker compose exec {{SERVICE}} sqlite3 {{SQLITE_CONT}}

[group('sqlite')]
[doc('run a one-off SQL query against the in-container sqlite db')]
sql QUERY:
    docker compose exec {{SERVICE}} sqlite3 -header -column {{SQLITE_CONT}} "{{QUERY}}"

[group('sqlite')]
[doc('list tool_calls for a given issue_key (e.g. owner/repo#123)')]
tool-calls ISSUE_KEY:
    docker compose exec {{SERVICE}} sqlite3 -header -column {{SQLITE_CONT}} \
      "SELECT id, ts, tool, COALESCE(error,'ok') AS err FROM tool_calls WHERE issue_key='{{ISSUE_KEY}}' ORDER BY id;"

[group('sqlite')]
[doc('list recent events (default 20)')]
recent-events LIMIT='20':
    docker compose exec {{SERVICE}} sqlite3 -header -column {{SQLITE_CONT}} \
      "SELECT received_at, event_type, issue_key, state, attempts FROM events ORDER BY received_at DESC LIMIT {{LIMIT}};"

[group('sqlite')]
[doc('show events stuck in queued/running')]
stuck:
    docker compose exec {{SERVICE}} sqlite3 -header -column {{SQLITE_CONT}} \
      "SELECT delivery_id, event_type, issue_key, state, attempts, started_at FROM events WHERE state IN ('queued','running') ORDER BY received_at;"

# ───────── webhook helpers ─────────

[group('webhook')]
[doc('POST a synthetic ping to /webhook/github (signed with $GITHUB_WEBHOOK_SECRET from .env)')]
ping:
    #!/usr/bin/env bash
    set -euo pipefail
    : "${GITHUB_WEBHOOK_SECRET:?missing in .env}"
    body='{"zen":"justfile ping","hook_id":0}'
    sig="sha256=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$GITHUB_WEBHOOK_SECRET" -r | awk '{print $1}')"
    curl -fsS -X POST 'http://localhost:{{PORT}}/webhook/github' \
      -H 'Content-Type: application/json' \
      -H 'X-GitHub-Event: ping' \
      -H "X-GitHub-Delivery: just-$(date +%s)" \
      -H "X-Hub-Signature-256: $sig" \
      --data "$body"
    echo

# ───────── danger zone ─────────

[group('danger')]
[confirm('Drop every per-issue workspace under ./data/workspaces. Continue?')]
[doc('rm -rf ./data/workspaces (keeps sqlite + logs)')]
wipe-workspaces:
    rm -rf {{DATA_DIR}}/workspaces
    mkdir -p {{DATA_DIR}}/workspaces

[group('danger')]
[confirm('Delete ./data entirely (sqlite, logs, workspaces). Continue?')]
[doc('wipe sqlite, logs, and all workspaces')]
nuke-data:
    rm -rf {{DATA_DIR}}
    mkdir -p {{DATA_DIR}}

[group('danger')]
[confirm('Tear down the stack with -v and remove the staged build context. Continue?')]
[doc('full reset: docker compose down -v + rm -rf .pi-context')]
reset:
    docker compose down -v
    rm -rf {{STAGE}}

# ───────── aliases ─────────

alias t  := test
alias b  := build
alias l  := logs
alias s  := sh
alias h  := healthz
