(() => {
  'use strict';

  const MANUAL_GROUPS = [
    { title: 'Getting started', sections: ['index', 'dashboard', 'containers', 'images'] },
    { title: 'Deploying apps', sections: ['app-creation', 'app-creation-run', 'app-creation-compose', 'app-creation-git', 'app-creation-upload', 'app-creation-assist', 'app-config-modal'] },
    { title: 'Managing apps', sections: ['apps', 'app-library', 'amendments', 'sources', 'terminal'] },
    { title: 'Core services', sections: ['settings-core', 'core-nginx', 'core-cloudflared', 'core-authentik', 'core-authelia', 'core-mail', 'core-dns', 'core-opencode', 'core-host-helper'] },
    { title: 'Dok settings', sections: ['settings-dok', 'dok-designer', 'dok-groups', 'dok-registries'] },
    { title: 'Operations', sections: ['settings-logs', 'settings-backups', 'field-reference', 'troubleshooting'] }
  ];

  const MANUAL = {
    index: {
      title: 'Dok user manual',
      html: `
        <p>Dok is a self-hosted control panel for Docker. It manages containers, images, app deployments, bundled core services, backups, and an on-demand AI coding terminal.</p>
        <p>Use the navigation on the left or the <strong>?</strong> buttons beside each section title. Every settings card also has a small <strong>?</strong> that opens the guide for that area. Hover or focus the <strong>?</strong> marker beside an individual field to read what that field does.</p>
        <h4>Main workflow</h4>
        <ol>
          <li>Create or connect a core <strong>nginx-proxy</strong> in Settings so hostnames route to containers.</li>
          <li>Create apps with <strong>OC Assist</strong>, or import a docker run command, compose file, git repository, or upload from <strong>App Creation</strong>.</li>
          <li>Every app is saved stopped. Open <strong>Apps → Deploy</strong> to configure routing, ports, paths, and secrets before deploying it.</li>
          <li>Use <strong>Apps</strong> for Deploy, Stop, Remove, and library export/import.</li>
          <li>Protect access with <strong>Authelia</strong> or publish through <strong>Cloudflare Tunnel</strong> if needed.</li>
          <li>Take regular backups from <strong>Settings → Maintenance</strong>.</li>
        </ol>
        <p class="muted">Dok has no built-in login. Anyone who can reach the UI can use the Docker socket, so expose it only behind a trusted network or an authenticated reverse proxy.</p>
      `
    },
    dashboard: {
      title: 'Dashboard',
      html: `
        <p>The Dashboard is a live health view of the Docker host and engine. Cards show CPU, memory, disk, load average, uptime, Docker engine information, and network details.</p>
        <ul>
          <li><strong>Refresh</strong> reloads statistics immediately. The view also refreshes automatically.</li>
          <li><strong>Terminal</strong> opens an admin shell inside the Dok container starting in <code>/app</code>.</li>
          <li><strong>Core Service Consoles</strong> shows an <strong>Open GUI</strong> button for each installed service that has a web interface: Authentik, Authelia, Technitium, AdGuard Home, Mailpit, and Stalwart. The button uses the configured domain when one is set, otherwise the localhost port. Stopped services are disabled until you start them.</li>
        </ul>
        <p>High disk usage usually points to images, volumes, or backups that can be removed from Images and Maintenance. High load with low CPU can indicate blocked I/O inside a container.</p>
      `
    },
    containers: {
      title: 'Containers',
      html: `
        <p>Containers lists every container and separates them into <strong>Core Services</strong> and <strong>Workloads</strong>. Core services are recognised from compose project labels and known names, and are protected against accidental removal.</p>
        <ul>
          <li><strong>Start / Stop / Restart / Pause / Unpause</strong> act immediately on the container.</li>
          <li><strong>Logs</strong> opens the tail of the container log.</li>
          <li><strong>Inspect</strong> shows the full Docker inspection data.</li>
          <li><strong>Redeploy</strong> recreates the container from its current configuration.</li>
          <li><strong>Save to apps</strong> captures a standalone container as a managed app. Core containers cannot be saved this way.</li>
          <li><strong>Remove</strong> deletes a container. Protected containers require typing the exact container name.</li>
        </ul>
        <p>Core containers are intentionally guarded. Change them through Settings → Core Services or by editing their managed compose file.</p>
      `
    },
    images: {
      title: 'Images',
      html: `
        <p>Images lists local Docker images and provides pull and removal tools.</p>
        <ul>
          <li><strong>Pull image</strong> accepts a full reference such as <code>nginx:alpine</code> or <code>ghcr.io/org/app:tag</code>. Registry credentials saved under Dok Settings are used automatically.</li>
          <li><strong>Quick run</strong> creates a container from an image reference.</li>
          <li><strong>Remove</strong> deletes an image. A running container that uses the image must be stopped or removed first.</li>
          <li>The search box filters the current image list.</li>
        </ul>
        <p>Removing old image tags is the quickest way to reclaim disk space, but keep at least the tags used by your apps.</p>
      `
    },
    'app-creation': {
      title: 'App Creation',
      html: `
        <p>App Creation is the primary way to add an application to Dok. Every option asks for a required <strong>app title</strong>, ends in the same compose configuration modal, and saves the app under <code>apps/&lt;name&gt;/</code> with its own compose project.</p>
        <h4>Creation methods</h4>
        <ul>
          <li><strong>OC Assist</strong> (default) describes the app in natural language and lets OpenCode build and register it.</li>
          <li><strong>Docker run</strong> converts a pasted command into a compose file.</li>
          <li><strong>Docker Compose</strong> accepts a compose file you paste.</li>
          <li><strong>Git Clone</strong> clones any git repository and looks for compose or Dockerfile files.</li>
          <li><strong>Local upload</strong> uploads files or a folder from your computer.</li>
        </ul>
        <p>If a git clone or upload has no compose file or Dockerfile, Dok stores it under Projects instead of creating an app. You can deploy it later from that project.</p>
        <p>Created apps join Dok&rsquo;s default network (normally <code>wicked</code>). If nginx-proxy is installed, the routed service gets a matching <code>VIRTUAL_HOST</code>/<code>VIRTUAL_PORT</code> pair, is attached to that network, and its published host ports are removed so the GUI is served through nginx.</p>
        <p>Before finalising, Dok validates the compose file, resolves networks and bind mounts, checks published ports, and asks for any missing choices. <strong>Save to library</strong> saves the app stopped. <strong>Test launch (stops after test)</strong> starts it briefly, reports the container states, and stops it again. Nothing stays running until you deploy from Apps.</p>
      `
    },
    'app-creation-run': {
      title: 'Create from docker run',
      html: `
        <p>Paste a complete <code>docker run</code> command into <strong>Docker run</strong>. Dok parses flags, image name, arguments, ports, volumes, environment variables, restart policy, and common options.</p>
        <ul>
          <li>Combined short flags such as <code>-dp8080:80</code> and <code>-it</code> are expanded.</li>
          <li>Arguments after the image are preserved as the container command.</li>
          <li>Shell operators such as pipes, redirects, and <code>&amp;&amp;</code> are rejected for safety.</li>
          <li>Host, none, and container network modes drop published ports. Bridge network mode keeps them.</li>
          <li><code>--rm</code> is not supported because Dok manages restartable app containers.</li>
        </ul>
        <p>After parsing, give the app a name and continue to the compose configuration modal. The form ports are authoritative when the app was created from docker run.</p>
      `
    },
    'app-creation-compose': {
      title: 'Create from Docker Compose',
      html: `
        <p>Paste a complete <code>docker-compose.yml</code> or <code>compose.yaml</code>. Dok stores it as the app&rsquo;s managed compose file and opens it in the visual builder.</p>
        <ul>
          <li>Compose services, networks, volumes, and unknown top-level keys are preserved.</li>
          <li>Relative bind mounts are mapped beneath the app data directory when the defaults allow it.</li>
          <li>Missing external networks and bind paths are listed before finalising.</li>
          <li>An explicitly empty compose input is rejected.</li>
        </ul>
        <p>Use <strong>Validate compose</strong> at any time. If validation reports issues you may still choose to save anyway, but the launch may fail for the same reasons.</p>
      `
    },
    'app-creation-git': {
      title: 'Create from Git',
      html: `
        <p>Enter any git URL, the required app title, and optionally a branch. Private HTTPS repositories use matching git connections saved under Dok Settings; SSH URLs use the container user&rsquo;s keys.</p>
        <ul>
          <li>If the repository contains <code>docker-compose.yml</code>, <code>compose.yaml</code>, or a <code>Dockerfile</code>, Dok copies it into <code>apps/&lt;name&gt;</code>.</li>
          <li>Dockerfile-only projects receive a generated compose file that builds the image.</li>
          <li>Repositories without either file are routed to Projects instead of becoming apps.</li>
          <li>TLS verification is on by default. <code>WICKEDAFDOK_GIT_INSECURE=1</code> is available for trusted self-signed servers.</li>
        </ul>
      `
    },
    'app-creation-upload': {
      title: 'Create from upload',
      html: `
        <p>Choose files or a folder from your computer and give the app a name. Uploads are staged in <code>uploads/</code> and then copied into the app source area.</p>
        <ul>
          <li>If a compose file or Dockerfile is present, the app opens in the compose configuration modal.</li>
          <li>Without either file, the upload is kept under Projects for editing and later deployment.</li>
          <li>Destination paths are traversal-checked and symlinks cannot escape the project directory.</li>
        </ul>
      `
    },
    'app-creation-assist': {
      title: 'OC Assist',
      html: `
        <p><strong>OC Assist</strong> creates an app from a written brief. Enter a required app title and prompt describing the app, optionally add pasted data such as a docker run command, compose file, or repository URL, and upload supporting files.</p>
        <p>When you select <strong>Create app with OC Assist</strong>, Dok writes a private brief and the uploaded files under <code>sources/oc-assist-&lt;stamp&gt;/</code>, then immediately opens the OpenCode chat in <strong>User mode</strong> with the dedicated <code>assist</code> agent. There is no shell or mode picker: the chat is the only thing shown. The brief and all creator fields are passed automatically; you only need to answer questions if OpenCode needs more information.</p>
        <p>OC Assist reads any repository or reference URL you provide to identify the app&rsquo;s real GUI container port and always writes <code>VIRTUAL_PORT</code> on the primary GUI service, even when you do not supply a domain. For multi-port apps it selects the public web UI port rather than a database, metrics, or internal API port. <code>VIRTUAL_HOST</code> is added when you supply a hostname or ask for routing.</p>
        <p>If OpenCode fails during startup, Dok shows the captured terminal error instead of opening an empty chat. Inside the terminal, <strong>Escape</strong> is sent to OpenCode (for its own dialogs); use the terminal&rsquo;s close button to end the session.</p>
        <h4>What the assistant is allowed to do</h4>
        <ul>
          <li>Read and edit files only inside <code>apps/</code>, the OC Assist source folder, and its own brief folder.</li>
          <li>Run app-related shell commands such as <code>git clone</code>, file inspection, and the registration helper. Docker and system administration commands stay blocked.</li>
          <li>Register the finished app through <code>server/assist-register.mjs</code>. Registration saves it stopped; the assistant may run a temporary test launch that Dok stops again.</li>
          <li>It cannot manage Docker system resources, packages, or the Dok source code.</li>
        </ul>
        <p>The app is saved stopped in Apps. Open <strong>Apps → Deploy</strong> to configure routing, ports, paths, and secrets before deploying. The assistant uses the same registration path as manual creation, so amendment approval still applies if a container name would change.</p>
      `
    },
    'app-config-modal': {
      title: 'App configuration modal',
      html: `
        <p>Every creation method opens the app configuration modal. The left side shows the generated compose file and the right side shows editable fields.</p>
        <h4>Visual builder</h4>
        <ul>
          <li>Services, networks, named volumes, and top-level settings are editable as fields.</li>
          <li><strong>+ Add service</strong>, <strong>+ Add field</strong>, <strong>+ Add network</strong>, and <strong>+ Add volume</strong> add new entries. <strong>−</strong> removes one.</li>
          <li>Each service keeps a stable field order: service, image, container name, restart policy, command, entrypoint, ports, environment, volumes, networks, then additional settings.</li>
          <li>Multi-value sections use individual rows for ports, environment pairs, volumes, and networks.</li>
          <li>Unknown keys appear under <strong>Additional settings</strong> with a field-type selector and optional raw JSON.</li>
          <li>Required values, duplicate names, duplicate published ports, invalid ports, and invalid JSON are highlighted in red.</li>
          <li>Every change regenerates the compose preview and is validated by the server.</li>
        </ul>
        <p><strong>VIRTUAL_HOST</strong> and <strong>VIRTUAL_PORT</strong> quick fields stay in sync with the service environment. When nginx-proxy, Authelia, or acme-companion is installed (running or stopped), the builder adds the matching environment fields automatically: routing host and container port, optional <code>ENABLE_AUTH=true</code>, and certificate host and email. Suggested hostnames use <code>&lt;app&gt;.&lt;primary domain&gt;</code> from Dok Settings.</p>
        <p>When nginx-proxy is installed, the routed service joins Dok&rsquo;s default network and uses <code>VIRTUAL_HOST</code> plus a matching container <code>VIRTUAL_PORT</code>. <code>VIRTUAL_PORT</code> is filled from an explicit form value, then an existing <code>VIRTUAL_PORT</code>, then the first published container port, then <code>expose</code>, then the <code>PORT</code> environment variable, then 80. Published host <code>ports</code> are removed from that service because nginx reaches it over the shared network, so several apps can use the same container port without host conflicts. Finalize and Deploy apply the same rule even when you paste or manually edit a compose file.</p>
        <h4>Manual editing</h4>
        <p><strong>Manually edit compose file</strong> shows a warning and switches to raw text editing. Manual mode bypasses the builder guard but still uses compose validation. Use <strong>Validate compose</strong> before finishing.</p>
        <h4>Missing resources</h4>
        <p>Missing input networks must be mapped to an existing network or explicitly created. Missing bind paths must be chosen or created; protected system paths cannot be newly created, though existing safe paths such as <code>/var/run/docker.sock</code> remain selectable.</p>
        <h4>Finalise</h4>
        <p><strong>Save to library</strong> saves the app stopped. <strong>Test launch (stops after test)</strong> starts it briefly, reports each container&rsquo;s state, and stops the app again so it remains ready for configuration. If the target app directory already exists, Dok asks for overwrite confirmation. Progress is shown in stages: prepare, build, validate, save, and test.</p>
        <p>Persistent app data is never overwritten or deleted. If the new app targets an existing data directory, Dok tells you that it will connect to the existing data. Overwriting app files preserves <code>data/</code> and existing <code>.env</code> files. For fresh data, use a new app name or data location, or delete the existing data manually first.</p>
      `
    },
    apps: {
      title: 'Apps',
      html: `
        <p>Apps lists every app in the Dok library. Each app is a compose project stored under <code>apps/&lt;name&gt;/</code>. Apps are saved stopped until you deploy them.</p>
        <ul>
          <li><strong>Deploy</strong> opens the visual compose builder for the app. Review routing, ports, paths, and secrets, then use <strong>Save configuration</strong> or <strong>Save and deploy</strong>. This is the only way to start or redeploy an app.</li>
          <li><strong>Stop</strong> stops the compose project without changing its configuration.</li>
          <li><strong>Remove</strong> removes the app from the registry. Files stay on disk unless you remove them separately.</li>
          <li><strong>Configure &amp; Deploy</strong> is the same Deploy action, labelled for imported library apps that still need installation-specific settings.</li>
          <li><strong>Export library</strong> creates a portable archive of selected apps. <strong>Import library</strong> adds apps from another Dok installation.</li>
        </ul>
        <p>Badges show <strong>needs setup</strong> for imported apps and <strong>library</strong> for apps that came from an exported library.</p>
        <p>To edit raw YAML instead of the builder fields, use <strong>Manually edit compose file</strong> inside the builder. Saving updates the base compose; saving and deploying applies it immediately. If a container name would be renamed, Dok asks for approval first.</p>
      `
    },
    'app-library': {
      title: 'App library export and import',
      html: `
        <p>Dok can export selected apps as a portable library and import that library into any Dok installation. The archive format is <code>wickedafdok.library/v1</code> and contains a manifest plus each app&rsquo;s compose project.</p>
        <h4>Export</h4>
        <ol>
          <li>Open <strong>Apps</strong> and choose <strong>Export library</strong>.</li>
          <li>Select the apps to include and optionally give the library a name.</li>
          <li>Download the generated <code>.tar.gz</code> archive.</li>
        </ol>
        <p>Installation-specific data is stripped automatically: container names, virtual hosts, published host ports, authentication flags, the compose project name, absolute bind-mount sources (except safe system paths), external network names other than <code>wicked</code>, generated override files, environment files, git data, and node modules. App data is not included.</p>
        <h4>Import</h4>
        <ol>
          <li>Open <strong>Apps</strong> and choose <strong>Import library</strong> for a downloaded archive, or <strong>Import from repository</strong> to clone a git repository directly.</li>
          <li>For a repository, enter the git URL and optionally a branch and a subfolder containing <code>dok-library.json</code>.</li>
          <li>Repositories without a library manifest but with a compose file or Dockerfile are imported as a single app.</li>
          <li>Confirm overwrite if an app with the same name already exists. Existing app data and <code>.env</code> files are preserved and reused.</li>
        </ol>
        <p>Imported apps are marked <strong>needs setup</strong>. They do not launch automatically. Use <strong>Configure &amp; Deploy</strong> to open the compose builder and supply the information that was stripped, such as hostnames, ports, and bind paths. Saving clears the setup flag.</p>
        <h4>Structure rules</h4>
        <ul>
          <li>Each app must have a compose file at the root of its app folder.</li>
          <li>Apps are managed by Docker Compose; standalone containers are exported only after saving them as apps.</li>
          <li>Portable libraries must not rely on absolute host paths outside the app data location.</li>
          <li>Secrets should be supplied after import; environment files are intentionally not exported.</li>
          <li>Network names other than <code>wicked</code> are treated as installation-specific and removed.</li>
        </ul>
      `
    },
    amendments: {
      title: 'Amendment approval',
      html: `
        <p>When a deploy, test launch, or OC Assist registration would rename a container that already belongs to another app instance, Dok pauses and shows an <strong>Approve amendments</strong> dialog first.</p>
        <p>The dialog lists every affected app instance and the exact rename or replacement, for example renaming a stale <code>web</code> container to <code>web-previous-a1b2c3</code>. Nothing is renamed or launched until you approve. Normal recreation of this app&rsquo;s own containers does not need approval.</p>
        <ul>
          <li><strong>Approve and continue</strong> applies the listed renames and continues the original action.</li>
          <li><strong>Cancel</strong> leaves everything unchanged.</li>
          <li>Conflicts with protected core services are never auto-resolved; the action stops with an error.</li>
        </ul>
        <p>Approval applies only to the current action. A later deploy checks again because container state may have changed.</p>
      `
    },
    sources: {
      title: 'Projects and sources',
      html: `
        <p>Projects lets you browse and edit files under <code>sources/</code>. It is intended for projects that are not yet apps or that need changes before deployment.</p>
        <ul>
          <li><strong>Browse</strong> the file tree and open text files in the editor.</li>
          <li><strong>Save</strong> writes the file back in place.</li>
          <li><strong>Deploy</strong> sends a project through the same app creation flow, including compose validation and configuration.</li>
        </ul>
        <p>Git repositories and uploads without a compose file or Dockerfile land here automatically. File operations are sandboxed to the sources directory.</p>
      `
    },
    terminal: {
      title: 'Terminal and OC Assist',
      html: `
        <p>The Dashboard <strong>Terminal</strong> button opens an interactive shell in the Dok container. Shell sessions exist only while running and stop when the terminal is closed, the session exits, or the server shuts down.</p>
        <p>The shell starts in <code>/app</code> and runs as the Dok container user. It is not permission-restricted.</p>
        <h4>OC Assist</h4>
        <p>OC Assist is the only OpenCode chat launched from Dok. Start it from <strong>App Creation → OC Assist</strong>; Dok opens the chat directly, without shell or mode options. The assistant runs in User mode with permission to edit apps and register them. It saves each app stopped so you can configure and deploy it from Apps.</p>
        <p>Closing the chat window does not cancel the build. OC Assist keeps running in the background, and running sessions are listed under <strong>App Creation → OC Assist</strong> with an <strong>Open chat</strong> button so you can reattach after a reload or a failed connection. Use <strong>Stop</strong> in the terminal to end it deliberately.</p>
        <p>Admin OpenCode is available only inside the Dok Maintenance container. Provider settings for OC Assist can be saved under Settings → Core Services → OpenCode.</p>
      `
    },
    'settings-core': {
      title: 'Core Services',
      html: `
        <p>Core Services manages the bundled supporting services. Each card can be created, started, stopped, restarted, edited, and opened.</p>
        <ul>
          <li><strong>nginx-proxy</strong> routes hostnames to containers and terminates TLS when certificates are present.</li>
          <li><strong>cloudflared</strong> publishes services through a Cloudflare Tunnel.</li>
          <li><strong>Authentik</strong> provides single sign-on and user management.</li>
          <li><strong>Authelia</strong> provides forward authentication for apps that opt in.</li>
          <li><strong>Email</strong> configures outgoing SMTP, the Mailpit capture sink, and the Stalwart mail server.</li>
          <li><strong>DNS</strong> provides Technitium DNS or AdGuard Home with ad blocking.</li>
          <li><strong>OpenCode</strong> configures the on-demand AI assistant.</li>
          <li><strong>Host Helper</strong> is an optional privileged helper for creating host directories.</li>
        </ul>
        <p><strong>Start all</strong>, <strong>Stop all</strong>, and <strong>Restart all</strong> apply to every created core service except on-demand OpenCode sessions. The running Dok container is shown as a protected <strong>Dok</strong> core service.</p>
      `
    },
    'core-nginx': {
      title: 'nginx-proxy',
      html: `
        <p>nginx-proxy is the main reverse proxy. It reads <strong>VIRTUAL_HOST</strong> and <strong>VIRTUAL_PORT</strong> from containers and forwards the matching hostname to the container.</p>
        <ol>
          <li>Set the default primary domain under Dok Settings if you want suggestions.</li>
          <li>In Core Services, create nginx-proxy with a network (normally <code>wicked</code>) and optional domain for the Dok UI.</li>
          <li>Set each app&rsquo;s <strong>VIRTUAL_HOST</strong> and <strong>VIRTUAL_PORT</strong> in the compose builder.</li>
          <li>Place TLS certificates at <code>core/nginx-proxy/certs/&lt;host&gt;.crt</code> and <code>&lt;host&gt;.key</code> before relying on HTTPS.</li>
        </ol>
        <p>When a Dok domain is configured, Dok may recreate its own container to attach it to the nginx network with the right host variables. The UI reconnects after recreation.</p>
        <p><strong>Edit compose</strong> exposes the managed file for advanced changes. <strong>Apply domain</strong> updates the virtual host without rebuilding the service.</p>
        <p><strong>Certificates</strong> can be requested automatically by enabling <code>nginxproxy/acme-companion</code>. Enter a certificate email and optionally use the staging service while testing. Containers that need certificates set <code>LETSENCRYPT_HOST</code> (usually the same as <code>VIRTUAL_HOST</code>) and, when required, <code>LETSENCRYPT_EMAIL</code>. The companion stores certificates under <code>core/nginx-proxy/certs</code> and renews them. If you leave it disabled, place certificates there manually with <code>&lt;host&gt;.crt</code> and <code>&lt;host&gt;.key</code> names.</p>
      `
    },
    'core-cloudflared': {
      title: 'cloudflared',
      html: `
        <p>cloudflared publishes a service through a Cloudflare Tunnel without opening inbound ports. Create the tunnel in Cloudflare, copy its token, paste it into the cloudflared card, and launch the service.</p>
        <ul>
          <li>The token is encrypted at rest and never returned in full by the API.</li>
          <li>Configure public hostnames in the Cloudflare dashboard and point them at the Dok or app service.</li>
          <li>Use <strong>Open</strong> to reach the Cloudflare dashboard or the configured service.</li>
        </ul>
      `
    },
    'core-authentik': {
      title: 'Authentik',
      html: `
        <p>Authentik is an optional identity provider and SSO portal. Dok launches PostgreSQL, Redis, a server, and a worker on the <code>wicked</code> network.</p>
        <ul>
          <li>Admin credentials are seeded from Dok Settings defaults or generated when first launched.</li>
          <li>Set an optional GUI domain to expose the Authentik interface through nginx-proxy.</li>
          <li>After launch, open Authentik and create providers and applications for your services.</li>
          <li>Dok can apply <code>ENABLE_AUTH=true</code> to selected containers for use with Authelia, but Authentik applications and proxy providers are configured in Authentik itself.</li>
        </ul>
        <p>The managed compose pins a tested server image version. Upgrade by changing the version only when the database migrations are compatible.</p>
      `
    },
    'core-authelia': {
      title: 'Authelia',
      html: `
        <p>Authelia provides forward authentication. Apps opt in with <code>ENABLE_AUTH=true</code> plus <strong>VIRTUAL_HOST</strong> and <strong>VIRTUAL_PORT</strong>. Dok generates the nginx-proxy vhost files and keeps them in sync every 60 seconds and after app lifecycle changes.</p>
        <ol>
          <li>Create certificates for the portal and every protected host under <code>core/nginx-proxy/certs</code>.</li>
          <li>Launch Authelia with a portal domain such as <code>auth.example.com</code>.</li>
          <li>Use the auth container picker or set <code>ENABLE_AUTH=true</code> on an app, then deploy it.</li>
          <li>Choose <strong>Sync protected apps</strong> after changing hostnames.</li>
        </ol>
        <p>Protected hosts must share the portal&rsquo;s cookie parent domain. Hosts under a different parent are skipped and reported. Wildcard virtual hosts are not supported for forward auth; list literal hostnames.</p>
        <p><strong>Manage users</strong> edits local users and the admin account. <strong>Require login for the Dok UI</strong> protects Dok itself without an environment variable, provided the Dok domain routes through nginx-proxy. HTTPS is required because Authelia marks cookies Secure and nginx-proxy needs certificates.</p>
      `
    },
    'core-mail': {
      title: 'Email and Mailpit',
      html: `
        <p>Email settings configure outgoing SMTP for Authelia notifications. The provider-agnostic form accepts host, port, TLS mode, username, password, sender, and an optional identifier.</p>
        <ul>
          <li><strong>None</strong> disables SMTP; Authelia falls back to its filesystem notifier.</li>
          <li><strong>STARTTLS</strong> and <strong>TLS</strong> select the appropriate secure scheme.</li>
          <li>A blank password keeps the saved password. Passwords are encrypted at rest.</li>
          <li><strong>Use Mailpit</strong> launches the capture sink and points notifications at <code>mailpit:1025</code> without TLS.</li>
        </ul>
        <p>Mailpit is a test sink. It stores messages for inspection in its web UI and never delivers mail to the internet. It is not a mailbox server.</p>
        <p><strong>Stalwart</strong> is a full mail server with SMTP, IMAP, JMAP, and a web admin. Launch it from the Email card, open the web admin to finish setup, then point the SMTP fields above at <code>stalwart:587</code> (or the published submission port). Publish 25, 587, 465, and 993 on the host and configure DNS MX/SPF/DKIM records before accepting internet mail.</p>
      `
    },
    'core-dns': {
      title: 'DNS (Technitium or AdGuard Home)',
      html: `
        <p>Choose the DNS provider in the card. <strong>Technitium DNS</strong> provides zones, records, blocklists, and a full web console. <strong>AdGuard Home</strong> provides filtering DNS with a setup wizard and query dashboard.</p>
        <ul>
          <li>Technitium: set the web console port (default 5380), DNS port (default 53), and an admin password. A blank password is generated.</li>
          <li>AdGuard Home: launch it, open the setup wizard, and choose port <code>3000</code> for the admin UI if prompted so the published port keeps working.</li>
          <li>Set an optional GUI domain to expose the console through nginx-proxy.</li>
          <li>Point clients at the host&rsquo;s port 53 to use Dok&rsquo;s DNS service.</li>
        </ul>
        <p>If port 53 is already used by another resolver, choose a different host port or stop the conflicting service first. Switching provider changes which compose project Dok manages for the DNS card.</p>
      `
    },
    'core-opencode': {
      title: 'OpenCode',
      html: `
        <p>OpenCode powers <strong>OC Assist</strong> in App Creation. It is not a compose service and is excluded from Start all/Stop all.</p>
        <ul>
          <li>OC Assist runs in User mode, starts in <code>apps/</code>, and restricts the agent to app work.</li>
          <li>Start an OC Assist chat only from <strong>App Creation → OC Assist</strong>. Dok opens the chat directly with no shell or mode picker.</li>
          <li>Admin OpenCode is available only inside the Dok Maintenance container, where it can access Docker and the full Dok checkout.</li>
          <li>Provider, model, and API key can be saved here to preconfigure OC Assist. If the provider is left blank it is inferred from the <code>provider/model</code> prefix.</li>
          <li>The API key is encrypted at rest and only reported as set or not set.</li>
          <li><strong>Stop OC Assist sessions</strong> ends any running OC Assist chats.</li>
        </ul>
        <p>OpenCode is installed in the image; set <code>OPENCODE_BIN</code> only for development with a different binary.</p>
      `
    },
    'core-host-helper': {
      title: 'Host Helper',
      html: `
        <p>Host Helper is an optional privileged companion container. It lets the non-root Dok process create and chown host directories through a shared Unix socket.</p>
        <ul>
          <li>Launch it when the default data location or bind paths cannot be created directly.</li>
          <li>The helper is privileged and has access to the host paths you allow.</li>
          <li>Without the helper, host paths outside the runtime directories must already be writable by the Dok user.</li>
        </ul>
        <p>The socket and token are stored under <code>data/host-helper</code>. The helper is a deliberate privilege boundary; review its compose file before launching.</p>
      `
    },
    'settings-dok': {
      title: 'Dok Settings',
      html: `
        <p>Dok Settings controls how new apps are created and how Dok itself is presented.</p>
        <h4>Default settings</h4>
        <ul>
          <li><strong>Primary domain</strong> suggests core-service hostnames such as auth, sso, dns, and mail.</li>
          <li><strong>Dok domain</strong> sets the UI hostname and can fill a blank nginx domain.</li>
          <li><strong>Data location</strong> is an absolute host path. <strong>Data mode</strong> sets the folder permissions (default 0775).</li>
          <li><strong>Auto app data</strong> creates <code>&lt;dataLocation&gt;/apps/&lt;app&gt;/data</code> and maps missing relative bind mounts beneath it.</li>
          <li><strong>Allow outside data</strong> permits bind paths outside the data location. Leave it off unless you need host paths the Dok user can write.</li>
          <li><strong>Admin user/email/password</strong> seed Authelia, Authentik, and Technitium installs.</li>
          <li><strong>Default network</strong> is used by new apps and may be created on first use.</li>
          <li><strong>Protect Dok</strong> adds the Dok host to Authelia&rsquo;s protected set without recreating the container.</li>
        </ul>
        <p>Saving creates the data location and app folder, validates domains and modes, and syncs Authelia if protection changed. <strong>Apply data location</strong> re-applies the folder and permissions through the Host Helper when needed.</p>
      `
    },
    'dok-designer': {
      title: 'Designer',
      html: `
        <p>Designer changes the Dok header name, tagline, CSS, and logo. Changes apply live and are stored in <code>data/settings.json</code> and <code>data/designer/</code>.</p>
        <ul>
          <li><strong>App name</strong> and <strong>tag line</strong> replace the header text.</li>
          <li><strong>CSS override</strong> is injected into the page for advanced styling.</li>
          <li><strong>Logo</strong> accepts PNG, JPG, WebP, SVG, or ICO.</li>
          <li>The nginx-proxy file editor under Designer opens error pages by default and lets you edit vhost snippets and configs. Dotfiles and private key/<code>.pem</code> files are excluded.</li>
        </ul>
        <p>Bundled error pages are created only when absent. Existing pages and configs are never overwritten automatically.</p>
      `
    },
    'dok-groups': {
      title: 'Groups',
      html: `
        <p>Groups organise containers into named sets for quick reference. They are stored in <code>data/groups.json</code>.</p>
        <ul>
          <li>Enter a group name, select containers, and save.</li>
          <li>The built-in <strong>Core Services</strong> group is computed from live Docker labels and known names. It cannot be edited or deleted and always appears first.</li>
          <li>Groups are labels for the UI; they do not change container permissions or startup order.</li>
        </ul>
      `
    },
    'dok-registries': {
      title: 'Registry and git connections',
      html: `
        <p>Save credentials for container registries and git hosts. Registry credentials are used automatically for image pulls and compose launches. Git credentials are used only for matching HTTPS hosts.</p>
        <ul>
          <li>Choose a preset or custom host, enter a name, username, and secret/token, then save.</li>
          <li>Secrets are encrypted with AES-256-GCM and only reported as set or not set.</li>
          <li><strong>Test</strong> validates the connection using the provider API or a temporary Docker login.</li>
          <li>SSH git URLs use the container user&rsquo;s SSH keys and are unaffected by these connections.</li>
        </ul>
        <p>Losing <code>data/.credentials-key</code> makes stored secrets unrecoverable; delete and re-enter them if that happens.</p>
      `
    },
    'settings-logs': {
      title: 'Logs',
      html: `
        <p>Logs has two views: server logs and Docker Compose logs.</p>
        <ul>
          <li><strong>Server logs</strong> show console output and mutating <code>/api</code> requests. They are also written to <code>data/logs/server.log</code>.</li>
          <li><strong>Clear</strong> empties the in-memory and file log.</li>
          <li><strong>Compose logs</strong> selects an app or created core service and shows its compose output with a configurable tail.</li>
          <li>Auto-refresh can be disabled to freeze a window while you read it.</li>
        </ul>
        <p>Use compose logs when a launch fails; Docker reports pull, build, port, and startup errors there.</p>
      `
    },
    'settings-backups': {
      title: 'Backups and updates',
      html: `
        <p>Backups, snapshots, imports, and updates are now managed by the Dok Maintenance container under <strong>Settings → Maintenance</strong>. The legacy Dok backup routes remain available for compatibility, but the Maintenance store lives outside the Dok checkout (normally <code>&lt;checkout&gt;-maintenance-data</code>, or <code>MAINTENANCE_DATA_PATH</code>) and is never exported with an app.</p>
        <p>Legacy backups are stored locally under <code>data/backups</code> as a <code>.tar.gz</code> archive plus JSON metadata.</p>
        <h4>Scopes</h4>
        <ul>
          <li><strong>Full</strong> includes data, apps, core, and sources. Backups, temporary files, and the helper socket are excluded; logs are optional.</li>
          <li><strong>App</strong> includes one app folder plus a registry snapshot.</li>
          <li><strong>Custom</strong> lets you choose data, apps, core, sources, logs, individual apps, and individual core services.</li>
        </ul>
        <h4>Restore and import</h4>
        <p>Restore requires explicit overwrite confirmation. Custom restores only overwrite the sections recorded in their manifest. Import accepts a Dok archive and restores it through the same flow. An app restore replaces app files but preserves existing app <code>data/</code> and <code>.env</code> files; choose a new app name or delete the data manually first for a clean restore.</p>
        <h4>Updates</h4>
        <p>Update from Git pulls the configured repository. The code root must be writable. In the default image the source is baked in, so an in-app update is lost on container recreation unless <code>/app</code> is bind-mounted; otherwise update on the host with <code>git pull</code> and rebuild.</p>
      `
    },
    'field-reference': {
      title: 'Field reference',
      html: `
        <p>Hover or focus the <strong>?</strong> beside any field for its specific explanation. Common fields are summarised here.</p>
        <h4>App identity</h4>
        <ul>
          <li><strong>App title</strong> is required and becomes the folder <code>apps/&lt;name&gt;</code> and the compose project name after sanitising. Use lowercase letters, numbers, dashes, and underscores for the cleanest folder name.</li>
          <li><strong>Container name</strong> is optional. Leaving it blank lets Compose generate a project-scoped name, which is safer for duplicate prevention.</li>
          <li><strong>Image</strong> is required unless the service has a build context.</li>
          <li><strong>Restart policy</strong> controls what Docker does after a crash or host reboot. <code>unless-stopped</code> is a common choice for apps.</li>
        </ul>
        <h4>Networking</h4>
        <ul>
          <li><strong>Ports</strong> use <code>host:container</code> or <code>container</code>. Published host ports must be unique on the host. With nginx-proxy installed, a routed service should not publish host ports; Dok removes them and routes through the shared network instead.</li>
          <li><strong>Networks</strong> attach the service to Docker networks. <code>wicked</code> is Dok&rsquo;s default app network and the routed service is always attached to it.</li>
          <li><strong>VIRTUAL_HOST</strong> is the hostname nginx-proxy serves.</li>
          <li><strong>VIRTUAL_PORT</strong> is the container port nginx-proxy forwards to, not the host port. Dok fills it automatically from the service&rsquo;s container port so the GUI works through nginx.</li>
          <li><strong>ENABLE_AUTH</strong> opts the container into Authelia forward authentication.</li>
        </ul>
        <h4>Storage</h4>
        <ul>
          <li><strong>Volumes</strong> map host paths or named volumes into the container. Read-only mounts end with <code>:ro</code>.</li>
          <li><strong>Environment</strong> sets container environment variables. Secrets should be supplied after importing a library.</li>
          <li><strong>Command</strong> and <strong>Entrypoint</strong> override the image defaults.</li>
        </ul>
        <h4>Data location</h4>
        <ul>
          <li><strong>Data location</strong> must be an absolute host path.</li>
          <li><strong>Data mode</strong> is an octal permission such as <code>0775</code>.</li>
          <li><strong>Auto app data</strong> maps missing relative mounts under the app data directory.</li>
        </ul>
      `
    },
    troubleshooting: {
      title: 'Troubleshooting',
      html: `
        <h4>App will not launch</h4>
        <ul>
          <li>Open Settings → Logs → Compose logs for the app.</li>
          <li>Validate the compose file and check for duplicate host ports.</li>
          <li>Confirm missing networks and bind paths were resolved in the builder.</li>
          <li>If an amendment dialog appeared, approve or cancel it; nothing starts while it is open.</li>
        </ul>
        <h4>Hostname does not resolve</h4>
        <ul>
          <li>Confirm nginx-proxy is running and the app is on the same Docker network.</li>
          <li>Check <strong>VIRTUAL_HOST</strong> and <strong>VIRTUAL_PORT</strong>.</li>
          <li>Place certificates in <code>core/nginx-proxy/certs</code> for HTTPS hosts.</li>
        </ul>
        <h4>Permission denied</h4>
        <ul>
          <li>Run <code>sudo ./setup.sh</code> on the host, then restart Dok with <code>./start.sh</code>.</li>
          <li>Use Host Helper or make the target host path writable by the Dok user.</li>
          <li>After a Docker socket group change, rerun setup and start.</li>
        </ul>
        <h4>Terminal or OpenCode will not open</h4>
        <ul>
          <li>Check the server log for PTY, shell, or OpenCode errors.</li>
          <li>The terminal switches to HTTP compatibility mode when a proxy blocks <code>/api/terminal/ws</code>. Forwarding WebSocket upgrades is still faster.</li>
          <li>The terminal keeps retrying while the connection is interrupted. If the window was closed, reattach the still-running OC Assist session from <strong>App Creation → OC Assist</strong>.</li>
          <li>Rebuild the image if OpenCode is missing from an older deployment.</li>
        </ul>
        <h4>Imported app needs setup</h4>
        <p>This is expected. Export strips installation-specific hostnames, ports, paths, and secrets. Use <strong>Configure &amp; Deploy</strong> and supply them in the builder.</p>
      `
    }
  };

  const SECTION_HELP = {
    'tab-dashboard': 'dashboard',
    'tab-containers': 'containers',
    'tab-images': 'images',
    'tab-appcreation': 'app-creation',
    'tab-sources': 'sources',
    'tab-apps': 'apps',
    'tab-settings': 'settings-core',
    'subtab-run': 'app-creation-run',
    'subtab-compose': 'app-creation-compose',
    'subtab-git': 'app-creation-git',
    'subtab-upload': 'app-creation-upload',
    'subtab-assist': 'app-creation-assist',
    'settings-pane-core': 'settings-core',
    'settings-pane-dok': 'settings-dok',
    'settings-pane-logs': 'settings-logs',
    'settings-pane-backups': 'settings-backups'
  };

  const FIELD_LABEL = {
    appCfgCompose: 'Compose file',
    appCfgName: 'App title',
    appCfgNetwork: 'Network',
    editContent: 'File content',
    editPath: 'File path',
    runCmd: 'Docker run command',
    composeYaml: 'Compose file',
    gitRepo: 'Git repository URL',
    assistPrompt: 'App description',
    assistData: 'Reference data',
    libraryImportFile: 'Library archive',
    libraryRepoUrl: 'Repository URL',
    libraryRepoBranch: 'Branch or tag',
    libraryRepoPath: 'Library folder',
    libraryRepoName: 'App title',
    importBackupFile: 'Backup archive'
  };

  const FIELD_HELP = {
    containerSearch: 'Filter the container list by name, image, project, or state.',
    imageSearch: 'Filter the image list by repository, tag, or image ID.',
    pullImageInput: 'Full image reference to pull, for example nginx:alpine or ghcr.io/org/app:tag.',
    runImage: 'Image to run in the quick-run helper.',
    runName: 'Required app title for the new app. It becomes the apps/<name> folder and the compose project name.',
    appCfgName: 'Required app title. It becomes the apps/<name> folder and the compose project name.',
    appCfgCompose: 'Raw compose file. Editing here switches the modal to manual mode.',
    appCfgNetwork: 'Default network used by the compose preview when no service network is selected.',
    runCmd: 'Complete docker run command to convert into an app compose file.',
    composeName: 'Required app title for the pasted compose project.',
    composeYaml: 'Complete docker-compose.yml or compose.yaml content.',
    gitRepo: 'Git clone URL. HTTPS, SSH, and any hosted git server are supported.',
    gitBranch: 'Optional branch, tag, or commit to check out. Leave blank for the remote default.',
    gitName: 'Required app title for the cloned project.',
    uploadName: 'Required app title for the uploaded files.',
    uploadFolder: 'Files or a folder selected from this computer.',
    uploadFiles: 'Individual files selected from this computer.',
    assistPrompt: 'Required description of the app you want OC Assist to create.',
    assistData: 'Optional pasted docker run command, compose file, repository URL, or other reference material.',
    assistName: 'Required app title. OC Assist uses it for the app folder, compose project, and saved library entry.',
    assistFolder: 'Optional existing folder to use as the app source.',
    assistFiles: 'Optional files to give OC Assist as supporting material.',
    libraryExportName: 'Optional filename prefix for the exported library archive.',
    libraryImportFile: 'A Dok library .tar.gz archive exported from another installation.',
    libraryRepoUrl: 'Git URL for a repository that contains a Dok library or a single compose/Dockerfile app. HTTPS, SSH, and self-hosted git servers are supported.',
    libraryRepoBranch: 'Optional branch, tag, or commit to clone. Leave blank for the remote default.',
    libraryRepoPath: 'Subfolder inside the repository that contains dok-library.json and its apps/ folder.',
    libraryRepoName: 'App name to use when the repository has no dok-library.json and is imported as a single app.',
    nginxAcmeEnabled: 'Create and renew Let\'s Encrypt certificates automatically with nginxproxy/acme-companion.',
    nginxAcmeEmail: 'Contact email used for certificate registration and expiry notices.',
    nginxAcmeStaging: 'Use the Let\'s Encrypt staging service while testing to avoid rate limits. Staging certificates are not trusted by browsers.',
    dnsProvider: 'Choose Technitium DNS or AdGuard Home as the local DNS and ad-blocking service.',
    dnsAdminPassword: 'Technitium admin password. A blank value generates one.',
    dnsWebPort: 'Host port for the DNS web console. Technitium defaults to 5380; AdGuard Home setup defaults to 3000.',
    dnsDnsPort: 'Host port for DNS queries. Port 53 is standard but may conflict with a resolver on the host.',
    dnsDomain: 'Optional hostname for the DNS console through nginx-proxy.',
    stalwartDomain: 'Optional hostname for the Stalwart web admin through nginx-proxy.',
    stalwartAdminUser: 'Admin username used for the Stalwart setup and recovery account.',
    stalwartAdminPassword: 'Admin password. A blank value generates one and stores it encrypted.',
    stalwartWebPort: 'Host port for the Stalwart web admin.',
    stalwartSmtpPort: 'Host port for inbound SMTP delivery. Usually 25.',
    stalwartSubmissionPort: 'Host port for authenticated mail submission. Usually 587.',
    stalwartImapsPort: 'Host port for IMAPS. Usually 993.',
    importBackupFile: 'A Dok backup archive to upload and restore.',
    importBackupName: 'Optional name for the imported backup.',
    backupName: 'Optional name for the new backup archive.',
    backupScope: 'Full backs up data, apps, core, and sources. App backs up one app. Custom lets you choose sections.',
    backupApp: 'App to include when the scope is App.',
    backupCompData: 'Include data in a custom backup.',
    backupCompApps: 'Include app folders in a custom backup.',
    backupCompCore: 'Include core service folders in a custom backup.',
    backupCompSources: 'Include sources/projects in a custom backup.',
    backupCompLogs: 'Include server logs in a custom backup.',
    backupAppsSelect: 'Selected apps for a custom backup. No selection means all apps.',
    backupCoreSelect: 'Selected core services for a custom backup. No selection means all core services.',
    backupIncludeLogs: 'Include server logs in a full backup.',
    backupAppsAuto: 'Refresh the available apps and core services for custom backups.',
    updateRepo: 'Git repository URL used to update Dok.',
    updateBranch: 'Branch to pull from when updating.',
    nginxDomain: 'Hostname for the Dok UI when routed through nginx-proxy. Leave blank to skip self-reconfiguration.',
    nginxNetwork: 'Docker network shared by nginx-proxy and apps. wicked is the default.',
    nginxPort: 'Container port nginx-proxy forwards Dok traffic to. The Dok UI listens on 8080.',
    nginxComposeEditor: 'Managed nginx-proxy compose file. Advanced editing can break routing.',
    cfToken: 'Cloudflare Tunnel token. It is encrypted at rest.',
    cfComposeEditor: 'Managed cloudflared compose file.',
    authDomain: 'Optional hostname for the Authentik web interface.',
    authDomainManage: 'Set or change the Authentik GUI hostname.',
    authPort: 'Container port for the Authentik server. Defaults to 9000.',
    authPassword: 'Initial Authentik admin password. It is encrypted at rest.',
    authEmail: 'Initial Authentik admin email address.',
    authComposeEditor: 'Managed Authentik compose file. It includes PostgreSQL, Redis, server, and worker.',
    autheliaDomain: 'Portal hostname used for Authelia login, for example auth.example.com.',
    autheliaDomainManage: 'Set or change the Authelia portal hostname.',
    autheliaPort: 'Container port for Authelia. Defaults to 9091.',
    autheliaPassword: 'Admin password. It is hashed before storage and shown only once.',
    autheliaEmail: 'Admin email address for Authelia notifications and login.',
    autheliaProtectDok: 'Add the Dok hostname to Authelia protected hosts without recreating Dok.',
    autheliaComposeEditor: 'Managed Authelia compose file.',
    autheliaUser: 'Existing Authelia account to edit.',
    autheliaUserName: 'Username for the local Authelia account.',
    autheliaUserDisplay: 'Display name shown in the Authelia portal.',
    autheliaUserEmail: 'Email address for the local Authelia account.',
    autheliaUserPassword: 'Password for the local account. Leave blank to keep the current password.',
    autheliaUserDisabled: 'Disable this account without deleting it.',
    autheliaAdminUser: 'Admin username for Authelia.',
    autheliaAdminEmail: 'Admin email address for Authelia.',
    autheliaAdminPassword: 'New admin password. It is hashed and stored encrypted.',
    mailSmtpHost: 'SMTP server hostname. Leave blank to disable outgoing email and use the filesystem notifier.',
    mailSmtpPort: 'SMTP port. Common values are 25, 465 for TLS, and 587 for STARTTLS.',
    mailSmtpTls: 'TLS mode: none, STARTTLS, or implicit TLS.',
    mailSmtpUser: 'SMTP username, if authentication is required.',
    mailSmtpPassword: 'SMTP password. A blank value keeps the saved password.',
    mailSmtpSender: 'From address used for notification email.',
    dnsWebPort: 'Host port for the Technitium web console. Defaults to 5380.',
    dnsDnsPort: 'Host port for DNS queries. Defaults to 53.',
    dnsAdminPassword: 'Technitium admin password. A blank value generates one.',
    dnsDomain: 'Optional hostname for the Technitium web console.',
    dnsDomainManage: 'Set or change the Technitium console hostname.',
    dnsComposeEditor: 'Managed Technitium DNS compose file.',
    mailpitSmtpPort: 'Host port for captured SMTP traffic. Defaults to 1025.',
    mailpitWebPort: 'Host port for the Mailpit web interface. Defaults to 8025.',
    mailpitMaxMessages: 'Maximum number of captured messages to keep. Defaults to 500.',
    mailpitDomain: 'Optional hostname for the Mailpit web interface.',
    mailpitDomainManage: 'Set or change the Mailpit hostname.',
    mailpitComposeEditor: 'Managed Mailpit compose file.',
    opencodeModel: 'Default model in provider/model form, for example openai/gpt-4.1.',
    opencodeProvider: 'Provider name. If blank, it is inferred from the model prefix.',
    opencodeApiKey: 'Provider API key. It is encrypted at rest and never displayed again.',
    opencodeClearApiKey: 'Remove the saved provider API key.',
    helperImage: 'Container image used for the privileged Host Helper.',
    helperComposeEditor: 'Managed Host Helper compose file.',
    groupName: 'Name for a new container group.',
    groupContainers: 'Containers to include in the group.',
    registryKind: 'Whether this connection is for a container registry or a git host.',
    registryProvider: 'Preset provider or custom host type.',
    registryName: 'Friendly name shown in Dok.',
    registryHost: 'Registry or git host, for example ghcr.io or github.com.',
    registryUsername: 'Username or account name for the connection.',
    registrySecret: 'Password, token, or access key. It is encrypted at rest.',
    defaultsPrimaryDomain: 'Base domain used to suggest auth, sso, dns, and mail hostnames.',
    defaultsDokDomain: 'Hostname for the Dok UI. It can fill a blank nginx-proxy domain.',
    defaultsDataLocation: 'Absolute host path where app data is stored.',
    defaultsDataMode: 'Octal permissions for created data folders, for example 0775.',
    defaultsAllowOutsideData: 'Allow bind mounts outside the configured data location.',
    defaultsAutoAppData: 'Automatically create and map app data folders for missing relative mounts.',
    defaultsAdminUser: 'Default admin username used to seed authentication and DNS services.',
    defaultsAdminEmail: 'Default admin email used to seed authentication services.',
    defaultsAdminPassword: 'Default admin password. It is encrypted at rest.',
    defaultsClearAdminPassword: 'Remove the saved default admin password.',
    defaultsNetwork: 'Default Docker network for new apps.',
    defaultsProtectDok: 'Add the Dok hostname to Authelia protection.',
    designerName: 'Product name shown in the Dok header.',
    designerTagline: 'Short subtitle shown in the Dok header.',
    designerCss: 'CSS override injected into the Dok UI.',
    designerLogoFile: 'Logo image file. PNG, JPG, WebP, SVG, and ICO are accepted.',
    designerFilePath: 'nginx-proxy file to edit, including error pages and vhost snippets.',
    designerFileContent: 'Contents of the selected nginx-proxy file.',
    logsAuto: 'Automatically refresh the server log.',
    appLogsSelect: 'App or core service whose compose logs should be shown.',
    appLogsTail: 'Number of recent log lines to load.',
    appLogsAuto: 'Automatically refresh the selected compose log.',
    serverLogsAuto: 'Automatically refresh the server log.',
    logsAuto: 'Automatically refresh the server log.',
    editPath: 'File path inside the project. Parent traversal is blocked.',
    editContent: 'Editable text content of the selected source file.',
    sourceName: 'Required app title for the project being deployed.',
    sourceMode: 'How the source is processed: docker run, compose, or deploy.',
    sourceCommand: 'Docker run command used to create the source.',
    sourcePorts: 'Comma-separated ports for the source deployment.',
    sourceVhost: 'Virtual hostname to route to the source deployment.',
    sourceVport: 'Container port used by the virtual host.',
    service: 'Compose service name used inside this app project.',
    image: 'Container image used by this service, for example nginx:alpine.',
    build: 'Build context for the service. Use . to build from the app directory.',
    container_name: 'Fixed container name. Leave blank to let Compose generate a project-scoped name.',
    restart: 'Restart policy for the service, such as unless-stopped or always.',
    command: 'Command that overrides the image default command.',
    entrypoint: 'Entrypoint that overrides the image default entrypoint.',
    ports: 'Container ports to publish. Host mappings are added when the app is deployed.',
    environment: 'Environment variables passed to the service. Installation-specific routing variables are removed on library export.',
    volumes: 'Bind mounts and named volumes used by the service. Absolute host paths become relative app data paths in a library.',
    networks: 'Networks the service joins. The app deployment network is added separately.',
    depends_on: 'Services that must start before this service.',
    healthcheck: 'Health check configuration for the service.',
    labels: 'Container labels, including reverse-proxy and service metadata.',
    extra_hosts: 'Additional host-to-IP mappings for the service.',
    tmpfs: 'In-memory filesystem mounts for the service.',
    shm_size: 'Shared memory size for the service, for example 1gb.',
    user: 'User or UID:GID the container process runs as.',
    working_dir: 'Working directory inside the container.',
    'Named Volumes': 'Top-level named volume definitions used by service volume mappings.',
    Networks: 'Top-level network definitions. The shared wicked network is kept for portability.',
    'Other top-level settings': 'Optional JSON for top-level configs, secrets, or x-* extension fields.',
    'Additional settings': 'Compose keys that do not have a dedicated field. Use the field type selector to add common keys or raw JSON.',
    sourcesPath: 'Path inside sources/ to browse or edit.',
    authPort: 'Container port used by the Authentik server.',
    authPassword: 'Initial Authentik admin password.',
    authEmail: 'Initial Authentik admin email.',
    nginxPort: 'Container port for Dok. Defaults to 8080.',
    autheliaPort: 'Container port for Authelia. Defaults to 9091.',
    dnsWebPort: 'Host port for the Technitium web console.',
    dnsDnsPort: 'Host port for DNS.',
    mailpitWebPort: 'Host port for the Mailpit web interface.',
    mailpitSmtpPort: 'Host port for captured SMTP messages.'
  };

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
  }

  function manualKeyForPane(pane) {
    if (!pane || !pane.id) return null;
    if (SECTION_HELP[pane.id]) return SECTION_HELP[pane.id];
    if (pane.id.startsWith('settings-pane-')) return SECTION_HELP[pane.id] || 'settings-dok';
    if (pane.id.startsWith('subtab-')) return SECTION_HELP[pane.id] || 'app-creation';
    return null;
  }

  function renderNav(activeKey) {
    const nav = document.getElementById('manualNav');
    if (!nav) return;
    nav.innerHTML = MANUAL_GROUPS.map((group) => `
      <div class="manual-nav-group">
        <div class="manual-nav-title">${esc(group.title)}</div>
        ${group.sections.map((key) => {
          const entry = MANUAL[key];
          if (!entry) return '';
          return `<button class="manual-nav-link ${key === activeKey ? 'active' : ''}" data-manual-key="${esc(key)}">${esc(entry.title)}</button>`;
        }).join('')}
      </div>
    `).join('');
  }

  function renderManual(key) {
    const entry = MANUAL[key] || MANUAL.index;
    const content = document.getElementById('manualContent');
    const title = document.getElementById('manualTitle');
    if (!content) return;
    if (title) title.textContent = entry.title;
    renderNav(key);
    content.innerHTML = `<h2>${esc(entry.title)}</h2>${entry.html}`;
    const modal = document.getElementById('manualModal');
    if (modal) modal.classList.remove('hidden');
    content.scrollTop = 0;
  }

  function openManual(key) {
    renderManual(key || 'index');
  }

  function humanizeFieldName(value) {
    const text = String(value || '')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) return 'Field';
    const label = text.charAt(0).toUpperCase() + text.slice(1);
    const acronyms = {
      Api: 'API', Cpu: 'CPU', Dns: 'DNS', Gui: 'GUI', Id: 'ID', Imap: 'IMAP',
      Json: 'JSON', Ram: 'RAM', Smtp: 'SMTP', Ssh: 'SSH', Sso: 'SSO', Tls: 'TLS', Url: 'URL'
    };
    return label.replace(/\b(?:Api|Cpu|Dns|Gui|Id|Imap|Json|Ram|Smtp|Ssh|Sso|Tls|Url)\b/g, word => acronyms[word] || word);
  }

  function cleanFieldTitle(value) {
    let text = String(value || '').trim();
    text = text.replace(/\s*[,;:]?\s*(?:e\.g\.|for example|for instance).*$/i, '');
    for (let i = 0; i < 3; i++) {
      text = text.replace(/\s*\([^()]*\)\s*$/i, '').trim();
    }
    return text.replace(/\s{2,}/g, ' ').replace(/[,;:\s]+$/g, '').trim();
  }

  function decorateField(control) {
    if (!control || control.dataset.helpDecorated) return;
    if (control.closest('.xterm')) return;
    if (control.closest('.builder-field, .builder-kv-row, .builder-row, .builder-list-row, .compose-builder-card, .terminal-container')) return;
    const type = (control.getAttribute('type') || '').toLowerCase();
    if (['hidden', 'submit', 'reset', 'button'].includes(type)) return;
    if (control.dataset.noFieldHelp === 'true') return;

    const id = control.id || '';
    const labelFor = id ? document.querySelector(`label[for="${cssEscape(id)}"]`) : null;
    const wrappingLabel = control.closest('label');
    const originalAria = (control.getAttribute('aria-label') || '').trim();
    const explicitLabel = (labelFor?.textContent || wrappingLabel?.textContent || originalAria || '').trim();
    const explicitTitle = FIELD_LABEL[id] || explicitLabel;
    const cleanTitle = cleanFieldTitle(explicitTitle);
    const titleIsExample = !cleanTitle || cleanTitle.length > 60 || /^(https?:\/\/|git@|ssh:\/\/|[^\s]+@)/i.test(cleanTitle);
    const fieldName = titleIsExample ? humanizeFieldName(control.getAttribute('name') || id) : cleanTitle;
    const help = FIELD_HELP[id] || FIELD_HELP[control.getAttribute('name')] || (() => {
      if (type === 'checkbox' || type === 'radio') return `Enable or disable ${fieldName.toLowerCase()}.`;
      if (type === 'file') return `Choose a file for ${fieldName.toLowerCase()}.`;
      return `Sets the ${fieldName.toLowerCase()} value used by this section.`;
    })();

    if (!originalAria) control.setAttribute('aria-label', fieldName);

    const dot = document.createElement('span');
    dot.className = 'field-help';
    dot.tabIndex = 0;
    dot.setAttribute('role', 'img');
    dot.setAttribute('aria-label', `Help: ${help}`);
    dot.setAttribute('data-tip', help);
    dot.title = help;
    dot.textContent = '?';
    dot.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });

    const noWrap = control.closest('.modal-header, .terminal-container, .terminal-footer, .builder-field, .builder-kv-row, .builder-row, .builder-list-row, .compose-builder-card, .manual-layout');
    if (labelFor) {
      labelFor.appendChild(dot);
    } else if (wrappingLabel) {
      wrappingLabel.appendChild(dot);
    } else if (!noWrap && control.parentElement && type !== 'checkbox' && type !== 'radio') {
      const wrap = document.createElement('span');
      wrap.className = 'field-wrap';
      if (control.tagName === 'TEXTAREA') wrap.classList.add('field-wrap-block');
      if (control.classList.contains('flex')) wrap.classList.add('field-wrap-grow');
      wrap.classList.toggle('hidden', control.classList.contains('hidden'));
      const labelRow = document.createElement('span');
      labelRow.className = 'field-label-row';
      const label = document.createElement('span');
      label.className = 'field-label-text';
      label.textContent = fieldName;
      labelRow.appendChild(label);
      labelRow.appendChild(dot);
      control.parentElement.insertBefore(wrap, control);
      wrap.appendChild(labelRow);
      wrap.appendChild(control);
    } else {
      control.insertAdjacentElement('afterend', dot);
    }
    control.dataset.helpDecorated = '1';
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
    return String(value).replace(/["\\]/g, '\\$&');
  }

  function decorateFields(root) {
    const scope = root && root.querySelectorAll ? root : document;
    scope.querySelectorAll('input, select, textarea').forEach(decorateField);
    if (root && root.matches && root.matches('input, select, textarea')) decorateField(root);
  }

  function sectionButton(key, label) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn manual-help-btn';
    btn.textContent = '?';
    btn.title = `Open instructions for ${label}`;
    btn.setAttribute('aria-label', `Open instructions for ${label}`);
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openManual(key);
    });
    return btn;
  }

  function addSectionHelp() {
    document.querySelectorAll('section.tab-pane').forEach((section) => {
      const key = SECTION_HELP[section.id];
      if (!key) return;
      const header = section.querySelector('.section-header');
      if (!header || header.querySelector('.manual-help-btn')) return;
      const entry = MANUAL[key];
      const btn = sectionButton(key, entry?.title || key);
      const inline = header.querySelector('.inline') || header;
      inline.appendChild(btn);
    });

    document.querySelectorAll('#tab-appcreation .subtab-pane, #tab-settings .settings-pane').forEach((pane) => {
      const key = manualKeyForPane(pane);
      if (!key || pane.querySelector('.manual-section-bar')) return;
      const entry = MANUAL[key];
      const bar = document.createElement('div');
      bar.className = 'manual-section-bar';
      const text = document.createElement('span');
      text.textContent = 'Need help with this section?';
      bar.appendChild(text);
      bar.appendChild(sectionButton(key, entry?.title || key));
      pane.prepend(bar);
    });

    document.querySelectorAll('#tab-appcreation .card, #tab-settings .card').forEach((card) => {
      const heading = card.querySelector('h3, h4');
      if (!heading || heading.querySelector('.manual-inline-help')) return;
      const pane = card.closest('.settings-pane, .subtab-pane, .tab-pane');
      let key = manualKeyForPane(pane);
      if (!key) key = pane?.id === 'tab-appcreation' ? 'app-config-modal' : null;
      if (!key || !MANUAL[key]) return;
      const entry = MANUAL[key];
      const btn = sectionButton(key, entry.title);
      btn.classList.add('manual-inline-help');
      heading.appendChild(btn);
    });
  }

  function wireManual() {
    const openBtn = document.getElementById('openManualBtn');
    if (openBtn && !openBtn.dataset.manualWired) {
      openBtn.dataset.manualWired = '1';
      openBtn.addEventListener('click', (event) => {
        event.preventDefault();
        openManual('index');
      });
    }
    document.querySelectorAll('[data-open-manual]').forEach((btn) => {
      if (btn.dataset.manualWired) return;
      btn.dataset.manualWired = '1';
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        openManual('index');
      });
    });
    const nav = document.getElementById('manualNav');
    if (nav && !nav.dataset.manualWired) {
      nav.dataset.manualWired = '1';
      nav.addEventListener('click', (event) => {
        const link = event.target.closest('[data-manual-key]');
        if (!link) return;
        openManual(link.dataset.manualKey);
      });
    }
    const content = document.getElementById('manualContent');
    if (content && !content.dataset.manualWired) {
      content.dataset.manualWired = '1';
      content.addEventListener('click', (event) => {
        const link = event.target.closest('[data-manual-key]');
        if (!link) return;
        event.preventDefault();
        openManual(link.dataset.manualKey);
      });
    }
  }

  function init() {
    addSectionHelp();
    decorateFields(document);
    wireManual();
    let sectionHelpTimer = null;
    const scheduleSectionHelp = () => {
      if (sectionHelpTimer) return;
      sectionHelpTimer = window.setTimeout(() => {
        sectionHelpTimer = null;
        addSectionHelp();
      }, 150);
    };
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes') {
          const control = mutation.target;
          if (control.matches?.('input, select, textarea')) {
            const wrap = control.closest('.field-wrap');
            if (wrap) wrap.classList.toggle('hidden', control.classList.contains('hidden'));
          }
          continue;
        }
        let addedElement = false;
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== 1) continue;
          addedElement = true;
          decorateFields(node);
        }
        if (addedElement) scheduleSectionHelp();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  }

  window.DokManual = {
    open: openManual,
    decorateFields,
    sections: Object.keys(MANUAL),
    helpFor: (key) => FIELD_HELP[key] || FIELD_HELP[String(key || '').toLowerCase()] || '',
    labelFor: (key) => FIELD_LABEL[key] || ''
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
