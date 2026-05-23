#!/usr/bin/env bash
# Cross-topology collab harness (attn-orf) — reproduces the cross-machine,
# no-TURN desync deterministically in Docker.
#
# Boots a relay on the host (reachable by all containers) + 3 headless
# `attn-agent` containers (owner + reviewerB + reviewerC). Then runs two
# topologies and compares:
#
#   baseline   — full connectivity. WebRTC mesh forms; everything converges.
#   partition  — iptables DROPs ALL inter-agent traffic (peers can't reach
#                each other) while the relay stays reachable. This is the
#                no-TURN symmetric-NAT condition: direct DataChannels CANNOT
#                form, so collab + comments must survive over the relay
#                fallback. If they don't, the asymmetric drop is reproduced.
#
# A comment + a collab payload are sent by reviewerB; we assert both reach the
# owner AND reviewerC. The interesting result is the DIFF: baseline PASS but
# partition FAIL == bug reproduced. Once the per-peer relay-fallback fix
# (attn-7qv) lands, partition should also PASS.
#
# Requires: docker, and either a built `attn-agent:latest` image or this script
# builds it. Relay needs node/wrangler on the host (relay/node_modules).
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${ATTN_AGENT_IMAGE:-attn-agent:latest}"
NET="attn-topo-net"
PORT="${RELAY_PORT:-8787}"
RELAY_URL_HOST="http://127.0.0.1:$PORT"
# Containers reach the host relay via the docker host-gateway alias.
RELAY_URL_CTR="http://host.docker.internal:$PORT"
WORK="${WORK:-/tmp/attn-topo}"
AGENTS=(owner rvB rvC)

log(){ printf '== %s\n' "$*"; }
err(){ printf 'topo: %s\n' "$*" >&2; }

RELAY_PID=""
declare -A PIDS
cleanup(){
  for a in "${AGENTS[@]}"; do docker rm -f "topo-$a" >/dev/null 2>&1 || true; done
  docker network rm "$NET" >/dev/null 2>&1 || true
  [ -n "$RELAY_PID" ] && { pkill -P "$RELAY_PID" 2>/dev/null; kill "$RELAY_PID" 2>/dev/null; }
  pkill -f "wrangler dev --local --port $PORT" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

ensure_image(){
  if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    log "building $IMAGE (docker/agent.Dockerfile)"
    docker build -f "$ROOT/docker/agent.Dockerfile" -t "$IMAGE" "$ROOT" || { err "image build failed"; exit 1; }
  fi
}

start_relay(){
  [ -d "$ROOT/relay/node_modules" ] || (cd "$ROOT/relay" && npm ci >/dev/null)
  # Hermetic relay: persist DO state to a fresh per-run dir (NOT the default
  # relay/.wrangler/state, which survives across runs and leaks rooms/invites
  # between scenarios — that flakes convergence and reuses stale room ids).
  local pstate="$WORK/wrangler-state"
  rm -rf "$pstate"; mkdir -p "$pstate"
  log "starting relay on host :$PORT (bind 0.0.0.0, hermetic state)"
  ( cd "$ROOT/relay" && exec npx wrangler dev --local --ip 0.0.0.0 --port "$PORT" --persist-to "$pstate" ) \
      >"$WORK/relay.log" 2>&1 &
  RELAY_PID=$!
  local deadline=$(( $(date +%s) + 60 ))
  until curl -fsS "$RELAY_URL_HOST/health" >/dev/null 2>&1; do
    [ "$(date +%s)" -lt "$deadline" ] || { err "relay never healthy"; tail -20 "$WORK/relay.log" >&2; exit 1; }
    kill -0 "$RELAY_PID" 2>/dev/null || { err "relay died"; tail -20 "$WORK/relay.log" >&2; exit 1; }
    sleep 0.3
  done
  log "relay healthy"
}

# Per-scenario directory for logs + command files, so two sequential scenarios
# never share (or truncate) each other's capture. Set by run_scenario.
SDIR="$WORK"

# Run one agent container. The control channel is a CONTAINER-LOCAL file the
# agent polls (ATTN_AGENT_CMD_FILE=/ctl/cmd); the harness appends commands to it
# via `docker exec`. We do NOT use `docker run -i` stdin, bind-mounted FIFOs, or
# bind-mounted files: all three silently drop rapid back-to-back writes on
# Docker Desktop (stdin/FIFO don't stream; single-file bind mounts go stale in
# the FUSE attribute cache). `docker exec ... >> /ctl/cmd` writes inside the
# container's own filesystem, so the agent sees every appended line immediately.
start_agent(){ # name
  local a="$1" logf="$SDIR/out_$a"
  : > "$logf"
  docker run --rm --name "topo-$a" \
      --network "$NET" \
      --cap-add NET_ADMIN \
      --add-host host.docker.internal:host-gateway \
      -e "ATTN_RELAY_URL=$RELAY_URL_CTR" \
      -e "ATTN_HOME=/data" \
      -e "ATTN_AGENT_CMD_FILE=/ctl/cmd" \
      "$IMAGE" --mode live \
      > "$logf" 2>&1 &
  PIDS[$a]=$!
}
# Append one JSON command line to the agent's container-local control file.
# The JSON is passed as an argv element (not interpolated into the shell text)
# so embedded quotes/braces/backslashes survive verbatim.
send(){ docker exec "topo-$1" sh -c 'printf "%s\n" "$1" >> /ctl/cmd' _ "$2"; }
saw(){ grep -q "$2" "$SDIR/out_$1" 2>/dev/null; }

ctr_ip(){ docker inspect -f "{{.NetworkSettings.Networks.${NET}.IPAddress}}" "topo-$1" 2>/dev/null; }

# Block ALL traffic between the two sibling agents (both directions), leaving
# the host relay reachable. Models "no peer-to-peer path; relay only".
# Faithful no-TURN / symmetric-NAT model: block ALL UDP in every agent, both
# directions. WebRTC ICE, DTLS, and the SCTP DataChannel all ride UDP, so this
# guarantees no direct peer-to-peer channel can form — and with no TURN there
# is no UDP relay to fall back on. The Cloudflare relay is reached over TCP
# (WS signaling + HTTP outbox), which UDP-drop leaves untouched, so collab +
# comments must survive over the relay alone. (An earlier version dropped only
# inter-container IPs; ICE found a path around it and the mesh still formed —
# blocking the whole UDP transport is unambiguous and path-independent.)
partition_agents(){
  log "PARTITION: blocking ALL UDP in every agent (no ICE/DTLS/DataChannel; relay TCP only)"
  for a in "${AGENTS[@]}"; do
    docker exec "topo-$a" sh -c 'iptables -A INPUT -p udp -j DROP && iptables -A OUTPUT -p udp -j DROP' \
      || { err "[$a] failed to install UDP-drop rules — partition not faithful"; return 1; }
    # Verify the rules are actually present (a silent miss invalidates the test).
    docker exec "topo-$a" iptables -S 2>/dev/null | grep -q -- '-p udp -j DROP' \
      || { err "[$a] UDP-drop rules absent after install"; return 1; }
  done
}

run_scenario(){ # topology(baseline|partition)
  local topo="$1"
  local cmark="CMT_${topo}_$$" gmark="COLLAB_${topo}_$$"
  log "=== scenario: $topo ==="
  # Fresh per-scenario capture dir + clean FD/PID maps so scenarios never
  # share or truncate each other's logs/FIFOs.
  SDIR="$WORK/$topo"; mkdir -p "$SDIR"
  PIDS=()
  docker network create "$NET" >/dev/null 2>&1 || true
  for a in "${AGENTS[@]}"; do start_agent "$a"; done
  sleep 2

  [ "$topo" = "partition" ] && partition_agents

  log "owner shares (live)"
  # Owner needs a file inside its container; write one via the share command's
  # path — the image has /data writable, so seed a doc there first.
  docker exec "topo-owner" sh -c 'printf "# Shared\n\nseed line\n" > /data/doc.md' 2>/dev/null || true
  send owner '{"cmd":"share","path":"/data/doc.md","mode":"live"}'

  local invite="" deadline=$(( $(date +%s) + 20 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    invite=$(grep -ho 'attn://review/[A-Za-z0-9_/#=.-]*' "$SDIR/out_owner" 2>/dev/null | head -1)
    [ -n "$invite" ] && break; sleep 0.3
  done
  [ -n "$invite" ] || { err "[$topo] owner produced no invite"; tail -5 "$SDIR/out_owner" >&2; return 2; }
  log "invite ${invite:0:42}…"

  send rvB "{\"cmd\":\"join\",\"invite\":\"$invite\"}"
  send rvC "{\"cmd\":\"join\",\"invite\":\"$invite\"}"
  sleep 5   # let WebRTC attempt to form (and fail, under partition)

  log "reviewerB sends comment ($cmark) + collab ($gmark)"
  send rvB "{\"cmd\":\"comment\",\"body\":\"$cmark\"}"
  send rvB "{\"cmd\":\"collab\",\"payload\":\"{\\\"m\\\":\\\"$gmark\\\"}\"}"

  local pass=0 total=4
  for who in owner rvC; do
    for mark in "$cmark" "$gmark"; do
      local ok=0 dl=$(( $(date +%s) + 25 ))
      while [ "$(date +%s)" -lt "$dl" ]; do saw "$who" "$mark" && { ok=1; break; }; sleep 0.4; done
      if [ "$ok" = 1 ]; then echo "  PASS [$topo] $who saw $mark"; pass=$((pass+1));
      else echo "  FAIL [$topo] $who never saw $mark"; fi
    done
  done

  # Under partition the data MUST have ridden the relay, not a DataChannel.
  # Prove the mesh never formed: `live_direct` is the connection state an agent
  # emits the moment a WebRTC channel connects. If we see it, the UDP block
  # leaked and "relay-only" wasn't actually exercised — so the partition pass is
  # meaningless and the scenario fails regardless of convergence.
  local mesh_ok=1
  if [ "$topo" = "partition" ]; then
    local meshed=0
    for a in "${AGENTS[@]}"; do
      grep -q '"connection":"live_direct"' "$SDIR/out_$a" 2>/dev/null && meshed=1
    done
    if [ "$meshed" = 0 ]; then
      echo "  PASS [partition] mesh never formed (no live_direct) — relay carried comment+collab"
    else
      echo "  FAIL [partition] a DataChannel formed (live_direct seen) — UDP block leaked; relay-only NOT proven"
      mesh_ok=0
    fi
  fi

  # Teardown this scenario's containers/network before the next.
  for a in "${AGENTS[@]}"; do docker rm -f "topo-$a" >/dev/null 2>&1 || true; done
  docker network rm "$NET" >/dev/null 2>&1 || true
  echo "RESULT[$topo]: $pass/$total"
  [ "$pass" = "$total" ] && [ "$mesh_ok" = 1 ]
}

mkdir -p "$WORK"
ensure_image
start_relay

base_ok=0; part_ok=0
run_scenario baseline  && base_ok=1
run_scenario partition && part_ok=1

echo
echo "================ SUMMARY ================"
echo "baseline (full connectivity) : $([ $base_ok = 1 ] && echo PASS || echo FAIL)"
echo "partition (no peer-to-peer)  : $([ $part_ok = 1 ] && echo PASS || echo FAIL)"
if [ $base_ok = 1 ] && [ $part_ok = 0 ]; then
  echo ">> BUG REPRODUCED (attn-7qv): converges over the WebRTC mesh, but DROPS"
  echo "   when ALL UDP is blocked and peers can only reach the relay (the"
  echo "   no-TURN symmetric-NAT case). The per-peer relay fallback is incomplete."
  exit 1
elif [ $base_ok = 1 ] && [ $part_ok = 1 ]; then
  echo ">> attn-7qv VALIDATED: baseline converges WebRTC-primary; under a faithful"
  echo "   UDP blackout the mesh never forms (no live_direct) yet comment+collab"
  echo "   still converge via the relay alone. No-TURN fallback works."
  exit 0
else
  echo ">> Baseline itself failed — harness/relay/image issue, not the bug."
  exit 2
fi
