#!/bin/sh
set -eu

DIR="$(cd "$(dirname "$0")" && pwd)"
COMPOSE="$DIR/docker-compose.yml"
ALT="$DIR/data/wickedafdok/docker-compose.yml"
SOCK=${DOCKER_SOCK:-/var/run/docker.sock}
SOCK_OVERRIDE="$DIR/data/.docker-socket-gid.yml"

if [ "$SOCK" != "/var/run/docker.sock" ] && [ -z "${DOCKER_HOST:-}" ]; then
  DOCKER_HOST="unix://$SOCK"
  export DOCKER_HOST
fi

# WickedAFDok talks to Docker through the mounted socket. If the socket group
# changes (Docker reinstall, reboot, host update), a stale compose override
# leaves the container without the new GID. Generate a small extra override on
# every start so the live socket group is always applied.
sock_gid() {
  stat -c '%g' "$SOCK" 2>/dev/null || stat -f '%g' "$SOCK" 2>/dev/null || true
}

write_socket_override() {
  compose_file=$1
  out_file=$2
  gid=$3
  rm -f "$out_file"
  [ -n "$gid" ] || return 0
  [ -f "$compose_file" ] || return 0
  service=$(docker compose -f "$compose_file" config --services 2>/dev/null | head -n 1 || true)
  [ -n "$service" ] || return 0
  cat > "$out_file" <<EOF
# managed-by: wickedafdok-start
services:
  "$service":
    group_add:
      - "$gid"
EOF
}

GID=$(sock_gid)

if [ -f "$ALT" ]; then
  if grep -qE '^[[:space:]]*-[[:space:]]*"?/app/(data|sources|uploads|apps|core):/app/(data|sources|uploads|apps|core)"?$' "$ALT"; then
    echo "Ignoring managed compose with container-local bind paths: $ALT" >&2
  else
    echo "Using managed compose: $ALT"
    cd "$DIR/data/wickedafdok"
    rm -f docker-compose.socket-gid.yml
    write_socket_override docker-compose.yml docker-compose.socket-gid.yml "$GID"
    set -- docker compose -p wickedafdok -f docker-compose.yml
    if [ -f docker-compose.override.yml ]; then
      set -- "$@" -f docker-compose.override.yml
    fi
    if [ -f docker-compose.socket-gid.yml ]; then
      set -- "$@" -f docker-compose.socket-gid.yml
    fi
    set -- "$@" up -d --force-recreate --remove-orphans
    "$@"
    exit 0
  fi
fi

if [ -f "$COMPOSE" ]; then
  echo "Using root compose: $COMPOSE"
  cd "$DIR"
  if ! docker network inspect wicked >/dev/null 2>&1; then
    docker network create wicked >/dev/null
  fi
  write_socket_override docker-compose.yml "$SOCK_OVERRIDE" "$GID"
  set -- docker compose -f docker-compose.yml
  if [ -f docker-compose.override.yml ]; then
    set -- "$@" -f docker-compose.override.yml
  fi
  if [ -f "$SOCK_OVERRIDE" ]; then
    set -- "$@" -f "$SOCK_OVERRIDE"
  fi
  set -- "$@" up -d --build --remove-orphans
  "$@"
  exit 0
fi

echo "No compose file found" >&2
exit 1
