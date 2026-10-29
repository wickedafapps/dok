# OC Assist App Library Contract

This file is managed by Dok. Every app created by OC Assist and every app added to the Dok App Library must follow these rules. The goal is a consistent, portable, functional app that is ready to launch after the user supplies installation-specific configuration in Dok's compose editor.

## Required outcome

- The app title is required. Use it for the app folder and compose project.
- Save the app to the library in a complete, validated, ready-to-launch state, but stopped. Never leave containers running.
- The user configures routing, ports, paths, and secrets in Dok's compose editor before the real deploy from Apps. Do not claim the app is running or reachable.
- A test launch is allowed only to verify the app starts. Dok stops it again before reporting the result.
- Record the app's official repository or website when one is available, so users can review upstream configuration and documentation from the Apps tab.

## Official reference

- If the user supplies a repository or project website, treat it as the primary reference and use it to identify the official upstream project.
- Prefer the official source repository, homepage, or documentation site. Do not use a fork, mirror, unrelated tutorial, or random third-party page as the official reference.
- Use upstream metadata such as `package.json`, `composer.json`, `pyproject.toml`, `Cargo.toml`, `Dockerfile` image labels, and the project README to confirm the official repository or website.
- Pass the link to publishing with `--reference-url <url>`. Omit the flag when no reliable official link is available; never invent one.
- The link is configuration guidance only. It does not replace the README, `.env.example`, and GUI-port documentation inside the app.

## Required layout

```
apps/<app-name>/
  docker-compose.yml      # required; compose.yaml is accepted but prefer docker-compose.yml
  .env.example            # required when the app needs configuration
  README.md               # recommended: setup, ports, data, and credentials
  <app files>             # source, config templates, scripts, etc.
  data/                   # runtime only; never commit source or secrets here
```

- One app per `apps/<app-name>/` directory.
- Use a lowercase slug: letters, numbers, dots, underscores, and hyphens; start with a letter or number.
- The primary compose service should use the same name as the app when practical.
- Do not create `docker-compose.wickedafdok.yml`; Dok generates it.
- Do not add a top-level compose `name:`; Dok supplies the project name.
- Do not depend on files outside the app directory except shared Docker resources explicitly documented in the README.

## Compose requirements

- Every service must have an `image` or `build` definition. Pin image tags; avoid `latest` for anything that stores data or exposes an API.
- Set `restart: unless-stopped` on long-running services unless the app explicitly requires something else.
- Use `depends_on` with health or start ordering where startup order matters.
- Prefer a healthcheck for the primary service when the image provides a probe.
- Use `init: true` when the image does not handle signals and child processes well.
- Do not publish host ports in library apps. Expose container ports and always set `VIRTUAL_PORT` to the app's GUI container port on the primary GUI service. Host ports are installation-specific and are stripped from library exports. When nginx-proxy is installed, Dok removes published `ports` from the routed service and uses the app's `VIRTUAL_PORT`, so the app is reachable only through nginx.
- Join the Dok default network (normally `wicked`, exposed as Compose's external `default` network) for every service that must be reachable by nginx-proxy or another Dok service. Dok enforces this at save time.
- Always write `VIRTUAL_PORT` even when no `VIRTUAL_HOST` was supplied, so Dok can route the app later without guessing. When `VIRTUAL_HOST` is present, both variables must be set together on the same service. Do not also publish host `ports` for that service.
- Do not declare arbitrary external networks. Use the default app network, or the shared `wicked` network when the app must be reachable by nginx-proxy or another Dok service.
- Do not use `container_name` to claim a global Docker name unless it is required and documented. Dok can rename conflicting containers.
- Do not use `network_mode: host`, `privileged: true`, or mount `/var/run/docker.sock` unless the app cannot work any other way. Document the reason and the security impact in the README.
- Keep the compose file free of machine-specific absolute paths, host ports, local domains, and generated certificate paths.

## Routing and core service integration

Set these environment variables on the primary GUI service:

- `VIRTUAL_PORT=<gui-container-port>` - required for every app with a web GUI, even when no domain is supplied
- `VIRTUAL_HOST=<hostname>` - only when the user supplied a domain or asked for routing
- `ENABLE_AUTH=true` only when Authelia forward-auth is wanted
- `LETSENCRYPT_HOST=<hostname>` and `LETSENCRYPT_EMAIL=<email>` only when acme-companion manages certificates

Rules:

- Always set `VIRTUAL_PORT` to the app's actual GUI/listening container port. Do not leave it out and do not rely on Dok's inference.
- Determine the GUI port from the supplied repository or reference URL by reading its README, compose files, Dockerfile `EXPOSE` lines, image documentation, and default configuration. If the reference is unavailable or ambiguous, ask the user rather than guessing.
- For multi-service or multi-port apps, use the public web UI port. Do not use a database, queue, metrics, worker, or internal API port.
- `VIRTUAL_HOST` and `LETSENCRYPT_HOST` must be literal host names, not wildcard or regex patterns.
- `VIRTUAL_PORT` may be set without `VIRTUAL_HOST`; it prepares the app for routing. Never set `VIRTUAL_HOST` without a matching `VIRTUAL_PORT`.
- `VIRTUAL_PORT` is the container port, never the published host port.
- Remove published host `ports` from the routed service; nginx-proxy reaches it through the shared network, so the app GUI must not depend on a host port.
- Keep the routed service on the Dok default network (normally `wicked`, exposed as Compose's external `default` network) so nginx-proxy can reach it.
- Do not invent domains. Ask the user when a hostname is required, or omit only `VIRTUAL_HOST` and let them configure routing after import.
- Do not enable Authelia or Let's Encrypt without the user asking for it.
- Keep routing variables on the single primary GUI service, not every service.

## Persistent data

App data is user data. It survives updates, redeploys, app-file overwrites, exports, and normal app removal.

- Store persistent state in a bind mount at `./data` (or a clearly named subdirectory such as `./data/db`). Dok maps missing app data into the configured app data location.
- Use relative app-local bind sources. Never use absolute host paths in a library app.
- Never delete, truncate, recreate, chmod, chown, or mass-migrate `data/` from an entrypoint, init script, install script, or first-run seed when it already contains user data.
- Seed defaults only when the target is missing or empty. Preserve existing files and database files.
- Do not store source code, caches, `node_modules`, backups, or secrets inside `data/`.
- Do not use named volumes with `external: true` or installation-specific `name:` values. Named volumes may be used for caches that are safe to lose, but user data must survive a fresh container.
- If a requested app targets an existing data directory, tell the user the app will connect to the existing data and that it was not reset. Do not overwrite it.
- If the user wants fresh data, tell them to use a new app name or data location, or to delete the existing data manually first. Do not delete it for them.
- Never add cleanup steps that remove volumes, data directories, or database contents as part of deploy, update, or repair.

## Configuration and secrets

- Put configuration in environment variables with safe defaults: `${VAR:-default}`.
- Provide `.env.example` with placeholders and descriptions. Never put real credentials, tokens, keys, or passwords in it.
- Do not commit `.env`, certificates, private keys, database dumps, or generated credentials.
- Never print secrets in chat or logs.
- If a generated credential is required, generate it at runtime and store it in `data/` or the app's configuration path with restrictive permissions.
- Document required user-supplied values and safe defaults in the README.

## Library hygiene

Apps must be portable between Dok installations.

- No installation-specific domains, published host ports, container names, absolute bind paths, external network names, or generated compose overrides.
- No `data/` contents, `.env` files, `.git`, `node_modules`, logs, caches, or backups in a library export.
- Keep images and files reasonably small; do not bundle large binaries when an official image exists.
- Include a README covering purpose, required configuration, ports, persistent paths, first-run behavior, upgrade notes, and any elevated permissions.
- Keep the app runnable on the shared `wicked` network and with the default Dok app data location.

## Publish and verify

1. Create the app files under `apps/<app-name>/` using the required app title.
2. Validate the compose file and resolve missing networks, paths, ports, and required environment values. Make the app functional and ready to launch once the user supplies installation-specific settings.
3. Publish with the command in the OC Assist brief, adding `--reference-url <url>` when the official repository or website is known. Publishing saves the app to the library **stopped**.
4. `--test` is optional. It starts the app briefly so you can verify it, then the server stops it again and returns the container states. Never leave an app running.
5. The user applies routing, ports, paths, and secrets in the Dok compose editor and deploys from the Apps tab. Do not claim the app is deployed or reachable yet.
6. If publishing reports existing app data, explain that the app will reuse it; do not attempt to reset it.
7. If publishing asks for amendment approval, summarize every affected container and ask before approving.
8. Report the app title, the files and compose that were created, the required configuration, and that the user must open Apps → Deploy to configure and deploy it.

## Pre-publish checklist

- [ ] `apps/<app-name>/docker-compose.yml` exists and uses the app name.
- [ ] Every service has an image or build context and a restart policy.
- [ ] User data is under relative `./data` paths and is never reset automatically.
- [ ] No real secrets, `.env`, `data/` contents, absolute paths, or host ports are included.
- [ ] The primary GUI service sets `VIRTUAL_PORT` to the GUI container port, even when no domain was supplied.
- [ ] Any `VIRTUAL_HOST` or `LETSENCRYPT_HOST` is literal and paired with the correct container-port `VIRTUAL_PORT`.
- [ ] `.env.example` and README explain required values, the GUI port, and persistent paths.
- [ ] The official repository or website is passed with `--reference-url` when one was found; no link is invented.
- [ ] The compose file validates and the app can be configured through the Dok compose builder.
