#!/usr/bin/env bash
# robomp container entrypoint. No per-boot pip installs — everything is baked
# into the image; we only sanity-check the runtime mount and create state dirs.
set -euo pipefail

: "${PI_ROOT:=/work/pi}"
if [ ! -d "$PI_ROOT/packages/coding-agent" ]; then
  echo "robomp: $PI_ROOT does not look like a pi checkout — bind-mount it at $PI_ROOT" >&2
  exit 2
fi

mkdir -p /data/workspaces /data/logs
# Persistent build caches under the /data volume. CARGO_HOME, CARGO_TARGET_DIR,
# RUSTUP_HOME, and BUN_INSTALL_CACHE_DIR are pinned to these paths in the image
# ENV so every per-issue worktree shares one cargo target and one bun cache.
mkdir -p /data/cache/cargo /data/cache/cargo-target /data/cache/rustup /data/cache/bun-cache
exec "$@"
