# Slim headless review-agent image for the cross-topology harness (attn-orf).
#
# Two stages:
#   - builder: compiles `attn-agent`. The crate graph still pulls wry +
#     webkit2gtk-sys (non-optional deps), whose build scripts need the GTK/
#     WebKit *dev* libs via pkg-config — even though attn-agent doesn't LINK
#     them. build.rs early-returns by copying the prebuilt web/dist/index.html
#     (kept in the context), so no Node/npm is needed.
#   - runtime: debian-slim with only ca-certificates + iptables/iproute2 (for
#     the harness's NAT/partition fault injection). attn-agent links no GUI
#     libs, so nothing else is required at runtime.
#
# Build from the repo root:
#   docker build -f docker/agent.Dockerfile -t attn-agent:latest .

FROM rust:1-bookworm AS builder
RUN apt-get update && apt-get install -y --no-install-recommends \
        libwebkit2gtk-4.1-dev \
        libgtk-3-dev \
        libsoup-3.0-dev \
        pkg-config \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
# Belt-and-suspenders: assert the early-return input is present so a missing
# web/dist doesn't silently fall through to an npm build that isn't installed.
RUN test -f web/dist/index.html || (echo "web/dist/index.html missing — run 'npm --prefix web run build' first" && exit 1)
RUN cargo build --release --bin attn-agent
RUN strip target/release/attn-agent || true

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        iptables \
        iproute2 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /src/target/release/attn-agent /usr/local/bin/attn-agent
# Each container gets its own ATTN_HOME so peers stay isolated.
ENV ATTN_HOME=/data
# /data = ATTN_HOME (identity/store); /ctl = container-local control channel
# (the harness appends commands here via `docker exec`; the agent polls it).
# Deliberately NOT a host bind mount — single-file bind mounts go stale on
# Docker Desktop's FUSE layer and silently drop rapid appends.
RUN mkdir -p /data /ctl
ENTRYPOINT ["attn-agent"]
