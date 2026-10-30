# Architecture and Operations

Load this file for startup/setup work, storage layout, networking, file handling, permissions, security, and known limitations.

## Startup and setup notes

- `start.sh` prefers the managed compose at `data/wickedafdok/docker-compose.yml` if it exists; otherwise uses root `docker-compose.yml`. It ignores legacy managed files whose bind sources are container-local `/app/...` paths. In the managed-compose path it rebuilds the referenced image from the checkout when a `Dockerfile` is present (the generated compose has no build context), so `git pull` still reaches a self-recreated container
- The source checkout mount is always an absolute host path. `start.sh` exports `DOK_SOURCE_PATH="$DIR"` and, for managed compose, writes `docker-compose.host-source.yml` with `$DIR:/app/host-source`; root `docker-compose.yml` uses `${DOK_SOURCE_PATH:-.}`. This prevents Compose launched from inside Maintenance from resolving `./` to `/dok-source` and creating an empty host directory that looks like the checkout. The container also receives `DOK_SOURCE_HOST_PATH` so self-recreation regenerates the correct mount instead of copying an invalid one. Maintenance resolves the checkout from `DOK_HOST_PATH`, recent launch/build log paths, or a bounded `/host` scan, and refuses to recreate Dok with an unknown source host path (run `sudo ./setup.sh` from the checkout to repair it)
- The Compose project is pinned to `wickedafdok` (top-level `name:` plus `-p wickedafdok` in `start.sh`) so a checkout directory such as `Dok` cannot create a separate `dok` project for the same container. `wickedafdok` remains the internal container/image/managed-data identifier for compatibility with existing installs even when the product is called Dok
- `start.sh` generates a small `docker-compose.socket-gid.yml` override from the live Docker socket GID on every start and passes it with `-f`, so a changed socket group does not leave the container unable to reach Docker. The self-recreate helper does the same before recreating the container.
- Root `docker-compose.yml` declares the `wicked` network as external. `setup.sh` creates it, and `start.sh` also creates it when missing, so `docker compose up` directly requires setup first
- `start.sh` honors a custom `DOCKER_SOCK` by exporting `DOCKER_HOST=unix://...` when `DOCKER_HOST` is not already set
- Managed compose is generated from the running container's inspect data during self-recreation; it is not created at server startup
- `setup.sh` defaults the container UID/GID to `SUDO_UID`/`SUDO_GID` (the sudo user), then falls back to the repo owner when not run via sudo. `--uid`/`--gid` override it; `--root` uses `0:0`. It also adds the invoking `SUDO_USER` to the socket group and prints a logout reminder at the end. After preparing permissions it builds `wickedafdok:latest` (`SKIP_BUILD=1` skips), creates `.maintenance-token` under the configured storage root (`data/.maintenance-token` before installation) and a temporary Maintenance store at `<checkout>-maintenance-data` beside the checkout (override with `--maintenance-data` or `MAINTENANCE_DATA_PATH`), migrates a legacy in-checkout `maintenance-data/`, and starts the `wickedafdok-maintenance` container with the host checkout, storage root, host root, and Docker socket mounted; it prints the token URL for the browser installer. The installer moves Dok's data and the Maintenance store into `<data location>/Dok` (Maintenance at `<data location>/Dok/maintenance`).
- `setup.sh` takes ownership of the whole checkout (including `server/`, `public/`, and `.git`), normalizes directories to `755` and files to `644` while keeping executable scripts at `755`. Runtime JSON, logs, backups, helper credentials, `.env`, and managed `docker-compose*.yml` files are set to `600`; `data/.home`, `data/backups`, `data/host-helper`, and `data/opencode` (including its subdirectories) are `700`, and files under `data/opencode` are `600`. It also chowns the generated compose override files when running non-root.
- OpenCode is installed into the image at build time from the official installer (`OPENCODE_VERSION` build arg, symlinked to `/usr/local/bin/opencode`). Setting `OPENCODE_BIN` points the server at a different binary, which is useful for development.
- The Dockerfile starts Node directly (`node server/index.js`) so non-root operation does not depend on npm having a writable home; setup sets `HOME=/app/data/.home`
- No built-in authentication - put behind a reverse proxy with auth if exposed publicly. `/api/auth` is a settings placeholder, not an auth middleware; it stores credentials and does not protect API routes.
- Runtime JSON files are written with mode `600` because settings/auth/DNS files can contain secrets. Registry/git connection secrets in `data/registries.json` and service secrets in `data/settings.json` are AES-256-GCM encrypted with `data/.credentials-key`; other runtime JSON remains plaintext.

## Persistent data layout

Dok's persistent data root is `<data location>/Dok` and is required during installation. It contains `data`, `apps`, `core`, `sources`, `uploads`, and `maintenance`; app runtime data remains `<data location>/apps/<app>/data`. Before an installation the storage root is the checkout. Maintenance storage starts at `<checkout>-maintenance-data` (or `MAINTENANCE_DATA_PATH` / `setup.sh --maintenance-data`) and moves to `<data location>/Dok/maintenance` during installation.

The installer also detects older installations that used the selected data location itself as the storage root (with `data/`, `apps/`, `core/`, and `sources/` directly inside it). It reports what it found before writing anything, adopts the folder that contains the newest complete installation instead of creating an empty `Dok` folder beside it, and leaves any alternate layout untouched. Detection never treats the source checkout, an unrelated `apps/` folder, or a bare maintenance token as a previous installation.

Persistent state is handled in three protection categories:

1. **Replaceable** — generated Dok compose files, temporary files, and logs. These can be regenerated on install, repair, or update.
2. **Configurable** — `data/settings.json`, `data/registries.json`, `data/auth.json`, `data/dns.json`, `.credentials-key`, and core service configuration. On reinstall the user chooses **Reuse existing settings** or **Replace settings**; only the replace path rewrites these files. Reuse keeps existing credentials/secrets and merges the wizard values.
3. **User data** — the app library (`apps/` plus `data/registry.json`), app runtime data under `<data location>/apps`, app groups, `sources/`, `uploads/`, and Maintenance backups/snapshots. These are never overwritten or deleted by installation, repair, update, or restore; only the user removes them manually.

Before a reinstall or repair changes an existing storage root, Maintenance records a `pre-install` snapshot (best effort) so the previous state can be restored. Installation verifies the Dok container, API, HTML UI, stored settings, app-library JSON, credential key, Docker access, and installation state before it reports completion.

## Network

- Default network is `wicked` (bridge), declared external in root `docker-compose.yml` and created by `setup.sh` or `start.sh`
- Apps connect to `wicked` network by default
- nginx-proxy uses `wicked` network
- Core services may auto-create their configured network via `ensureNetwork()`; failures propagate to the caller instead of being ignored
- App creation never silently creates arbitrary input networks; it requires `networkChoices` or an explicit create action
- Finalize rejects `host`, `none`, `bridge`, `default`, `container:*`, and `service:*` as form network names; use `network_mode` for those modes

## File handling

- Uploads use multer with disk storage in `uploads/`
- Cross-device moves use copy+delete fallback (handles EXDEV)
- File operations sandboxed to allowed directories with realpath checks where applicable
- Upload paths are parsed as an array, traversal/empty destinations are discarded and their temp files removed, and destination parents are checked to stay inside the project after resolving symlinks
- Git clones and self-update use generic git over any host. TLS verification is enabled by default; `WICKEDAFDOK_GIT_INSECURE=1` opts into `GIT_SSL_NO_VERIFY=true` for trusted self-signed servers.
- Git connections stored in Dok Settings inject `GIT_ASKPASS` and credential environment variables only for matching HTTPS hosts. Secret values are never placed in the askpass script or command line.
- Runtime JSON writes use mode `600`, as do managed app/core compose files and backup archives. Registry/git connection secrets and service secrets in `data/settings.json` are encrypted at rest; other non-secret runtime JSON remains plaintext.
- `shm_size` values generated from `docker run --shm-size` are normalized to human-readable Compose sizes (`1073741824` becomes `1gb`); the builder displays `shm_size` the same way.

## Permission handling

- `processIdentity()`, `permissionDenied()`, and `ensureWritableDirectory()` provide consistent `403` responses with the server UID/GID and `sudo ./setup.sh` guidance
- `ensureHostDirectory()` retries host path creation through the optional Host Helper socket when direct `mkdir` is denied
- App, source, upload, finalize, and volume-directory creation use permission-aware handling; the global error handler also converts uncaught `EACCES`/`EPERM`/`EROFS` to `403`
- `setup.sh` owns/chowns the whole checkout and normalizes its modes; if host paths are created outside those directories, the container user must already have write access
- The container mounts the Docker socket and therefore has root-equivalent Docker control. Treat unauthenticated UI/API access accordingly.
- Docker socket access depends on the container user being in the socket's group. `setup.sh` writes the current GID into the compose override, `start.sh` refreshes it on every start, and self-recreation adds it to the generated compose. If Docker access is lost after a daemon/host update (socket GID changed), run `sudo ./setup.sh` and then `./start.sh`.

## Registry and Git Connections

- `data/registries.json` holds `{ connections: [...] }`; each entry has `kind` (`registry` or `git`), `provider`, `name`, `host`, `username`, and `secretEnc`
- `encryptSecret()`/`decryptSecret()` use AES-256-GCM with a 32-byte key from `data/.credentials-key`; corrupt or missing keys make existing secrets unusable and are treated as missing
- Hosts are normalized (protocol/path stripped, `index.docker.io`/`registry-1.docker.io` mapped to `docker.io`)
- `ensureDockerConfigForRegistries()` writes `data/docker-config/config.json` with `auths` entries for every container-registry connection, preserving any pre-existing Docker config. `run()` automatically sets `DOCKER_CONFIG` for `docker` commands when connections exist, so image pulls and compose launches authenticate without exposing secrets in command lines
- `gitEnvironment(repo)` matches the URL host against `kind: 'git'` connections and injects `GIT_ASKPASS` plus `WICKEDAFDOK_GIT_USERNAME`/`WICKEDAFDOK_GIT_PASSWORD`. The askpass helper lives in `data/tmp/git-askpass.sh` and contains no secrets. SSH URLs are unaffected and use the container user's keys
- `POST /api/registries/:id/test` uses a temporary `DOCKER_CONFIG` and `docker login --password-stdin` for registries, the GitHub/GitLab user APIs for those git hosts, and a connection-saved response for custom git hosts

## Known limitations

- No authentication or authorization middleware. `/api/auth` only stores settings; every API route remains open. The Docker socket gives the container root-equivalent Docker control.
- App configuration and compose builder state are client-side; the server re-validates on finalize. An existing non-empty `apps/<name>/` is previewed in a hidden staging directory, and finalizing into an existing app name requires the overwrite confirmation.
- The Host Helper is optional and privileged. Without it, host paths outside the runtime directories must be writable by the server UID/GID.
- Authentik is launched as a standalone SSO service. Per-app forward-auth/proxy providers still need to be configured in Authentik and the fronting proxy; WickedAFDok does not automatically enable auth for every app.
- Self-update requires a writable persistent application code checkout mounted from an absolute host path at `/app/host-source`. The default image bakes source into `/app` and runs as non-root in common deployments, so an in-app update is lost on container recreation unless the host checkout is bind-mounted; otherwise update on the host with `git pull` and rebuild via `./start.sh`. If Docker shows `/app/host-source` sourced from `/dok-source` or the directory is empty, run `sudo ./setup.sh` from the checkout; Compose cannot resolve a relative `./` to the host checkout when it runs inside Maintenance. Dok and Maintenance run git with `-c safe.directory=<checkout dir>`, so a checkout owned by the host user does not fail with Git's `detected dubious ownership` error.
- Service secrets in `data/settings.json` (cloudflared token, Authentik and Authelia passwords/keys, Technitium admin password, SMTP password, OpenCode API key) are AES-256-GCM encrypted with `data/.credentials-key`. `readSettings()` decrypts for internal use, `writeSettings()` encrypts, and API responses redact values while exposing `*Set` flags. Legacy plaintext values are encrypted on the first start. Registry and git connection secrets use the same key; losing that key makes the stored secrets unrecoverable (delete and re-enter them).
- OpenCode is installed during the Docker image build. Existing deployments must rebuild the image to add it, and the build needs network access to `opencode.ai`/GitHub releases. Set `OPENCODE_BIN` to use a local binary during development.
- User mode is a permission guardrail for the AI agent, not an OS sandbox. It runs as the same container user as Admin mode, so a determined command can still reach files or binaries the Unix user can access. Shell sessions are not restricted at all. Use a separate container/user for hard isolation.
- The browser terminal and OC Assist are protected only by the same (currently absent) authentication as the rest of the UI. Anyone who can reach the UI can open an Admin shell; keep it behind a trusted network or authenticated reverse proxy. WebSocket upgrades at `/api/terminal/ws` are preferred for the shell; when a proxy blocks them, the HTTP compatibility transport keeps the terminal usable at the cost of higher request overhead. OC Assist uses plain HTTP polling against the local OpenCode server, so chat rendering and follow-up prompts do not depend on WebSocket upgrades.
- A corrupt `data/registry.json` is preserved once as `registry.json.corrupt-<timestamp>` and treated as an empty registry; recovery is manual.
- There is no automated test suite. Use Bun builds and API smoke tests; Docker CLI-backed compose validation is unavailable when the CLI is missing.
