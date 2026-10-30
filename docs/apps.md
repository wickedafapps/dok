# Apps, App Creation, and App Library

Load this file for app creation, the compose builder, deployed apps, app library export/import, OC Assist, app data, and compose management.

## App Creation

The unified way to deploy applications. Every app is stored in `apps/<name>/` with its own `docker-compose.yml` and managed as a compose project.

**Creation Methods:**

Every creation method requires an app title; the API rejects creator requests without one. Apps are always saved to the library **stopped**; users configure and deploy them from the Apps tab.

Every creation method also detects the app's official repository or website when one is available and prefills it into the compose editor. The link is stored as `referenceUrl` in `data/registry.json`, shown in Apps for configuration reference, and carried through library export/import.

Created and saved composes join the app network selected in the single **App network** field, which defaults to the configured Dok default (normally `wicked`, written as an external Compose `default` network). The modal also has a separate **Create a network** box; `wicked` and the configured default are auto-created during save/deploy if missing. When deploying, Dok also recreates the saved app network and falls back any other missing external network reference to the saved app network. When nginx-proxy is installed, a routed app must carry `VIRTUAL_HOST` and the matching container-port `VIRTUAL_PORT` on the same service; Dok always adds `VIRTUAL_PORT` automatically (explicit form value, then an existing `VIRTUAL_PORT`, then the first published/`expose` container port, then `PORT`, then 80). Finalize resolves routing from the form quick fields **or** from a `VIRTUAL_HOST` already present in the compose (OC Assist, imported, pasted, or `docker run` env), so a host name is never saved without its port. Because nginx reaches the container over the shared network, published host `ports` are removed from the routed service so the app GUI is served through nginx and multiple apps can use the same container port without host conflicts. The routing service is also attached to the selected app network even when it lists other networks.

1. **OC Assist** (default tab) - Describe the app in a required prompt, optionally paste data (docker run, compose, repository/page URL) and upload files. WickedAFDok writes a private brief plus the uploads under `sources/oc-assist-<stamp>-<random>/`, starts a **User-mode** OpenCode server with the dedicated `assist` agent, creates a chat session, and immediately opens the native chat modal. The assist agent is restricted to app files, the OC Assist source/brief folders, and the registration helper; it creates the compose and registers the app through `server/assist-register.mjs`. Registration saves the app stopped; an optional `--test` performs a temporary launch that the server stops again. The chat streams assistant text, reasoning, tool calls, changed files, follow-up questions, and permission requests; answers and approvals post back to OpenCode. Use `#assistPrompt`, `#assistData`, `#assistName`, `#assistFiles`, `#assistFolder`, `#assistStartBtn`, `#assistOutput`, and the `#assistSessions`/`#assistSessionsList` running-chat list with **Open chat** buttons. The start route returns the chat summary once OpenCode accepts the first prompt; if OpenCode cannot start or accept it, the UI receives the server error instead of a blank chat.
2. **Docker Run** - Paste a `docker run` command. WickedAFDok parses and converts it to a normalized compose file. Opens App Configuration modal.
3. **Docker Compose** - Paste `docker-compose.yml`/`compose.yaml` content. Stored in the app's own managed compose file and opened in App Configuration modal.
4. **Git Clone** - Provide any git URL (generic git, not limited to GitHub API). If repo contains `docker-compose.yml`/`compose.yaml` or `Dockerfile`, files are copied to `apps/<name>` and opened in App Configuration modal; Dockerfile-only projects get a generated compose file. If no compose/Dockerfile found, routed to **Projects**.
5. **Local Upload** - Upload files/folders via multipart form. If compose or Dockerfile present, files are copied to `apps/<name>` and opened in App Configuration modal; Dockerfile-only uploads get a generated compose file. Otherwise routed to **Projects**.

**Repository Inspection:**

- Git clones, uploads, Projects deployments, and repository imports search the root and common subdirectories (`docker/`, `deploy/`, `deployment/`, `compose/`, `.docker/`) for compose files and Dockerfiles, skipping tests, examples, docs, dependencies, and build output. A selected import subfolder becomes the project root.
- A nested compose file is moved to the app root and its relative build contexts, `env_file`, bind-mount sources, `extends` files, include paths, and config/secret files are rewritten so they still point inside the copied app directory. Block-style and common inline YAML forms are supported.
- A project with several equally likely compose files or Dockerfiles (for example a monorepo of sample apps) stays in Projects rather than guessing; open the desired app folder and create it from there.
- Dockerfile-only repositories get a compose file with the correct build context and Dockerfile path. Its `EXPOSE` ports are written as `expose`; `VOLUME` paths are mapped under `./data`; and README `docker run` or compose examples supply additional container ports. If exactly one TCP port is found, the generated compose sets `VIRTUAL_PORT`.
- Nested `Dockerfile`/`Containerfile` files are used with the repository root as the build context; root `Containerfile`, `dockerfile`, and `containerfile` names are also supported.

**App Configuration Modal:**

- Opens with a visual Compose builder (`#appCfgBuilder`) populated from the managed compose via `/api/compose/parse`
- **Official repository or website** (`#appCfgReferenceUrl`) is prefilled by the creator when a reliable link is found and can be edited or cleared; `#appCfgReferenceLink` opens the current value. It is saved with the app and shown in Apps; non-http(s) values are rejected.
- Builder model shape: `{ services: [{ name, fields: [{ key, type, value, required? }] }], networks: [{ key, external, name, driver, extra? }], volumes: [...], other?: string }`
- The only network control in the visual builder is the app-level **App network** `<select>` (`#appCfgNetwork`) plus the **Create a network** input/button (`#appCfgNewNetwork`/`#appCfgCreateNetwork`). Service `networks` and top-level Networks definitions are hidden from the visual controls but remain in the model and raw compose; `network_mode` stays available under Additional settings for host/none/container use. The selected app network is written to the managed external `default` network.
- Services, named volumes, and top-level settings are editable as fields; `+ Add service`, `+ Add field`, and `+ Add volume` add fields, while `−` removes them
- The service field type dropdown covers common Compose keys; unknown parsed keys appear as custom JSON fields. Advanced structures are preserved in raw/JSON fields (`depends_on` conditions, network aliases/options, long ports/volumes, multiline commands, `extra_hosts`, unknown top-level keys). Device mappings use one short `/dev/host:target[:permissions]` line per device in the editor but are written to the compose as long `source`/`target`/`permissions` mappings, and the obsolete top-level `version:` key is omitted.
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
- Missing app networks are shown in `#appCfgNetworkNotice`; create the network from `#appCfgNewNetwork`/`#appCfgCreateNetwork` or select an existing one. `wicked` and the configured default network are auto-created; other arbitrary networks are never silently created.
- App networks `host`, `none`, `bridge`, `default`, `container:*`, and `service:*` are rejected by finalize; use `network_mode` in the compose file for those modes.
- Missing bind-mount host paths are shown in `#appCfgVolumeNotice`; the user must choose an existing absolute path or explicitly create the directory. Protected system paths are blocked when creating missing paths; existing protected paths such as `/var/run/docker.sock` remain selectable.
- The compose is validated both alone and together with the generated override before finalize; unresolved networks/volumes and port conflicts block creation unless the user chooses to save anyway.
- Explicitly empty compose input is rejected with `Compose file is empty`.

## Apps

- Lists all apps from `data/registry.json`
- Each app managed from `apps/<name>/` via docker compose
- Actions: **Deploy** (opens the visual compose builder for the app's base config), **Stop**, **Browse** (when source exists), and **Remove**. Deploy is the only way to start or redeploy an app. Imported apps show **Configure & Deploy** instead of **Deploy**.
- Apps with a saved `referenceUrl` show an **Official repository / website** link under the app summary.
- Deploy saves the edited compose as the new base `docker-compose.yml` (or the app's existing compose filename), removes the generated `docker-compose.wickedafdok.yml` override, points the managed external `default` network at the selected **App network**, re-adds prior `VIRTUAL_HOST`/`VIRTUAL_PORT` when needed, and can save only or save and deploy. When nginx-proxy is installed it also re-applies the routing policy: the routed service joins the selected app network, `VIRTUAL_PORT` is filled from the container port when missing, and published host ports are removed. It loads the visual builder from `/api/apps/:id/compose`; the response surfaces the saved routing env from the generated override in the editable base compose and includes parsed network/vhost data and issues. Saving accepts `network`; `wicked` and the configured default are auto-created, while another missing network returns `missingNetworks` so the UI can ask the user to create or select one.
- Deploy resolves duplicate `container_name` conflicts by renaming the stale non-core container to `<name>-previous-<shortid>`; conflicts with protected core services abort with `409`. Before renaming, the API returns `409 needsAmendApproval` with an `amendments` list, and the UI shows `#amendApprovalModal` so the user can review every affected instance (including `this app` vs `other instance`) and approve or cancel. Approval resubmits with `confirmAmend: true`.
- A first start that reports failure while project containers already exist is returned as `launchPending` instead of a failure so slow builds are not misreported
- UI element: `#tab-apps`, `#appsList`, `#appsRefresh`

## App Library

- Export/import uses the `wickedafdok.library/v1` schema (`kind: wickedafdok-app-library`). The archive contains `dok-library.json` plus `apps/<name>/...`.
- `POST /api/library/export` accepts `{ apps: [ids], name }` and returns a `.tar.gz` attachment. Apps are stripped of installation-specific data: `container_name`, `VIRTUAL_HOST`/`VIRTUAL_PORT`/`ENABLE_AUTH`/`LETSENCRYPT_*`, published host ports, absolute bind sources (except `/var/run/docker.sock`, `/etc/localtime`, `/etc/timezone`), top-level `name`, external network names (except the shared `wicked` network), external/name fields on named volumes, generated `docker-compose.wickedafdok.yml`, `.env*` (except `.env.example`), `.git`, `node_modules`, and the app's root `data` directory. Requirements metadata is sanitized the same way.
- `POST /api/library/import` accepts the archive (multipart `file`), validates the manifest, and imports into `apps/<name>`. Existing non-empty apps return `409` with `needsOverwrite`; overwriting preserves the existing root `data` directory and `.env*` files and reports the reused paths through `reuseData`/`message`. Imported apps are registered with `needsConfig: true` and library metadata; the Apps UI shows **Configure & Deploy**, which opens the visual compose editor so the user can supply local domains, ports, paths, and secrets.
- `POST /api/library/import-repo` clones a git repository (`repo`, optional `branch`, `path`, `name`, `description`, `overwrite`) and reuses the same importer. A repository with `dok-library.json` imports its apps; otherwise a single compose file or Dockerfile becomes one app using the same repository inspection as the other creators (nested compose relocation and Dockerfile-generated compose). `path` selects both a library root and a single-app subfolder. Conflicts return `409 needsOverwrite`. Shared helpers: `libraryManifestFromDirectory()`, `importLibraryTree()`, `synthesizeLibraryFromRepository()`.
- `referenceUrl` is written into `dok-library.json` and restored on import. Importing a repository uses the cloned repository URL as the default reference for apps that do not carry their own link.
- UI: `#libraryExportBtn`, `#libraryImportFile`, `#libraryImportRepoBtn`, `#libraryRepoModal`, `#libraryRepoUrl`, `#libraryRepoBranch`, `#libraryRepoPath`, `#libraryRepoName`, `#libraryRepoDo`, `#libraryExportModal`, `#libraryExportList`, `#libraryExportDo`.

## App Creation Flow

1. User submits via one of the creation methods with a required app title
2. Server processes input:
   - For docker run: parsed by `runCommandToCompose()`; combined short flags such as `-dp`, `-itp`, and `-dp8080:80` are expanded, command arguments after the image are preserved, and `--device` mappings are written in Compose long syntax
   - For compose: stored as the app's managed compose file
   - For git/upload/source: files are staged under `sources/`, checked for compose/Dockerfile in the root and common project subdirectories, then copied to `apps/<name>/`
   - If compose/Dockerfile found → copied to `apps/<name>/`, managed compose generated/retained, returns `needsConfig: true` with compose data
   - Nested compose files are relocated to the app root with project-relative paths rewritten; Dockerfile-only projects get a compose generated from the Dockerfile and README configuration
   - If no compose/Dockerfile → kept under `sources/`, returns `toProjects: true` or `needsConfig: false`
3. UI shows App Configuration modal with the managed compose
4. Every creator path (docker run, compose, git, upload, source, OC Assist) passes the generated compose through `standardizeAppCompose()` before analysis and saving. It removes an obsolete top-level `version:` and a top-level `name:` (Dok supplies the project name with `-p`), rewrites short `/dev/...` device entries as long `source`/`target`/`permissions` mappings, adds the `# managed-by: wickedafdok` header, adds `restart: unless-stopped` to services that have `image`/`build` but no restart policy, and applies `normalizeComposeNetworks()`. Finalize then attaches the app to the selected app network (configured default by default) and, when deploying, recreates missing managed networks. With nginx-proxy installed it applies `applyNginxRoutingPolicy()` to any service that carries `VIRTUAL_HOST` (including one that came from OC Assist, an import, a pasted compose, or `docker run` env). That fills the matching `VIRTUAL_PORT` from the container port and removes published host ports, so the form quick fields are not the only source of routing. The compose builder drops top-level `name` and `version` from its Other settings and never re-emits them.
5. Launch routes return analysis from `analyzeCompose()`: existing/missing external networks, missing bind sources, prefilled vhost data, and compose issues
6. On finalize (`/api/launch/finalize`) the server resolves `networkChoices`/`volumeChoices`, validates the base compose plus generated override, saves to the registry stopped, and optionally performs a test launch via docker compose in `apps/<name>/`. The test waits briefly, records each container state, and always runs `docker compose stop` before responding, so creation never leaves an app running. A renamed staged app is removed only after the final compose and registry entry are written successfully.
7. Every new app preview is staged in a hidden `apps/.preview-<name>-.../` directory, including when `apps/<name>/` does not exist yet, and is copied to the target only on finalize. This prevents finalize from mistaking its own preview for an existing app. Stale previews older than 24 hours are cleaned up. Finalizing into a non-empty existing app name returns `409` with `needsOverwrite`/`appName`; the UI asks for confirmation and resubmits with `overwrite: true`.
8. `finalizeLocks` (keyed by sanitized app name) rejects concurrent finalizes with `409 alreadyFinalizing`, and the lock is released in `finally` after the handler completes rather than when the client socket closes. Once the registry entry is written, later failures return `created: true` with the app name, so the UI closes and refreshes instead of prompting a duplicate install.
9. App persistent data is never removed or overwritten. Finalize and library import skip app-root `data/` and `.env*` when copying over an existing app, and app backup restore preserves them. Responses include `reuseData`/`dataNotice` when the new app will connect to existing data; the overwrite prompt lists the preserved data paths. Fresh data requires a new app name or data location, or manual deletion by the user.

## App Reference Links

- `detectAppReferenceUrl()` runs in every creator route and in finalize. It prefers project metadata (`package.json`, `composer.json`, `pyproject.toml`, `Cargo.toml`), README website/repository lines, compose and Dockerfile image labels (`org.opencontainers.image.source|url|documentation`, `org.label-schema.vcs-url|url`), labels on locally available images, and finally the git clone URL.
- `sanitizeAppReferenceUrl()` converts common git/SSH/scp forms to https, strips a trailing `.git`, and accepts only normal http(s) URLs without credentials or a fragment. Invalid values are rejected on finalize and on app compose save; an explicitly empty value clears the saved link.
- The detected or user-edited value is saved as `referenceUrl` in `data/registry.json`, returned by `GET /api/apps/:id/compose`, rendered as the Apps **Official repository / website** link, and written to library manifests.
- OC Assist passes a reliable official link with `server/assist-register.mjs --reference-url <url>` and is instructed to omit it rather than invent one.

## Defaults and App Data

- `defaultsDefaults()` owns `settings.defaults`; `configuredDefaults()` normalizes it, `defaultsForClient()` redacts the admin password as `adminPasswordSet`, and `defaultsPatch()` validates/saves input. `POST /api/settings/defaults` also applies the data location and syncs Authelia vhosts when Dok protection is enabled.
- `appDefaultDataDir(name)` returns `<dataLocation>/apps/<app>/data` unless `autoAppData` is false. Every new app gets this directory (mode from `dataMode`) and the path is stored as `dataPath` in the registry and returned as `appDataPath`.
- Missing relative bind sources are auto-mapped by `defaultVolumeSource()` beneath the app data directory (`<app>/data` for the `data` target, otherwise `<app>/data/<target-slug>`). Absolute/outside sources are only created when `allowOutsideData` is true; otherwise finalize returns the missing volume with an explanatory `reason`.
- `POST /api/settings/defaults/apply` re-creates the data location and `<dataLocation>/apps` through `ensureHostDirectory()` (direct or Host Helper), applying the octal mode.

## OC Assist

- `POST /api/assist/start` validates the prompt/name, rejects concurrent starts for the same app name, saves uploads under `sources/oc-assist-<stamp>-<random>/` (traversal-checked), writes a private brief at `data/opencode/assist/<stamp>-<random>/brief.md`, starts the shared User-mode OpenCode `serve` process, creates a chat session with the dedicated `assist` agent and title `OC Assist · <app>`, and queues the first prompt. The random suffix keeps two requests in the same second from sharing a directory. It returns `{ chat, appName, briefPath, uploadDir }`; server or prompt failures return `502` with the OpenCode detail instead of a dead session.
- The brief includes instructions, pasted data, uploaded file paths, and default admin username/email (never the password).
- The `assist` agent uses the User-mode permission model with external access limited to the app directory, `sources/oc-assist-*`, `data/opencode/assist/**`, and `server/assist-register.mjs`; Docker/system/privilege commands remain denied. The UI opens the returned chat directly in `#assistChatModal`.
- Chat data comes from the local OpenCode HTTP API, not a PTY: `GET /api/assist/chats/:id` returns the session status plus compact messages, pending questions, and permission requests, and restarts the OpenCode server if it exited. The browser polls faster while OpenCode is busy and slower when idle. `POST /api/assist/chats/:id/prompt` sends a follow-up, `abort` cancels the current run, `stop` aborts and removes the chat, and the `question`, `question/reject`, and `permission` routes answer pending requests.
- Closing the chat modal stops polling but leaves the chat and OpenCode running so a build can finish. The chat stays in `GET /api/assist/chats` and can be reopened from App Creation. The shared server stops after 30 minutes with no busy chats; `POST /api/core/opencode/stop` stops every chat and server immediately.
- OC Assist reads `apps/AGENTS.md`, generated from `server/app-agents.md` at startup and before each assist session. The contract defines the required app layout, compose/network/routing rules, secret handling, library-export hygiene, and the rule that app persistent data is never reset, deleted, or overwritten.
- The agent registers apps through `server/assist-register.mjs --name <app> --dir /app/apps/<app>`, which posts to `/api/launch/finalize` with `overwrite: true` and no launch by default. `--test` performs a temporary launch that the server stops again; the legacy `--launch` alias maps to a test. `--confirm-amend` approves reviewed container renames.

## App Library implementation

- `sanitizeComposeForLibrary()` parses YAML, removes installation-specific fields, rewrites published ports to their container port (including host-IP and long syntax), maps absolute bind sources to relative `./data/...` paths, preserves the shared `wicked` external network, and strips `external`/`name` from other networks and named volumes. `libraryFiles()` walks the app directory while skipping generated/runtime files, symlinks, app data, env files, `.git`, and `node_modules`.
- Export builds a temporary staging tree, writes `dok-library.json` (`schema`, `kind`, `version`, `name`, `created`, `apps`), archives it as `.tar.gz`, and streams it as an attachment. The registry is never modified.
- Import validates the schema/kind, sanitizes app names, rejects traversal, extracts to a staging directory, and copies into `apps/<name>`. It preserves existing `data/` and `.env*` on overwrite, writes library metadata to the registry, and sets `needsConfig: true`.
- Imported apps are configured and deployed through the normal App Configuration builder, which lets the user provide domains, ports, host paths, and secrets before the first deploy.

## Compose Management

- All apps use docker compose from their own directory
- Function `buildWadCompose()` generates normalized compose files
- Function `standardizeAppCompose()` applies the shared creator standard (Dok header, no top-level `name`/`version`, long-syntax `/dev` device mappings, restart policy, normalized networks) in every launch/finalize path and before library export; the builder omits top-level `name` and `version`
- Function `runCommandToCompose()` converts docker run commands to compose format; converts `--device` to long-syntax `source`/`target`/`permissions` entries; normalizes duplicate `VIRTUAL_HOST`/`VIRTUAL_PORT`; retains ports with `--network bridge` and drops them for host/none/container modes. Boolean flags honor explicit `=false` values for `--privileged`, `--init`, `--read-only`, `--no-healthcheck`, `-i`/`--interactive`, and `-t`/`--tty`; `-i`/`-t` map to `stdin_open`/`tty`, and `--rm` is reported as unsupported.
- `findProjectComposeFile()`, `findProjectDockerfile()`, `relocateProjectComposeText()`, and `projectDockerfileCompose()` implement repository inspection for git, upload, source, and repository-import creators. The app directory always receives a root `docker-compose.yml` so deploy, routing, and the compose builder keep using one managed file.
- `analyzeCompose()` uses `docker compose config --format json`; `analyzeComposeConfig()` inspects a parsed model
- `buildComposeOverride()` adds selected networks, network mappings, vhost changes, extra ports, and volume replacements
- Missing input networks can be resolved with `networkChoices` (`__create__` or an existing name); `wicked` and the configured default are auto-created, while arbitrary networks still require an explicit create/select. Missing bind sources require `volumeChoices` (`source` plus optional `create`)
- Replacing a missing bind source preserves its read-only flag (`:ro`); sources containing `:` or CR/LF/NUL are rejected for short volume syntax
- The app network is sent as `network` by the compose editor; `wicked` and the configured default network are auto-created if missing. `#appCfgCreateNetwork` reads `#appCfgNewNetwork`, creates and selects the network, and the app-level select is refreshed on modal open. Other input networks require the user to create or select one.
- Compose validation via `/api/compose/validate`; final combined validation also checks port conflicts and unresolved networks/volumes
- Compose builder parsing uses `docker compose config --format json` when available and a block-YAML subset reader when not; building normalizes the field model to YAML and validates conflicts server-side
- Compose input explicitly provided as empty is rejected with `Compose file is empty`
- `setMountSource()` rewrites bind-mount sources in place for managed composes. It decodes quoted YAML scalars and `$$` Compose escapes, normalizes the volume mode, and re-emits canonical short-syntax volumes, so repeated status/sync passes are byte-for-byte idempotent instead of growing the file

## Compose Builder Requirements

- Display every compose setting as editable fields populated from the source.
- Use a wide two-column modal: raw compose preview on the left and visual fields on the right, with the preview updating live.
- Keep a stable section order per service: Service, Image, Container Name, Restart Policy, Command, Entrypoint, Ports, Environment, Volumes, then Additional settings. Service network lists and top-level network definitions stay hidden because the app-level network selector manages them; `network_mode` remains available under Additional settings.
- Render multi-value sections as individual rows with add/remove controls: ports, environment key/value pairs, and service volumes.
- Put all unknown/custom keys in the Additional settings section with the field-type dropdown (common Compose keys plus scalar/raw JSON).
- Show the named-volume definitions in its own group after the services. Top-level network definitions remain in the model/compose but are hidden from the visual controls.
- Allow adding/removing services, fields, and volumes without editing raw YAML.
- Provide one **App network** select defaulting to `wicked`, plus a separate create-network input/button; refresh the select after creating a network.
- Auto-add required fields (for example `image` when there is no build) and mark them required until filled.
- Highlight conflicts and invalid values in red, including duplicate service/container names, duplicate published ports, invalid ports, and invalid JSON.
- Regenerate the compose from the field model for every change and validate server-side.
- Remove the old quick port/domain fields above the raw compose; derive finalize ports and `VIRTUAL_HOST`/`VIRTUAL_PORT` from the builder model.
- Show the **Official repository or website** field above the builder, keep its **Open reference** link in sync as it is edited, and save or clear the value with the app.
- With nginx-proxy installed, the routed service must use `VIRTUAL_HOST` + `VIRTUAL_PORT` and no published host ports; keep the service on the Dok default network.
- Open the builder with the generated compose, let the user approve or adjust it, then save to the app library with one-click deploy/redeploy.
