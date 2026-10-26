# WickedAFDok

Self-hosted server & Docker management UI running in a container with access to `/var/run/docker.sock`.

## Quick Start

Prepare permissions once (and again after changing the repo owner or Docker socket):

```bash
sudo ./setup.sh
```

This creates the runtime directories and `wicked` network, gives the container access to the Docker socket, and writes `docker-compose.override.yml` so the container runs with the invoking sudo user's UID/GID plus the socket group. It also takes ownership of the whole checkout and normalizes permissions (`755` directories, `644` files, `755` for scripts, `600` for runtime state, logs, backups, and managed compose files). Use `sudo ./setup.sh --root` to keep the container running as root, or pass `--uid`/`--gid` explicitly. If setup adds your host user to the Docker group, log out and back in before running `./start.sh`. The root compose file expects the `wicked` network to exist; `setup.sh` and `start.sh` both create it when missing.

Then start WickedAFDok:

```bash
./start.sh
```

Or with docker compose:

```bash
docker compose up -d --build
```

The Compose project name is pinned to the existing internal identifier `wickedafdok`, so the checkout directory does not matter (a clone in `Dok/` still uses that project). Run Compose commands from the checkout without `-p dok`.

Open `http://localhost:8080`. The UI has no built-in login — put it behind a reverse proxy if exposed. The optional Authelia core service protects apps behind nginx-proxy; it does not gate the WickedAFDok UI itself.

## Highlights

- Manage containers, images, apps, compose stacks, and core services from one UI. The Containers tab splits protected **Core Services** from workloads and has an **Apps interface** button.
- Use **Quick Deploy** for one-click app redeploys (duplicate container names are renamed safely) or **Alter State** to edit an app's compose file and save it as the new base configuration.
- Customize the installation from **Settings → Dok Settings → Designer**: logo, name, tagline, CSS override, and direct editing of nginx-proxy error pages and configuration files.
- Open a browser terminal from the dashboard, or launch OpenCode in Admin or User mode without any setup. OpenCode starts on demand and stops when you close the terminal.
- Give the Authentik and Technitium DNS web consoles their own domain; WickedAFDok writes the `VIRTUAL_HOST`/`VIRTUAL_PORT` reverse-proxy entries and can apply the change to an existing service.
- Add Authelia forward auth to any app: launch the auth service, pick containers from the window that opens, and WickedAFDok recreates them with `ENABLE_AUTH=true` or patches their compose file. Authelia runs alongside Authentik, not instead of it.
- Create full, single-app, or custom backups. Custom backups can mix data, apps, core services, sources, and logs, and optionally include only selected apps or core services.
- Store encrypted credentials for Docker Hub, GHCR, GitLab, Quay, and other registries in **Settings → Dok Settings**, and use them automatically for pulls and compose launches.
- App creation shows a live progress bar and closes the configuration window when the app is created.

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
3. Open **Settings → Backups & Updates**, enter the repository URL, for example `https://github.com/wickedafapps/dok.git`, and the branch (`main`), then click **Update & Restart**.
4. In Docker, WickedAFDok pulls the checkout, rebuilds its image from the updated source, and recreates the container with that image. The included compose file mounts the host checkout at `/app/host-source`, so the pull updates the host files and survives container recreation. If your container was created before that mount existed, run `git pull && ./start.sh` once on the host before using the in-app updater; this updates the checkout and recreates the container with the new mount.
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

The **Terminal** button on the dashboard opens a shell in the WickedAFDok container. The **OpenCode** button opens the same terminal with the OpenCode AI coding agent already running. The terminal is also available from Settings → Core Services → OpenCode.

OpenCode has two permission modes:

- **Admin mode** starts in `/app` with full access. Use it for maintenance, troubleshooting, Docker work, and changing WickedAFDok itself.
- **User mode** starts in `/app/apps` with app-only file access and a restricted set of shell commands. Use it to create apps and get basic help. OpenCode's Docker, system package installation, privilege escalation, and WickedAFDok source access are blocked by its permission rules.

The Terminal button and **Apps shell** button open a normal shell as the container user. Those shells are not permission-restricted; the two modes above apply to OpenCode.

OpenCode is preconfigured, so launching it needs no input. If you want a specific provider and model, expand **Model and provider** on the OpenCode card, enter a model such as `anthropic/claude-sonnet-4-5` and an API key, then save. The provider is inferred from the model prefix, or you can set it explicitly. You can also run `/connect` inside OpenCode and complete the provider login there. Provider credentials and session state are stored under `data/opencode` and are shared between modes; generated mode configs are stored in `data/opencode/<mode>`.

Closing the terminal stops the session. OpenCode is intentionally not part of **Start all/Stop all**, because it is a launch-on-demand tool rather than a long-running service.

If WickedAFDok is behind a reverse proxy, that proxy must forward WebSocket upgrades for `/api/terminal/ws`; otherwise the terminal and OpenCode cannot connect.

> User mode is a guardrail for the agent, not a hard security boundary: OpenCode runs as the same container user as Admin mode. Keep the UI behind a trusted network or an authenticated reverse proxy, since an Admin shell has full container and Docker access.

If a custom `docker-compose.override.yml` already exists, `setup.sh` leaves it alone and prints the `user`/`group_add` values to merge. Re-run `./start.sh` after setup to recreate the container with the new permissions.

Adding nginx and letting WickedAFDok recreate itself keeps Docker access: the generated compose preserves the container user, `group_add`, and `privileged`, and the recreation helper adds the live socket GID before `docker compose up`. If an older deployment still loses access after adding nginx or after a Docker/host update, the container user is probably missing the socket's current group. Run `sudo ./setup.sh` and then `./start.sh` on the host. `setup.sh` refreshes the compose override, and `start.sh` also injects the live socket GID on every start; the server log shows the socket owner, process UID/GID, and supplementary groups when Docker is unreachable.

If app creation reports `permission denied` while creating app or host directories, re-run `sudo ./setup.sh` so the checkout and runtime directories are owned by the container user. Missing bind-mount paths can only be created where that UID/GID has write access; otherwise launch the optional Host Helper from Settings → Core Services, or create the directory on the host with matching permissions.

Git clone and update verify TLS certificates by default. For a trusted self-hosted git server with a self-signed certificate only, set `WICKEDAFDOK_GIT_INSECURE=1` in the container environment. The in-app git updater also requires the application code directory to be writable by the container user; non-root deployments from the read-only image cannot self-update.
