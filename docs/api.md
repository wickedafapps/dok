# API Endpoints

Load this file when adding, changing, or calling REST or terminal endpoints.

## Health

- `GET /api/health` - Health check

## System

- `GET /api/system/stats` - Host CPU/memory/disk/load + Docker info
- `POST /api/system/update-from-git` - Update WickedAFDok from a required git repo; the code root must be writable by the server user

## Containers

- `GET /api/containers` - List containers; each entry includes `project`, `service`, `core`, `protected`, `self`, and `role`
- `GET /api/containers/:id/inspect` - Inspect container
- `GET /api/containers/:id/logs` - Get container logs
- `POST /api/containers/:id/:action(start|stop|restart|pause|unpause)` - Container actions
- `POST /api/containers/:id/exec` - Execute command in container
- `POST /api/containers/:id/update-check` - Check for updates
- `POST /api/containers/:id/redeploy` - Redeploy container
- `POST /api/containers/:id/save-to-registry` - Save to apps registry
- `DELETE /api/containers/:id` - Remove container; protected containers require `{ "confirmName": "<container name>" }` (otherwise `403`)

## Images

- `GET /api/images` - List images
- `POST /api/images/pull` - Pull image
- `POST /api/images/remove` - Remove image

## App Creation / Launch

- `POST /api/launch/run` - Process docker run command, return config modal data (required `name` app title)
- `POST /api/launch/compose` - Process compose content (required `name` app title)
- `POST /api/launch/git` - Clone git repo and process (required `name` app title)
- `POST /api/launch/upload` - Upload files and process (required `name` app title)
- `POST /api/launch/source` - Deploy from sources directory (required `name` app title)
- Creator routes return the detected `referenceUrl` for the compose editor when an official repository or website is found.
- `POST /api/assist/start` - Upload optional files, write the OC Assist brief, and start a User-mode `assist` OpenCode session (required `prompt` and `name` app title, optional `data`, `files`, `paths`)
- `POST /api/launch/finalize` - Complete creation (required app title; save to apps dir, update registry, optional test launch that is always stopped again); accepts `referenceUrl` and otherwise detects it; a per-app lock returns `409 alreadyFinalizing` and failures after the registry write return `created: true`
- `POST /api/compose/validate` - Validate compose file content
- `POST /api/compose/parse` - Parse a compose file into editable builder fields
- `POST /api/compose/build` - Generate compose from builder fields and return field-level issues

## Maintenance / Installation

- `GET /api/maintenance` - Maintenance container status, token URL, port, and compose path
- `POST /api/maintenance/start|stop|mode` - Start/stop Maintenance or toggle maintenance mode (`{ active }`) and start Dok when leaving
- `GET /api/installation` / `POST /api/installation/sync` - Read or write the sanitized `data/installation-state.json` snapshot used by Maintenance
- `GET /api/install` / `POST /api/install/validate` / `POST /api/install/run` - Maintenance installer state, plan validation, and installation job (Maintenance API)
- `GET /api/install/opencode-prompt` - Serve the saved installation integration brief or regenerate it from the saved plan/settings
- `POST /api/registries/test` - Test a registry login or git host before the installer saves the connection
- `GET /api/maintenance` also backs the Settings → Maintenance card; Admin OpenCode is rejected in Dok with `409`

## Core Services

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
- `GET /api/core/dns` / `POST /api/core/dns/compose` / `POST /api/core/dns/run` / `POST /api/core/dns/domain` - DNS status, compose, launch, GUI domain for Technitium or AdGuard Home (`provider`)
- `GET /api/core/stalwart` / `POST /api/core/stalwart/compose` / `POST /api/core/stalwart/run` / `POST /api/core/stalwart/domain` - Stalwart mail server status, compose, launch, GUI domain
- `GET /api/core/mail` - SMTP settings (redacted), Mailpit status/compose, and the resolved Authelia notifier address
- `POST /api/core/mail/smtp` - Save SMTP delivery settings and apply them to Authelia
- `POST /api/core/mail/use-mailpit` - Launch Mailpit and point notifications at `mailpit:1025`
- `GET /api/core/mailpit` / `POST /api/core/mailpit/compose` / `POST /api/core/mailpit/run` / `POST /api/core/mailpit/domain` - Mailpit status, compose, launch, GUI domain
- `GET /api/core/host-helper` / `POST /api/core/host-helper/compose` / `POST /api/core/host-helper/run` - Host helper status, compose, launch
- `POST /api/core/all/:action(start|stop|restart)` - Apply an action to every created core service
- `POST /api/core/:service/:action(start|stop|restart)` - Apply an action to one core service
- `GET /api/core/app-hints` - Installed-or-running core-service flags and compose environment field hints (`VIRTUAL_HOST`, `VIRTUAL_PORT`, `ENABLE_AUTH`, `LETSENCRYPT_HOST`, `LETSENCRYPT_EMAIL`) used by the app and library compose builders; `?app=<name>` supplies the default routed hostname
- `GET /api/core/dashboard` - Installed core services with web UIs, their configured/localhost URLs, and running state for the Dashboard console buttons
- `GET /api/core/opencode` - OpenCode install/version, running sessions, modes, and generated configs
- `POST /api/core/opencode/settings` - Save optional model/provider/API key
- `POST /api/core/opencode/run` - Legacy OpenCode launcher; Dok's UI no longer calls it (OC Assist starts through `POST /api/assist/start`)
- `POST /api/core/opencode/stop` - Stop all running OpenCode sessions

## Terminal

- `GET /api/terminal` - Terminal capabilities, OpenCode version, available modes, and sessions
- `POST /api/terminal/sessions` - Create a PTY session (`{ mode, app }`, where `app` is `shell` or `opencode`)
- `POST /api/terminal/sessions/:id/stop` - Stop one session
- `POST /api/terminal/sessions/stop-all` - Stop all sessions, optionally filtered by `app`
- `GET /api/terminal/sessions/:id/output?after=<sequence>` - Poll buffered output for the HTTP compatibility transport
- `POST /api/terminal/sessions/:id/input` - Send `data`, `cols`, and/or `rows` for the HTTP compatibility transport
- `GET /api/terminal/ws?id=<session>` (WebSocket upgrade) - Attach to a session; sends `ready`, `output`, `exit`, and `pong` messages, accepts `input`, `resize`, and `ping`

## Logs and Backups

- `GET /api/logs/server` / `DELETE /api/logs/server` - Read or clear the server log
- `GET /api/logs/apps` - List apps and created core services available for logs
- `GET /api/logs/app/:id` - Docker Compose logs for an app
- `GET /api/logs/core/:service` - Docker Compose logs for a core service
- `GET /api/backups` / `POST /api/backups` - List or create backups (`full`, `app`, or `custom` with `components`, `apps`, and `core`)
- `GET /api/backups/options` - List apps and core services available for custom backups
- `GET /api/backups/:id/download` / `DELETE /api/backups/:id` - Download or delete a backup
- `POST /api/backups/:id/restore` - Restore a backup; requires `overwrite: true`
- `POST /api/backups/import` - Upload and restore an archive; returns `409` with `needsOverwrite` when confirmation is required

## Sources/Projects

- `GET /api/sources/list` - List files in sources/
- `GET /api/sources/file` - Read file from sources/
- `POST /api/sources/file` - Write file to sources/

## Apps

- `GET /api/registry` - List apps in registry
- `POST /api/registry/:id/deploy` - Legacy one-click compose up (the UI now deploys through the compose editor); resolves duplicate container names
- `POST /api/registry/:id/:action(start|stop|restart)` - App compose lifecycle actions
- `GET /api/apps/:id/compose` - Read the app's base compose file (with saved routing env surfaced) plus network/vhost analysis, `referenceUrl`, and issues
- `POST /api/apps/:id/compose` - Save an edited compose as the new base. Body: `compose`, `network` (selected app network; defaults to the configured default), `deploy: true` to re-deploy, `force: true` to save despite validation issues, `confirmAmend: true` to approve container renames, `vhostTouched`, `vhostService`, `vhostPort`, and `referenceUrl` to update or clear the saved link. `wicked` and the configured default network are created when missing; another missing network returns `400` with `missingNetworks`.
- `DELETE /api/registry/:id` - Remove from registry

## App Library

- `POST /api/library/export` - Export selected registry apps as a `wickedafdok.library/v1` `.tar.gz`
- `POST /api/library/import` - Import a library archive; returns `409 needsOverwrite` when the target app exists
- `POST /api/library/import-repo` - Clone a git repository and import its library or single app

## Designer

- `GET /api/designer` / `POST /api/designer` - Read or save name, tagline, CSS, and logo state
- `POST /api/designer/logo` (multipart `logo`) - Upload PNG/JPG/WebP/SVG/ICO
- `GET /api/designer/logo` - Serve the uploaded logo
- `GET /api/designer/files` / `GET /api/designer/file?path=` / `POST /api/designer/file` - Browse and edit text files under `core/nginx-proxy`

## Networks & Settings

- `GET /api/networks` - List Docker networks
- `POST /api/networks/create` - Create a named Docker network (`{ name }`); used by the App network create box
- `GET /api/settings` - Get settings
- `POST /api/settings` - Save settings
- `GET /api/settings/defaults` / `POST /api/settings/defaults` / `POST /api/settings/defaults/apply` - Read, save, and re-apply default settings (domains, data location/mode, admin fallbacks, network, Dok protection)

## Groups, Registries, DNS, Auth

- `GET /api/groups` / `POST /api/groups` / `DELETE /api/groups/:id` - Container groups
- `GET /api/registries` / `POST /api/registries` / `DELETE /api/registries/:id` - Container registry and git host connections
- `POST /api/registries/:id/test` - Validate a stored registry or git credential
- `GET /api/dns` / `POST /api/dns` - DNS settings
- `GET /api/auth` / `POST /api/auth` - Auth settings placeholder (not enforced)
