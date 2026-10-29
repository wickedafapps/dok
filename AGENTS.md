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
- `setup.sh` defaults the container UID/GID to `SUDO_UID`/`SUDO_GID` (the sudo user), then falls back to the repo owner when not run via sudo. `--uid`/`--gid` override it; `--root` uses `0:0`. It also adds the invoking `SUDO_USER` to the socket group and prints a logout reminder at the end. After preparing permissions it builds `wickedafdok:latest` (`SKIP_BUILD=1` skips), creates `data/.maintenance-token` and the Maintenance store at `<checkout>-maintenance-data` beside the checkout (override with `--maintenance-data` or `MAINTENANCE_DATA_PATH`), migrates a legacy in-checkout `maintenance-data/`, and starts the `wickedafdok-maintenance` container with the host checkout, host root, and Docker socket mounted; it prints the token URL for the browser installer.
- `setup.sh` takes ownership of the whole checkout (including `server/`, `public/`, and `.git`), normalizes directories to `755` and files to `644` while keeping executable scripts at `755`. Runtime JSON, logs, backups, helper credentials, `.env`, and managed `docker-compose*.yml` files are set to `600`; `data/.home`, `data/backups`, `data/host-helper`, and `data/opencode` (including its subdirectories) are `700`, and files under `data/opencode` are `600`. It also chowns the generated compose override files when running non-root.
- OpenCode is installed into the image at build time from the official installer (`OPENCODE_VERSION` build arg, symlinked to `/usr/local/bin/opencode`). Setting `OPENCODE_BIN` points the server at a different binary, which is useful for development.
- The Dockerfile starts Node directly (`node server/index.js`) so non-root operation does not depend on npm having a writable home; setup sets `HOME=/app/data/.home`
- No built-in authentication - put behind a reverse proxy with auth if exposed publicly. `/api/auth` is a settings placeholder, not an auth middleware; it stores credentials and does not protect API routes.
- Runtime JSON files are written with mode `600` because settings/auth/DNS files can contain secrets. Registry/git connection secrets in `data/registries.json` and service secrets in `data/settings.json` are AES-256-GCM encrypted with `data/.credentials-key`; other runtime JSON remains plaintext.


## General Engineering Principles and Proactive Problem-Solving

### 1. Take Ownership of the Intended Outcome

When given a task by the user, take ownership of achieving the user's intended outcome, not merely following the literal wording of their instructions.

Understand what the user is trying to accomplish, why the requested change matters, and how it fits into the existing project. Use your own logic, reasoning, technical knowledge, and engineering judgment to determine what is needed to deliver a complete, reliable, secure, and usable solution.

Treat the user's explicit instructions as the primary requirements, but recognize that users may not know every technical detail, dependency, prerequisite, edge case, or supporting feature necessary to achieve their goals.

Do not interpret incomplete instructions as a requirement to produce an incomplete solution.

### 2. Proactively Identify Missing Requirements

Before implementing a task, independently consider what may have been overlooked or left unstated.

Depending on the task, evaluate:

- Required supporting functionality, dependencies, integrations, and configuration.
- Connections between the requested change and existing components, services, APIs, databases, and workflows.
- Data validation, error handling, permissions, authentication, authorization, and security implications.
- Data persistence, state management, concurrency, retries, recovery, and failure handling.
- User feedback, usability, accessibility, and expected behavior in normal and exceptional situations.
- Installation, deployment, environment variables, migrations, documentation, and operational requirements.
- Backwards compatibility, existing functionality, regressions, and interactions with other features.
- Testing requirements and how the finished result can be verified.

These are considerations, not a checklist that must be implemented identically for every task. Apply judgment based on the actual requirements and risks.

Identify both what the user explicitly requested and what must reasonably be true for the requested functionality to work as intended.

### 3. Inspect Before Assuming

Do not make decisions based solely on assumptions when relevant evidence is available.

Inspect the existing codebase, project structure, related implementations, configuration, dependencies, documentation, and tests before deciding how to proceed.

Follow established project conventions where appropriate. Reuse existing functionality and dependencies when doing so produces a sound solution.

When you identify a potential missing requirement, determine whether it is genuinely necessary, already implemented elsewhere, intentionally excluded, or merely an optional enhancement.

Do not duplicate existing functionality or introduce redundant infrastructure because you overlooked what the project already provides.

### 4. Implement the Smallest Complete Solution

When a missing requirement is clearly necessary or strongly implied by the user's goal, address it proactively as part of the task when it falls within the authorized scope.

Do not wait for the user to explicitly request every supporting implementation detail.

Prefer the smallest complete, maintainable solution that achieves the intended outcome. Include necessary integration, configuration, validation, error handling, and tests rather than delivering an isolated code change that does not work in practice.

However, proactive problem-solving does not authorize unnecessary feature development, unrelated refactoring, architectural redesigns, or speculative improvements.

Distinguish between:

- **Essential:** Necessary for the requested functionality to work correctly. Include it.
- **Important and directly relevant:** Materially improves reliability, security, maintainability, or usability. Include it when proportionate to the task and within scope.
- **Optional enhancement:** Potentially useful but not necessary to achieve the intended outcome. Mention it when worthwhile, but do not automatically implement it.
- **Out of scope or consequential:** Changes that materially expand the task, affect unrelated systems, incur significant costs, or introduce destructive or externally visible effects. Obtain approval when appropriate.

Never silently remove existing functionality, weaken security, discard user data, or change established behavior merely to simplify implementation.

### 5. Use Independent Judgment and Anticipate Problems

Do not blindly follow an implementation approach if inspection reveals that it will not achieve the user's goal.

Identify technical problems, contradictions, missing prerequisites, flawed assumptions, and foreseeable failure scenarios. If the user's proposed approach is likely to fail, explain why and choose a better approach when the intended outcome and authorization are clear.

Consider realistic edge cases and failure conditions relevant to the task, such as invalid input, missing configuration, unavailable services, network interruptions, permission failures, partial operations, and inconsistent state.

Add appropriate validation, error handling, logging, recovery, and user feedback where justified.

Make reasonable technical decisions independently. Do not ask the user to decide routine implementation details that can be resolved through sound engineering judgment.

### 6. Ask Questions Only When They Matter

Do not interrupt progress with unnecessary clarification requests when the intended outcome is clear and reasonable assumptions are sufficient.

Proceed using the best-supported assumptions when uncertainty is minor and the consequences of being wrong are low. Document important assumptions when they affect the implementation.

Ask the user for clarification or approval when:

- Multiple plausible interpretations would lead to materially different results.
- A missing decision cannot reasonably be resolved from the codebase, documentation, or context.
- A decision could cause significant data loss, security exposure, expense, downtime, or irreversible changes.
- The proposed implementation would materially expand the scope or conflict with the user's stated requirements.
- Required credentials, permissions, or authorization are unavailable.

When clarification is necessary, ask a focused question that explains the specific decision and why it matters. Do not offload the entire problem-solving process to the user.

### 7. Plan Around the Complete Task

Before making changes, establish:

1. The user's intended outcome and what success looks like.
2. The relevant existing implementation and project conventions.
3. The explicit requirements and necessary implied requirements.
4. Dependencies, integration points, edge cases, and risks.
5. The implementation steps and appropriate verification methods.

For complex tasks, communicate a concise plan before substantial implementation when useful. For straightforward tasks, perform this reasoning without unnecessary planning overhead.

As work progresses, update the approach when new evidence reveals overlooked requirements or a better solution.

### 8. Verify Functionality, Not Just Code Changes

Do not consider a task complete simply because the requested code has been written or the application compiles.

Perform appropriate verification based on the task, such as:

- Running relevant automated tests and adding tests for important new behavior.
- Checking linting, type checking, builds, and configuration validity when applicable.
- Exercising important workflows, integration points, and realistic edge cases.
- Checking that error handling and failure recovery behave appropriately.
- Reviewing changes for regressions, security issues, unintended side effects, and incomplete integration.
- Confirming that required configuration, migrations, dependencies, and documentation are addressed.

Use available tools and practical tests to establish whether the implementation works. Do not claim to have run tests, inspected systems, or verified behavior unless you actually did so.

If verification is blocked or unavailable, explain what remains unverified and why. Do not disguise uncertainty as success.

### 9. Definition of Done

A task is complete when:

- The intended outcome has been achieved to a reasonable, verifiable standard.
- Explicit requirements and necessary supporting requirements have been addressed.
- The implementation integrates correctly with the existing project.
- Relevant edge cases, failure conditions, security considerations, and regressions have been considered.
- Appropriate verification has been performed, or remaining verification limitations have been disclosed.
- No unnecessary scope expansion or unauthorized consequential changes have been introduced.
- Any remaining limitations, important assumptions, or recommended follow-up work are communicated clearly.

If a task cannot be completed fully, deliver the most useful safe progress possible and explicitly identify what remains outstanding.

### 10. Report Results Clearly

When finishing a task, summarize:

- What was implemented.
- What additional supporting requirements or overlooked issues were addressed.
- What tests and verification were actually performed and their results.
- Any remaining limitations, assumptions, risks, or follow-up actions.

Keep reports proportionate to the task. Prioritize meaningful results and outstanding issues over a lengthy account of routine implementation steps.

**Guiding principle:** Think like an engineer responsible for delivering the outcome, not a code generator responsible only for executing instructions. Use initiative to discover and address necessary missing pieces, evidence to guide decisions, restraint to avoid unnecessary complexity, and verification to establish whether the solution actually works.


## Directory Structure
```
.
├── .dockerignore        # Keeps runtime data and node_modules out of image builds
├── .gitignore           # Keeps runtime data, node_modules, and generated files out of git
├── server/index.js      # Main server with all API routes and business logic
├── server/host-agent.js # Legacy privileged helper socket (superseded by Maintenance)
├── server/assist-register.mjs # OC Assist helper that registers/deploys an app via finalize API
├── server/app-agents.md # OC Assist app-library contract; written to apps/AGENTS.md on startup
├── maintenance/         # Dok Maintenance container (server, shared lib, compose)
├── public/              # Frontend
│   ├── index.html       # UI structure
│   ├── css/style.css    # Styles
│   ├── js/app.js        # Frontend logic
│   ├── js/manual.js     # In-app manual, section help, and field labels/tooltips
│   └── maintenance/     # Maintenance installer/tools UI
├── apps/                # Deployed apps (each app in its own subdirectory with compose)
├── core/                # Installed core services (nginx-proxy, cloudflared, authentik, authelia, dns, mailpit, stalwart)
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

Maintenance storage is not part of the checkout: by default it lives beside it at `<checkout>-maintenance-data` (for example `/srv/dok-maintenance-data`), or at the absolute path in `MAINTENANCE_DATA_PATH` / `setup.sh --maintenance-data`.

## Features

### Dashboard
- Host/system stats (CPU, memory, disk, load average, uptime)
- Docker engine info
- Network information
- Core Service Consoles card with an **Open GUI** button for every installed service that has a web UI (Authentik, Authelia, Technitium, AdGuard Home, Mailpit, Stalwart). URLs use the configured domain when present, otherwise the published localhost port; stopped services are shown disabled
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

Every creation method requires an app title; the API rejects creator requests without one. Apps are always saved to the library **stopped**; users configure and deploy them from the Apps tab.

Every creation method also detects the app's official repository or website when one is available and prefills it into the compose editor. The link is stored as `referenceUrl` in `data/registry.json`, shown in Apps for configuration reference, and carried through library export/import.

Created and saved composes always join the configured default Dok network (normally `wicked`, written as an external Compose `default` network). When nginx-proxy is installed, a routed app must carry `VIRTUAL_HOST` and the matching container-port `VIRTUAL_PORT` on the same service; Dok always adds `VIRTUAL_PORT` automatically (explicit form value, then an existing `VIRTUAL_PORT`, then the first published/`expose` container port, then `PORT`, then 80). Finalize resolves routing from the form quick fields **or** from a `VIRTUAL_HOST` already present in the compose (OC Assist, imported, pasted, or `docker run` env), so a host name is never saved without its port. Because nginx reaches the container over the shared network, published host `ports` are removed from the routed service so the app GUI is served through nginx and multiple apps can use the same container port without host conflicts. The routing service is also attached to the `default` Dok network even when it lists other networks.

1. **OC Assist** (default tab) - Describe the app in a required prompt, optionally paste data (docker run, compose, repository/page URL) and upload files. WickedAFDok writes a private brief plus the uploads under `sources/oc-assist-<stamp>-<random>/`, starts a **User-mode** OpenCode session with the dedicated `assist` agent and the creator fields already in the first prompt, and immediately opens the chat in the terminal modal. The assist agent is restricted to app files, the OC Assist source/brief folders, and the registration helper; it creates the compose and registers the app through `server/assist-register.mjs`. Registration saves the app stopped; an optional `--test` performs a temporary launch that the server stops again. Use `#assistPrompt`, `#assistData`, `#assistName`, `#assistFiles`, `#assistFolder`, `#assistStartBtn`, `#assistOutput`, and the `#assistSessions`/`#assistSessionsList` running-session list with **Open chat** buttons. The start route waits briefly for OpenCode's first frame; if OpenCode exits during startup, the UI receives the captured terminal error instead of a blank session.
2. **Docker Run** - Paste a `docker run` command. WickedAFDok parses and converts it to a normalized compose file. Opens App Configuration modal.
3. **Docker Compose** - Paste `docker-compose.yml`/`compose.yaml` content. Stored in the app's own managed compose file and opened in App Configuration modal.
4. **Git Clone** - Provide any git URL (generic git, not limited to GitHub API). If repo contains `docker-compose.yml`/`compose.yaml` or `Dockerfile`, files are copied to `apps/<name>` and opened in App Configuration modal; Dockerfile-only projects get a generated compose file. If no compose/Dockerfile found, routed to **Projects**.
5. **Local Upload** - Upload files/folders via multipart form. If compose or Dockerfile present, files are copied to `apps/<name>` and opened in App Configuration modal; Dockerfile-only uploads get a generated compose file. Otherwise routed to **Projects**.

**App Configuration Modal:**
- Opens with a visual Compose builder (`#appCfgBuilder`) populated from the managed compose via `/api/compose/parse`
- **Official repository or website** (`#appCfgReferenceUrl`) is prefilled by the creator when a reliable link is found and can be edited or cleared; `#appCfgReferenceLink` opens the current value. It is saved with the app and shown in Apps; non-http(s) values are rejected.
- Builder model shape: `{ services: [{ name, fields: [{ key, type, value, required? }] }], networks: [{ key, external, name, driver, extra? }], volumes: [...], other?: string }`
- Services, networks, volumes, and top-level settings are editable as fields; `+ Add service`, `+ Add field`, `+ Add network`, and `+ Add volume` add fields, while `−` removes them
- The service field type dropdown covers common Compose keys; unknown parsed keys appear as custom JSON fields. Advanced structures are preserved in raw/JSON fields (`depends_on` conditions, network aliases/options, long ports/volumes, multiline commands, `extra_hosts`, unknown top-level keys)
- Required fields (image when no build context is present) are auto-added and marked required until filled; missing required values and conflicts such as duplicate service/container names, duplicate published ports, invalid ports, and invalid JSON are highlighted red
- Every builder change regenerates the compose through `/api/compose/build`; edits to ports and `VIRTUAL_HOST`/`VIRTUAL_PORT` stay in sync with the quick fields. Port/volume lists accept comma-separated values on one line; other list fields are one value per line so embedded commas (for example `tmpfs` options) are preserved
- Builder requests are sequenced: stale responses are ignored, in-flight builds cannot overwrite manual compose edits, and quick fields target the preferred app/vhost service instead of always `services[0]`
- When core services are installed (managed compose exists or the installer enabled them) or running, the builder calls `GET /api/core/app-hints` and adds their environment fields to the preferred service automatically: `VIRTUAL_HOST`/`VIRTUAL_PORT` for nginx-proxy, `ENABLE_AUTH=true` for Authelia, and `LETSENCRYPT_HOST`/`LETSENCRYPT_EMAIL` for acme-companion. Installed-but-stopped services still produce hints, so a freshly installed stack configures the editor before anything starts. `VIRTUAL_HOST` and `LETSENCRYPT_HOST` default to `<app>.<primaryDomain>` when a primary domain is configured, `VIRTUAL_PORT` defaults to the app's first container port, and `LETSENCRYPT_EMAIL` defaults to the configured admin email. Blank hint values are omitted from the generated compose, and existing keys are left untouched. The same model is used by Deploy editing and imported library apps.
- Switching to manual compose editing hides the builder and sets a dirty/manual flag so run-created apps retain their original `docker run` semantics unless the builder was actually edited
- When Docker Compose CLI is unavailable, `/api/compose/parse` falls back to a built-in block-YAML reader for the Compose subset
- **"Manually edit compose file"** - Opens warning modal about potential breakage; hides the builder and allows direct textarea editing
- **"Validate compose"** - Validates compose syntax/structure via `/api/compose/validate`
- Completion is blocked while the builder reports errors; manual editing bypasses the builder guard and still uses compose validation. The Complete buttons are guarded against double submission.
- Completing shows `#appCfgProgress` with a staged progress bar (prepare/build/validate/save/test), jumps to 100%, then closes the modal after a short delay on success. Failures hide the bar and restore the buttons.
- If validation errors occur on save, UI shows issues and prompts to fix or save anyway
- If core nginx-proxy not created, shows notice with option to create it: *"The core nginx service has not been created. Create it to automatically direct your domains to your containers."*
- Actions for new apps: **Save to library** (save stopped) or **Test launch (stops after test)** (start, report container states, stop). Actions when editing an existing app: **Save configuration** or **Save and deploy**.
- Missing required fields (like `VIRTUAL_HOST`/`VIRTUAL_PORT` when nginx-proxy running) are highlighted in red
- Existing `VIRTUAL_HOST`/`VIRTUAL_PORT` values from docker run or compose are prefilled into the form; form values override, duplicates are stripped, and clearing the field explicitly clears them. The initial vhost value is retained across missing-resource retries so a clear is not lost.
- When nginx-proxy hints are applied, a routed service with `VIRTUAL_HOST` loses its published `ports` and keeps only the matching `VIRTUAL_PORT` (first displayed port, then `expose`, then `PORT`, then 80). Finalize and Deploy reapply the same rule server-side, so a manually pasted compose cannot leave host ports or a mismatched `VIRTUAL_PORT` behind.
- For docker-run creation the form port list is authoritative; changing it replaces command ports and clearing it removes them. `--network bridge` keeps published ports; host/none/container network modes drop ports.
- Missing input networks are shown in `#appCfgNetworkNotice`; the user must choose an existing network or create it. Arbitrary networks are never silently created.
- Form networks `host`, `none`, `bridge`, `default`, `container:*`, and `service:*` are rejected by finalize; use `network_mode` in the compose file for those modes.
- Missing bind-mount host paths are shown in `#appCfgVolumeNotice`; the user must choose an existing absolute path or explicitly create the directory. Protected system paths are blocked when creating missing paths; existing protected paths such as `/var/run/docker.sock` remain selectable.
- The compose is validated both alone and together with the generated override before finalize; unresolved networks/volumes and port conflicts block creation unless the user chooses to save anyway.
- Explicitly empty compose input is rejected with `Compose file is empty`.

### Apps
- Lists all apps from `data/registry.json`
- Each app managed from `apps/<name>/` via docker compose
- Actions: **Deploy** (opens the visual compose builder for the app's base config), **Stop**, **Browse** (when source exists), and **Remove**. Deploy is the only way to start or redeploy an app. Imported apps show **Configure & Deploy** instead of **Deploy**.
- Apps with a saved `referenceUrl` show an **Official repository / website** link under the app summary.
- Deploy saves the edited compose as the new base `docker-compose.yml` (or the app's existing compose filename), removes the generated `docker-compose.wickedafdok.yml` override, re-adds the `wicked` default network and prior `VIRTUAL_HOST`/`VIRTUAL_PORT` when needed, and can save only or save and deploy. When nginx-proxy is installed it also re-applies the routing policy: the routed service joins the default network, `VIRTUAL_PORT` is filled from the container port when missing, and published host ports are removed. It loads the visual builder from `/api/apps/:id/compose`; the response surfaces the saved routing env from the generated override in the editable base compose and includes parsed network/vhost data and issues, but missing networks/volumes are reported as guidance because this route edits the base compose directly.
- Deploy resolves duplicate `container_name` conflicts by renaming the stale non-core container to `<name>-previous-<shortid>`; conflicts with protected core services abort with `409`. Before renaming, the API returns `409 needsAmendApproval` with an `amendments` list, and the UI shows `#amendApprovalModal` so the user can review every affected instance (including `this app` vs `other instance`) and approve or cancel. Approval resubmits with `confirmAmend: true`.
- A first start that reports failure while project containers already exist is returned as `launchPending` instead of a failure so slow builds are not misreported
- UI element: `#tab-apps`, `#appsList`, `#appsRefresh`

### App Library
- Export/import uses the `wickedafdok.library/v1` schema (`kind: wickedafdok-app-library`). The archive contains `dok-library.json` plus `apps/<name>/...`.
- `POST /api/library/export` accepts `{ apps: [ids], name }` and returns a `.tar.gz` attachment. Apps are stripped of installation-specific data: `container_name`, `VIRTUAL_HOST`/`VIRTUAL_PORT`/`ENABLE_AUTH`/`LETSENCRYPT_*`, published host ports, absolute bind sources (except `/var/run/docker.sock`, `/etc/localtime`, `/etc/timezone`), top-level `name`, external network names (except the shared `wicked` network), external/name fields on named volumes, generated `docker-compose.wickedafdok.yml`, `.env*` (except `.env.example`), `.git`, `node_modules`, and the app's root `data` directory. Requirements metadata is sanitized the same way.
- `POST /api/library/import` accepts the archive (multipart `file`), validates the manifest, and imports into `apps/<name>`. Existing non-empty apps return `409` with `needsOverwrite`; overwriting preserves the existing root `data` directory and `.env*` files and reports the reused paths through `reuseData`/`message`. Imported apps are registered with `needsConfig: true` and library metadata; the Apps UI shows **Configure & Deploy**, which opens the visual compose editor so the user can supply local domains, ports, paths, and secrets.
- `POST /api/library/import-repo` clones a git repository (`repo`, optional `branch`, `path`, `name`, `description`, `overwrite`) and reuses the same importer. A repository with `dok-library.json` imports its apps; one with only a compose file or Dockerfile becomes a single app. Conflicts return `409 needsOverwrite`. Shared helpers: `libraryManifestFromDirectory()`, `importLibraryTree()`, `synthesizeLibraryFromRepository()`.
- `referenceUrl` is written into `dok-library.json` and restored on import. Importing a repository uses the cloned repository URL as the default reference for apps that do not carry their own link.
- UI: `#libraryExportBtn`, `#libraryImportFile`, `#libraryImportRepoBtn`, `#libraryRepoModal`, `#libraryRepoUrl`, `#libraryRepoBranch`, `#libraryRepoPath`, `#libraryRepoName`, `#libraryRepoDo`, `#libraryExportModal`, `#libraryExportList`, `#libraryExportDo`.

### Projects / Sources
- Browse and edit files under `sources/` directory
- Auto-detect presence of compose files or Dockerfiles
- Deploy from Projects goes through App Creation flow
- UI element: `#tab-sources`

### Dok Settings

Settings is split into four subtabs: **Core Services**, **Dok Settings**, **Logs**, and **Maintenance**. Backups and updates moved into the Maintenance container; the old backups pane is kept in the DOM but hidden and its API routes remain for backward compatibility. Dok Settings contains the app's own management options: Default settings, Designer, Groups, and registry connections.

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

**User manual and field help:**
- `public/js/manual.js` renders the in-app manual from `MANUAL_GROUPS`/`MANUAL`, opens `#manualModal`, and wires the Settings header **User manual** button plus every `[data-open-manual]` section button.
- The manual covers every section (dashboard, containers, images, app creation, apps/library, sources, terminal/OpenCode, core services, Dok settings, logs, backups, troubleshooting) and includes a field reference.
- Top-level tab headers, App Creation panes, Settings panes, and settings/app-creation card headings have a `?` section-help button that opens the matching manual section.
- `decorateFields()` wraps unlabeled inputs/selects/textareas in `.field-wrap` with a visible label and adds a `.field-help` `?` tooltip using `FIELD_LABEL`/`FIELD_HELP`. A MutationObserver decorates dynamically rendered fields and syncs hidden wrappers; builder/terminal controls are excluded.
- `#openManualBtn`, `[data-open-manual]`, `#manualModal`, `#manualTitle`, `#manualContent`, `#manualNav` are the main UI hooks.

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

The **Core Services** subtab manages installed bundled services. Installation now happens only in the Dok Maintenance installer; Dok hides cards whose service is not installed and never renders a create/install form. Each installed service card keeps an **Edit compose** action for manual changes, and the running WickedAFDok container is reported as a protected core service (`role: Dok`) so it appears in the Core Services group. Status endpoints return `lookupFailed` when Docker cannot be queried; each card keeps its last displayed state instead of flipping an installed service back to the create view on a transient error.

**Dok Maintenance (managed, on demand):**
- Separate privileged container `wickedafdok-maintenance` built from the same image, started by `setup.sh`, by Dok's **Settings → Maintenance** tab, or on demand when a host directory must be created. It replaces the Host Helper (its socket/token remain compatible) and is managed from `maintenance/docker-compose.yml` or the generated copy at `data/wickedafdok/maintenance/docker-compose.yml`.
- Web UI/API on port `8090` (browser entry `/?token=<data/.maintenance-token>`). API routes require the token when `MAINTENANCE_REQUIRE_TOKEN=1`; `/api/health` and static files are public. WS uses `?token=`.
- Persistent state lives beside the checkout in `<checkout>-maintenance-data` (never inside the checkout or `data/`, never exported with apps): `installation.json`, `installation-state.json`, snapshots, backups, OpenCode state, logs. The installer records the sanitized Dok installation state and takes a snapshot when Maintenance opens, after install/update/backup, and on request; reinstall restores the newest snapshot, starts Dok, and starts every installed core service.
- Installer types are **Standalone Dok** (defaults/registrations may be skipped) and **Dok with Core Services** (choose at most one option per core category; required fields are enforced). The primary domain is requested first and fills `dok.`, `auth.`, `dns.`, and `mail.` subdomains plus the `authelia@<primary>` sender; every value stays editable. Repository connections lead with the name, autofill the preset address (or custom host), and can be tested with `POST /api/registries/test` before saving. The installer writes Dok settings/registries, launches Dok from the root compose, configures selected core services through Dok's APIs (nginx-proxy, cloudflared, Authentik, Authelia, DNS, Mailpit/Stalwart, SMTP), wires Mailpit's sender explicitly, applies ACME staging, writes `data/wickedafdok/installation-compose.yml` with Dok plus every installed core service, and saves the record. Dok protection is forced off unless Authelia and nginx-proxy are both selected. OpenCode Admin is available inside Maintenance to reconcile the selected stack.
- The installer writes an integration brief under `<maintenance-data>/opencode/prompts/<installation>.md` and stores its path as `opencodePrompt`; `GET /api/install/opencode-prompt` serves it (or regenerates it). The brief contains the selected service wiring matrix, expected nginx routes, current non-secret settings, launch results, per-service integration tasks (TLS/ACME staging, Authelia notifier and sender, DNS, Mailpit/Stalwart mailboxes, tunnel routes), port checks, and verification commands. Secrets are never included.
- Built-in tools cover overview/containers, app deploy/start/stop/restart proxying, backups/snapshots/import/export, updates (git pull/build/recreate then refresh Maintenance), diagnostics/repair, logs, terminal shells, and OpenCode Admin. Admin OpenCode is rejected in the Dok container (`409`); Dok UI buttons open Maintenance instead. User-mode OpenCode remains available in Dok.
- `setup.sh` takes host ownership as before, builds `wickedafdok:latest` (set `SKIP_BUILD=1` to skip), creates `data/.maintenance-token`, creates the sibling `<checkout>-maintenance-data` store (or `MAINTENANCE_DATA_PATH`), migrates a legacy in-checkout `maintenance-data/`, starts the Maintenance compose with host checkout/socket mounts, and prints its token URL. The store is mode `700`.

**nginx-proxy (managed):**
- Only one nginx-proxy managed from Core Services UI
- States: create/edit/run when missing, management/start/stop/restart/edit when present
- Default network: `wicked`
- If domain configured for WickedAFDok in nginx settings, can trigger self-recreation to attach UI container to nginx network with `VIRTUAL_HOST`/`VIRTUAL_PORT` env vars
- Uses `jwilder/nginx-proxy` style setup
- Optional `nginxproxy/acme-companion` certificate service (`services.nginxProxy.acme = { enabled, email, staging }`) requests and renews Let's Encrypt certificates; containers opt in with `LETSENCRYPT_HOST`/`LETSENCRYPT_EMAIL`. Without it, certificates are placed manually in `core/nginx-proxy/certs`
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
- Admin password is hashed with Argon2id in-process (Node 24 `crypto.argon2`, PHC string with Authelia's defaults); older runtimes fall back to `docker run authelia/authelia:4.39 crypto hash generate argon2`. The plaintext is only shown once in the UI. The manage card also has **Apply domain**, **Sync protected apps**, **Protect containers**, and **Require login for the Dok UI**. Enabling Dok protection requires the Authelia portal domain and a Dok host that shares its cookie domain; if the sync does not generate the auth vhost, the setting is reverted and the UI reports why. User/admin saves report whether Authelia was refreshed, and say when the portal domain or admin password still has to be set
- Managed users live in `settings.services.authelia.users` with encrypted `passwordHashEnc` values and are rendered into `core/authelia/config/users.yml` together with the admin account. `GET/POST /api/core/authelia/users`, `DELETE /api/core/authelia/users/:username`, and `POST /api/core/authelia/admin` manage them; changes rewrite the file and restart Authelia only when the content changed
- The Authelia card's **Manage users** button opens `#autheliaUsersModal` (admin account, add/edit/delete local users). The **Open** button opens the portal for provider/application administration
- The auth container picker lists every running container (not just apps), disables Dok itself with a pointer to Dok protection, and disables protected core services with a note that they are managed separately

**DNS (Technitium or AdGuard Home, managed):**
- One DNS card selects the provider via `services.dns.provider` (`technitium` default, or `adguard`)
- Technitium: web port `5380`, DNS `53` (UDP/TCP), generated admin password, optional GUI domain (`services.technitium.domain`), compose in `core/dns/docker-compose.yml`
- AdGuard Home: web/setup port `3000`, DNS `53` (UDP/TCP), optional GUI domain (`services.adguard.domain`), compose in the same `core/dns/docker-compose.yml` managed as project `adguard`, state in `core/dns/work` and `core/dns/conf`. Finish its setup wizard and keep the admin UI on `3000`.
- **Apply domain** works for either provider and updates `VIRTUAL_HOST`/`VIRTUAL_PORT`
- `GET/POST /api/core/dns` and `POST /api/core/dns/run` accept/return `provider`; `POST /api/core/dns/domain` honors it

**Email / Mailpit (managed):**
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

**Host Helper (legacy, replaced by Maintenance):**
- Privileged companion container running `server/host-agent.js`
- The Maintenance container implements the same Unix socket/token contract and stops an old `wickedafdok-host-helper` when it starts. Existing Host Helper installs keep working until then.
- Socket/token stored in `data/host-helper`; compose stored in `core/host-helper/docker-compose.yml`. Dok starts Maintenance on demand when a host directory must be created.

**OpenCode (on demand, not a compose service):**
- OpenCode powers OC Assist in App Creation. The only OpenCode launch control in Dok is **App Creation → Create app with OC Assist**; the Dashboard and Settings card no longer launch OpenCode or offer Admin/User mode choices.
- Unlike the other core services it is not a container in `core/` and is excluded from Start all/Stop all; each OC Assist launch starts a User-mode PTY inside the WickedAFDok container. Closing the chat window leaves it running in the background (up to the detached grace) so the build can finish; **Stop** on the terminal ends it. Running sessions are listed in App Creation with an **Open chat** button for reattach after a failed connection or reload
- **Admin mode:** only available inside the Dok Maintenance container (cwd `/dok`, full host/Docker access). Dok rejects admin OpenCode sessions with `409`.
- **User mode:** cwd `/app/apps`, `external_directory: deny`, and a bash/read allowlist tuned for app work; Docker, system package management, privilege escalation, and WickedAFDok source paths are intended to be off limits
- Generated configs live at `data/opencode/<mode>/opencode.json`; per-mode `HOME`/XDG directories keep sessions separate, while provider login/auth and caches are shared under `data/opencode/shared`
- `OPENCODE_DISABLE_PROJECT_CONFIG=1` prevents an app-level `opencode.json` from widening mode permissions
- Optional `services.opencode` settings (model, provider, API key) preconfigure OC Assist. If provider is blank, it is inferred from the `provider/model` prefix. The key is passed as `OPENCODE_PROVIDER_API_KEY` and generated configs reference `{env:OPENCODE_PROVIDER_API_KEY}`; it is encrypted at rest in `data/settings.json` and redacted as `apiKeySet` in API responses. It can also be added interactively with `/connect`
- The Dashboard **Terminal** button opens a plain admin shell in `/app`. The terminal modal has no mode, shell, or OpenCode picker; shell sessions run as the container user and are not permission-restricted like User-mode OpenCode.

**Logs:**
- Server console output plus mutating `/api` requests are written to `data/logs/server.log` and a 2000-line in-memory ring buffer
- Logs subtab shows server logs and Docker Compose logs for apps and core services with auto-refresh and tail controls

**Backups & Updates (legacy Dok pane, hidden):**
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

### Maintenance / Installation
- `GET /api/maintenance` - Maintenance container status, token URL, port, and compose path
- `POST /api/maintenance/start|stop|mode` - Start/stop Maintenance or toggle maintenance mode (`{ active }`) and start Dok when leaving
- `GET /api/installation` / `POST /api/installation/sync` - Read or write the sanitized `data/installation-state.json` snapshot used by Maintenance
- `GET /api/install` / `POST /api/install/validate` / `POST /api/install/run` - Maintenance installer state, plan validation, and installation job (Maintenance API)
- `GET /api/install/opencode-prompt` - Serve the saved installation integration brief or regenerate it from the saved plan/settings
- `POST /api/registries/test` - Test a registry login or git host before the installer saves the connection
- `GET /api/maintenance` also backs the Settings → Maintenance card; Admin OpenCode is rejected in Dok with `409`

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

### Terminal
- `GET /api/terminal` - Terminal capabilities, OpenCode version, available modes, and sessions
- `POST /api/terminal/sessions` - Create a PTY session (`{ mode, app }`, where `app` is `shell` or `opencode`)
- `POST /api/terminal/sessions/:id/stop` - Stop one session
- `POST /api/terminal/sessions/stop-all` - Stop all sessions, optionally filtered by `app`
- `GET /api/terminal/sessions/:id/output?after=<sequence>` - Poll buffered output for the HTTP compatibility transport
- `POST /api/terminal/sessions/:id/input` - Send `data`, `cols`, and/or `rows` for the HTTP compatibility transport
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
- `POST /api/registry/:id/deploy` - Legacy one-click compose up (the UI now deploys through the compose editor); resolves duplicate container names
- `POST /api/registry/:id/:action(start|stop|restart)` - App compose lifecycle actions
- `GET /api/apps/:id/compose` - Read the app's base compose file (with saved routing env surfaced) plus network/vhost analysis, `referenceUrl`, and issues
- `POST /api/apps/:id/compose` - Save an edited compose as the new base (`deploy: true` re-deploys; `force: true` saves despite validation issues; `confirmAmend: true` approves container renames; `referenceUrl` updates or clears the saved link)
- `DELETE /api/registry/:id` - Remove from registry

### App Library
- `POST /api/library/export` - Export selected registry apps as a `wickedafdok.library/v1` `.tar.gz`
- `POST /api/library/import` - Import a library archive; returns `409 needsOverwrite` when the target app exists
- `POST /api/library/import-repo` - Clone a git repository and import its library or single app

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
1. User submits via one of the creation methods with a required app title
2. Server processes input:
   - For docker run: parsed by `runCommandToCompose()`; combined short flags such as `-dp`, `-itp`, and `-dp8080:80` are expanded, and command arguments after the image are preserved
   - For compose: stored as the app's managed compose file
   - For git/upload: files are staged under `sources/`, checked for compose/Dockerfile, then copied to `apps/<name>/`
   - If compose/Dockerfile found → copied to `apps/<name>/`, managed compose generated/retained, returns `needsConfig: true` with compose data
   - If no compose/Dockerfile → kept under `sources/`, returns `toProjects: true` or `needsConfig: false`
3. UI shows App Configuration modal with the managed compose
4. Every creator path (docker run, compose, git, upload, source, OC Assist) passes the generated compose through `standardizeAppCompose()` before analysis and saving. It removes a top-level `name:` (Dok supplies the project name with `-p`), adds the `# managed-by: wickedafdok` header, adds `restart: unless-stopped` to services that have `image`/`build` but no restart policy, and applies `normalizeComposeNetworks()`. Finalize then attaches the app to the configured Dok default network and, with nginx-proxy installed, applies `applyNginxRoutingPolicy()` to any service that carries `VIRTUAL_HOST` (including one that came from OC Assist, an import, a pasted compose, or `docker run` env). That fills the matching `VIRTUAL_PORT` from the container port and removes published host ports, so the form quick fields are not the only source of routing. The compose builder drops top-level `name` from its Other settings and never re-emits it.
5. Launch routes return analysis from `analyzeCompose()`: existing/missing external networks, missing bind sources, prefilled vhost data, and compose issues
6. On finalize (`/api/launch/finalize`) the server resolves `networkChoices`/`volumeChoices`, validates the base compose plus generated override, saves to the registry stopped, and optionally performs a test launch via docker compose in `apps/<name>/`. The test waits briefly, records each container state, and always runs `docker compose stop` before responding, so creation never leaves an app running. A renamed staged app is removed only after the final compose and registry entry are written successfully.
7. Every new app preview is staged in a hidden `apps/.preview-<name>-.../` directory, including when `apps/<name>/` does not exist yet, and is copied to the target only on finalize. This prevents finalize from mistaking its own preview for an existing app. Stale previews older than 24 hours are cleaned up. Finalizing into a non-empty existing app name returns `409` with `needsOverwrite`/`appName`; the UI asks for confirmation and resubmits with `overwrite: true`.
8. `finalizeLocks` (keyed by sanitized app name) rejects concurrent finalizes with `409 alreadyFinalizing`, and the lock is released in `finally` after the handler completes rather than when the client socket closes. Once the registry entry is written, later failures return `created: true` with the app name, so the UI closes and refreshes instead of prompting a duplicate install.
9. App persistent data is never removed or overwritten. Finalize and library import skip app-root `data/` and `.env*` when copying over an existing app, and app backup restore preserves them. Responses include `reuseData`/`dataNotice` when the new app will connect to existing data; the overwrite prompt lists the preserved data paths. Fresh data requires a new app name or data location, or manual deletion by the user.

### App Reference Links
- `detectAppReferenceUrl()` runs in every creator route and in finalize. It prefers project metadata (`package.json`, `composer.json`, `pyproject.toml`, `Cargo.toml`), README website/repository lines, compose and Dockerfile image labels (`org.opencontainers.image.source|url|documentation`, `org.label-schema.vcs-url|url`), labels on locally available images, and finally the git clone URL.
- `sanitizeAppReferenceUrl()` converts common git/SSH/scp forms to https, strips a trailing `.git`, and accepts only normal http(s) URLs without credentials or a fragment. Invalid values are rejected on finalize and on app compose save; an explicitly empty value clears the saved link.
- The detected or user-edited value is saved as `referenceUrl` in `data/registry.json`, returned by `GET /api/apps/:id/compose`, rendered as the Apps **Official repository / website** link, and written to library manifests.
- OC Assist passes a reliable official link with `server/assist-register.mjs --reference-url <url>` and is instructed to omit it rather than invent one.

### Defaults and App Data
- `defaultsDefaults()` owns `settings.defaults`; `configuredDefaults()` normalizes it, `defaultsForClient()` redacts the admin password as `adminPasswordSet`, and `defaultsPatch()` validates/saves input. `POST /api/settings/defaults` also applies the data location and syncs Authelia vhosts when Dok protection is enabled.
- `appDefaultDataDir(name)` returns `<dataLocation>/apps/<app>/data` unless `autoAppData` is false. Every new app gets this directory (mode from `dataMode`) and the path is stored as `dataPath` in the registry and returned as `appDataPath`.
- Missing relative bind sources are auto-mapped by `defaultVolumeSource()` beneath the app data directory (`<app>/data` for the `data` target, otherwise `<app>/data/<target-slug>`). Absolute/outside sources are only created when `allowOutsideData` is true; otherwise finalize returns the missing volume with an explanatory `reason`.
- `POST /api/settings/defaults/apply` re-creates the data location and `<dataLocation>/apps` through `ensureHostDirectory()` (direct or Host Helper), applying the octal mode.

### OC Assist
- `POST /api/assist/start` validates the prompt/name, rejects concurrent starts for the same app name, saves uploads under `sources/oc-assist-<stamp>-<random>/` (traversal-checked), writes a private brief at `data/opencode/assist/<stamp>-<random>/brief.md`, and starts a User-mode OpenCode session with the dedicated `assist` agent and title `OC Assist · <app>`. The random suffix keeps two requests in the same second from sharing a directory. The route waits 1.2 s after spawning OpenCode; if the process exits, it returns `502` with the captured terminal output instead of a dead session.
- The brief includes instructions, pasted data, uploaded file paths, and default admin username/email (never the password).
- The `assist` agent uses the User-mode permission model with external access limited to the app directory, `sources/oc-assist-*`, `data/opencode/assist/**`, and `server/assist-register.mjs`; Docker/system/privilege commands remain denied. The UI opens the returned session directly in the terminal modal.
- OC Assist reads `apps/AGENTS.md`, generated from `server/app-agents.md` at startup and before each assist session. The contract defines the required app layout, compose/network/routing rules, secret handling, library-export hygiene, and the rule that app persistent data is never reset, deleted, or overwritten.
- The agent registers apps through `server/assist-register.mjs --name <app> --dir /app/apps/<app>`, which posts to `/api/launch/finalize` with `overwrite: true` and no launch by default. `--test` performs a temporary launch that the server stops again; the legacy `--launch` alias maps to a test. `--confirm-amend` approves reviewed container renames.

### App Library
- `sanitizeComposeForLibrary()` parses YAML, removes installation-specific fields, rewrites published ports to their container port (including host-IP and long syntax), maps absolute bind sources to relative `./data/...` paths, preserves the shared `wicked` external network, and strips `external`/`name` from other networks and named volumes. `libraryFiles()` walks the app directory while skipping generated/runtime files, symlinks, app data, env files, `.git`, and `node_modules`.
- Export builds a temporary staging tree, writes `dok-library.json` (`schema`, `kind`, `version`, `name`, `created`, `apps`), archives it as `.tar.gz`, and streams it as an attachment. The registry is never modified.
- Import validates the schema/kind, sanitizes app names, rejects traversal, extracts to a staging directory, and copies into `apps/<name>`. It preserves existing `data/` and `.env*` on overwrite, writes library metadata to the registry, and sets `needsConfig: true`.
- Imported apps are configured and deployed through the normal App Configuration builder, which lets the user provide domains, ports, host paths, and secrets before the first deploy.

### Compose Management
- All apps use docker compose from their own directory
- Function `buildWadCompose()` generates normalized compose files
- Function `standardizeAppCompose()` applies the shared creator standard (Dok header, no top-level `name`, restart policy, normalized networks) in every launch/finalize path and before library export; the builder omits top-level `name`
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
- `createTerminalSession()` spawns `$SHELL -i` (falling back to `bash`, then `sh`) or the resolved OpenCode binary with `node-pty`; sessions are kept in an in-memory `terminalSessions` map and exist only until stopped, exited and reaped, or the server shuts down
- Limits: 8 concurrent sessions, a 2 MiB rolling replay buffer per session, and a 30-minute idle cleanup for shells after the last client disconnects (OpenCode uses the detached grace below); output is streamed to attached WebSocket clients and the rolling buffer is replayed on connect (the UI resets xterm before applying it). The replay buffer stores `{ seq, data }` chunks so the HTTP transport can resume after a cursor
- A detached shell session is reaped after the 30-minute idle window. A detached OpenCode session is kept for one hour (`TERMINAL_OPENCODE_DETACHED_MS`) so an OC Assist build finishes even when the chat never attaches, the tab is backgrounded long enough to pause polling, or the user closes the chat window. The session count is capped and exited sessions are reaped, so this stays bounded. HTTP polls update `lastClientAt`, so an attached polling session is not treated as abandoned. The cleanup timer reschedules itself instead of checking once; when the session limit is reached, the oldest clientless session is evicted instead of rejecting the new one
- The WebSocket upgrade at `/api/terminal/ws` validates the `Origin` host against `X-Forwarded-Host`, `X-Original-Host`, and `Host` when an origin is present, so a proxy that rewrites `Host` still works; unknown session IDs get `404`
- If the WebSocket closes before opening (a proxy that strips `Upgrade`, or an origin rejection), the browser switches immediately to `GET /api/terminal/sessions/:id/output` polling plus `POST /api/terminal/sessions/:id/input`, shows a compatibility-mode notice, and keeps the session alive through `lastClientAt`. The HTTP path is intentionally simple: 25 ms input batching, 25 ms polling while draining output, and a 350 ms idle poll
- Server-side protocol pings run every 25 s to keep proxies from dropping an idle socket and to terminate clients that vanished without a close frame. The browser reconnects WebSocket sessions with backoff, rechecks that the session still exists, and does not reset its retry budget until a socket has stayed open for 10 s, so a proxy that accepts and instantly drops upgrades falls back to HTTP instead of looping forever. A socket that opens but never sends the `ready` frame also falls back to HTTP after 8 s. HTTP polling keeps retrying with a capped backoff after repeated failures instead of permanently giving up, and reattaches automatically when the server returns
- `POST /api/terminal/sessions/:id/stop` kills the PTY (with a `SIGKILL` fallback) and closes clients. Closing a shell terminal stops it; closing an OC Assist chat leaves OpenCode running so the build can finish, and the running session stays available under App Creation. Escape closes the modal only when focus is outside the terminal, so OpenCode can use Escape for its own dialogs without killing the session.
- OpenCode configs are generated on every launch from `opencodeConfigForMode()`, which sets the default agent, optional model/provider, and the Admin or User permission model. `writePrivateFile()` keeps them at mode `600`
- OpenCode launches use `OPENCODE_CONFIG_CONTENT` (the generated mode config, which outranks config files), `OPENCODE_CONFIG`, `OPENCODE_DISABLE_PROJECT_CONFIG=1`, `OPENCODE_DISABLE_AUTOUPDATE=1`, per-mode `HOME`/`XDG_*`, and `OPENCODE_PROVIDER_API_KEY` when a key is configured. Inherited `OPENCODE_*` variables are removed from all managed sessions so a host/desktop instance cannot leak its config or session id into the container terminal. `PORT`/`HOST` are also removed so an app dev server started by the agent cannot bind Dok's listen port; `WICKEDAFDOK_PORT` carries the real port for `assist-register.mjs`.
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
- Self-update requires a writable persistent application code checkout. The default image bakes source into `/app` and runs as non-root in common deployments, so an in-app update is lost on container recreation unless `/app` (with `node_modules`) is bind-mounted; otherwise update on the host with `git pull` and rebuild via `./start.sh`. Dok and Maintenance run git with `-c safe.directory=<checkout dir>`, so a checkout owned by the host user does not fail with Git's `detected dubious ownership` error.
- Service secrets in `data/settings.json` (cloudflared token, Authentik and Authelia passwords/keys, Technitium admin password, SMTP password, OpenCode API key) are AES-256-GCM encrypted with `data/.credentials-key`. `readSettings()` decrypts for internal use, `writeSettings()` encrypts, and API responses redact values while exposing `*Set` flags. Legacy plaintext values are encrypted on the first start. Registry and git connection secrets use the same key; losing that key makes the stored secrets unrecoverable (delete and re-enter them).
- OpenCode is installed during the Docker image build. Existing deployments must rebuild the image to add it, and the build needs network access to `opencode.ai`/GitHub releases. Set `OPENCODE_BIN` to use a local binary during development.
- User mode is a permission guardrail for the AI agent, not an OS sandbox. It runs as the same container user as Admin mode, so a determined command can still reach files or binaries the Unix user can access. Shell sessions are not restricted at all. Use a separate container/user for hard isolation.
- The browser terminal and OpenCode sessions are protected only by the same (currently absent) authentication as the rest of the UI. Anyone who can reach the UI can open an Admin shell; keep it behind a trusted network or authenticated reverse proxy. WebSocket upgrades at `/api/terminal/ws` are preferred; when a proxy blocks them, the HTTP compatibility transport keeps the session usable at the cost of higher request overhead.
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
- Dashboard: `#dashboardTerminalBtn`, `#dashboardCoreLinks`, `#dashboardCoreRefresh`
- Terminal Modal: `#terminalModal`, `#terminalContainer`, `#terminalStopBtn`, `#terminalStatus`, `#terminalSessionLabel`
- OpenCode Card: `#coreOpencodeCard`, `#opencodeStatus`, `#opencodeSessions`, `#opencodeStopBtn`, `#opencodeModel`, `#opencodeProvider`, `#opencodeApiKey`, `#opencodeSaveSettings`
- App Creation: `#runCreateBtn`, `#composeCreateBtn`, `#gitCloneBtn`, `#uploadBtn`, OC Assist (`#assistPrompt`, `#assistData`, `#assistName`, `#assistFiles`, `#assistFolder`, `#assistStartBtn`, `#assistOutput`, `#assistSessions`, `#assistSessionsList`)
- App Config Modal: `#appConfigModal`, `#appCfgBuilder`, `#appCfgCompose`, `#appCfgEditCompose`, `#appCfgValidate`, `#appCfgReferenceUrl`, `#appCfgReferenceLink`, `#appCfgComplete`, `#appCfgCompleteRun`, `#appCfgProgress`
- Notices: `#appCfgNetworkNotice`, `#appCfgVolumeNotice`, `#appCreationNginxNotice`, `#appCreationNginxNoticeModal`
- Modals: `#composeEditWarningModal`, `#composeSaveConfirmModal`, `#appOverwriteModal`, `#amendApprovalModal`, `#libraryExportModal`, `#manualModal`, `#authContainersModal`, `#autheliaUsersModal`, `#designerModal`
- Apps List: `#appsList`, `#appsRefresh`, `#libraryExportBtn`, `#libraryImportFile`, `#libraryExportList`, `#libraryExportDo`
- Manual: `#openManualBtn`, `[data-open-manual]`, `#manualTitle`, `#manualContent`, `#manualNav`
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
- Show the **Official repository or website** field above the builder, keep its **Open reference** link in sync as it is edited, and save or clear the value with the app.
- With nginx-proxy installed, the routed service must use `VIRTUAL_HOST` + `VIRTUAL_PORT` and no published host ports; keep the service on the Dok default network.
- Open the builder with the generated compose, let the user approve or adjust it, then save to the app library with one-click deploy/redeploy.



##-------------------------------------Tasks-----------------------------------

# Do these tasks 1 at a time and focus on the single task at hand. Do a task, push to github, Update AGENTS.md and remove the task, inform the user that you are ready to start the next task.

- App Creator methods should examine any given repository links for information on configuration to create the best possible compose file

- App Library: Add an option to deploy without saving. That way it will keep the base config.
