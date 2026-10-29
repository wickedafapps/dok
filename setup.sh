#!/bin/sh
set -eu

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -f "$DIR/.env" ]; then
  set -a
  . "$DIR/.env"
  set +a
fi
SOCK=${DOCKER_SOCK:-/var/run/docker.sock}
PUID=${PUID:-${SUDO_UID:-}}
PGID=${PGID:-${SUDO_GID:-}}
MAINT_DATA=${MAINTENANCE_DATA_PATH:-}
OVERRIDE_FAILED=0
GROUP_ADDED=0

usage() {
  cat <<EOF
Usage: sudo ./setup.sh [options]

Prepare host permissions for WickedAFDok.

Options:
  --uid UID       UID for the WickedAFDok container user (default: sudo user, else repo owner)
  --gid GID       GID for the WickedAFDok container user (default: sudo user, else repo owner)
  --socket PATH   Docker socket path (default: /var/run/docker.sock)
  --maintenance-data PATH
                  Host store for Maintenance backups/snapshots (default:
                  <storage root>/maintenance after installation, otherwise
                  <checkout>-maintenance-data beside the checkout)
  --root          Run the container as root (UID/GID 0)
  -h, --help      Show this help

Environment: PUID, PGID, DOCKER_SOCK, DOK_STORAGE_ROOT, MAINTENANCE_DATA_PATH, MAINTENANCE_PORT, SKIP_BUILD
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --uid)
      [ "$#" -ge 2 ] || { echo "Missing value for --uid" >&2; exit 2; }
      PUID=$2
      shift 2
      ;;
    --gid)
      [ "$#" -ge 2 ] || { echo "Missing value for --gid" >&2; exit 2; }
      PGID=$2
      shift 2
      ;;
    --socket)
      [ "$#" -ge 2 ] || { echo "Missing value for --socket" >&2; exit 2; }
      SOCK=$2
      shift 2
      ;;
    --maintenance-data)
      [ "$#" -ge 2 ] || { echo "Missing value for --maintenance-data" >&2; exit 2; }
      MAINT_DATA=$2
      shift 2
      ;;
    --root)
      PUID=0
      PGID=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "setup.sh must run as root (use sudo)." >&2
  exit 1
fi

stat_uid() {
  stat -c %u "$1" 2>/dev/null || stat -f %u "$1" 2>/dev/null || printf '0'
}

stat_gid() {
  stat -c %g "$1" 2>/dev/null || stat -f %g "$1" 2>/dev/null || printf '0'
}

[ -n "$PUID" ] || PUID=$(stat_uid "$DIR")
[ -n "$PGID" ] || PGID=$(stat_gid "$DIR")

case "$PUID" in
  ''|*[!0-9]*) echo "Invalid UID: $PUID" >&2; exit 2 ;;
esac
case "$PGID" in
  ''|*[!0-9]*) echo "Invalid GID: $PGID" >&2; exit 2 ;;
esac
if printf '%s' "$SOCK" | grep -q '[[:cntrl:]"$`\\]'; then
  echo "Unsupported characters in Docker socket path: $SOCK" >&2
  exit 2
fi

# Maintenance storage belongs beside the checkout, not inside it: replacing or
# re-cloning Dok must never put backups, snapshots, or installation records at
# risk. --maintenance-data / MAINTENANCE_DATA_PATH can point anywhere else.
DIR_REAL=$(cd -- "$DIR" && pwd -P)
STORAGE_ROOT=${DOK_STORAGE_ROOT:-}
case "$STORAGE_ROOT" in
  '') STORAGE_ROOT=$DIR_REAL ;;
  /*) STORAGE_ROOT=$(cd -- "$STORAGE_ROOT" 2>/dev/null && pwd -P || printf '%s' "$STORAGE_ROOT") ;;
  *) echo "The Dok storage root must be an absolute host path: $STORAGE_ROOT" >&2; exit 2 ;;
esac
if [ -z "$MAINT_DATA" ]; then
  if [ "$STORAGE_ROOT" != "$DIR_REAL" ]; then
    MAINT_DATA="$STORAGE_ROOT/maintenance"
  else
    MAINT_DATA="$(dirname "$DIR_REAL")/$(basename "$DIR_REAL")-maintenance-data"
  fi
fi
case "$MAINT_DATA" in
  /*) ;;
  *) echo "The maintenance data path must be absolute: $MAINT_DATA" >&2; exit 2 ;;
esac
MAINT_NAME=$(basename "$MAINT_DATA")
case "$MAINT_NAME" in
  ''|.|..) echo "Invalid maintenance data path: $MAINT_DATA" >&2; exit 2 ;;
esac
MAINT_PARENT=$(dirname "$MAINT_DATA")
mkdir -p "$MAINT_PARENT"
MAINT_PARENT=$(cd -- "$MAINT_PARENT" && pwd -P)
MAINT_DATA="$MAINT_PARENT/$MAINT_NAME"
case "$MAINT_DATA/" in
  "$DIR_REAL"/*)
    echo "The maintenance data store must be outside the Dok checkout: $MAINT_DATA" >&2
    exit 2
    ;;
esac

# Move a legacy in-checkout store on first run. When the new store already has
# data, keep the old one under a timestamped folder there instead of
# overwriting either copy.
LEGACY_MAINT_DATA="$DIR_REAL/maintenance-data"
if [ -d "$LEGACY_MAINT_DATA" ] && [ "$LEGACY_MAINT_DATA" != "$MAINT_DATA" ]; then
  if [ ! -e "$MAINT_DATA" ] || { [ -d "$MAINT_DATA" ] && [ -z "$(ls -A "$MAINT_DATA" 2>/dev/null)" ]; }; then
    rmdir "$MAINT_DATA" 2>/dev/null || true
    if mv "$LEGACY_MAINT_DATA" "$MAINT_DATA" 2>/dev/null; then
      echo "Moved maintenance data to $MAINT_DATA"
    else
      mkdir -p "$MAINT_DATA"
      cp -Rp "$LEGACY_MAINT_DATA/." "$MAINT_DATA/" && rm -rf "$LEGACY_MAINT_DATA"
      echo "Moved maintenance data to $MAINT_DATA"
    fi
  else
    archive="$MAINT_DATA/legacy-import-$(date +%Y%m%d%H%M%S)"
    mkdir -p "$archive"
    if mv "$LEGACY_MAINT_DATA" "$archive/legacy" 2>/dev/null; then :; else
      cp -Rp "$LEGACY_MAINT_DATA/." "$archive/" && rm -rf "$LEGACY_MAINT_DATA"
    fi
    echo "WARNING: kept the previous in-checkout maintenance data at $archive" >&2
  fi
fi

if [ "$SOCK" != "/var/run/docker.sock" ] && [ -z "${DOCKER_HOST:-}" ]; then
  DOCKER_HOST="unix://$SOCK"
  export DOCKER_HOST
fi

if [ ! -S "$SOCK" ]; then
  echo "Docker socket not found or not a socket: $SOCK" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "The docker CLI is required." >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "Cannot talk to Docker. Start Docker and ensure $SOCK is accessible." >&2
  exit 1
fi

SOCK_GID=$(stat_gid "$SOCK")
DOCKER_GID=$SOCK_GID

if command -v getent >/dev/null 2>&1; then
  SOCK_GROUP=$(getent group "$SOCK_GID" 2>/dev/null | cut -d: -f1 || true)

  if getent group docker >/dev/null 2>&1; then
    DOCKER_GID=$(getent group docker | cut -d: -f3)
    if ! chgrp docker "$SOCK" 2>/dev/null; then
      echo "WARNING: could not set $SOCK group to docker; using socket GID $SOCK_GID." >&2
      DOCKER_GID=$SOCK_GID
    fi
  elif [ -n "$SOCK_GROUP" ] && [ "$SOCK_GROUP" != "root" ]; then
    DOCKER_GID=$SOCK_GID
  else
    if [ "$DOCKER_GID" -eq 0 ]; then
      if command -v groupadd >/dev/null 2>&1; then
        groupadd -r docker 2>/dev/null || true
      elif command -v addgroup >/dev/null 2>&1; then
        addgroup -S docker 2>/dev/null || true
      fi
    else
      if command -v groupadd >/dev/null 2>&1; then
        groupadd -g "$DOCKER_GID" docker 2>/dev/null || true
      elif command -v addgroup >/dev/null 2>&1; then
        addgroup -g "$DOCKER_GID" -S docker 2>/dev/null || true
      fi
    fi

    if getent group docker >/dev/null 2>&1; then
      DOCKER_GID=$(getent group docker | cut -d: -f3)
      if ! chgrp docker "$SOCK" 2>/dev/null; then
        echo "WARNING: could not set $SOCK group to docker; using socket GID $SOCK_GID." >&2
        DOCKER_GID=$SOCK_GID
      fi
    else
      echo "WARNING: could not create a docker group; using socket GID $SOCK_GID." >&2
    fi
  fi
else
  echo "WARNING: getent not found; using socket GID $DOCKER_GID." >&2
fi

if ! chmod 660 "$SOCK"; then
  echo "Could not set mode 660 on $SOCK." >&2
  exit 1
fi

if [ "$DOCKER_GID" -eq 0 ]; then
  echo "WARNING: Docker socket uses the root group (GID 0)." >&2
  echo "         The container user will be added to GID 0 so Docker remains usable." >&2
fi

add_host_user_to_socket_group() {
  [ -n "${SUDO_USER:-}" ] || return 0
  [ "$SUDO_USER" != "root" ] || return 0
  id "$SUDO_USER" >/dev/null 2>&1 || return 0
  command -v getent >/dev/null 2>&1 || return 0

  group_name=$(getent group "$DOCKER_GID" 2>/dev/null | cut -d: -f1 || true)
  [ -n "$group_name" ] || return 0
  [ "$group_name" != "root" ] || return 0

  if id -G "$SUDO_USER" 2>/dev/null | tr ' ' '\n' | grep -qx "$DOCKER_GID"; then
    return 0
  fi

  if command -v usermod >/dev/null 2>&1; then
    usermod -aG "$group_name" "$SUDO_USER" 2>/dev/null || true
  elif command -v addgroup >/dev/null 2>&1; then
    addgroup "$SUDO_USER" "$group_name" 2>/dev/null || true
  fi

  if id -G "$SUDO_USER" 2>/dev/null | tr ' ' '\n' | grep -qx "$DOCKER_GID"; then
    GROUP_ADDED=1
    echo "Added $SUDO_USER to group $group_name."
  else
    echo "WARNING: could not add $SUDO_USER to group $group_name; add it manually." >&2
  fi
}

add_host_user_to_socket_group

for d in data sources uploads apps core data/wickedafdok data/.home data/opencode data/docker-config data/tmp; do
  mkdir -p "$DIR/$d"
done
mkdir -p "$MAINT_DATA"
if [ "$STORAGE_ROOT" != "$DIR_REAL" ]; then
  mkdir -p "$STORAGE_ROOT/data" "$STORAGE_ROOT/apps" "$STORAGE_ROOT/core" "$STORAGE_ROOT/sources" "$STORAGE_ROOT/uploads"
  if [ "$PUID" -ne 0 ] || [ "$PGID" -ne 0 ]; then
    chown -R -h "$PUID:$PGID" "$STORAGE_ROOT" 2>/dev/null || true
  fi
fi

# Take ownership of the whole checkout so the container user can update code,
# write runtime state, and manage compose files without root-owned leftovers.
if [ "$PUID" -ne 0 ] || [ "$PGID" -ne 0 ]; then
  if ! chown -R -h "$PUID:$PGID" "$DIR"; then
    echo "Could not change ownership of $DIR to $PUID:$PGID." >&2
    exit 1
  fi
fi

# Normalize permissions: directories stay traversable, scripts stay executable,
# everything else is read-only outside the owner. Executable files are detected
# before their mode is changed so app entrypoints and helper scripts keep their bits.
if ! find "$DIR" -type d -exec chmod 755 {} +; then
  echo "Could not update directory permissions under $DIR." >&2
  exit 1
fi
if ! find "$DIR" -type f -exec sh -c '
  for file do
    if [ -x "$file" ]; then chmod 755 "$file"; else chmod 644 "$file"; fi
  done
' sh {} +; then
  echo "Could not update file permissions under $DIR." >&2
  exit 1
fi

# Runtime state, logs, backups, helper credentials, and managed compose files
# can contain secrets, so keep them owner-only.
find "$DIR/data" -type f \( -name '*.json' -o -name '*.tar.gz' -o -name 'server.log' -o -name 'token' \) \
  -exec chmod 600 {} + 2>/dev/null || true
find "$DIR/apps" "$DIR/core" "$DIR/data/wickedafdok" -type f \
  \( -name 'docker-compose*.yml' -o -name 'docker-compose*.yaml' -o -name 'compose.yml' -o -name 'compose.yaml' \) \
  -exec chmod 600 {} + 2>/dev/null || true
if [ -f "$DIR/.env" ]; then
  chmod 600 "$DIR/.env" 2>/dev/null || true
fi
chmod 700 "$DIR/data/.home" "$DIR/data/backups" "$DIR/data/host-helper" "$DIR/data/opencode" \
  "$DIR/data/docker-config" "$DIR/data/tmp" "$MAINT_DATA" 2>/dev/null || true
chmod 600 "$DIR/data/.credentials-key" 2>/dev/null || true
chmod 700 "$DIR/data/tmp/git-askpass.sh" 2>/dev/null || true
# OpenCode stores provider auth, session state, and generated configs here.
find "$DIR/data/opencode" -type d -exec chmod 700 {} + 2>/dev/null || true
find "$DIR/data/opencode" -type f -exec chmod 600 {} + 2>/dev/null || true
for file in "$DIR"/data/*.json; do
  [ -f "$file" ] || continue
  chmod 600 "$file" 2>/dev/null || true
done

write_override() {
  target_dir=$1
  file="$target_dir/docker-compose.override.yml"

  if [ -f "$file" ] && ! grep -q '^# managed-by: wickedafdok-setup$' "$file"; then
    echo "WARNING: $file exists and is not managed by setup.sh; leaving it unchanged." >&2
    echo "         Merge user: \"$PUID:$PGID\", group_add: [\"$DOCKER_GID\"], the Docker socket volume, and HOME=/app/data/.home." >&2
    return 1
  fi

  tmp="$file.setup.$$"
  if ! cat > "$tmp" <<EOF
# managed-by: wickedafdok-setup
services:
  wickedafdok:
    user: "$PUID:$PGID"
    group_add:
      - "$DOCKER_GID"
    volumes:
      - type: bind
        source: "$SOCK"
        target: /var/run/docker.sock
    environment:
      - HOME=/app/data/.home
      - "DOCKER_SOCK=$SOCK"
      - "MAINTENANCE_PORT=${MAINTENANCE_PORT:-8090}"
      - "MAINTENANCE_DATA_PATH=$MAINT_DATA"
EOF
  then
    rm -f "$tmp"
    echo "Could not write $file." >&2
    return 1
  fi

  chmod 644 "$tmp" 2>/dev/null || true
  if ! mv "$tmp" "$file"; then
    rm -f "$tmp"
    echo "Could not replace $file." >&2
    return 1
  fi
  if [ "$PUID" -ne 0 ] || [ "$PGID" -ne 0 ]; then
    chown "$PUID:$PGID" "$file" 2>/dev/null || true
  fi
}

write_override "$DIR" || OVERRIDE_FAILED=1
write_override "$DIR/data/wickedafdok" || OVERRIDE_FAILED=1
if [ "$STORAGE_ROOT" != "$DIR_REAL" ]; then
  mkdir -p "$STORAGE_ROOT/data/wickedafdok"
  write_override "$STORAGE_ROOT/data/wickedafdok" || OVERRIDE_FAILED=1
fi

if docker network inspect wicked >/dev/null 2>&1; then
  echo "Docker network wicked already exists."
else
  if ! docker network create --driver bridge wicked >/dev/null; then
    echo "Could not create the wicked Docker network." >&2
    exit 1
  fi
  echo "Created Docker network wicked."
fi

# ---------------------------------------------------------------------------
# Dok Maintenance
# setup.sh is the only host-privileged entry point. It starts the Maintenance
# container so the browser installer can create host directories, launch Dok,
# and configure the selected core services.
# ---------------------------------------------------------------------------
TOKEN_FILE="$STORAGE_ROOT/data/.maintenance-token"
mkdir -p "$STORAGE_ROOT/data"
if [ ! -s "$TOKEN_FILE" ]; then
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 24 > "$TOKEN_FILE"
  else
    head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$TOKEN_FILE"
  fi
fi
chmod 600 "$TOKEN_FILE" 2>/dev/null || true
if [ "$PUID" -ne 0 ] || [ "$PGID" -ne 0 ]; then
  chown "$PUID:$PGID" "$TOKEN_FILE" 2>/dev/null || true
fi
MAINTENANCE_TOKEN=$(cat "$TOKEN_FILE")
MAINTENANCE_PORT=${MAINTENANCE_PORT:-8090}

find "$MAINT_DATA" -type d -exec chmod 700 {} + 2>/dev/null || true
find "$MAINT_DATA" -type f -exec chmod 600 {} + 2>/dev/null || true
if [ "$PUID" -ne 0 ] || [ "$PGID" -ne 0 ]; then
  chown -R "$PUID:$PGID" "$MAINT_DATA" 2>/dev/null || true
fi

if [ "${SKIP_BUILD:-0}" != "1" ]; then
  echo "Building the WickedAFDok/Maintenance image..."
  if ! docker build -t wickedafdok:latest "$DIR"; then
    echo "Could not build wickedafdok:latest." >&2
    exit 1
  fi
fi

if docker inspect wickedafdok-maintenance >/dev/null 2>&1; then
  docker rm -f wickedafdok-maintenance >/dev/null 2>&1 || true
fi
if ! DOK_SOURCE_PATH="$DIR" DOK_STORAGE_ROOT="$STORAGE_ROOT" HOST_PATH=/ PUID="$PUID" PGID="$PGID" \
  DOCKER_SOCK="$SOCK" MAINTENANCE_PORT="$MAINTENANCE_PORT" \
  MAINTENANCE_DATA_PATH="$MAINT_DATA" \
  MAINTENANCE_URL="http://localhost:$MAINTENANCE_PORT" MAINTENANCE_REQUIRE_TOKEN=1 \
  docker compose -p wickedafdok-maintenance -f "$DIR/maintenance/docker-compose.yml" up -d --remove-orphans --force-recreate; then
  echo "Could not start the Dok Maintenance container." >&2
  exit 1
fi

echo
echo "Dok Maintenance is starting:"
echo "  URL:   http://localhost:$MAINTENANCE_PORT/?token=$MAINTENANCE_TOKEN"
echo "  Token: $MAINTENANCE_TOKEN"
echo
echo "Open the URL and choose Start installation. The Maintenance container"
echo "installs Dok and the core services you select, then can be shut down."
echo

echo
echo "WickedAFDok permissions configured:"
echo "  Container user: $PUID:$PGID"
echo "  Docker socket:  $SOCK (GID $DOCKER_GID, mode 660)"
echo "  Docker network: wicked"
echo "  Volume owner:   $PUID:$PGID"
echo

if [ "$OVERRIDE_FAILED" -ne 0 ]; then
  echo "WARNING: One or more docker-compose.override.yml files were not written." >&2
  echo "         Resolve the warning above, then rerun ./setup.sh." >&2
  exit 1
fi

echo "After installation, start Dok with: ./start.sh"
if [ "$GROUP_ADDED" -ne 0 ]; then
  echo "Log out and back in first so the new Docker group membership applies."
fi
