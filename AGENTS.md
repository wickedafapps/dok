# WickedAFDok - Agent Guide

## Overview
- **Name:** WickedAFDok
- **Purpose:** Self-hosted Docker/container management UI running in a container with access to `/var/run/docker.sock`. Provides a web interface to manage containers, images, deploy apps, and configure core services.
- **Stack:** Node.js 24 (ESM), Express.js, Dockerode + Docker CLI, vanilla HTML/CSS/JS, `node-pty` + `ws` + xterm.js for the browser terminal, OpenCode CLI for on-demand AI sessions
- **Entry Point:** `server/index.js` - serves REST API, terminal WebSocket, and static files from `public/`
- **Port:** 8080 (default, configurable via `PORT` env var)
- **Volumes:** `./data`, `./sources`, `./uploads`, `./apps`, `./core`

## Quick Start
```bash
# Prepare permissions and runtime directories once
sudo ./setup.sh

# Preferred method using start script
./start.sh

# Or with docker compose from repo root
docker compose up -d --build

# Or build and run manually
docker build -t wickedafdok .
docker run -d --name wickedafdok -p 8080:8080 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/sources:/app/sources \
  -v $(pwd)/uploads:/app/uploads \
  -v $(pwd)/apps:/app/apps \
  -v $(pwd)/core:/app/core \
  wickedafdok
```

**Notes on startup:**
- `start.sh` prefers the managed compose at `data/wickedafdok/docker-compose.yml` if it exists; otherwise uses root `docker-compose.yml`. It ignores legacy managed files whose bind sources are container-local `/app/...` paths. In the managed-compose path it rebuilds the referenced image from the checkout when a `Dockerfile` is present (the generated compose has no build context), so `git pull` still reaches a self-recreated container
- The Compose project is pinned to `wickedafdok` (top-level `name:` plus `-p wickedafdok` in `start.sh`) so a checkout directory such as `Dok` cannot create a separate `dok` project for the same container. `wickedafdok` remains the internal container/image/managed-data identifier for compatibility with existing installs even when the product is called Dok
- `start.sh` generates a small `docker-compose.socket-gid.yml` override from the live Docker socket GID on every start and passes it with `-f`, so a changed socket group does not leave the container unable to reach Docker. The self-recreate helper does the same before recreating the container.
- Root `docker-compose.yml` declares the `wicked` network as external. `setup.sh` creates it, and `start.sh` also creates it when missing, so `docker compose up` directly requires setup first
- `start.sh` honors a custom `DOCKER_SOCK` by exporting `DOCKER_HOST=unix://...` when `DOCKER_HOST` is not already set
- Managed compose is generated from the running container's inspect data during self-recreation; it is not created at server startup
- `setup.sh` defaults the container UID/GID to `SUDO_UID`/`SUDO_GID` (the sudo user), then falls back to the repo owner when not run via sudo. `--uid`/`--gid` override it; `--root` uses `0:0`. It also adds the invoking `SUDO_USER` to the socket group and prints a logout reminder at the end.
- `setup.sh` takes ownership of the whole checkout (including `server/`, `public/`, and `.git`), normalizes directories to `755` and files to `644` while keeping executable scripts at `755`. Runtime JSON, logs, backups, helper credentials, `.env`, and managed `docker-compose*.yml` files are set to `600`; `data/.home`, `data/backups`, `data/host-helper`, and `data/opencode` (including its subdirectories) are `700`, and files under `data/opencode` are `600`. It also chowns the generated compose override files when running non-root.
- OpenCode is installed into the image at build time from the official installer (`OPENCODE_VERSION` build arg, symlinked to `/usr/local/bin/opencode`). Setting `OPENCODE_BIN` points the server at a different binary, which is useful for development.
- The Dockerfile starts Node directly (`node server/index.js`) so non-root operation does not depend on npm having a writable home; setup sets `HOME=/app/data/.home`
- No built-in authentication - put behind a reverse proxy with auth if exposed publicly. `/api/auth` is a settings placeholder, not an auth middleware; it stores credentials and does not protect API routes.
- Runtime JSON files are written with mode `600` because settings/auth/DNS files can contain secrets. Registry/git connection secrets in `data/registries.json` and service secrets in `data/settings.json` are AES-256-GCM encrypted with `data/.credentials-key`; other runtime JSON remains plaintext.

## Directory Structure
```
.
├── .dockerignore        # Keeps runtime data and node_modules out of image builds
├── .gitignore           # Keeps runtime data, node_modules, and generated files out of git
├── server/index.js      # Main server with all API routes and business logic
├── server/host-agent.js # Optional privileged helper socket for host directory creation
├── server/assist-register.mjs # OC Assist helper that registers/deploys an app via finalize API
├── public/              # Frontend
│   ├── index.html       # UI structure
│   ├── css/style.css    # Styles
│   └── js/app.js        # Frontend logic
├── apps/                # Deployed apps (each app in its own subdirectory with compose)
├── core/                # Core services (nginx-proxy, cloudflared, authentik, authelia, dns, mailpit, host-helper)
├── data/                # Persistent data (registry, settings, backups, logs, managed compose)
│   ├── registries.json  # Encrypted registry and git connection credentials
│   ├── .credentials-key # 0600 AES-256-GCM key used for registry and settings secrets
│   ├── designer/        # Uploaded Designer logo files
│   ├── docker-config/   # Generated Docker auth config used for pulls (0700/0600)
│   ├── backups/         # Local full/app backup archives + metadata
│   ├── logs/            # server.log
│   ├── host-helper/     # Host helper token and agent socket
│   └── opencode/        # Per-mode OpenCode config/state + shared provider auth/data
├── sources/             # Projects/sources for manual browsing/editing
├── uploads/             # Temporary upload staging area
├── setup.sh             # Host permission/Docker socket setup script
└── start.sh             # Startup helper script
```

## Features

### Dashboard
- Host/system stats (CPU, memory, disk, load average, uptime)
- Docker engine info
- Network information
- Live auto-refresh

### Containers
- List all containers (running/stopped), split into **Core Services** and **Workloads**
- Core containers are identified from compose project labels/known names, protected from easy deletion, and cannot be updated/re-saved as apps from this tab
- Protected removal requires typing the exact container name; the API enforces `confirmName`
- **Apps interface** button opens the Apps tab
- Actions: start, stop, restart, pause, unpause
- Remove containers
- View container logs (modal)
- Inspect container details
- Redeploy containers
- Save containers to apps registry

### Images
- List Docker images
- Pull images from registry
- Remove images
- Quick-run helper

### App Creation
The unified way to deploy applications. Every app is stored in `apps/<name>/` with its own `docker-compose.yml` and managed as a compose project.

**Creation Methods:**

1. **Docker Run** - Paste a `docker run` command. WickedAFDok parses and converts it to a normalized compose file. Opens App Configuration modal.
2. **Docker Compose** - Paste `docker-compose.yml`/`compose.yaml` content. Stored in the app's own managed compose file and opened in App Configuration modal.
3. **Git Clone** - Provide any git URL (generic git, not limited to GitHub API). If repo contains `docker-compose.yml`/`compose.yaml` or `Dockerfile`, files are copied to `apps/<name>` and opened in App Configuration modal; Dockerfile-only projects get a generated compose file. If no compose/Dockerfile found, routed to **Projects**.
4. **Local Upload** - Upload files/folders via multipart form. If compose or Dockerfile present, files are copied to `apps/<name>` and opened in App Configuration modal; Dockerfile-only uploads get a generated compose file. Otherwise routed to **Projects**.
5. **OC Assist** - Describe the app in a required prompt, optionally paste data (docker run, compose, repository/page URL) and upload files. WickedAFDok writes a private brief plus the uploads under `sources/oc-assist-<stamp>-<random>/`, starts an Admin OpenCode session with that brief, and the agent creates the compose, registers the app through `server/assist-register.mjs`, and deploys it. Use `#assistPrompt`, `#assistData`, `#assistName`, `#assistFiles`, `#assistFolder`, `#assistStartBtn`, and `#assistOutput`.

**App Configuration Modal:**
- Opens with a visual Compose builder (`#appCfgBuilder`) populated from the managed compose via `/api/compose/parse`
- Builder model shape: `{ services: [{ name, fields: [{ key, type, value, required? }] }], networks: [{ key, external, name, driver, extra? }], volumes: [...], other?: string }`
- Services, networks, volumes, and top-level settings are editable as fields; `+ Add service`, `+ Add field`, `+ Add network`, and `+ Add volume` add fields, while `−` removes them
- The service field type dropdown covers common Compose keys; unknown parsed keys appear as custom JSON fields. Advanced structures are preserved in raw/JSON fields (`depends_on` conditions, network aliases/options, long ports/volumes, multiline commands, `extra_hosts`, unknown top-level keys)
- Required fields (image when no build context is present) are auto-added and marked required until filled; missing required values and conflicts such as duplicate service/container names, duplicate published ports, invalid ports, and invalid JSON are highlighted red
- Every builder change regenerates the compose through `/api/compose/build`; edits to ports and `VIRTUAL_HOST`/`VIRTUAL_PORT` stay in sync with the quick fields. Port/volume lists accept comma-separated values on one line; other list fields are one value per line so embedded commas (for example `tmpfs` options) are preserved
- Builder requests are sequenced: stale responses are ignored, in-flight builds cannot overwrite manual compose edits, and quick fields target the preferred app/vhost service instead of always `services[0]`
- Switching to manual compose editing hides the builder and sets a dirty/manual flag so run-created apps retain their original `docker run` semantics unless the builder was actually edited
- When Docker Compose CLI is unavailable, `/api/compose/parse` falls back to a built-in block-YAML reader for the Compose subset
- **"Manually edit compose file"** - Opens warning modal about potential breakage; hides the builder and allows direct textarea editing
- **"Validate compose"** - Validates compose syntax/structure via `/api/compose/validate`
- Completion is blocked while the builder reports errors; manual editing bypasses the builder guard and still uses compose validation. The Complete buttons are guarded against double submission.
- Completing shows `#appCfgProgress` with a staged progress bar (prepare/build/validate/save/launch), jumps to 100%, then closes the modal after a short delay on success. Failures hide the bar and restore the buttons.
- If validation errors occur on save, UI shows issues and prompts to fix or save anyway
- If core nginx-proxy not created, shows notice with option to create it: *"The core nginx service has not been created. Create it to automatically direct your domains to your containers."*
- Actions: **Complete Creation** (save/configure only) or **Complete Creation and Launch** (configure and start)
- Missing required fields (like `VIRTUAL_HOST`/`VIRTUAL_PORT` when nginx-proxy running) are highlighted in red
- Existing `VIRTUAL_HOST`/`VIRTUAL_PORT` values from docker run or compose are prefilled into the form; form values override, duplicates are stripped, and clearing the field explicitly clears them. The initial vhost value is retained across missing-resource retries so a clear is not lost.
- For docker-run creation the form port list is authoritative; changing it replaces command ports and clearing it removes them. `--network bridge` keeps published ports; host/none/container network modes drop ports.
- Missing input networks are shown in `#appCfgNetworkNotice`; the user must choose an existing network or create it. Arbitrary networks are never silently created.
- Form networks `host`, `none`, `bridge`, `default`, `container:*`, and `service:*` are rejected by finalize; use `network_mode` in the compose file for those modes.
- Missing bind-mount host paths are shown in `#appCfgVolumeNotice`; the user must choose an existing absolute path or explicitly create the directory. Protected system paths are blocked when creating missing paths; existing protected paths such as `/var/run/docker.sock` remain selectable.
- The compose is validated both alone and together with the generated override before finalize; unresolved networks/volumes and port conflicts block creation unless the user chooses to save anyway.
- Explicitly empty compose input is rejected with `Compose file is empty`.

### Apps
- Lists all apps from `data/registry.json`
- Each app managed from `apps/<name>/` via docker compose
- Actions: **Quick Deploy** (one-click compose up), **Alter State** (opens the compose editor for the app's base config), start, stop, restart, and remove
- Quick Deploy resolves duplicate `container_name` conflicts by renaming the stale non-core container to `<name>-previous-<shortid>`; conflicts with protected core services abort with `409`
- Alter State saves the edited compose as the new base `docker-compose.yml` (or the app's existing compose filename), removes the generated `docker-compose.wickedafdok.yml` override, re-adds the `wicked` default network and prior `VIRTUAL_HOST`/`VIRTUAL_PORT` when needed, and can save only or save and deploy
- A first start that reports failure while project containers already exist is returned as `launchPending` instead of a failure so slow builds are not misreported
- UI element: `#tab-apps`, `#appsList`, `#appsRefresh`

### Projects / Sources
- Browse and edit files under `sources/` directory
- Auto-detect presence of compose files or Dockerfiles
- Deploy from Projects goes through App Creation flow
- UI element: `#tab-sources`

### Dok Settings

Settings is split into four subtabs: **Core Services**, **Dok Settings**, **Logs**, and **Backups & Updates**. Dok Settings contains the app's own management options: Default settings, Designer, Groups, and registry connections.

**Default settings:**
- `#defaultsCard` stores fallback values in `settings.defaults` and exposes `GET/POST /api/settings/defaults`, plus `POST /api/settings/defaults/apply`
- `primaryDomain` is used to suggest `auth.<domain>`, `sso.<domain>`, `dns.<domain>`, and `mail.<domain>` in the core-service forms
- `dokDomain` is used for the Dok UI and falls back to `services.nginxProxy.domain`; saving a Dok domain also fills a blank nginx domain
- `dataLocation` (absolute host path) and `dataMode` (octal, default `0775`) create `<dataLocation>/apps`; app data defaults to `<dataLocation>/apps/<app>/data` and missing relative bind mounts are mapped beneath that folder
- `autoAppData` controls automatic app data folders; `allowOutsideData` permits creating/using bind paths outside the data location (otherwise finalize rejects missing outside paths). Creation goes through the Host Helper when direct access is denied
- `adminUser`, `adminEmail`, and `adminPassword` prefill/seed Authelia, Authentik, and Technitium installs; the password is encrypted and exposed only as `adminPasswordSet`
- `defaultNetwork` is used by app creation and may be auto-created on first use
- `protectDok` adds the Dok host to the Authelia protected set without recreating the Dok container; the Dok domain must already route through nginx-proxy, the Authelia portal domain must be set, and both must share a cookie domain for the protection to take effect. Enabling it is rejected (and the setting reverted) when sync cannot generate the auth vhost
- Saving defaults creates the configured data location and apps folder, validates domains/modes, and triggers Authelia vhost sync when `protectDok` changes

**Designer:**
- `#openDesigner` in Dok Settings opens `#designerModal`
- Stores `designer.name`, `designer.tagline`, `designer.css`, and `designer.logo` in `data/settings.json`; uploaded logos live under `data/designer/`
- `GET/POST /api/designer`, `POST /api/designer/logo`, `GET /api/designer/logo`
- Name, tagline, and CSS are applied live to the header; the CSS override is injected as a `<style>` element
- Bundled error pages live in `core/nginx-proxy/html/` (`html/404.html`, `html/403.html`, `html/errors/50x.html`) and are mounted at `/usr/share/nginx/html` in nginx-proxy. `core/nginx-proxy/vhost.d/default` (created only when absent) sets `proxy_intercept_errors`/`error_page` to those files. Existing pages and configs are never overwritten
- The file picker opens `html/404.html` by default and lists error pages before vhost snippets and the compose file
- `GET /api/designer/files`, `GET /api/designer/file?path=`, and `POST /api/designer/file` expose editable text files under `core/nginx-proxy` (error pages, vhost snippets, configs); dotfiles and private key/`.pem` files are excluded

**Groups:**
- Stores container groups in `data/groups.json`
- The **Core Services** group is built in and computed from live Docker labels/names (`com.docker.compose.project` and known core container names). It cannot be edited or deleted and appears first in `GET /api/groups`
- `GET /api/groups`, `POST /api/groups`, and `DELETE /api/groups/:id`
- UI elements live inside `#settings-pane-dok`: `#groupName`, `#groupContainers`, `#saveGroup`, `#groupsList`

**Registry connections:**
- Stores container registry and git host credentials in `data/registries.json`
- Secrets are encrypted with AES-256-GCM using `data/.credentials-key`; API responses only expose `hasSecret`, never the secret itself
- `GET /api/registries` lists connections, `POST /api/registries` creates/updates one, `DELETE /api/registries/:id` removes one, and `POST /api/registries/:id/test` validates it
- Presets cover Docker Hub, GHCR, GitLab Container Registry, Quay, custom registries, GitHub, GitLab, Gitea/Forgejo, and custom git hosts
- `run()` injects a generated `DOCKER_CONFIG` (from `data/docker-config`) for every `docker` command, so pulls and compose launches authenticate to matching registries
- `gitEnvironment(repo)` injects a temporary `GIT_ASKPASS` helper for HTTPS URLs whose host matches a stored git connection; SSH URLs continue to use keys
- UI elements: `#registryKind`, `#registryProvider`, `#registryName`, `#registryHost`, `#registryUsername`, `#registrySecret`, `#saveRegistry`, `#cancelRegistryEdit`, `#registriesRefresh`, `#registriesList`

### Settings / Core Services

The **Core Services** subtab manages the bundled services. Each created service card keeps an **Edit compose** action for manual changes, and the running WickedAFDok container is reported as a protected core service (`role: Dok`) so it appears in the Core Services group. Status endpoints return `lookupFailed` when Docker cannot be queried; each card keeps its last displayed state instead of flipping an installed service back to the create view on a transient error.

**nginx-proxy (managed):**
- Only one nginx-proxy managed from Core Services UI
- States: create/edit/run when missing, management/start/stop/restart/edit when present
- Default network: `wicked`
- If domain configured for WickedAFDok in nginx settings, can trigger self-recreation to attach UI container to nginx network with `VIRTUAL_HOST`/`VIRTUAL_PORT` env vars
- Uses `jwilder/nginx-proxy` style setup
- Managed compose stored in `core/nginx-proxy/docker-compose.yml`
- `GET /api/core/nginx-proxy` reports `exists`/`running` (live Docker state), `installed` (a live or stopped nginx-proxy container), `composeExists` (compose file on disk), and `lookupFailed` (Docker could not be queried). Reading status never creates the compose file, so a fresh install stays "not created" until the user launches nginx-proxy. A leftover compose file alone is not "installed": after the container is removed the card returns to the create view with a hint that the saved compose will be reused. `installed` falls back to `composeExists` only when `lookupFailed` is true, so a transient Docker/API failure cannot flip a running nginx-proxy back to "not installed"; the UI keeps the last known state on failed lookups
- Compose reads are capped at 2 MB. A managed core-service compose that grows past the cap is renamed to `<name>.corrupt-<timestamp>` and treated as absent, so status/sync/launch recover and regenerate it from saved settings instead of failing with `Invalid string length`. `readManagedCompose()` applies this to nginx-proxy, cloudflared, Authentik, Authelia, Technitium, and Mailpit

**cloudflared (managed):**
- Create/run/edit Cloudflare Tunnel via UI
- Token configuration supported
- Managed compose stored in `core/cloudflared/docker-compose.yml`

**Authentik (managed authentication):**
- Optional single sign-on and user management core service
- Managed compose stores `postgresql`, `redis`, `server`, and `worker` and uses the `wicked` network
- Generated secrets and bootstrap admin email/password are stored in `data/settings.json`
- Users create Authentik providers/applications from the Authentik admin UI; WickedAFDok exposes the service and launch/edit controls
- Optional GUI domain stored as `services.authentik.domain`; the managed compose adds `VIRTUAL_HOST`/`VIRTUAL_PORT=9000` to the `server` service only. The manage view has an **Apply domain** action that patches an existing compose and recreates a running service.
- After launching Authentik (or Authelia), the UI opens a container picker; the Authelia manage card's **Protect containers** button reopens it later. `POST /api/core/auth/apply` recreates selected containers with `ENABLE_AUTH=true`; app-managed containers are patched in their compose file and re-upped, standalone containers are recreated from their full Docker config. Protected core containers are skipped (and shown disabled in the picker). `ENABLE_AUTH` vhosts are generated by Authelia; Authentik is an SSO portal and does not consume that flag.
- Managed compose stored in `core/auth/docker-compose.yml`

**Authelia (managed authentication):**
- Optional forward-auth service; separate card from Authentik, so both can be installed at once
- Apps opt in with `ENABLE_AUTH=true` plus `VIRTUAL_HOST`/`VIRTUAL_PORT`; WickedAFDok inspects running containers and writes nginx-proxy per-vhost configs (`<host>` and `<host>_location`) into `core/nginx-proxy/vhost.d/`
- HTTPS is required: Authelia rejects non-https target URLs and marks session cookies Secure, and nginx-proxy refuses TLS for hosts without a certificate. Put `core/nginx-proxy/certs/<host>.crt` and `<host>.key` in place for the portal and every protected host before nginx-proxy loads them
- Portal domain stored as `services.authelia.domain`; cookie domains are derived from the registrable-looking parent of the portal and of each protected host (`auth.example.com`/`app.example.com` → `example.com`) and regenerated when the protected set changes
- Managed compose pins `authelia/authelia:4.39`, sets `PUID`/`PGID` to the WickedAFDok uid/gid (the image entrypoint runs `chown -R` on `/config`), and lives in `core/authelia/docker-compose.yml` with config under `core/authelia/config`
- Admin password is hashed with `authelia crypto hash generate argon2`; the plaintext is only shown once in the UI. The manage card also has **Apply domain**, **Sync protected apps**, **Protect containers**, and **Require login for the Dok UI**. Enabling Dok protection requires the Authelia portal domain and a Dok host that shares its cookie domain; if the sync does not generate the auth vhost, the setting is reverted and the UI reports why
- Managed users live in `settings.services.authelia.users` with encrypted `passwordHashEnc` values and are rendered into `core/authelia/config/users.yml` together with the admin account. `GET/POST /api/core/authelia/users`, `DELETE /api/core/authelia/users/:username`, and `POST /api/core/authelia/admin` manage them; changes rewrite the file and restart Authelia only when the content changed
- The Authelia card's **Manage users** button opens `#autheliaUsersModal` (admin account, add/edit/delete local users). The **Open** button opens the portal for provider/application administration
- The auth container picker lists every running container (not just apps), disables Dok itself with a pointer to Dok protection, and disables protected core services with a note that they are managed separately

**Technitium DNS (managed):**
- Optional DNS and ad-blocking core service with a web console
- Web port defaults to `5380`, DNS defaults to `53` (UDP/TCP)
- Admin password is generated when blank
- Optional GUI domain stored as `services.technitium.domain`; the managed compose adds `VIRTUAL_HOST`/`VIRTUAL_PORT=5380`. The manage view exposes the same **Apply domain** action as Authentik.
- Managed compose stored in `core/dns/docker-compose.yml`

**Email / Mailpit (managed):**
- One card covers outgoing SMTP (`services.mail`) and the optional Mailpit capture sink (`services.mailpit`)
- `services.mail` is provider-agnostic: `host`, `port`, `tls` (`none` | `starttls` | `tls`), `username`, `password`, `sender`, `identifier`. A blank `host` disables SMTP and leaves Authelia on the filesystem notifier
- The password is AES-256-GCM encrypted in `data/settings.json`, redacted as `passwordSet`, and a blank password field keeps the saved one
- Authelia's generated `configuration.yml` emits `notifier.smtp` from these settings: `tls` maps to the `submissions://` (implicit TLS), `submission://` (STARTTLS), or `smtp://` scheme, and `none` adds `disable_require_tls` (not `disable_starttls`, which Authelia flags as a plaintext warning). With `host: mailpit`, `disable_startup_check` is on so a stopped test sink cannot stop Authelia (and every protected app) from starting
- `services.mailpit`: `smtpPort` (default `1025`), `webPort` (default `8025`), `maxMessages` (default `500`), optional `domain`. The managed compose publishes both ports, mounts `core/mailpit/data`, and runs on `wicked`; a domain adds `VIRTUAL_HOST`/`VIRTUAL_PORT=8025`
- Mailpit is a capture sink only. It stores messages for inspection in its web UI and never delivers or receives internet mail; it is not a mailbox server
- **Use Mailpit** launches the sink and points `services.mail` at `mailpit:1025` with no TLS in one step
- Managed compose stored in `core/mailpit/docker-compose.yml`; settings are applied to Authelia immediately (config written, restart only if the content changed)

**Host Helper (optional):**
- Privileged companion container running `server/host-agent.js`
- Lets the non-root WickedAFDok process create host directories and chown them through a shared Unix socket
- Socket/token stored in `data/host-helper`; compose stored in `core/host-helper/docker-compose.yml`
- Only starts when the user launches it; normal runtime directories still work without it

**OpenCode (on demand, not a compose service):**
- AI coding agent available from the dashboard **OpenCode** and **Terminal** buttons or the Settings → Core Services card
- Unlike the other core services it is not a container in `core/` and is excluded from Start all/Stop all; each launch starts a PTY inside the WickedAFDok container and closing the terminal stops it
- **Admin mode:** cwd `/app`, `permission: { "*": "allow", external_directory: "allow" }`; intended for maintenance, troubleshooting, and changing WickedAFDok
- **User mode:** cwd `/app/apps`, `external_directory: deny`, and a bash/read allowlist tuned for app work; Docker, system package management, privilege escalation, and WickedAFDok source paths are intended to be off limits
- Generated configs live at `data/opencode/<mode>/opencode.json`; per-mode `HOME`/XDG directories keep sessions separate, while provider login/auth and caches are shared under `data/opencode/shared`
- `OPENCODE_DISABLE_PROJECT_CONFIG=1` prevents an app-level `opencode.json` from widening mode permissions
- Optional `services.opencode` settings (model, provider, API key) preconfigure a provider. If provider is blank, it is inferred from the `provider/model` prefix. The key is passed as `OPENCODE_PROVIDER_API_KEY` and generated configs reference `{env:OPENCODE_PROVIDER_API_KEY}`; it is encrypted at rest in `data/settings.json` and redacted as `apiKeySet` in API responses. It can also be added interactively with `/connect`
- The same terminal modal can open a plain bash shell. Admin shell starts in `/app`; the apps shell starts in `apps/`. Shell sessions run as the container user and are not permission-restricted like User-mode OpenCode.

**Logs:**
- Server console output plus mutating `/api` requests are written to `data/logs/server.log` and a 2000-line in-memory ring buffer
- Logs subtab shows server logs and Docker Compose logs for apps and core services with auto-refresh and tail controls

**Backups & Updates:**
- Local backups stored under `data/backups` as `<id>.tar.gz` plus `<id>.json` metadata
- Scopes: `full`, `app`, and `custom`
- Full backups include `data`, `apps`, `core`, and `sources`; `data/backups`, `data/tmp`, and the helper socket are excluded, and `data/logs` is optional
- App backups include `apps/<name>` plus a registry snapshot
- Custom backups accept toggles for `data`, `apps`, `core`, `sources`, and `logs`, plus optional per-app and per-core-service selections. An empty app/core selection means all of that section. The manifest is stored at `data/.backup-manifest.json` (or as the only `data` entry when data is excluded) with `scope: 'custom'`, `components`, `apps`, and `core` fields.
- Custom restores only overwrite the sections recorded in the manifest; full and app archives remain backward compatible
- `GET /api/backups/options` returns the app and core-service pickers used by the UI
- Import accepts a WickedAFDok archive and restores it; restore requires explicit overwrite confirmation
- The temporary git update UI now lives under Backups & Updates

**Settings:** Persisted in `data/settings.json`. Legacy `/api/dns` and `/api/auth` endpoints remain as unenforced scaffolds; they are not used by the new Core Services UI.

## API Endpoints

### Health
- `GET /api/health` - Health check

### System
- `GET /api/system/stats` - Host CPU/memory/disk/load + Docker info
- `POST /api/system/update-from-git` - Update WickedAFDok from a required git repo; the code root must be writable by the server user

### Containers
- `GET /api/containers` - List containers; each entry includes `project`, `service`, `core`, `protected`, `self`, and `role`
- `GET /api/containers/:id/inspect` - Inspect container
- `GET /api/containers/:id/logs` - Get container logs
- `POST /api/containers/:id/:action(start|stop|restart|pause|unpause)` - Container actions
- `POST /api/containers/:id/exec` - Execute command in container
- `POST /api/containers/:id/update-check` - Check for updates
- `POST /api/containers/:id/redeploy` - Redeploy container
- `POST /api/containers/:id/save-to-registry` - Save to apps registry
- `DELETE /api/containers/:id` - Remove container; protected containers require `{ "confirmName": "<container name>" }` (otherwise `403`)

### Images
- `GET /api/images` - List images
- `POST /api/images/pull` - Pull image
- `POST /api/images/remove` - Remove image

### App Creation / Launch
- `POST /api/launch/run` - Process docker run command, return config modal data
- `POST /api/launch/compose` - Process compose content
- `POST /api/launch/git` - Clone git repo and process
- `POST /api/launch/upload` - Upload files and process
- `POST /api/launch/source` - Deploy from sources directory
- `POST /api/assist/start` - Upload optional files, write the OC Assist brief, and start an Admin OpenCode session (`prompt`, optional `data`, `name`, `files`, `paths`)
- `POST /api/launch/finalize` - Complete creation (save to apps dir, update registry, optionally launch); a per-app lock returns `409 alreadyFinalizing` and failures after the registry write return `created: true`
- `POST /api/compose/validate` - Validate compose file content
- `POST /api/compose/parse` - Parse a compose file into editable builder fields
- `POST /api/compose/build` - Generate compose from builder fields and return field-level issues

### Core Services
- `GET /api/core/nginx-proxy` - Get nginx-proxy status/config
- `POST /api/core/nginx-proxy/compose` - Save nginx-proxy compose
- `POST /api/core/nginx-proxy/run` - Start/run nginx-proxy
- `GET /api/core/cloudflared` - Get cloudflared status/config
- `POST /api/core/cloudflared/compose` - Save cloudflared compose
- `POST /api/core/cloudflared/run` - Start/run cloudflared
- `GET /api/core/auth` / `POST /api/core/auth/compose` / `POST /api/core/auth/run` / `POST /api/core/auth/domain` / `POST /api/core/auth/apply` - Authentik status, compose, launch, GUI domain, and apply `ENABLE_AUTH` to selected containers
- `GET /api/core/authelia` / `POST /api/core/authelia/compose` / `POST /api/core/authelia/run` / `POST /api/core/authelia/domain` / `POST /api/core/authelia/sync` - Authelia status, compose, launch, portal domain, ENABLE_AUTH vhost sync
- `GET /api/core/authelia/users` / `POST /api/core/authelia/users` / `DELETE /api/core/authelia/users/:username` / `POST /api/core/authelia/admin` - Manage local Authelia users and the admin account
- `POST /api/core/authelia/dok-protection` - Toggle Authelia protection for the Dok UI
- `GET /api/core/dns` / `POST /api/core/dns/compose` / `POST /api/core/dns/run` / `POST /api/core/dns/domain` - Technitium status, compose, launch, GUI domain
- `GET /api/core/mail` - SMTP settings (redacted), Mailpit status/compose, and the resolved Authelia notifier address
- `POST /api/core/mail/smtp` - Save SMTP delivery settings and apply them to Authelia
- `POST /api/core/mail/use-mailpit` - Launch Mailpit and point notifications at `mailpit:1025`
- `GET /api/core/mailpit` / `POST /api/core/mailpit/compose` / `POST /api/core/mailpit/run` / `POST /api/core/mailpit/domain` - Mailpit status, compose, launch, GUI domain
- `GET /api/core/host-helper` / `POST /api/core/host-helper/compose` / `POST /api/core/host-helper/run` - Host helper status, compose, launch
- `POST /api/core/all/:action(start|stop|restart)` - Apply an action to every created core service
- `POST /api/core/:service/:action(start|stop|restart)` - Apply an action to one core service
- `GET /api/core/opencode` - OpenCode install/version, running sessions, modes, and generated configs
- `POST /api/core/opencode/settings` - Save optional model/provider/API key
- `POST /api/core/opencode/run` - Start an OpenCode Admin or User session
- `POST /api/core/opencode/stop` - Stop all running OpenCode sessions

### Terminal
- `GET /api/terminal` - Terminal capabilities, OpenCode version, available modes, and sessions
- `POST /api/terminal/sessions` - Create a PTY session (`{ mode, app }`, where `app` is `shell` or `opencode`)
- `POST /api/terminal/sessions/:id/stop` - Stop one session
- `POST /api/terminal/sessions/stop-all` - Stop all sessions, optionally filtered by `app`
- `GET /api/terminal/ws?id=<session>` (WebSocket upgrade) - Attach to a session; sends `ready`, `output`, `exit`, and `pong` messages, accepts `input`, `resize`, and `ping`

### Logs and Backups
- `GET /api/logs/server` / `DELETE /api/logs/server` - Read or clear the server log
- `GET /api/logs/apps` - List apps and created core services available for logs
- `GET /api/logs/app/:id` - Docker Compose logs for an app
- `GET /api/logs/core/:service` - Docker Compose logs for a core service
- `GET /api/backups` / `POST /api/backups` - List or create backups (`full`, `app`, or `custom` with `components`, `apps`, and `core`)
- `GET /api/backups/options` - List apps and core services available for custom backups
- `GET /api/backups/:id/download` / `DELETE /api/backups/:id` - Download or delete a backup
- `POST /api/backups/:id/restore` - Restore a backup; requires `overwrite: true`
- `POST /api/backups/import` - Upload and restore an archive; returns `409` with `needsOverwrite` when confirmation is required

### Sources/Projects
- `GET /api/sources/list` - List files in sources/
- `GET /api/sources/file` - Read file from sources/
- `POST /api/sources/file` - Write file to sources/

### Apps
- `GET /api/registry` - List apps in registry
- `POST /api/registry/:id/deploy` - Quick Deploy: compose up, resolving duplicate container names
- `POST /api/registry/:id/:action(start|stop|restart)` - App compose lifecycle actions
- `GET /api/apps/:id/compose` - Read the app's base compose file
- `POST /api/apps/:id/compose` - Save an edited compose as the new base (`deploy: true` re-deploys; `force: true` saves despite validation issues)
- `DELETE /api/registry/:id` - Remove from registry

### Designer
- `GET /api/designer` / `POST /api/designer` - Read or save name, tagline, CSS, and logo state
- `POST /api/designer/logo` (multipart `logo`) - Upload PNG/JPG/WebP/SVG/ICO
- `GET /api/designer/logo` - Serve the uploaded logo
- `GET /api/designer/files` / `GET /api/designer/file?path=` / `POST /api/designer/file` - Browse and edit text files under `core/nginx-proxy`

### Networks & Settings
- `GET /api/networks` - List Docker networks
- `POST /api/networks/create` - Create network
- `GET /api/settings` - Get settings
- `POST /api/settings` - Save settings
- `GET /api/settings/defaults` / `POST /api/settings/defaults` / `POST /api/settings/defaults/apply` - Read, save, and re-apply default settings (domains, data location/mode, admin fallbacks, network, Dok protection)

### Groups, Registries, DNS, Auth
- `GET /api/groups` / `POST /api/groups` / `DELETE /api/groups/:id` - Container groups
- `GET /api/registries` / `POST /api/registries` / `DELETE /api/registries/:id` - Container registry and git host connections
- `POST /api/registries/:id/test` - Validate a stored registry or git credential
- `GET /api/dns` / `POST /api/dns` - DNS settings
- `GET /api/auth` / `POST /api/auth` - Auth settings placeholder (not enforced)

## Key Implementation Details

### App Creation Flow
1. User submits via one of the creation methods
2. Server processes input:
   - For docker run: parsed by `runCommandToCompose()`; combined short flags such as `-dp`, `-itp`, and `-dp8080:80` are expanded, and command arguments after the image are preserved
   - For compose: stored as the app's managed compose file
   - For git/upload: files are staged under `sources/`, checked for compose/Dockerfile, then copied to `apps/<name>/`
   - If compose/Dockerfile found → copied to `apps/<name>/`, managed compose generated/retained, returns `needsConfig: true` with compose data
   - If no compose/Dockerfile → kept under `sources/`, returns `toProjects: true` or `needsConfig: false`
3. UI shows App Configuration modal with the managed compose
4. Launch routes return analysis from `analyzeCompose()`: existing/missing external networks, missing bind sources, prefilled vhost data, and compose issues
5. On finalize (`/api/launch/finalize`) the server resolves `networkChoices`/`volumeChoices`, validates the base compose plus generated override, saves to the registry, and optionally launches via docker compose in `apps/<name>/`. A renamed staged app is removed only after the final compose and registry entry are written successfully.
6. Every new app preview is staged in a hidden `apps/.preview-<name>-.../` directory, including when `apps/<name>/` does not exist yet, and is copied to the target only on finalize. This prevents finalize from mistaking its own preview for an existing app. Stale previews older than 24 hours are cleaned up. Finalizing into a non-empty existing app name returns `409` with `needsOverwrite`/`appName`; the UI asks for confirmation and resubmits with `overwrite: true`.
7. `finalizeLocks` (keyed by sanitized app name) rejects concurrent finalizes with `409 alreadyFinalizing`, and the lock is released in `finally` after the handler completes rather than when the client socket closes. Once the registry entry is written, later failures return `created: true` with the app name, so the UI closes and refreshes instead of prompting a duplicate install.

### Defaults and App Data
- `defaultsDefaults()` owns `settings.defaults`; `configuredDefaults()` normalizes it, `defaultsForClient()` redacts the admin password as `adminPasswordSet`, and `defaultsPatch()` validates/saves input. `POST /api/settings/defaults` also applies the data location and syncs Authelia vhosts when Dok protection is enabled.
- `appDefaultDataDir(name)` returns `<dataLocation>/apps/<app>/data` unless `autoAppData` is false. Every new app gets this directory (mode from `dataMode`) and the path is stored as `dataPath` in the registry and returned as `appDataPath`.
- Missing relative bind sources are auto-mapped by `defaultVolumeSource()` beneath the app data directory (`<app>/data` for the `data` target, otherwise `<app>/data/<target-slug>`). Absolute/outside sources are only created when `allowOutsideData` is true; otherwise finalize returns the missing volume with an explanatory `reason`.
- `POST /api/settings/defaults/apply` re-creates the data location and `<dataLocation>/apps` through `ensureHostDirectory()` (direct or Host Helper), applying the octal mode.

### OC Assist
- `POST /api/assist/start` validates the prompt/name, rejects concurrent starts for the same app name, saves uploads under `sources/oc-assist-<stamp>-<random>/` (traversal-checked), writes a private brief at `data/opencode/assist/<stamp>-<random>/brief.md`, and starts an Admin OpenCode session with `--prompt` and title `OC Assist · <app>`. The random suffix keeps two requests in the same second from sharing a directory.
- The brief includes instructions, pasted data, uploaded file paths, and default admin username/email (never the password).
- The agent registers/deploys through `server/assist-register.mjs --name <app> --dir /app/apps/<app> --launch`, which posts to `/api/launch/finalize` with `overwrite: true`; `--launch` is opt-in so a dry registration is possible.

### Compose Management
- All apps use docker compose from their own directory
- Function `buildWadCompose()` generates normalized compose files
- Function `runCommandToCompose()` converts docker run commands to compose format; normalizes duplicate `VIRTUAL_HOST`/`VIRTUAL_PORT`; retains ports with `--network bridge` and drops them for host/none/container modes. Boolean flags honor explicit `=false` values for `--privileged`, `--init`, `--read-only`, `--no-healthcheck`, `-i`/`--interactive`, and `-t`/`--tty`; `-i`/`-t` map to `stdin_open`/`tty`, and `--rm` is reported as unsupported.
- `analyzeCompose()` uses `docker compose config --format json`; `analyzeComposeConfig()` inspects a parsed model
- `buildComposeOverride()` adds selected networks, network mappings, vhost changes, extra ports, and volume replacements
- Missing input networks require `networkChoices` (`__create__` or an existing name); missing bind sources require `volumeChoices` (`source` plus optional `create`)
- Replacing a missing bind source preserves its read-only flag (`:ro`); sources containing `:` or CR/LF/NUL are rejected for short volume syntax
- Form network creation is explicit (`createNetwork`/`#appCfgCreateNetwork`); `wicked` and the configured default network are auto-created, other input networks require a choice
- Compose validation via `/api/compose/validate`; final combined validation also checks port conflicts and unresolved networks/volumes
- Compose builder parsing uses `docker compose config --format json` when available and a block-YAML subset reader when not; building normalizes the field model to YAML and validates conflicts server-side
- Compose input explicitly provided as empty is rejected with `Compose file is empty`
- `setMountSource()` rewrites bind-mount sources in place for managed composes. It decodes quoted YAML scalars and `$$` Compose escapes, normalizes the volume mode, and re-emits canonical short-syntax volumes, so repeated status/sync passes are byte-for-byte idempotent instead of growing the file

### Registry and Git Connections
- `data/registries.json` holds `{ connections: [...] }`; each entry has `kind` (`registry` or `git`), `provider`, `name`, `host`, `username`, and `secretEnc`
- `encryptSecret()`/`decryptSecret()` use AES-256-GCM with a 32-byte key from `data/.credentials-key`; corrupt or missing keys make existing secrets unusable and are treated as missing
- Hosts are normalized (protocol/path stripped, `index.docker.io`/`registry-1.docker.io` mapped to `docker.io`)
- `ensureDockerConfigForRegistries()` writes `data/docker-config/config.json` with `auths` entries for every container-registry connection, preserving any pre-existing Docker config. `run()` automatically sets `DOCKER_CONFIG` for `docker` commands when connections exist, so image pulls and compose launches authenticate without exposing secrets in command lines
- `gitEnvironment(repo)` matches the URL host against `kind: 'git'` connections and injects `GIT_ASKPASS` plus `WICKEDAFDOK_GIT_USERNAME`/`WICKEDAFDOK_GIT_PASSWORD`. The askpass helper lives in `data/tmp/git-askpass.sh` and contains no secrets. SSH URLs are unaffected and use the container user's keys
- `POST /api/registries/:id/test` uses a temporary `DOCKER_CONFIG` and `docker login --password-stdin` for registries, the GitHub/GitLab user APIs for those git hosts, and a connection-saved response for custom git hosts

### Core Services Self-Management
- When nginx-proxy launched with domain configured, `scheduleSelfRecreate()` may trigger recreation of WickedAFDok container
- Uses managed compose at `data/wickedafdok/docker-compose.yml`
- Attaches WickedAFDok to nginx network and sets `VIRTUAL_HOST`/`VIRTUAL_PORT`
- Regenerates the managed compose from container inspect data and preserves `user`, `group_add`, and `privileged`; it always adds the live socket GID to `group_add` when the socket is mounted, including for root, so rootless/userns-remapped or stale-group cases keep Docker access. The updater helper also writes a socket-GID override from inside the helper before `docker compose up`.
- On startup the server probes `docker.version()`; if the socket is unreachable it logs the socket owner/mode, process UID/GID, and supplementary groups, plus the `sudo ./setup.sh` remediation. API errors for socket `EACCES` get the same hint.
- nginx-proxy restarted to detect changes
- UI reconnects after recreation
- `selfContainerInfo()` backs `selfMountSource()`/`selfMountRef()`, which turn container paths into host paths for core-service bind mounts. It uses a 5s cache declared as `let selfInfoCache`; without that declaration every launch of Authentik, Technitium DNS, and any other service that resolves `/app/core` or `/app/data` fails with `selfinfocache is not defined`
- Authentik's compose pins `AUTHENTIK_IMAGE_VERSION` (currently `2026.8.5`). ghcr.io publishes no `latest` tag for `goauthentik/server`, so a `:latest` reference fails with `not found`; upgrade by bumping the constant and keep it aligned with the database migrations. `services.authentik.version` overrides it per install

### Authelia and ENABLE_AUTH vhosts
- `listAuthProtectedHosts()` inspects every running container (the `listContainers` summary omits `Env`), accepts `ENABLE_AUTH=1|true|yes|on` case-insensitively, and splits `VIRTUAL_HOST` on commas. When `defaults.protectDok` is set it also adds the Dok host before the Docker lookup, and Dok itself never needs an `ENABLE_AUTH` env or a self-recreate. If Docker cannot be queried, the last set saved in `.wickedafdok-auth.json` is reused instead of pruning every protected vhost
- Authelia users are stored in `settings.services.authelia.users` with encrypted `passwordHashEnc` values; `autheliaConfiguration()` renders the admin plus those users into `users.yml`, and `refreshAutheliaConfig()` rewrites/restarts only when the file content changes
- `syncAuthVhosts()` writes `<host>` (server scope: `location = /authelia` proxying to `http://authelia:9091/api/authz/auth-request` with `X-Original-URL`/`X-Forwarded-*`) and `<host>_location` (`auth_request /authelia`, forwards `Remote-User`, `Remote-Groups`, `Remote-Name`, `Remote-Email`, `Remote-Status`, and `error_page 401 =302 https://<portal>/?rd=$target_url`). Only files starting with `# managed-by: wickedafdok:authelia` are pruned
- Protected hosts must share the portal's cookie domain (`app.example.com` and `auth.example.com` → `example.com`); hosts under a different parent are skipped (`skippedHosts` in the state file, plus a server warning) because the portal cannot set a session cookie for another parent. Cookie domains use the last two labels, so multi-level public suffixes such as `co.uk` are not handled specially
- Wildcard/regexp `VIRTUAL_HOST` patterns are skipped: nginx-proxy uses different file naming for its server and location scopes, so pattern hosts have no reliable per-vhost hook. List the literal hostnames on the container instead
- The protected-host set and cookie domains are cached in `core/nginx-proxy/vhost.d/.wickedafdok-auth.json`. Stale host files are removed, nginx-proxy is restarted when the files change (docker-gen only re-renders on container events and checks vhost files at render time, so a plain reload would miss newly protected hosts), and Authelia's `configuration.yml` is rewritten only when the cookie-domain set or the mail-settings fingerprint changes (the fingerprint is stored in the same state file); a restart follows only when the file content actually changed. SMTP settings are therefore never lost on a 60 s sync, and changing them takes effect without waiting for a cookie-domain change
- Sync runs on server start, every 60 s (unref'd timer), after app deploy/start/stop/restart, after `POST /api/core/nginx-proxy/run`, and from the Authelia run/domain/sync routes
- nginx-proxy's managed compose mounts the host-resolved core directory (`selfMountSource('/app/core')`, then `nginx-proxy/vhost.d` and `nginx-proxy/certs:ro`), and Authelia mounts the host-resolved `authelia/config`. Relative bind sources would be resolved on the Docker daemon host (e.g. `/app/core/...`) and silently mount empty directories; existing managed composes are patched in place with `setMountSource()`. `ensureNginxProxyCompose()` upgrades older composes on `GET /api/core/nginx-proxy` and during sync, and recreates a live nginx-proxy once if its container is missing either mount. Without the certs, the https server blocks fail their TLS handshake and never reach the auth check
- Authelia 4.39 schema traps: `identity_validation.reset_password.jwt_secret` is required (and `.disable` is rejected); `session.cookies[].secure` is rejected; `authelia_url` must be https; a cookie `domain` needs a dot or an IP; the top-level `default_redirection_url` cannot be combined with `session.cookies`, so it is emitted per cookie; `authelia hash-password` is gone in favor of `authelia crypto hash generate argon2`

### Terminal and OpenCode Sessions
- `createTerminalSession()` spawns `/bin/bash -i` or the resolved OpenCode binary with `node-pty`; sessions are kept in an in-memory `terminalSessions` map and exist only until stopped, exited and reaped, or the server shuts down
- Limits: 8 concurrent sessions, a 2 MiB rolling replay buffer per session, and a 30-minute idle cleanup after the last client disconnects; output is streamed to attached WebSocket clients and the rolling buffer is replayed on connect (the UI resets xterm before applying it)
- The WebSocket upgrade at `/api/terminal/ws` validates the `Origin` host against `Host`/`X-Forwarded-Host` when an origin is present, and rejects unknown session IDs
- `POST /api/terminal/sessions/:id/stop` kills the PTY (with a `SIGKILL` fallback) and closes clients; the UI also stops the active session when the terminal modal closes or Escape closes it
- OpenCode configs are generated on every launch from `opencodeConfigForMode()`, which sets the default agent, optional model/provider, and the Admin or User permission model. `writePrivateFile()` keeps them at mode `600`
- OpenCode launches use `OPENCODE_CONFIG_CONTENT` (the generated mode config, which outranks config files), `OPENCODE_CONFIG`, `OPENCODE_DISABLE_PROJECT_CONFIG=1`, `OPENCODE_DISABLE_AUTOUPDATE=1`, per-mode `HOME`/`XDG_*`, and `OPENCODE_PROVIDER_API_KEY` when a key is configured. Inherited `OPENCODE_*` variables are removed from all managed sessions so a host/desktop instance cannot leak its config or session id into the container terminal.
- User-mode sessions start in `apps/`, strip Docker/host/credential environment variables, deny `external_directory`, and use explicit bash allows/denies; this is a permission guardrail for the agent, not a separate OS sandbox (the process still runs as the WickedAFDok container user)
- Closing all WebSocket clients does not immediately kill a session, so a brief reconnect does not lose the shell; it is stopped after the idle timeout
- `SIGTERM`/`SIGINT` stop all live sessions before the HTTP server closes

### File Handling
- Uploads use multer with disk storage in `uploads/`
- Cross-device moves use copy+delete fallback (handles EXDEV)
- File operations sandboxed to allowed directories with realpath checks where applicable
- Upload paths are parsed as an array, traversal/empty destinations are discarded and their temp files removed, and destination parents are checked to stay inside the project after resolving symlinks
- Git clones and self-update use generic git over any host. TLS verification is enabled by default; `WICKEDAFDOK_GIT_INSECURE=1` opts into `GIT_SSL_NO_VERIFY=true` for trusted self-signed servers.
- Git connections stored in Dok Settings inject `GIT_ASKPASS` and credential environment variables only for matching HTTPS hosts. Secret values are never placed in the askpass script or command line.
- Runtime JSON writes use mode `600`, as do managed app/core compose files and backup archives. Registry/git connection secrets and service secrets in `data/settings.json` are encrypted at rest; other non-secret runtime JSON remains plaintext.
- `shm_size` values generated from `docker run --shm-size` are normalized to human-readable Compose sizes (`1073741824` becomes `1gb`); the builder displays `shm_size` the same way.

### Permission Handling
- `processIdentity()`, `permissionDenied()`, and `ensureWritableDirectory()` provide consistent `403` responses with the server UID/GID and `sudo ./setup.sh` guidance
- `ensureHostDirectory()` retries host path creation through the optional Host Helper socket when direct `mkdir` is denied
- App, source, upload, finalize, and volume-directory creation use permission-aware handling; the global error handler also converts uncaught `EACCES`/`EPERM`/`EROFS` to `403`
- `setup.sh` owns/chowns the whole checkout and normalizes its modes; if host paths are created outside those directories, the container user must already have write access
- The container mounts the Docker socket and therefore has root-equivalent Docker control. Treat unauthenticated UI/API access accordingly.
- Docker socket access depends on the container user being in the socket's group. `setup.sh` writes the current GID into the compose override, `start.sh` refreshes it on every start, and self-recreation adds it to the generated compose. If Docker access is lost after a daemon/host update (socket GID changed), run `sudo ./setup.sh` and then `./start.sh`.

### Network
- Default network is `wicked` (bridge), declared external in root `docker-compose.yml` and created by `setup.sh` or `start.sh`
- Apps connect to `wicked` network by default
- nginx-proxy uses `wicked` network
- Core services may auto-create their configured network via `ensureNetwork()`; failures propagate to the caller instead of being ignored
- App creation never silently creates arbitrary input networks; it requires `networkChoices` or an explicit create action
- Finalize rejects `host`, `none`, `bridge`, `default`, `container:*`, and `service:*` as form network names; use `network_mode` for those modes

### Known Limitations
- No authentication or authorization middleware. `/api/auth` only stores settings; every API route remains open. The Docker socket gives the container root-equivalent Docker control.
- App configuration and compose builder state are client-side; the server re-validates on finalize. An existing non-empty `apps/<name>/` is previewed in a hidden staging directory, and finalizing into an existing app name requires the overwrite confirmation.
- The Host Helper is optional and privileged. Without it, host paths outside the runtime directories must be writable by the server UID/GID.
- Authentik is launched as a standalone SSO service. Per-app forward-auth/proxy providers still need to be configured in Authentik and the fronting proxy; WickedAFDok does not automatically enable auth for every app.
- Self-update requires a writable persistent application code checkout. The default image bakes source into `/app` and runs as non-root in common deployments, so an in-app update is lost on container recreation unless `/app` (with `node_modules`) is bind-mounted; otherwise update on the host with `git pull` and rebuild via `./start.sh`.
- Service secrets in `data/settings.json` (cloudflared token, Authentik and Authelia passwords/keys, Technitium admin password, SMTP password, OpenCode API key) are AES-256-GCM encrypted with `data/.credentials-key`. `readSettings()` decrypts for internal use, `writeSettings()` encrypts, and API responses redact values while exposing `*Set` flags. Legacy plaintext values are encrypted on the first start. Registry and git connection secrets use the same key; losing that key makes the stored secrets unrecoverable (delete and re-enter them).
- OpenCode is installed during the Docker image build. Existing deployments must rebuild the image to add it, and the build needs network access to `opencode.ai`/GitHub releases. Set `OPENCODE_BIN` to use a local binary during development.
- User mode is a permission guardrail for the AI agent, not an OS sandbox. It runs as the same container user as Admin mode, so a determined command can still reach files or binaries the Unix user can access. Shell sessions are not restricted at all. Use a separate container/user for hard isolation.
- The browser terminal and OpenCode sessions are protected only by the same (currently absent) authentication as the rest of the UI. Anyone who can reach the UI can open an Admin shell; keep it behind a trusted network or authenticated reverse proxy. A reverse proxy must forward WebSocket upgrades for `/api/terminal/ws`.
- A corrupt `data/registry.json` is preserved once as `registry.json.corrupt-<timestamp>` and treated as an empty registry; recovery is manual.
- There is no automated test suite. Use Bun builds and API smoke tests; Docker CLI-backed compose validation is unavailable when the CLI is missing.

## UI Structure

**Tabs (in `public/index.html`):**
- Dashboard (`#tab-dashboard`)
- Containers (`#tab-containers`)
- Images (`#tab-images`)
- App Creation (`#tab-appcreation`) - primary deployment interface
- Sources/Projects (`#tab-sources`)
- Apps (`#tab-apps`) - deployed apps
- Settings (`#tab-settings`) - includes `#settings-pane-dok` with Default settings, Designer, Groups, and registry connections

**Key UI Elements:**
- Containers: `#containersList`, `#containerSearch`, `#containersOpenApps` (opens the Apps tab), `#refreshContainers`
- Dashboard: `#dashboardTerminalBtn`, `#dashboardOpencodeBtn`
- Terminal Modal: `#terminalModal`, `#terminalContainer`, `#terminalModeSelect`, `#terminalShellBtn`, `#terminalOpencodeBtn`, `#terminalStopBtn`, `#terminalStatus`, `#terminalModeBadge`
- OpenCode Card: `#coreOpencodeCard`, `#opencodeLaunchAdmin`, `#opencodeLaunchUser`, `#opencodeShellAdmin`, `#opencodeShellUser`, `#opencodeStopBtn`, `#opencodeModel`, `#opencodeProvider`, `#opencodeApiKey`, `#opencodeSaveSettings`
- App Creation: `#runCreateBtn`, `#composeCreateBtn`, `#gitCloneBtn`, `#uploadBtn`, OC Assist (`#assistPrompt`, `#assistData`, `#assistName`, `#assistFiles`, `#assistFolder`, `#assistStartBtn`, `#assistOutput`)
- App Config Modal: `#appConfigModal`, `#appCfgBuilder`, `#appCfgCompose`, `#appCfgEditCompose`, `#appCfgValidate`, `#appCfgComplete`, `#appCfgCompleteRun`, `#appCfgProgress`
- Notices: `#appCfgNetworkNotice`, `#appCfgVolumeNotice`, `#appCreationNginxNotice`, `#appCreationNginxNoticeModal`
- Modals: `#composeEditWarningModal`, `#composeSaveConfirmModal`, `#appOverwriteModal`, `#authContainersModal`, `#autheliaUsersModal`, `#designerModal`
- Apps List: `#appsList`, `#appsRefresh`
- Settings: `#tab-settings`, `#settingsSubtabs`, `#settings-pane-core`, `#settings-pane-dok`, `#settings-pane-logs`, `#settings-pane-backups`, `#coreAllStart`, `#coreAllStop`, `#coreAllRestart`, `#nginxNetwork`, `#runNginxProxyCore`, `#authRunBtn`, `#dnsRunBtn`, `#mailSmtpHost`, `#mailSmtpPort`, `#mailSmtpTls`, `#mailSmtpUser`, `#mailSmtpPassword`, `#mailSmtpSender`, `#mailSaveSmtp`, `#mailUseMailpit`, `#mailStatus`, `#mailpitRunBtn`, `#mailpitStatus`, `#mailpitOpenBtn`, `#helperRunBtn`
- Designer: `#openDesigner`, `#designerName`, `#designerTagline`, `#designerCss`, `#designerLogoFile`, `#designerLogoUpload`, `#designerLogoRemove`, `#designerFilePath`, `#designerFileContent`, `#designerFileSave`
- Auth picker: `#authContainersList`, `#authApplySelected`, `#authSelectAll`, `#authSelectNone`, `#authApplyMsg`
- Dok Settings: `#defaultsCard`, `#defaultsPrimaryDomain`, `#defaultsDokDomain`, `#defaultsDataLocation`, `#defaultsDataMode`, `#defaultsAllowOutsideData`, `#defaultsAutoAppData`, `#defaultsAdminUser`, `#defaultsAdminEmail`, `#defaultsAdminPassword`, `#defaultsClearAdminPassword`, `#defaultsNetwork`, `#defaultsProtectDok`, `#saveDefaults`, `#defaultsApplyData`, `#defaultsRefresh`, `#groupName`, `#groupContainers`, `#saveGroup`, `#groupsList`, `#registryKind`, `#registryProvider`, `#registryName`, `#registryHost`, `#registryUsername`, `#registrySecret`, `#saveRegistry`, `#cancelRegistryEdit`, `#registriesRefresh`, `#registriesList`
- Authelia management: `#autheliaManageBtn`, `#autheliaOpenBtn`, `#autheliaProtectDok`, `#autheliaPickContainers`, `#autheliaUsersModal`, `#autheliaAdminUser`, `#autheliaAdminEmail`, `#autheliaAdminPassword`, `#autheliaAdminSave`, `#autheliaUserName`, `#autheliaUserDisplay`, `#autheliaUserEmail`, `#autheliaUserPassword`, `#autheliaUserDisabled`, `#autheliaUserSave`, `#autheliaUserCancel`, `#autheliaUsersList`, `#autheliaUsersRefresh`
- Logs: `#serverLogsOutput`, `#serverLogsRefresh`, `#serverLogsClear`, `#appLogsSelect`, `#appLogsRefresh`, `#appLogsOutput`
- Backups: `#createBackupBtn`, `#backupScope`, `#backupCustomOptions`, `#backupAppsSelect`, `#backupCoreSelect`, `#backupsList`, `#backupRefresh`, `#importBackupFile`, `#importBackupBtn`

## Development Notes
- ESM module (`"type": "module"` in package.json)
- No TypeScript - vanilla JS
- When modifying UI, update both `public/index.html` and `public/js/app.js`
- All Docker operations go through Dockerode or docker CLI via `run()` helper
- Terminal dependencies (`node-pty`, `ws`, `@xterm/xterm`, `@xterm/addon-fit`) are production dependencies. xterm assets are served from `node_modules` at `/vendor/xterm` and `/vendor/xterm-fit`; do not remove those packages or the terminal UI will render blank
- OpenCode is not an npm dependency; the image installs the release binary and the server resolves `OPENCODE_BIN`, `/usr/local/bin/opencode`, or a local `node_modules/.bin/opencode` fallback
- Settings stored as JSON in `data/settings.json`
- App library stored as JSON array in `data/registry.json`
- Registry/git connections stored in `data/registries.json`; secrets are AES-256-GCM encrypted with `data/.credentials-key`
- Service secrets in `data/settings.json` use the same encryption; the API redacts them and reports `*Set` flags. `clearSecrets` on `POST /api/settings` removes a stored secret explicitly
- Docker runs use a generated `DOCKER_CONFIG` at `data/docker-config` when at least one container-registry connection exists
- Paste-based docker run commands reject shell operators for security
- No automated tests or lint script. Verify with syntax/build checks (for example `node --check server/index.js` or a Bun browser/node build when available) and API smoke tests.
- Docker CLI may be absent in development; composer parse falls back internally, but Docker-backed validation and launches cannot be exercised without it.

### Docker-in-Docker Testing
- Building and running the image needs a Docker daemon whose data root is on a non-overlay filesystem. Webtop's built-in DIND without a `/var/lib/docker` volume cannot start containers: dockerd runs in the webtop container, its data root sits on the container's overlay layer, and the next overlay mount fails with `failed to mount /config/.XDG/containerd-mount...: fstype: overlay ... invalid argument`. Fix it in the webtop container definition before testing, then recreate the container (mounts cannot be added to a running one):

  ```yaml
  services:
    webtop:
      volumes:
        - /home/castlez/weboc/docker:/var/lib/docker
  ```

  `/home/castlez/weboc` is bind-mounted as `/config` inside webtop, so the host directory for the data root is the same one as `/config/docker`. A named volume on the host also works; the point is that the data root must land on ext4 (`/dev/sda1`), not the container overlay. The old data root is hidden, not deleted, so images and containers from it must be re-pulled after the switch. Verify with `docker info --format '{{.Driver}} {{.DockerRootDir}}'` and `docker run --rm alpine:3.20 echo ok`.

- A `--bridge=dind0` flag also fails unless that bridge exists; omit it so DIND creates its own `docker0` inside its network namespace.
- The socket-GID regression is tested end to end with a `docker:dind` sidecar attached to webtop's Docker network (reachable as `webtop-dind:2375`, with published app ports as `webtop-dind:<port>`). Build `wickedafdok:e2e`, run it as `1000:1000` with `--group-add <live socket GID>` and the live socket mounted, call `POST /api/core/nginx-proxy/run` with a domain, then confirm the recreated container keeps that GID in `HostConfig.GroupAdd` and `/api/containers` still returns 200. The updater helper runs the same image as root, so the image must keep the bundled Docker CLI and Compose plugin.
- `docker build` against that daemon needs the Buildx CLI plugin in `$DOCKER_CONFIG/cli-plugins`; without it the CLI falls back to the deprecated legacy builder, which rejects `--progress`.
- Authelia/`ENABLE_AUTH` end-to-end: build `wickedafdok:e2e`, run it as `1000:1000` with `--group-add <socket GID>`, bind host directories onto `/app/core`, `/app/data`, and `/app/apps` (launch fails with `EACCES: mkdir '/app/core/...'` otherwise), and keep "wickedafdok" in the container name so `selfContainerInfo()` can resolve host paths. Launch nginx-proxy with a blank domain to avoid the self-recreate path, create self-signed certs for the portal and app hosts in `core/nginx-proxy/certs` before nginx-proxy starts, then launch Authelia with a portal domain. Start an app (`nginx:alpine` is enough) on the `wicked` network with `VIRTUAL_HOST=app.<domain>` and `ENABLE_AUTH=true`, call `POST /api/core/authelia/sync`, and verify `curl -k --resolve app.<domain>:443:127.0.0.1 https://app.<domain>/` returns a 302 to the portal. Log in with `POST https://auth.<domain>/api/firstfactor`, replay the `authelia_session` cookie against the app (expect 200), and run `docker exec nginx-proxy nginx -t` to confirm the generated vhost files parse.

## Important Conventions
- Apps are always managed via their directory in `apps/<name>/` with compose files
- "Launch" functionality has evolved into "App Creation" - the flow is create/configure/manage through the App Creation tab and Apps tab
- Git operations are generic (support any git host), not hardcoded to GitHub API
- If no compose/Dockerfile found in git/upload, route to Projects/Sources
- Core nginx-proxy is managed as a single instance from Core Services; additional instances can be created differently
- Default network migrated to `wicked`

## Compose Builder Requirements
- Display every compose setting as editable fields populated from the source.
- Use a wide two-column modal: raw compose preview on the left and visual fields on the right, with the preview updating live.
- Keep a stable section order per service: Service, Image, Container Name, Restart Policy, Command, Entrypoint, Ports, Environment, Volumes, Networks, then Additional settings.
- Render multi-value sections as individual rows with add/remove controls: ports, environment key/value pairs, service volumes, and service networks.
- Put all unknown/custom keys in the Additional settings section with the field-type dropdown (common Compose keys plus scalar/raw JSON).
- Show top-level Named Volumes and Networks definitions in their own groups after the services.
- Allow adding/removing services, fields, networks, and volumes without editing raw YAML.
- Auto-add required fields (for example `image` when there is no build) and mark them required until filled.
- Highlight conflicts and invalid values in red, including duplicate service/container names, duplicate published ports, invalid ports, and invalid JSON.
- Regenerate the compose from the field model for every change and validate server-side.
- Remove the old quick port/domain fields above the raw compose; derive finalize ports and `VIRTUAL_HOST`/`VIRTUAL_PORT` from the builder model.
- Open the builder with the generated compose, let the user approve or adjust it, then save to the app library with one-click deploy/redeploy.


##------------------------------------------Your current task--------------------------------------

To hopefully simplify things create a new section for the user to define default/fallback settings and anything you think should be set to make everything function smoother.
When launching the auth service it didn't find any of the containers that were running to list for selection so the wickedafdok is still without auth.
Still showing failures on apps that install successfully leaving the window open. It's confusing and the app gets installed over and over when it was successful in the first place.

Settings:
 Dok Settings:
  Add a section for the user to define default/fallback settings.
   1. set a Primary Domain
   2. set doks domain - autofilled if set with nginx first
   3. Set a data location and its permissions - User defined app storage location. This becomes the default as /user/defined/path/apps/appname/data.
   4. Choose if volume paths can be set outside the data location. Allowing paths outside the data location allows creation and setting permissions with sudo.
   5. Set default admin creds and email - when set autofills admin info for apps and services
If there is anything you think should be set here to make everything function smoother, suggest it so we can add it.

 Core Services:
  Add an edit button to each service after its created that opens the compose editor to manually update changes if needed like adding auth etc..
  Group the wickedafdok container with core services

 Authentication:
   Create a management interface for Authelia for administration, user management, and configuration. Add a button to access it.

 App Creator:
  Create a new section called "OC Assist". This will be the most versitile and cool creation option.
  It will have a required prompt field to state your app instructions.
  It will have an optional data input field to paste whatever you need, such as docker run, compose, link to repository or web page whatever
  Optional local upload
  A Create App button
The Create App button launches open code and passes the prompt, data and local upload info if any. Opencode and the user use the chat to go over any other details and Opencode creates your app and adds it to the Apps Section.

Push to github