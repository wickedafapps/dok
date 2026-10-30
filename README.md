# WickedAFDok

Self-hosted server & Docker management UI running in a container with access to `/var/run/docker.sock`.

## Quick Start

Prepare permissions once (and again after changing the repo owner or Docker socket):

```bash
sudo ./setup.sh
```

This creates the runtime directories and `wicked` network, gives the container access to the Docker socket, and writes `docker-compose.override.yml` so the container runs with the invoking sudo user's UID/GID plus the socket group. It also takes ownership of the whole checkout, normalizes permissions (`755` directories, `644` files, `755` for scripts, `600` for runtime state, logs, backups, and managed compose files), builds `wickedafdok:latest`, creates a temporary Maintenance store beside the checkout (`<checkout>-maintenance-data`), and starts the privileged **Dok Maintenance** container. Pass `--maintenance-data /absolute/path` or set `MAINTENANCE_DATA_PATH` to keep that store elsewhere before installation; a legacy in-checkout `maintenance-data/` is moved automatically. The installer requires a persistent data location and moves Dok's data and the Maintenance store into `<data location>/Dok` (Maintenance data at `<data location>/Dok/maintenance`). Use `sudo ./setup.sh --root` to keep the containers running as root, or pass `--uid`/`--gid` explicitly. If setup adds your host user to the Docker group, log out and back in before running `./start.sh`. The root compose file expects the `wicked` network to exist; `setup.sh` and `start.sh` both create it when missing.

Setup prints a Maintenance URL with its token, for example `http://localhost:8090/?token=...`. Opening that link unlocks Maintenance immediately (the server also stores the token in a cookie). When no previous Dok installation is detected, Maintenance opens in **Installation mode** and hides the other tools until the installation is complete. Installation requires a persistent data location; new installs use a `Dok` folder inside it, while older installs that stored `data/`, `apps/`, `core/`, and `sources/` directly in the selected location are detected and keep using that folder without moving user data. If a previous installation is found, the installer lists the settings, apps, app data, and services it detected and asks whether to reuse or replace the existing settings. The app library, app directories, persistent app data, sources, uploads, and backups are never overwritten, and a safety snapshot is saved before any change. The installer writes the Dok configuration, launches Dok, verifies the container, API, HTML UI, stored settings, app library, Docker access, and installation state, and optionally installs selected core services. For an existing installation, start Dok normally:

```bash
./start.sh
```

Or with docker compose:

```bash
docker compose up -d --build
```

The Compose project name is pinned to the existing internal identifier `wickedafdok`, so the checkout directory does not matter (a clone in `Dok/` still uses that project). Run Compose commands from the checkout without `-p dok`.

Open `http://localhost:8080`. The UI has no built-in login — put it behind a reverse proxy if exposed. The optional Authelia core service protects apps behind nginx-proxy; it does not gate the WickedAFDok UI itself.

Reopen Maintenance from **Settings → Maintenance** for installs, updates, backups, repairs, diagnostics, or maintenance mode. Before installation its data lives beside the checkout in `<checkout>-maintenance-data`, outside the checkout and `data/`. After installation it moves into the persistent data location at `<data location>/Dok/maintenance`, so it survives a damaged or replaced Dok installation.

## Highlights

- Manage containers, images, apps, compose stacks, and core services from one UI. The Containers tab splits protected **Core Services** from workloads and has an **Apps interface** button.
- Create apps with **OC Assist** (default) or import a docker run command, compose file, git repository, or upload. Every app requires an app title and is saved to the library stopped. App creators and repository imports inspect compose files and Dockerfiles in the root and common deployment folders, relocate nested compose paths, and build Dockerfile-only apps from exposed ports, volumes, and README run examples. Repositories with several equally likely apps stay in Projects for manual selection. Each creator also detects the app's official repository or website when available and prefills it in the compose editor for configuration reference. Use **Apps → Deploy** to review the compose, configure routing, ports, paths, and secrets, then save or save and deploy. Deploy is the only way to start or redeploy an app; duplicate container names are renamed safely after approval.
- Apps join the network selected in the single **App network** field, which defaults to Dok's configured default network (normally `wicked`). The compose editor also has a separate create-network box; `wicked` and the configured default are auto-created when missing. When nginx-proxy is installed, the editor and server keep `VIRTUAL_HOST` and the matching container `VIRTUAL_PORT` paired, remove published host ports from the routed service, and attach it to the selected app network so every app GUI is served through nginx without port collisions.
- Customize the installation from **Settings → Dok Settings → Designer**: logo, name, tagline, CSS override, and direct editing of nginx-proxy error pages and configuration files.
- Install, update, back up, repair, and recover the whole installation from the on-demand **Dok Maintenance** container. It keeps an exact installation record and snapshots in `<data location>/Dok/maintenance` after installation (or in `<checkout>-maintenance-data` / `MAINTENANCE_DATA_PATH` before it), runs Admin OpenCode, and replaces the old Host Helper.
- Build apps in a native in-browser OpenCode chat with **OC Assist**, or open a plain terminal from the dashboard. Admin OpenCode runs from Dok Maintenance, where the host checkout and repair tools live. OC Assist starts on demand, keeps running when you close the chat so the build can finish, and stops after it has been idle.
- Give the Authentik, Technitium, or AdGuard Home web consoles their own domain; WickedAFDok writes the `VIRTUAL_HOST`/`VIRTUAL_PORT` reverse-proxy entries and can apply the change to an existing service.
- Request and renew Let's Encrypt certificates automatically with the optional `nginxproxy/acme-companion` service, or place certificates manually.
- Send outgoing mail through any SMTP provider, capture it locally with Mailpit, or run a full Stalwart mail server from the Email card.
- Import app libraries from a local archive or directly from a git repository, including single compose/Dockerfile projects.
- Add Authelia forward auth to any app: launch the auth service, pick containers from the window that opens, and WickedAFDok recreates them with `ENABLE_AUTH=true` or patches their compose file. Authelia runs alongside Authentik, not instead of it.
- Create full backups and exact installation snapshots in Dok Maintenance. The legacy Dok backup pane still supports single-app and custom scopes for compatibility. Snapshots restore the saved install without re-entering settings.
- Store encrypted credentials for Docker Hub, GHCR, GitLab, Quay, and other registries in **Settings → Dok Settings**, and use them automatically for pulls and compose launches.
- App creation shows a live progress bar and closes the configuration window when the app is saved. A creation-time test launch starts the app only to verify it and stops it again; nothing stays running until you deploy from Apps.
- Apps created or imported into the library are complete and ready to launch, but must be configured in the compose editor before launch. The editor adds routing, auth, and certificate fields from the installed core services.
- Persistent app data is never overwritten or deleted by app creation, library import, or app backup restore. Existing data is reused with a notice; fresh data requires a new app name or data location, or manual deletion first.
- OC Assist follows `apps/AGENTS.md`, a generated app-library contract covering layout, compose, routing, secrets, persistent-data rules, and the stopped/ready-to-configure library state.

## Dok Maintenance

Dok Maintenance is a separate privileged container that runs only when you launch it: from `setup.sh` for installation, from **Settings → Maintenance**, or on demand when a host directory must be created. It replaces the old Host Helper.

- **Installation** asks for the primary domain first, then autofills the Dok, authentication, DNS, and mail subdomains plus an `authelia@<primary>` notification sender; every suggested value remains editable. It offers **Standalone Dok** (skip optional settings and registry connections if you want) and **Dok with Core Services** (pick at most one option per category, then supply the required accounts and secrets). Repository connections lead with the registry or git name, autofill the address from a preset, and can be tested in place before the installer saves them. The installer writes Dok's settings, registries, and compose files, launches Dok, configures and wires the selected services (including the Mailpit notifier sender and optional ACME staging), and writes an installation-specific OpenCode brief that documents the chosen domains, expected container wiring, service settings, launch results, per-service integration tasks, and verification commands. **Configure with OpenCode** opens that brief in an Admin session when the install finishes. If host port 80 is already in use, nginx-proxy automatically moves to an alternative port (starting at 8081) and the resulting Dok URL includes it.
- **Backups and snapshots** are stored in `<data location>/Dok/maintenance` after installation (or `<checkout>-maintenance-data` / `MAINTENANCE_DATA_PATH` before it) with an installation record that is refreshed whenever Dok settings, apps, registries, or services change. Restoring re-creates the saved install without asking for the same information again.
- **Updates** pull the checkout, rebuild the image, and recreate Dok; **Diagnostics and repair** check Docker access, directories, settings, encryption keys, networks, and containers; **Terminal** and **OpenCode Admin** provide full host/Docker access for troubleshooting.
- Apps created by Dok are labeled `dok.managed=true`, `dok.created-by=dok`, `dok.app=<name>`, and `dok.installation=<id>` so Maintenance can find every instance. App persistent data is never reset, deleted, or overwritten by Maintenance restores.
- The browser entry is `http://localhost:8090/?token=...`; the token is in `<data location>/Dok/data/.maintenance-token` after installation (or the checkout's `data/.maintenance-token` before it) and is printed by `setup.sh`. Keep the maintenance store (`<data location>/Dok/maintenance`) and `.maintenance-token` private and include them in host-level backups.

## Dok Settings: Designer, groups, and registry connections

**Settings → Dok Settings** holds the app's own management options:

- **Designer** changes the logo, name, tagline, and CSS override, and opens the nginx-proxy files under `core/nginx-proxy` for editing. Bundled `html/404.html`, `html/403.html`, and `html/errors/50x.html` pages are mounted into nginx-proxy and used for custom error responses; edit them in Designer and restart nginx-proxy. Uploaded logos are stored in `data/designer/`; private key files are not exposed.
- **Container Groups** groups running containers for easier management. Groups are stored in `data/groups.json`. The **Core Services** group is built in and computed from the running core containers, so it cannot be edited or deleted.
- **Registry connections** stores credentials for container registries and git hosts. Presets cover Docker Hub, GitHub Container Registry (`ghcr.io`), GitLab Container Registry, Quay.io, GitHub, GitLab, Gitea/Forgejo, and custom hosts.

Secrets are encrypted at rest in `data/registries.json` and `data/settings.json` with a key in `data/.credentials-key`. Keep that file with your data backups; without it, stored secrets cannot be decrypted and must be re-entered. The API returns only whether a secret is set, never the secret itself. A blank secret field keeps the existing value; use `clearSecrets` when you want to remove one.

WickedAFDok applies credentials automatically:

- `docker pull` and `docker compose` commands use a generated Docker auth config at `data/docker-config`, so matching private images pull without extra flags.
- HTTPS git clone and update operations use a matching **Git host** connection. SSH remotes continue to use the container user's SSH keys.
- **Test** validates a connection. Registry tests use a temporary Docker login; GitHub and GitLab tests call their user APIs with the stored token.

For GitHub source updates, a fine-grained personal access token with **Contents: Read** is enough. Use `x-access-token` as the username when the token is a GitHub PAT. Add **Contents: Read and write** only if you want to push from inside WickedAFDok.

For GitHub Container Registry (`ghcr.io`), use your GitHub username and a token with package read access (`read:packages`). A classic PAT is the simplest option for GHCR; fine-grained tokens need the package permissions enabled for the owning account or organization.

## Managing WickedAFDok from GitHub

WickedAFDok can self-update from any git remote. To manage the app through a GitHub repository:

1. Create a repository (private is fine) and push this checkout to it. The default branch is usually `main`.
2. Decide how the app will authenticate:
   - **HTTPS + token (recommended):** create a fine-grained PAT for the repository with **Contents: Read**, then add a **Git host** connection for `github.com` in Dok Settings. Add **Contents: Read and write** only if the same token will also push commits; WickedAFDok itself only pulls.
   - **SSH deploy key:** add a read-only deploy key to the repository and mount the matching private key for the container user. No Dok Settings git connection is needed.
3. Open **Settings → Maintenance → Updates**, enter the repository URL, for example `https://github.com/wickedafapps/dok.git`, and the branch (`main`), then click **Update & Restart**.
4. In Docker, WickedAFDok pulls the checkout, rebuilds its image from the updated source, and recreates the container with that image. The included compose file mounts the host checkout at `/app/host-source` from the absolute `DOK_SOURCE_PATH` set by `start.sh`, so the pull updates the host files and survives container recreation. If Docker shows an empty `/app/host-source` or a source of `/dok-source`, run `sudo ./setup.sh` once from the checkout; this repairs the mount and recreates Dok. Then retry the update.
5. Running from a source checkout without Docker pulls the code and reports that a restart is required. Restart the server process to apply it.

The repository URL and branch are remembered after the first successful update. The updater refuses to overwrite uncommitted local changes unless you confirm the overwrite in the UI.

Before updating, check:

- The repository URL and default branch.
- For a PAT: the token is entered in Dok Settings, never in a URL.
- For SSH: a deploy key is added to the repository and the private key is available to the container user.
- The source checkout is writable by the container user (the included compose uses root inside the container).
- Docker access is available if you want the in-app updater to rebuild and recreate the container.

The included `.gitignore` keeps `data/`, `apps/`, `core/`, `sources/`, `uploads/`, and `node_modules/` out of the repository. A first push looks like this:

```bash
cd Dok
git init -b main
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/<account>/dok.git
git push -u origin main
```

## Protect apps with Authelia

Settings → Core Services has an **Authentication (Authelia)** card next to Authentik. Authentik provides an SSO portal and application providers; Authelia gates individual apps with nginx forward auth:

1. Put TLS certificates in `core/nginx-proxy/certs/`: one `<domain>.crt`/`<domain>.key` pair for the Authelia portal and one for each protected host. Authelia only works over HTTPS (it rejects insecure redirects and marks its session cookies Secure), and nginx-proxy will not answer TLS for a host without a matching certificate.
2. Launch nginx-proxy from Core Services (ports 80 and 443), if it is not already running.
3. Launch Authelia with a portal domain such as `auth.example.com` and an admin user. Leave the password blank to generate one; the generated password is shown once in the result message.
4. Launch Authelia and choose containers in the picker window that opens. WickedAFDok recreates the selected containers with `ENABLE_AUTH=true`; compose-managed apps are patched in their own compose file. You can also add `ENABLE_AUTH=true`, a `VIRTUAL_HOST`, and `VIRTUAL_PORT` (if the app does not listen on port 80) manually in the app's compose file. Authentik is an SSO portal for apps that support it; the `ENABLE_AUTH` forward-auth vhosts are generated by Authelia.
5. WickedAFDok notices the app within a minute and writes the nginx config. Use **Sync protected apps** on the Authelia card to apply it immediately.

Unauthenticated requests to a protected host are redirected to the Authelia portal and returned to the app after sign-in. Authenticated requests are proxied with `Remote-User`, `Remote-Groups`, `Remote-Name`, and `Remote-Email` headers, so apps that support header auth can trust the signed-in user. Removing `ENABLE_AUTH` or stopping the app removes its protection on the next sync.

The Authelia card also lists the protected hosts, allows changing the portal domain, and exposes the managed compose for editing. Runtime config lives in `core/authelia/config` and the compose in `core/authelia/docker-compose.yml`.

The session cookie is scoped to the shared parent domain (for example `example.com`), so keep the portal and protected apps under the same parent and always reach them over HTTPS. Apps under an unrelated parent are skipped (the sync result names them) because the portal cannot set a cookie for them.

WickedAFDok generates `core/authelia/config/configuration.yml` and `users.yml` from the portal domain, the protected hosts, and the Email card's SMTP settings. The periodic sync leaves manual edits alone unless one of those inputs changes; **Launch Authelia** and **Apply domain** regenerate the files, so put persistent customizations in the managed compose or back up those files first.

## Email notifications

Settings → Core Services has an **Email** card. It controls outgoing mail for Authelia (password resets and alerts) and can run Mailpit, a local capture sink.

- **Mailpit** (recommended first step): click **Use Mailpit**. Dok launches one small container (`axllent/mailpit`), publishes SMTP on `1025` and the web UI on `8025`, and points Authelia at `mailpit:1025`. Messages are captured, not delivered, so open the Mailpit UI to read them. It is a testing tool, not a mailbox server, and it cannot receive internet mail.
- **Real delivery**: enter your provider's SMTP host, port, TLS mode, username, password, and a From address, then **Save SMTP**. Authelia's `notifier.smtp` is regenerated from these settings, and the container restarts only when the config actually changed. The password is encrypted in `data/settings.json`; leaving the field blank keeps the saved one.

Other containers reach Mailpit at `mailpit:1025` on the `wicked` network; the published ports are for host tools and the browser. Set a GUI domain on the Mailpit block to serve its UI through nginx-proxy, or leave it on the LAN.

Running a real mail server for your own mailboxes needs inbound port 25, a static IP, and reverse DNS, which most residential connections do not provide. Use a hosted mailbox provider for real inboxes and keep Mailpit for testing; Dok's SMTP settings work the same either way.

## Browser terminal and OpenCode

The **Terminal** button on the dashboard opens a shell in the WickedAFDok container. **OC Assist** in App Creation opens a native chat with a User-mode OpenCode session. The chat shows the assistant's replies, reasoning, tool calls, changed files, follow-up questions, and permission requests.

OpenCode has two permission modes, split across the two containers:

- **User mode** runs in Dok, starts in `/app/apps`, and has app-only file access plus a restricted set of shell commands. Use it to create apps and get basic help. Docker, system package installation, privilege escalation, and WickedAFDok source access are blocked by its permission rules.
- **Admin mode** runs only in Dok Maintenance, starts in `/dok`, and has full host and Docker access. Dok rejects Admin sessions with `409`; its Admin buttons open Maintenance instead. Use Admin mode for updates, repairs, and changing WickedAFDok itself.

The Terminal button and **Apps shell** button open a normal shell as the container user. Those shells are not permission-restricted; the two OpenCode modes above are.

OpenCode is preconfigured, so starting OC Assist needs no input. Set a model and API key in Dok Maintenance's OpenCode card, or run `/connect` inside an Admin session. Provider credentials and User-mode sessions are stored under `data/opencode`; Admin sessions and provider state used by Maintenance live under `<maintenance-data>/opencode`.

Closing a shell terminal stops it. Closing an OC Assist chat leaves OpenCode running so the app build can finish; running chats stay listed in **App Creation** with an **Open chat** button, and **Stop chat** ends one deliberately. The shared OpenCode server stops after 30 minutes without a busy chat. OpenCode is intentionally not part of **Start all/Stop all**, because it is a launch-on-demand tool rather than a long-running service.

OC Assist uses plain HTTP polling against Dok's local OpenCode server, so the chat still works behind proxies that block WebSocket upgrades. The shell terminal normally uses a WebSocket at `/api/terminal/ws`; if a preview or reverse proxy blocks the upgrade, Dok automatically switches that session to HTTP polling. Forwarding WebSocket upgrades is still recommended because it has lower latency and less overhead.

> User mode is a guardrail for the agent, not a hard security boundary: it still runs as the Dok container user. Keep the UI and Maintenance token behind a trusted network or an authenticated reverse proxy, since an Admin shell in Maintenance has full host, container, and Docker access.

If a custom `docker-compose.override.yml` already exists, `setup.sh` leaves it alone and prints the `user`/`group_add` values to merge. Re-run `./start.sh` after setup to recreate the container with the new permissions.

Adding nginx and letting WickedAFDok recreate itself keeps Docker access: the generated compose preserves the container user, `group_add`, and `privileged`, and the recreation helper adds the live socket GID before `docker compose up`. If an older deployment still loses access after adding nginx or after a Docker/host update, the container user is probably missing the socket's current group. Run `sudo ./setup.sh` and then `./start.sh` on the host. `setup.sh` refreshes the compose override, and `start.sh` also injects the live socket GID on every start; the server log shows the socket owner, process UID/GID, and supplementary groups when Docker is unreachable.

If app creation reports `permission denied` while creating app or host directories, re-run `sudo ./setup.sh` so the checkout and runtime directories are owned by the container user. Missing bind-mount paths can only be created where that UID/GID has write access; otherwise start Dok Maintenance, which replaces the old Host Helper and can create host paths with its privileges, or create the directory on the host with matching permissions.

Git clone and update verify TLS certificates by default. For a trusted self-hosted git server with a self-signed certificate only, set `WICKEDAFDOK_GIT_INSECURE=1` in the container environment. The in-app git updater also requires the application code directory to be writable by the container user; non-root deployments from the read-only image cannot self-update. Git commands trust the checkout directory itself, so a host-owned checkout does not trigger Git's `detected dubious ownership` error inside the container.
