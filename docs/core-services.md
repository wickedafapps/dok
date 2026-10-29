# Core Services

Load this file for Dok Maintenance, nginx-proxy, cloudflared, Authentik, Authelia, DNS, Email/Mailpit/Stalwart, Host Helper, OpenCode, core-service self-management, and Authelia `ENABLE_AUTH` vhosts.

## Settings / Core Services

The **Core Services** subtab manages installed bundled services. Installation now happens only in the Dok Maintenance installer; Dok hides cards whose service is not installed and never renders a create/install form. Each installed service card keeps an **Edit compose** action for manual changes, and the running WickedAFDok container is reported as a protected core service (`role: Dok`) so it appears in the Core Services group. Status endpoints return `lookupFailed` when Docker cannot be queried; each card keeps its last displayed state instead of flipping an installed service back to the create view on a transient error.

### Dok Maintenance (managed, on demand)

- Separate privileged container `wickedafdok-maintenance` built from the same image, started by `setup.sh`, by Dok's **Settings → Maintenance** tab, or on demand when a host directory must be created. It replaces the Host Helper (its socket/token remain compatible) and is managed from `maintenance/docker-compose.yml` or the generated copy at `data/wickedafdok/maintenance/docker-compose.yml`.
- Web UI/API on port `8090` (browser entry `/?token=<data/.maintenance-token>`). API routes require the token when `MAINTENANCE_REQUIRE_TOKEN=1`; `/api/health` and static files are public. WS uses `?token=`.
- Persistent state lives in `<data location>/Dok/maintenance` after installation (before installation: `<checkout>-maintenance-data` or `MAINTENANCE_DATA_PATH`; never exported with apps): `installation.json`, `installation-state.json`, snapshots, backups, OpenCode state, logs. The installer records the sanitized Dok installation state and takes a snapshot when Maintenance opens, after install/update/backup, and on request; reinstall restores the newest snapshot, starts Dok, and starts every installed core service.
- Installer types are **Standalone Dok** (defaults/registrations may be skipped) and **Dok with Core Services** (choose at most one option per core category; required fields are enforced). The primary domain is requested first and fills `dok.`, `auth.`, `dns.`, and `mail.` subdomains plus the `authelia@<primary>` sender; every value stays editable. Repository connections lead with the name, autofill the preset address (or custom host), and can be tested with `POST /api/registries/test` before saving. The installer writes Dok settings/registries, launches Dok from the root compose, configures selected core services through Dok's APIs (nginx-proxy, cloudflared, Authentik, Authelia, DNS, Mailpit/Stalwart, SMTP), wires Mailpit's sender explicitly, applies ACME staging, writes `data/wickedafdok/installation-compose.yml` with Dok plus every installed core service, and saves the record. Dok protection is forced off unless Authelia and nginx-proxy are both selected. OpenCode Admin is available inside Maintenance to reconcile the selected stack.
- The installer writes an integration brief under `<maintenance-data>/opencode/prompts/<installation>.md` and stores its path as `opencodePrompt`; `GET /api/install/opencode-prompt` serves it (or regenerates it). The brief contains the selected service wiring matrix, expected nginx routes, current non-secret settings, launch results, per-service integration tasks (TLS/ACME staging, Authelia notifier and sender, DNS, Mailpit/Stalwart mailboxes, tunnel routes), port checks, and verification commands. Secrets are never included.
- Built-in tools cover overview/containers, app deploy/start/stop/restart proxying, backups/snapshots/import/export, updates (git pull/build/recreate then refresh Maintenance), diagnostics/repair, logs, terminal shells, and OpenCode Admin. Admin OpenCode is rejected in the Dok container (`409`); Dok UI buttons open Maintenance instead. User-mode OpenCode remains available in Dok.
- `setup.sh` takes host ownership as before, builds `wickedafdok:latest` (set `SKIP_BUILD=1` to skip), creates `.maintenance-token` under the storage root, creates the temporary `<checkout>-maintenance-data` store (or `MAINTENANCE_DATA_PATH`), migrates a legacy in-checkout `maintenance-data/`, starts the Maintenance compose with host checkout, storage root, host root, and socket mounts, and prints its token URL. The store is mode `700`; the installer moves it under `<data location>/Dok/maintenance`.
- Installation stops Dok, runs `relocateDokStorage()` to create `<data location>/Dok/{data,apps,core,sources,uploads,maintenance}`, copies the checkout data and Maintenance store (skipping sockets, `.git`, `node_modules`, and previews), writes `DOK_STORAGE_ROOT`/`MAINTENANCE_DATA_PATH` to the checkout `.env`, removes stale managed compose files, then launches Dok from the root compose. `mirrorMaintenanceData()` copies the store and `install-job.json` before Maintenance is recreated through `POST /api/maintenance/start { recreate: true }`. The install job persists at `<maintenance-data>/install-job.json`, and an interrupted job is marked failed when Maintenance restarts.

### nginx-proxy (managed)

- Only one nginx-proxy managed from Core Services UI
- States: create/edit/run when missing, management/start/stop/restart/edit when present
- Default network: `wicked`
- If domain configured for WickedAFDok in nginx settings, can trigger self-recreation to attach UI container to nginx network with `VIRTUAL_HOST`/`VIRTUAL_PORT` env vars
- Uses `jwilder/nginx-proxy` style setup
- Optional `nginxproxy/acme-companion` certificate service (`services.nginxProxy.acme = { enabled, email, staging }`) requests and renews Let's Encrypt certificates; containers opt in with `LETSENCRYPT_HOST`/`LETSENCRYPT_EMAIL`. Without it, certificates are placed manually in `core/nginx-proxy/certs`
- Managed compose stored in `core/nginx-proxy/docker-compose.yml`
- `GET /api/core/nginx-proxy` reports `exists`/`running` (live Docker state), `installed` (a live or stopped nginx-proxy container), `composeExists` (compose file on disk), and `lookupFailed` (Docker could not be queried). Reading status never creates the compose file, so a fresh install stays "not created" until the user launches nginx-proxy. A leftover compose file alone is not "installed": after the container is removed the card returns to the create view with a hint that the saved compose will be reused. `installed` falls back to `composeExists` only when `lookupFailed` is true, so a transient Docker/API failure cannot flip a running nginx-proxy back to "not installed"; the UI keeps the last known state on failed lookups
- Compose reads are capped at 2 MB. A managed core-service compose that grows past the cap is renamed to `<name>.corrupt-<timestamp>` and treated as absent, so status/sync/launch recover and regenerate it from saved settings instead of failing with `Invalid string length`. `readManagedCompose()` applies this to nginx-proxy, cloudflared, Authentik, Authelia, Technitium, and Mailpit

### cloudflared (managed)

- Create/run/edit Cloudflare Tunnel via UI
- Token configuration supported
- Managed compose stored in `core/cloudflared/docker-compose.yml`

### Authentik (managed authentication)

- Optional single sign-on and user management core service
- Managed compose stores `postgresql`, `redis`, `server`, and `worker` and uses the `wicked` network
- Generated secrets and bootstrap admin email/password are stored in `data/settings.json`
- Users create Authentik providers/applications from the Authentik admin UI; WickedAFDok exposes the service and launch/edit controls
- Optional GUI domain stored as `services.authentik.domain`; the managed compose adds `VIRTUAL_HOST`/`VIRTUAL_PORT=9000` to the `server` service only. The manage view has an **Apply domain** action that patches an existing compose and recreates a running service.
- After launching Authentik (or Authelia), the UI opens a container picker; the Authelia manage card's **Protect containers** button reopens it later. `POST /api/core/auth/apply` recreates selected containers with `ENABLE_AUTH=true`; app-managed containers are patched in their compose file and re-upped, standalone containers are recreated from their full Docker config. Protected core containers are skipped (and shown disabled in the picker). `ENABLE_AUTH` vhosts are generated by Authelia; Authentik is an SSO portal and does not consume that flag.
- Managed compose stored in `core/auth/docker-compose.yml`

### Authelia (managed authentication)

- Optional forward-auth service; separate card from Authentik, so both can be installed at once
- Apps opt in with `ENABLE_AUTH=true` plus `VIRTUAL_HOST`/`VIRTUAL_PORT`; WickedAFDok inspects running containers and writes nginx-proxy per-vhost configs (`<host>` and `<host>_location`) into `core/nginx-proxy/vhost.d/`
- HTTPS is required: Authelia rejects non-https target URLs and marks session cookies Secure, and nginx-proxy refuses TLS for hosts without a certificate. Put `core/nginx-proxy/certs/<host>.crt` and `<host>.key` in place for the portal and every protected host before nginx-proxy loads them
- Portal domain stored as `services.authelia.domain`; cookie domains are derived from the registrable-looking parent of the portal and of each protected host (`auth.example.com`/`app.example.com` → `example.com`) and regenerated when the protected set changes
- Managed compose pins `authelia/authelia:4.39`, sets `PUID`/`PGID` to the WickedAFDok uid/gid (the image entrypoint runs `chown -R` on `/config`), and lives in `core/authelia/docker-compose.yml` with config under `core/authelia/config`
- Admin password is hashed with Argon2id in-process (Node 24 `crypto.argon2`, PHC string with Authelia's defaults); older runtimes fall back to `docker run authelia/authelia:4.39 crypto hash generate argon2`. The plaintext is only shown once in the UI. The manage card also has **Apply domain**, **Sync protected apps**, **Protect containers**, and **Require login for the Dok UI**. Enabling Dok protection requires the Authelia portal domain and a Dok host that shares its cookie domain; if the sync does not generate the auth vhost, the setting is reverted and the UI reports why. User/admin saves report whether Authelia was refreshed, and say when the portal domain or admin password still has to be set
- Managed users live in `settings.services.authelia.users` with encrypted `passwordHashEnc` values and are rendered into `core/authelia/config/users.yml` together with the admin account. `GET/POST /api/core/authelia/users`, `DELETE /api/core/authelia/users/:username`, and `POST /api/core/authelia/admin` manage them; changes rewrite the file and restart Authelia only when the content changed
- The Authelia card's **Manage users** button opens `#autheliaUsersModal` (admin account, add/edit/delete local users). The **Open** button opens the portal for provider/application administration
- The auth container picker lists every running container (not just apps), disables Dok itself with a pointer to Dok protection, and disables protected core services with a note that they are managed separately

### DNS (Technitium or AdGuard Home, managed)

- One DNS card selects the provider via `services.dns.provider` (`technitium` default, or `adguard`)
- Technitium: web port `5380`, DNS `53` (UDP/TCP), generated admin password, optional GUI domain (`services.technitium.domain`), compose in `core/dns/docker-compose.yml`
- AdGuard Home: web/setup port `3000`, DNS `53` (UDP/TCP), optional GUI domain (`services.adguard.domain`), compose in the same `core/dns/docker-compose.yml` managed as project `adguard`, state in `core/dns/work` and `core/dns/conf`. Finish its setup wizard and keep the admin UI on `3000`.
- **Apply domain** works for either provider and updates `VIRTUAL_HOST`/`VIRTUAL_PORT`
- `GET/POST /api/core/dns` and `POST /api/core/dns/run` accept/return `provider`; `POST /api/core/dns/domain` honors it

### Email / Mailpit (managed)

- One card covers outgoing SMTP (`services.mail`) and the optional Mailpit capture sink (`services.mailpit`)
- `services.mail` is provider-agnostic: `host`, `port`, `tls` (`none` | `starttls` | `tls`), `username`, `password`, `sender`, `identifier`. A blank `host` disables SMTP and leaves Authelia on the filesystem notifier
- The password is AES-256-GCM encrypted in `data/settings.json`, redacted as `passwordSet`, and a blank password field keeps the saved one
- Authelia's generated `configuration.yml` emits `notifier.smtp` from these settings: `tls` maps to the `submissions://` (implicit TLS), `submission://` (STARTTLS), or `smtp://` scheme, and `none` adds `disable_require_tls` (not `disable_starttls`, which Authelia flags as a plaintext warning). With `host: mailpit`, `disable_startup_check` is on so a stopped test sink cannot stop Authelia (and every protected app) from starting
- `services.mailpit`: `smtpPort` (default `1025`), `webPort` (default `8025`), `maxMessages` (default `500`), optional `domain`. The managed compose publishes both ports, mounts `core/mailpit/data`, and runs on `wicked`; a domain adds `VIRTUAL_HOST`/`VIRTUAL_PORT=8025`
- Mailpit is a capture sink only. It stores messages for inspection in its web UI and never delivers or receives internet mail; it is not a mailbox server
- **Use Mailpit** launches the sink and points `services.mail` at `mailpit:1025` with no TLS in one step
- **Stalwart** is launched from the same Email card and configured in its own web admin
- Managed compose stored in `core/mailpit/docker-compose.yml`; settings are applied to Authelia immediately (config written, restart only if the content changed)
- `services.stalwart` is an optional full mail server (`stalwartlabs/stalwart`, compose in `core/stalwart/docker-compose.yml`): admin user/password (encrypted), web port `8088`, SMTP `25`, submission `587`, IMAPS `993`, optional GUI domain. Routes: `GET /api/core/stalwart`, `POST /api/core/stalwart/compose|run|domain`. It is independent of the SMTP notifier settings; point `services.mail.host` at `stalwart` after configuring it.

### Host Helper (legacy, replaced by Maintenance)

- Privileged companion container running `server/host-agent.js`
- The Maintenance container implements the same Unix socket/token contract and stops an old `wickedafdok-host-helper` when it starts. Existing Host Helper installs keep working until then.
- Socket/token stored in `data/host-helper`; compose stored in `core/host-helper/docker-compose.yml`. Dok starts Maintenance on demand when a host directory must be created.

### OpenCode (on demand, not a compose service)

- OpenCode powers OC Assist in App Creation. The only OpenCode launch control in Dok is **App Creation → Create app with OC Assist**; the Dashboard and Settings card no longer launch OpenCode or offer Admin/User mode choices.
- Unlike the other core services it is not a container in `core/` and is excluded from Start all/Stop all; each OC Assist launch starts a User-mode PTY inside the WickedAFDok container. Closing the chat window leaves it running in the background (up to the detached grace) so the build can finish; **Stop** on the terminal ends it. Running sessions are listed in App Creation with an **Open chat** button for reattach after a failed connection or reload
- **Admin mode:** only available inside the Dok Maintenance container (cwd `/dok`, full host/Docker access). Dok rejects admin OpenCode sessions with `409`.
- **User mode:** cwd `/app/apps`, `external_directory: deny`, and a bash/read allowlist tuned for app work; Docker, system package management, privilege escalation, and WickedAFDok source paths are intended to be off limits
- Generated configs live at `data/opencode/<mode>/opencode.json`; per-mode `HOME`/XDG directories keep sessions separate, while provider login/auth and caches are shared under `data/opencode/shared`
- `OPENCODE_DISABLE_PROJECT_CONFIG=1` prevents an app-level `opencode.json` from widening mode permissions
- Optional `services.opencode` settings (model, provider, API key) preconfigure OC Assist. If provider is blank, it is inferred from the `provider/model` prefix. The key is passed as `OPENCODE_PROVIDER_API_KEY` and generated configs reference `{env:OPENCODE_PROVIDER_API_KEY}`; it is encrypted at rest in `data/settings.json` and redacted as `apiKeySet` in API responses. It can also be added interactively with `/connect`
- The Dashboard **Terminal** button opens a plain admin shell in `/app`. The terminal modal has no mode, shell, or OpenCode picker; shell sessions run as the container user and are not permission-restricted like User-mode OpenCode.

## Core Services Self-Management

- When nginx-proxy launched with domain configured, `scheduleSelfRecreate()` may trigger recreation of WickedAFDok container
- Uses managed compose at `data/wickedafdok/docker-compose.yml`
- Attaches WickedAFDok to nginx network and sets `VIRTUAL_HOST`/`VIRTUAL_PORT`
- Regenerates the managed compose from container inspect data and preserves `user`, `group_add`, and `privileged`; it always adds the live socket GID to `group_add` when the socket is mounted, including for root, so rootless/userns-remapped or stale-group cases keep Docker access. The updater helper also writes a socket-GID override from inside the helper before `docker compose up`.
- On startup the server probes `docker.version()`; if the socket is unreachable it logs the socket owner/mode, process UID/GID, and supplementary groups, plus the `sudo ./setup.sh` remediation. API errors for socket `EACCES` get the same hint.
- nginx-proxy restarted to detect changes
- UI reconnects after recreation
- `selfContainerInfo()` backs `selfMountSource()`/`selfMountRef()`, which turn container paths into host paths for core-service bind mounts. It uses a 5s cache declared as `let selfInfoCache`; without that declaration every launch of Authentik, Technitium DNS, and any other service that resolves `/app/core` or `/app/data` fails with `selfinfocache is not defined`
- Authentik's compose pins `AUTHENTIK_IMAGE_VERSION` (currently `2026.8.5`). ghcr.io publishes no `latest` tag for `goauthentik/server`, so a `:latest` reference fails with `not found`; upgrade by bumping the constant and keep it aligned with the database migrations. `services.authentik.version` overrides it per install

## Authelia and ENABLE_AUTH vhosts

- `listAuthProtectedHosts()` inspects every running container (the `listContainers` summary omits `Env`), accepts `ENABLE_AUTH=1|true|yes|on` case-insensitively, and splits `VIRTUAL_HOST` on commas. When `defaults.protectDok` is set it also adds the Dok host before the Docker lookup, and Dok itself never needs an `ENABLE_AUTH` env or a self-recreate. If Docker cannot be queried, the last set saved in `.wickedafdok-auth.json` is reused instead of pruning every protected vhost
- Authelia users are stored in `settings.services.authelia.users` with encrypted `passwordHashEnc` values; `autheliaConfiguration()` renders the admin plus those users into `users.yml`, and `refreshAutheliaConfig()` rewrites/restarts only when the file content changes
- `syncAuthVhosts()` writes `<host>` (server scope: `location = /authelia` proxying to `http://authelia:9091/api/authz/auth-request` with `X-Original-URL`/`X-Forwarded-*`) and `<host>_location` (`auth_request /authelia`, forwards `Remote-User`, `Remote-Groups`, `Remote-Name`, `Remote-Email`, `Remote-Status`, and `error_page 401 =302 https://<portal>/?rd=$target_url`). Only files starting with `# managed-by: wickedafdok:authelia` are pruned
- Protected hosts must share the portal's cookie domain (`app.example.com` and `auth.example.com` → `example.com`); hosts under a different parent are skipped (`skippedHosts` in the state file, plus a server warning) because the portal cannot set a session cookie for another parent. Cookie domains use the last two labels, so multi-level public suffixes such as `co.uk` are not handled specially
- Wildcard/regexp `VIRTUAL_HOST` patterns are skipped: nginx-proxy uses different file naming for its server and location scopes, so pattern hosts have no reliable per-vhost hook. List the literal hostnames on the container instead
- The protected-host set and cookie domains are cached in `core/nginx-proxy/vhost.d/.wickedafdok-auth.json`. Stale host files are removed, nginx-proxy is restarted when the files change (docker-gen only re-renders on container events and checks vhost files at render time, so a plain reload would miss newly protected hosts), and Authelia's `configuration.yml` is rewritten only when the cookie-domain set or the mail-settings fingerprint changes (the fingerprint is stored in the same state file); a restart follows only when the file content actually changed. SMTP settings are therefore never lost on a 60 s sync, and changing them takes effect without waiting for a cookie-domain change
- Sync runs on server start, every 60 s (unref'd timer), after app deploy/start/stop/restart, after `POST /api/core/nginx-proxy/run`, and from the Authelia run/domain/sync routes
- nginx-proxy's managed compose mounts the host-resolved core directory (`selfMountSource('/app/core')`, then `nginx-proxy/vhost.d` and `nginx-proxy/certs:ro`), and Authelia mounts the host-resolved `authelia/config`. Relative bind sources would be resolved on the Docker daemon host (e.g. `/app/core/...`) and silently mount empty directories; existing managed composes are patched in place with `setMountSource()`. `ensureNginxProxyCompose()` upgrades older composes on `GET /api/core/nginx-proxy` and during sync, and recreates a live nginx-proxy once if its container is missing either mount. Without the certs, the https server blocks fail their TLS handshake and never reach the auth check
- Authelia 4.39 schema traps: `identity_validation.reset_password.jwt_secret` is required (and `.disable` is rejected); `session.cookies[].secure` is rejected; `authelia_url` must be https; a cookie `domain` needs a dot or an IP; the top-level `default_redirection_url` cannot be combined with `session.cookies`, so it is emitted per cookie; `authelia hash-password` is gone in favor of `authelia crypto hash generate argon2`
