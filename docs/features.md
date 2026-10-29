# Features and Settings UI

Load this file for Dashboard, Containers, Images, Projects/Sources, Dok Settings, Logs, and the legacy backups pane.

## Dashboard

- Host/system stats (CPU, memory, disk, load average, uptime)
- Docker engine info
- Network information
- Core Service Consoles card with an **Open GUI** button for every installed service that has a web UI (Authentik, Authelia, Technitium, AdGuard Home, Mailpit, Stalwart). URLs use the configured domain when present, otherwise the published localhost port; stopped services are shown disabled
- Live auto-refresh

## Containers

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

## Images

- List Docker images
- Pull images from registry
- Remove images
- Quick-run helper

## Projects / Sources

- Browse and edit files under `sources/` directory
- Auto-detect presence of compose files or Dockerfiles
- Deploy from Projects goes through App Creation flow
- UI element: `#tab-sources`

## Dok Settings

Settings is split into four subtabs: **Core Services**, **Dok Settings**, **Logs**, and **Maintenance**. Backups and updates moved into the Maintenance container; the old backups pane is kept in the DOM but hidden and its API routes remain for backward compatibility. Dok Settings contains the app's own management options: Default settings, Designer, Groups, and registry connections.

### Default settings

- `#defaultsCard` stores fallback values in `settings.defaults` and exposes `GET/POST /api/settings/defaults`, plus `POST /api/settings/defaults/apply`
- `primaryDomain` is used to suggest `auth.<domain>`, `sso.<domain>`, `dns.<domain>`, and `mail.<domain>` in the core-service forms
- `dokDomain` is used for the Dok UI and falls back to `services.nginxProxy.domain`; saving a Dok domain also fills a blank nginx domain
- `dataLocation` (absolute host path) and `dataMode` (octal, default `0775`) create `<dataLocation>/apps`; app data defaults to `<dataLocation>/apps/<app>/data` and missing relative bind mounts are mapped beneath that folder
- `autoAppData` controls automatic app data folders; `allowOutsideData` permits creating/using bind paths outside the data location (otherwise finalize rejects missing outside paths). Creation goes through the Host Helper when direct access is denied
- `adminUser`, `adminEmail`, and `adminPassword` prefill/seed Authelia, Authentik, and Technitium installs; the password is encrypted and exposed only as `adminPasswordSet`
- `defaultNetwork` is used by app creation and may be auto-created on first use
- `protectDok` adds the Dok host to the Authelia protected set without recreating the Dok container; the Dok domain must already route through nginx-proxy, the Authelia portal domain must be set, and both must share a cookie domain for the protection to take effect. Enabling it is rejected (and the setting reverted) when sync cannot generate the auth vhost
- Saving defaults creates the configured data location and apps folder, validates domains/modes, and triggers Authelia vhost sync when `protectDok` changes

### User manual and field help

- `public/js/manual.js` renders the in-app manual from `MANUAL_GROUPS`/`MANUAL`, opens `#manualModal`, and wires the Settings header **User manual** button plus every `[data-open-manual]` section button.
- The manual covers every section (dashboard, containers, images, app creation, apps/library, sources, terminal/OpenCode, core services, Dok settings, logs, backups, troubleshooting) and includes a field reference.
- Top-level tab headers, App Creation panes, Settings panes, and settings/app-creation card headings have a `?` section-help button that opens the matching manual section.
- `decorateFields()` wraps unlabeled inputs/selects/textareas in `.field-wrap` with a visible label and adds a `.field-help` `?` tooltip using `FIELD_LABEL`/`FIELD_HELP`. A MutationObserver decorates dynamically rendered fields and syncs hidden wrappers; builder/terminal controls are excluded.
- `#openManualBtn`, `[data-open-manual]`, `#manualModal`, `#manualTitle`, `#manualContent`, `#manualNav` are the main UI hooks.

### Designer

- `#openDesigner` in Dok Settings opens `#designerModal`
- Stores `designer.name`, `designer.tagline`, `designer.css`, and `designer.logo` in `data/settings.json`; uploaded logos live under `data/designer/`
- `GET/POST /api/designer`, `POST /api/designer/logo`, `GET /api/designer/logo`
- Name, tagline, and CSS are applied live to the header; the CSS override is injected as a `<style>` element
- Bundled error pages live in `core/nginx-proxy/html/` (`html/404.html`, `html/403.html`, `html/errors/50x.html`) and are mounted at `/usr/share/nginx/html` in nginx-proxy. `core/nginx-proxy/vhost.d/default` (created only when absent) sets `proxy_intercept_errors`/`error_page` to those files. Existing pages and configs are never overwritten
- The file picker opens `html/404.html` by default and lists error pages before vhost snippets and the compose file
- `GET /api/designer/files`, `GET /api/designer/file?path=`, and `POST /api/designer/file` expose editable text files under `core/nginx-proxy` (error pages, vhost snippets, configs); dotfiles and private key/`.pem` files are excluded

### Groups

- Stores container groups in `data/groups.json`
- The **Core Services** group is built in and computed from live Docker labels/names (`com.docker.compose.project` and known core container names). It cannot be edited or deleted and appears first in `GET /api/groups`
- `GET /api/groups`, `POST /api/groups`, and `DELETE /api/groups/:id`
- UI elements live inside `#settings-pane-dok`: `#groupName`, `#groupContainers`, `#saveGroup`, `#groupsList`

### Registry connections

- Stores container registry and git host credentials in `data/registries.json`
- Secrets are encrypted with AES-256-GCM using `data/.credentials-key`; API responses only expose `hasSecret`, never the secret itself
- `GET /api/registries` lists connections, `POST /api/registries` creates/updates one, `DELETE /api/registries/:id` removes one, and `POST /api/registries/:id/test` validates it
- Presets cover Docker Hub, GHCR, GitLab Container Registry, Quay, custom registries, GitHub, GitLab, Gitea/Forgejo, and custom git hosts
- `run()` injects a generated `DOCKER_CONFIG` (from `data/docker-config`) for every `docker` command, so pulls and compose launches authenticate to matching registries
- `gitEnvironment(repo)` injects a temporary `GIT_ASKPASS` helper for HTTPS URLs whose host matches a stored git connection; SSH URLs continue to use keys
- UI elements: `#registryKind`, `#registryProvider`, `#registryName`, `#registryHost`, `#registryUsername`, `#registrySecret`, `#saveRegistry`, `#cancelRegistryEdit`, `#registriesRefresh`, `#registriesList`

## Logs

- Server console output plus mutating `/api` requests are written to `data/logs/server.log` and a 2000-line in-memory ring buffer
- Logs subtab shows server logs and Docker Compose logs for apps and core services with auto-refresh and tail controls

## Backups & Updates (legacy Dok pane, hidden)

- New backups, snapshots, imports, and updates are managed by Dok Maintenance; the routes below remain for compatibility.
- Local backups stored under `data/backups` as `<id>.tar.gz` plus `<id>.json` metadata
- Scopes: `full`, `app`, and `custom`
- Full backups include `data`, `apps`, `core`, and `sources`; `data/backups`, `data/tmp`, and the helper socket are excluded, and `data/logs` is optional
- App backups include `apps/<name>` plus a registry snapshot
- App backup restore preserves an existing app-root `data/` directory and `.env*` files, reports them through `reuseData`/`message`, and never deletes them during the restore
- Custom backups accept toggles for `data`, `apps`, `core`, `sources`, and `logs`, plus optional per-app and per-core-service selections. An empty app/core selection means all of that section. The manifest is stored at `data/.backup-manifest.json` (or as the only `data` entry when data is excluded) with `scope: 'custom'`, `components`, `apps`, and `core` fields.
- Custom restores only overwrite the sections recorded in the manifest; full and app archives remain backward compatible
- `GET /api/backups/options` returns the app and core-service pickers used by the UI
- Import accepts a WickedAFDok archive and restores it; restore requires explicit overwrite confirmation
- The temporary git update UI lives in the Maintenance container's Updates panel.

## Settings storage

**Settings:** Persisted in `data/settings.json`. Legacy `/api/dns` and `/api/auth` endpoints remain as unenforced scaffolds; they are not used by the new Core Services UI.
