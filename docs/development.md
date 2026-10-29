# Development and Testing

Load this file before changing code, running verification, or testing Docker-in-Docker.

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

## Docker-in-Docker Testing

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
