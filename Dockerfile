# syntax=docker/dockerfile:1.7
################################################################################
# robomp — orchestrator image
#
# This is a three-stage build. The `pi` build-context (declared via
# `additional_contexts: pi: /work/pi` in docker-compose.yml) gives the builder
# stages access to the host's `oh-my-pi` checkout *at build time*. At runtime
# /work/pi is also mounted read-only so `omp` (the Bun shim) can execute the
# coding-agent source directly. The Rust-built pi-natives .node addon, which
# must be Linux-native, is produced here and dropped into /opt/bun/bin so the
# pi loader finds it on next boot.
################################################################################

############################
# 1) natives-builder — Rust+Bun, compiles pi-natives for the image's arch.
############################
FROM rust:1.86-slim-bookworm AS natives-builder

ARG BUN_VERSION=1.3.14
ENV BUN_INSTALL=/opt/bun \
    PATH=/opt/bun/bin:/usr/local/cargo/bin:/usr/local/bin:/usr/bin:/bin \
    CARGO_TERM_COLOR=never

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        curl ca-certificates pkg-config libssl-dev unzip git \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" \
    && /opt/bun/bin/bun --version

# We need the pi checkout for the build, but copying the whole tree drags in
# node_modules / runs / .fallow / etc. Use a bind mount to read the source
# during the build; only the resulting .node file is copied out below.
#
# The `rust-toolchain.toml` at the repo root pins nightly; the `rustup show`
# call inside the mount triggers the install on first build.
RUN --mount=type=bind,from=pi,source=/,target=/pi,readonly \
    --mount=type=cache,target=/root/.cargo/registry \
    --mount=type=cache,target=/root/.cargo/git \
    --mount=type=cache,target=/build/pi-src/target \
    set -eux; \
    mkdir -p /build /build/pi-src /out; \
    cp -a /pi/. /build/pi-src/; \
    cd /build/pi-src; \
    rustup show; \
    bun install --frozen-lockfile --ignore-scripts; \
    bun --cwd=packages/natives run build; \
    cp packages/natives/native/pi_natives.linux-*.node /out/

############################
# 2) python-builder — wheel for omp-rpc from the pi checkout.
############################
FROM python:3.12-slim-bookworm AS python-builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --upgrade pip build

RUN --mount=type=bind,from=pi,source=/python/omp-rpc,target=/src,readonly \
    set -eux; \
    mkdir -p /build /out; \
    cp -a /src /build/omp-rpc; \
    cd /build/omp-rpc; \
    python -m build --wheel --outdir /out

############################
# 3) runtime — slim image, only what we actually need at boot.
############################
FROM python:3.12-slim-bookworm AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    BUN_INSTALL=/opt/bun \
    PI_ROOT=/work/pi \
    # Persistent build caches under the /data volume so cargo target,
    # rustup toolchains, and bun's global package cache are shared across
    # every per-issue worktree AND survive container restarts.
    CARGO_HOME=/data/cache/cargo \
    CARGO_TARGET_DIR=/data/cache/cargo-target \
    RUSTUP_HOME=/data/cache/rustup \
    BUN_INSTALL_CACHE_DIR=/data/cache/bun-cache \
    PATH=/opt/bun/bin:/usr/local/cargo/bin:/usr/local/bin:/usr/bin:/bin

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git curl ca-certificates unzip openssh-client tini \
        build-essential pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*

ARG BUN_VERSION=1.3.14
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" \
    && /opt/bun/bin/bun --version

# Rustup launcher. Install the cargo/rustc/rustup proxies into a fixed
# image path; the real toolchain is *not* baked in — it's installed
# lazily into RUSTUP_HOME (=/data/cache/rustup) on the first `cargo`
# invocation inside a worktree, driven by pi's rust-toolchain.toml.
# That keeps the image small while sharing the toolchain across reboots.
RUN curl -fsSL https://sh.rustup.rs -o /tmp/rustup-init.sh \
    && CARGO_HOME=/usr/local/cargo RUSTUP_HOME=/usr/local/rustup-bootstrap \
       sh /tmp/rustup-init.sh -y --no-modify-path --default-toolchain none --profile minimal \
    && rm -f /tmp/rustup-init.sh \
    && rm -rf /usr/local/rustup-bootstrap \
    && /usr/local/cargo/bin/rustup --version

# pi-natives addon: pi's loader probes /opt/bun/bin as a fallback path.
COPY --from=natives-builder /out/pi_natives.linux-*.node /opt/bun/bin/

# omp-rpc Python wheel, installed at build time.
COPY --from=python-builder /out/*.whl /tmp/wheels/
RUN pip install /tmp/wheels/omp_rpc-*.whl && rm -rf /tmp/wheels

WORKDIR /app

# `omp` shim — calls into the mounted pi checkout via Bun.
RUN cat > /usr/local/bin/omp <<'EOF' && chmod +x /usr/local/bin/omp
#!/usr/bin/env bash
set -euo pipefail
: "${PI_ROOT:=/work/pi}"
if [ ! -d "$PI_ROOT/packages/coding-agent" ]; then
  echo "robomp: PI_ROOT=$PI_ROOT does not look like a pi checkout" >&2
  exit 127
fi
exec bun "$PI_ROOT/packages/coding-agent/src/cli.ts" "$@"
EOF

# robomp itself.
COPY pyproject.toml ./
COPY src/ ./src/
RUN pip install --upgrade pip \
    && pip install \
        "fastapi>=0.112" "uvicorn[standard]>=0.30" "httpx>=0.27" \
        "pydantic>=2.6" "pydantic-settings>=2.2" "python-dotenv>=1.0" \
        "click>=8.1" \
    && pip install --no-deps .

COPY entrypoint.sh /usr/local/bin/robomp-entrypoint
RUN chmod +x /usr/local/bin/robomp-entrypoint

VOLUME ["/data"]
EXPOSE 8080

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/robomp-entrypoint"]
CMD ["python", "-m", "robomp", "serve"]
