import express from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import multer from 'multer';
import pty from 'node-pty';
import { WebSocketServer } from 'ws';
import {
  DOK_ROOT, DOK_COMPOSE_ROOT, HOST_ROOT, MAINT_DATA, DOK_CONTAINER, DOK_PORT, DOK_IMAGE, DOK_HOST_PATH,
  MAINTENANCE_URL, DEFAULT_NETWORK, dataDir, appsDir, coreDir, sourcesDir, uploadsDir,
  backupsDir, snapshotsDir, logsDir, opencodeDir, installationPath, installationStatePath, tokenPath,
  ensureDirs, readJson, writeJson, writePrivateFile, run, tail, randomSecret, yamlScalar,
  normalizeDomain, validDomain, projectName, credentialsKey, readSettings, writeSettings,
  writeRegistriesFromPlan, readRegistries, readRegistry, readInstallation, saveInstallation,
  installationState, refreshInstallationState, dokOwner, chownDokPath, chownTree,
  docker, dockerInspect, dokStatus, dockerJson, containerList, ensureNetwork, dokApi,
  waitForDok, maintenanceToken, CORE_CATEGORIES, normalizeInstallPlan, validateInstallPlan,
  selectedServiceIds, baseSettings, ensurePlanDirectories, listCoreServices, listApps,
  installationSummary, writeInstallationCompose, captureSnapshot, listSnapshots,
  listBackups, createBackup, restoreArchive, repairInstallation, systemInfo, dockerInfo,
  maintenanceVersion, installationExists
} from './lib.js';

ensureDirs();
credentialsKey({ create: true }).toString('base64');
// Never expose the API unauthenticated just because setup.sh has not created
// the token yet.
maintenanceToken({ create: true });

const app = express();
const upload = multer({ dest: path.join(MAINT_DATA, 'tmp'), limits: { fileSize: 1024 * 1024 * 1024, files: 5 } });
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(DOK_ROOT, 'public', 'maintenance'), { etag: false, maxAge: 0 }));
app.use(express.static('/app/public/maintenance', { etag: false, maxAge: 0 }));
app.use('/vendor/xterm', express.static('/app/node_modules/@xterm/xterm'));
app.use('/vendor/xterm-fit', express.static('/app/node_modules/@xterm/addon-fit'));
app.use('/vendor/xterm', express.static(path.join(DOK_ROOT, 'node_modules/@xterm/xterm')));
app.use('/vendor/xterm-fit', express.static(path.join(DOK_ROOT, 'node_modules/@xterm/addon-fit')));

const MAINTENANCE_REQUIRE_TOKEN = process.env.MAINTENANCE_REQUIRE_TOKEN === '1';
const MAINTENANCE_PORT = Number(process.env.MAINTENANCE_PORT) || 8090;
const SESSION_LIMIT = 6;
const SESSION_BUFFER_LIMIT = 2 * 1024 * 1024;
const SESSION_IDLE_MS = 30 * 60 * 1000;
const sessions = new Map();
let installJob = null;
let updateJob = null;
let logCache = [];

function logLine(level, message) {
  const line = `${new Date().toISOString()} [${level}] ${String(message).replace(/\r?\n/g, '\n    ')}`;
  logCache.push(line);
  if (logCache.length > 3000) logCache.splice(0, logCache.length - 3000);
  try { fs.appendFileSync(path.join(logsDir, 'maintenance.log'), line + '\n', { mode: 0o600 }); } catch {}
  process.stdout.write(line + '\n');
}

function authorized(req) {
  if (!MAINTENANCE_REQUIRE_TOKEN) return true;
  const expected = maintenanceToken();
  if (!expected) return true;
  const header = String(req.headers.authorization || '');
  if (header === `Bearer ${expected}`) return true;
  const query = String(req.query?.token || '');
  if (query === expected) return true;
  const cookie = String(req.headers.cookie || '');
  const match = cookie.match(/(?:^|;\s*)dok_maintenance_token=([^;]+)/);
  if (match && decodeURIComponent(match[1]) === expected) return true;
  return false;
}

app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  if (req.path === '/api/health') return next();
  if (!authorized(req)) {
    return res.status(401).json({ error: 'Maintenance authentication required', needsToken: true });
  }
  next();
});

function api(handler) {
  return (req, res) => {
    Promise.resolve(handler(req, res)).catch(e => {
      const status = e.status || 500;
      logLine('ERROR', `${req.method} ${req.path}: ${e.message}`);
      res.status(status).json({
        error: e.message,
        stdout: tail(e.stdout || ''),
        stderr: tail(e.stderr || ''),
        needsOverwrite: !!e.needsOverwrite
      });
    });
  };
}

function jobSnapshot(job) {
  if (!job) return null;
  return {
    running: job.running,
    phase: job.phase,
    started: job.started,
    finished: job.finished,
    log: tail(job.log.join('\n'), 200000),
    result: job.result || null,
    error: job.error || ''
  };
}

// ---------- health/status ----------
app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'dok-maintenance', version: maintenanceVersion(), tokenRequired: MAINTENANCE_REQUIRE_TOKEN });
});

app.get('/api/system', api(async (req, res) => {
  const [dok, containers, info] = await Promise.all([
    dokStatus().catch(e => ({ exists: false, running: false, error: e.message })),
    containerList().catch(() => []),
    dockerInfo().catch(e => ({ error: e.message }))
  ]);
  const state = installationState();
  res.json({
    ok: true,
    version: maintenanceVersion(),
    system: systemInfo(),
    docker: info,
    dok,
    containers,
    installation: {
      exists: installationExists(),
      state: state ? { updated: state.updated, id: state.installationId, summary: state.summary || state.counts || null } : null,
      summary: installationSummary(),
      core: listCoreServices(),
      apps: listApps(),
      tokenRequired: MAINTENANCE_REQUIRE_TOKEN,
      root: DOK_ROOT,
      dataRoot: MAINT_DATA,
      hostPath: DOK_HOST_PATH,
      maintenanceUrl: MAINTENANCE_URL
    },
    services: CORE_CATEGORIES,
    snapshots: listSnapshots().slice(0, 5),
    backups: listBackups().slice(0, 5)
  });
}));

app.get('/api/containers', api(async (req, res) => {
  const list = await containerList();
  res.json({ ok: true, containers: list.map(item => ({
    ...item,
    dok: item.name === DOK_CONTAINER,
    maintenance: item.name === 'wickedafdok-maintenance'
  })) });
}));

app.post('/api/containers/:id/:action(start|stop|restart)', api(async (req, res) => {
  const { id, action } = req.params;
  await docker([action, id]);
  res.json({ ok: true, message: `Container ${action} requested.` });
}));

app.get('/api/apps', api(async (req, res) => {
  const registry = readRegistry();
  const containers = await containerList().catch(() => []);
  const apps = listApps().map(app => {
    const labelApp = projectName(app.name);
    const containersForApp = containers.filter(item => item.labels?.['dok.app'] === labelApp ||
      item.labels?.['com.docker.compose.project'] === `app-${app.name}` ||
      item.labels?.['com.docker.compose.project'] === projectName(app.name));
    return {
      ...app,
      running: containersForApp.some(item => item.state === 'running'),
      containers: containersForApp.map(item => ({ name: item.name, state: item.state, status: item.status }))
    };
  });
  res.json({ ok: true, apps, registry });
}));

app.post('/api/apps/:id/:action(deploy|start|stop|restart)', api(async (req, res) => {
  const id = encodeURIComponent(req.params.id);
  const action = req.params.action;
  const out = await dokApi(`/api/registry/${id}/${action}`, {
    method: 'POST',
    body: action === 'deploy' ? { confirmAmend: req.body?.confirmAmend === true } : {},
    timeout: 600000
  });
  res.json({ ok: true, ...out, apps: listApps() });
}));

// ---------- installer ----------
app.get('/api/install', api(async (req, res) => {
  const saved = readInstallation() || {};
  const state = installationState();
  const dok = await dokStatus().catch(() => ({ exists: false, running: false }));
  res.json({
    ok: true,
    dok,
    installation: {
      exists: !!readInstallation(),
      saved: {
        id: saved.id || '',
        created: saved.created || '',
        updated: saved.updated || '',
        type: saved.type || '',
        plan: saved.plan || null,
        summary: saved.summary || null,
        completedAt: saved.completedAt || ''
      },
      stateSummary: state?.summary || null,
      snapshots: listSnapshots().length
    },
    services: CORE_CATEGORIES,
    discovered: {
      dokDomain: readSettings().defaults?.dokDomain || readSettings().services?.nginxProxy?.domain || '',
      primaryDomain: readSettings().defaults?.primaryDomain || '',
      dataLocation: readSettings().defaults?.dataLocation || '',
      adminUser: readSettings().defaults?.adminUser || 'admin',
      adminEmail: readSettings().defaults?.adminEmail || '',
      coreServices: listCoreServices()
    },
    defaults: {
      dataMode: '0775',
      allowOutsideData: true,
      autoAppData: true,
      defaultNetwork: DEFAULT_NETWORK
    }
  });
}));

app.post('/api/install/validate', api(async (req, res) => {
  const plan = normalizeInstallPlan(req.body || {});
  const issues = validateInstallPlan(plan);
  res.json({ ok: issues.length === 0, issues, plan: { type: plan.type, services: plan.services, defaults: { ...plan.defaults, adminPassword: plan.defaults.adminPassword ? 'set' : '' } } });
}));

async function launchDok({ build = true } = {}) {
  const compose = path.join(DOK_COMPOSE_ROOT, 'docker-compose.yml');
  if (!fs.existsSync(compose)) throw new Error(`Dok compose file was not found at ${compose}`);
  const args = ['compose', '-p', 'wickedafdok', '-f', compose];
  const override = path.join(DOK_COMPOSE_ROOT, 'docker-compose.override.yml');
  if (fs.existsSync(override)) args.push('-f', override);
  const socketOverride = path.join(DOK_COMPOSE_ROOT, 'data', '.docker-socket-gid.yml');
  if (fs.existsSync(socketOverride)) args.push('-f', socketOverride);
  args.push('up', '-d', '--remove-orphans');
  if (build) args.push('--build');
  const result = await run('docker', args, { cwd: DOK_COMPOSE_ROOT, timeout: 0 });
  return result;
}

async function configureServices(plan, log) {
  const results = [];
  const defaults = plan.defaults || {};
  const primary = normalizeDomain(defaults.primaryDomain || '');
  const dokDomain = normalizeDomain(plan.dokDomain || defaults.dokDomain || '');
  const authDomain = normalizeDomain(plan.authDomain || (primary ? `auth.${primary}` : ''));
  const service = plan.services || {};
  const record = (name, ok, detail) => {
    results.push({ name, ok, detail: String(detail || '').slice(0, 2000) });
    log(`${ok ? 'OK' : 'WARN'} ${name}: ${detail}`);
  };

  if (service.proxy === 'nginx-proxy') {
    try {
      const out = await dokApi('/api/core/nginx-proxy/run', {
        method: 'POST',
        timeout: 300000,
        body: {
          network: defaults.defaultNetwork || DEFAULT_NETWORK,
          domain: dokDomain,
          acme: { enabled: !!plan.acmeEmail, email: plan.acmeEmail || '', staging: false }
        }
      });
      record('nginx-proxy', true, out.message || 'Launched');
    } catch (e) { record('nginx-proxy', false, e.message); }
  }

  if (service.dns) {
    try {
      const provider = service.dns === 'adguard' ? 'adguard' : 'technitium';
      const out = await dokApi('/api/core/dns/run', {
        method: 'POST',
        timeout: 300000,
        body: {
          provider,
          domain: normalizeDomain(plan.dnsDomain || (primary ? `dns.${primary}` : '')),
          webPort: provider === 'adguard' ? Number(plan.dnsWebPort) || 3000 : undefined,
          dnsPort: Number(plan.dnsPort) || 53,
          adminPassword: plan.adminPassword || defaults.adminPassword || ''
        }
      });
      record('DNS', true, out.message || 'Launched');
    } catch (e) { record('DNS', false, e.message); }
  }

  if (service.mail === 'mailpit') {
    try {
      const out = await dokApi('/api/core/mailpit/run', {
        method: 'POST',
        timeout: 300000,
        body: {
          smtpPort: Number(plan.mailpitSmtpPort) || 1025,
          webPort: Number(plan.mailpitWebPort) || 8025,
          maxMessages: Number(plan.mailpitMaxMessages) || 500,
          domain: normalizeDomain(plan.mailDomain || (primary ? `mail.${primary}` : ''))
        }
      });
      record('Mailpit', true, out.message || 'Launched');
      await dokApi('/api/core/mail/use-mailpit', { method: 'POST', body: {} }).catch(() => {});
    } catch (e) { record('Mailpit', false, e.message); }
  } else if (service.mail === 'stalwart') {
    try {
      const out = await dokApi('/api/core/stalwart/run', {
        method: 'POST',
        timeout: 300000,
        body: {
          domain: normalizeDomain(plan.mailDomain || (primary ? `mail.${primary}` : '')),
          adminUser: plan.stalwartAdminUser || 'admin',
          adminPassword: plan.stalwartAdminPassword || defaults.adminPassword || '',
          webPort: Number(plan.stalwartWebPort) || 8088,
          smtpPort: Number(plan.stalwartSmtpPort) || 25,
          submissionPort: Number(plan.stalwartSubmissionPort) || 587,
          imapsPort: Number(plan.stalwartImapsPort) || 993
        }
      });
      record('Stalwart', true, out.message || 'Launched');
    } catch (e) { record('Stalwart', false, e.message); }
  } else if (service.mail === 'smtp') {
    try {
      const out = await dokApi('/api/core/mail/smtp', {
        method: 'POST',
        timeout: 120000,
        body: {
          host: plan.smtpHost,
          port: Number(plan.smtpPort) || 587,
          tls: plan.smtpTls || 'starttls',
          username: plan.smtpUser || '',
          password: plan.smtpPassword || '',
          sender: plan.smtpFrom || ''
        }
      });
      record('SMTP', true, out.message || 'Saved');
    } catch (e) { record('SMTP', false, e.message); }
  }

  if (service.auth === 'authelia') {
    try {
      const out = await dokApi('/api/core/authelia/run', {
        method: 'POST',
        timeout: 300000,
        body: {
          domain: authDomain,
          adminUser: plan.adminUser || defaults.adminUser || 'admin',
          adminEmail: plan.adminEmail || defaults.adminEmail || '',
          adminPassword: plan.adminPassword || defaults.adminPassword || ''
        }
      });
      record('Authelia', true, out.message || 'Launched');
      if (plan.protectDok && dokDomain) {
        try {
          const protection = await dokApi('/api/core/authelia/dok-protection', { method: 'POST', body: { protect: true } });
          record('Authelia Dok protection', true, protection.message || 'Enabled');
        } catch (e) {
          record('Authelia Dok protection', false, e.message);
        }
      }
      await dokApi('/api/core/authelia/sync', { method: 'POST', body: {} }).catch(() => {});
    } catch (e) { record('Authelia', false, e.message); }
  } else if (service.auth === 'authentik') {
    try {
      const out = await dokApi('/api/core/auth/run', {
        method: 'POST',
        timeout: 300000,
        body: {
          domain: authDomain,
          port: Number(plan.authPort) || 9000,
          adminEmail: plan.adminEmail || defaults.adminEmail || '',
          adminPassword: plan.adminPassword || defaults.adminPassword || ''
        }
      });
      record('Authentik', true, out.message || 'Launched');
    } catch (e) { record('Authentik', false, e.message); }
  }

  if (service.tunnel === 'cloudflared') {
    try {
      const out = await dokApi('/api/core/cloudflared/run', {
        method: 'POST',
        timeout: 300000,
        body: { token: plan.cloudflareToken || '' }
      });
      record('cloudflared', true, out.message || 'Launched');
    } catch (e) { record('cloudflared', false, e.message); }
  }

  return results;
}

async function runInstall(plan) {
  const job = installJob;
  const log = (message) => {
    job.log.push(`${new Date().toISOString()} ${message}`);
    logLine('INFO', message);
  };
  const phase = (value) => { job.phase = value; log(`Phase: ${value}`); };
  try {
    const issues = validateInstallPlan(plan);
    if (issues.length) throw new Error(issues.join(' '));
    phase('prepare');
    ensureDirs();
    await ensureNetwork(plan.defaults.defaultNetwork || DEFAULT_NETWORK);
    await ensurePlanDirectories(plan);

    phase('write-configuration');
    const existing = readSettings();
    const fresh = baseSettings(plan);
    const settings = {
      ...fresh,
      ...existing,
      services: { ...fresh.services, ...(existing.services || {}) },
      defaults: { ...fresh.defaults, ...existing.defaults, ...plan.defaults },
      designer: { ...fresh.designer, ...(existing.designer || {}) },
      installation: {
        installedAt: existing.installation?.installedAt || new Date().toISOString(),
        installedBy: 'dok-maintenance',
        type: plan.type,
        lastInstallAt: new Date().toISOString()
      }
    };
    if (plan.dokDomain || plan.defaults.dokDomain) {
      settings.services.nginxProxy = {
        ...(settings.services.nginxProxy || {}),
        domain: normalizeDomain(plan.dokDomain || plan.defaults.dokDomain)
      };
    }
    if (plan.acmeEmail) {
      settings.services.nginxProxy = {
        ...(settings.services.nginxProxy || {}),
        acme: { enabled: true, email: plan.acmeEmail, staging: false }
      };
    }
    if (plan.adminPassword) settings.services.opencode = { ...(settings.services.opencode || {}) };
    writeSettings(settings);
    if (plan.registries.length) writeRegistriesFromPlan(plan);
    if (!fs.existsSync(path.join(dataDir, 'registry.json'))) writeJson(path.join(dataDir, 'registry.json'), []);
    if (!fs.existsSync(path.join(dataDir, 'groups.json'))) writeJson(path.join(dataDir, 'groups.json'), { groups: [] });
    if (!fs.existsSync(path.join(dataDir, 'auth.json'))) writeJson(path.join(dataDir, 'auth.json'), { enabled: false, users: [] });
    chownTree(path.join(dataDir, 'wickedafdok'));
    chownDokPath(path.join(dataDir, '.credentials-key'));
    log('Configuration written to data/.');

    const saved = saveInstallation({
      type: plan.type,
      plan: {
        type: plan.type,
        defaults: { ...plan.defaults, adminPassword: plan.defaults.adminPassword ? '(stored in encrypted settings)' : '' },
        services: plan.services,
        selected: [...selectedServiceIds(plan)],
        registries: plan.registries.map(item => ({ kind: item.kind, provider: item.provider, name: item.name, host: item.host, username: item.username }))
      },
      summary: installationSummary(),
      completedAt: ''
    });
    log(`Installation record ${saved.id} created.`);

    phase('launch-dok');
    const status = await dokStatus().catch(() => ({ exists: false, running: false }));
    if (!status.running) {
      const out = await launchDok({ build: true });
      log((out.stdout || '').trim().slice(-4000) || 'Dok image built and container started.');
    } else {
      log('Dok is already running; using the existing container.');
    }

    phase('wait-for-dok');
    await waitForDok(300000);
    log(`Dok is healthy at http://${DOK_CONTAINER}:${DOK_PORT}.`);

    let serviceResults = [];
    if (plan.type === 'core') {
      phase('configure-core-services');
      serviceResults = await configureServices(plan, log);
    } else {
      log('Standalone installation selected; core service configuration skipped.');
    }

    phase('record-snapshot');
    writeInstallationCompose();
    try { refreshInstallationState(); } catch {}
    const snapshot = await captureSnapshot({ reason: 'install', label: 'Initial installation snapshot' }).catch(e => {
      log(`Snapshot warning: ${e.message}`);
      return null;
    });
    if (snapshot) log(`Installation snapshot ${snapshot.id} captured.`);
    saveInstallation({
      type: plan.type,
      plan: {
        type: plan.type,
        defaults: { ...plan.defaults, adminPassword: plan.defaults.adminPassword ? '(stored in encrypted settings)' : '' },
        services: plan.services,
        selected: [...selectedServiceIds(plan)],
        registries: plan.registries.map(item => ({ kind: item.kind, provider: item.provider, name: item.name, host: item.host, username: item.username }))
      },
      summary: installationSummary(),
      completedAt: new Date().toISOString(),
      dok: { url: plan.dokDomain ? `http://${plan.dokDomain}` : `http://localhost:8080`, container: DOK_CONTAINER },
      services: serviceResults
    });

    phase('done');
    const failures = serviceResults.filter(item => !item.ok);
    job.result = {
      ok: failures.length === 0,
      dokUrl: plan.dokDomain ? `http://${plan.dokDomain}` : `http://localhost:8080`,
      dokIp: `http://${DOK_CONTAINER}:${DOK_PORT}`,
      type: plan.type,
      services: serviceResults,
      warnings: failures,
      snapshot: snapshot ? snapshot.id : '',
      message: failures.length
        ? `Dok is running. ${failures.length} core service${failures.length === 1 ? '' : 's'} reported an issue; review the log.`
        : 'Installation completed. Dok is running.'
    };
    job.running = false;
    job.finished = new Date().toISOString();
    log(job.result.message);
  } catch (e) {
    job.error = e.message;
    job.phase = 'error';
    job.running = false;
    job.finished = new Date().toISOString();
    log(`Installation failed: ${e.message}`);
  }
}

app.post('/api/install/run', api(async (req, res) => {
  if (installJob?.running) return res.status(409).json({ error: 'An installation is already running', job: jobSnapshot(installJob) });
  const plan = normalizeInstallPlan(req.body || {});
  const issues = validateInstallPlan(plan);
  if (issues.length) return res.status(400).json({ error: issues.join(' '), issues });
  installJob = {
    running: true,
    phase: 'starting',
    started: new Date().toISOString(),
    finished: '',
    log: [],
    result: null,
    error: ''
  };
  runInstall(plan);
  res.json({ ok: true, started: true, job: jobSnapshot(installJob) });
}));

app.get('/api/install/status', (req, res) => {
  res.json({ ok: true, job: jobSnapshot(installJob) });
});

app.post('/api/install/reinstall', api(async (req, res) => {
  const id = String(req.body?.snapshotId || '').trim();
  const snapshots = listSnapshots();
  const target = id ? snapshots.find(item => item.id === id) : snapshots[0];
  if (!target) return res.status(404).json({ error: 'No installation snapshot is available for an exact reinstall. Create a backup first.' });
  const result = await restoreArchive(target.archive, { overwrite: true, restart: true });
  await waitForDok(300000).catch(() => {});
  const start = await dokApi('/api/core/all/start', { method: 'POST', body: {} }).catch(e => ({ error: e.message }));
  refreshInstallationState();
  saveInstallation({ completedAt: new Date().toISOString(), reinstall: { snapshot: target.id, at: new Date().toISOString() }, summary: installationSummary() });
  res.json({ ok: true, ...result, coreStart: start.error ? { error: start.error } : { ok: true }, message: 'Exact reinstall completed from the saved installation snapshot.' });
}));

// ---------- maintenance lifecycle ----------
app.get('/api/maintenance', api(async (req, res) => {
  const mode = readJson(path.join(MAINT_DATA, 'mode.json'), {}) || {};
  res.json({
    ok: true,
    maintenance: true,
    active: mode.active !== false,
    url: MAINTENANCE_URL,
    tokenRequired: MAINTENANCE_REQUIRE_TOKEN,
    version: maintenanceVersion()
  });
}));

app.post('/api/maintenance/sync', api(async (req, res) => {
  let dok = null;
  try {
    dok = await dokApi('/api/installation/sync', { method: 'POST', body: { snapshot: req.body?.snapshot === true }, timeout: 120000 });
  } catch (e) {
    logLine('WARN', `Dok installation sync failed: ${e.message}`);
  }
  const state = refreshInstallationState();
  res.json({ ok: true, state: state ? { updated: state.updated, summary: state.summary || null } : null, dok });
}));

app.post('/api/maintenance/stop', api(async (req, res) => {
  writeJson(path.join(MAINT_DATA, 'mode.json'), { active: false, updated: new Date().toISOString() });
  res.json({ ok: true, message: 'Maintenance container is shutting down.' });
  setTimeout(() => {
    docker(['stop', 'wickedafdok-maintenance']).catch(() => process.exit(0));
  }, 1200);
}));

app.post('/api/maintenance/mode', api(async (req, res) => {
  const active = req.body?.active !== false;
  const restartDok = req.body?.restartDok === true;
  writeJson(path.join(MAINT_DATA, 'mode.json'), { active, updated: new Date().toISOString() });
  if (!active) {
    const status = await dokStatus().catch(() => ({ exists: false }));
    if (status.exists && !status.running) {
      await docker(['start', DOK_CONTAINER]).catch(() => {});
    }
    if (restartDok && status.exists) await docker(['restart', DOK_CONTAINER]).catch(() => {});
    res.json({ ok: true, active: false, message: 'Dok is running. Maintenance will shut down.' });
    setTimeout(() => { docker(['stop', 'wickedafdok-maintenance']).catch(() => process.exit(0)); }, 1500);
    return;
  }
  res.json({ ok: true, active: true, message: 'Maintenance mode is active.' });
}));

// ---------- installation state / snapshots ----------
app.get('/api/installation', api(async (req, res) => {
  const saved = readInstallation() || {};
  const state = installationState();
  res.json({ ok: true, installation: saved, state, summary: installationSummary(), snapshots: listSnapshots() });
}));

app.post('/api/installation/sync', api(async (req, res) => {
  const state = refreshInstallationState();
  const snapshot = req.body?.snapshot === true
    ? await captureSnapshot({ reason: 'manual-sync', label: 'Maintenance sync snapshot' })
    : null;
  res.json({ ok: true, state: state ? { updated: state.updated, summary: state.summary || null } : null, snapshot });
}));

app.get('/api/installation/export', api(async (req, res) => {
  const state = installationState() || {};
  res.setHeader('content-type', 'application/json');
  res.setHeader('content-disposition', `attachment; filename="dok-installation-${Date.now()}.json"`);
  res.send(JSON.stringify({ ...state, exported: new Date().toISOString() }, null, 2));
}));

app.post('/api/snapshots', api(async (req, res) => {
  const meta = await captureSnapshot({ reason: 'manual', label: req.body?.label || '' });
  res.json({ ok: true, snapshot: meta });
}));

app.get('/api/snapshots', api(async (req, res) => {
  res.json({ ok: true, snapshots: listSnapshots() });
}));

app.get('/api/snapshots/:id/download', api(async (req, res) => {
  const meta = listSnapshots().find(item => item.id === req.params.id);
  if (!meta) return res.status(404).json({ error: 'Snapshot not found' });
  res.download(meta.archive, `dok-snapshot-${meta.id}.tar.gz`);
}));

app.post('/api/snapshots/:id/restore', api(async (req, res) => {
  const meta = listSnapshots().find(item => item.id === req.params.id);
  if (!meta) return res.status(404).json({ error: 'Snapshot not found' });
  const result = await restoreArchive(meta.archive, {
    overwrite: req.body?.overwrite === true,
    restart: req.body?.restart !== false
  });
  res.json({ ok: true, ...result });
}));

app.delete('/api/snapshots/:id', api(async (req, res) => {
  const meta = listSnapshots().find(item => item.id === req.params.id);
  if (!meta) return res.status(404).json({ error: 'Snapshot not found' });
  try { fs.rmSync(meta.archive, { force: true }); } catch {}
  try { fs.rmSync(path.join(snapshotsDir, `${meta.id}.json`), { force: true }); } catch {}
  res.json({ ok: true });
}));

// ---------- backups ----------
app.get('/api/backups', api(async (req, res) => {
  res.json({ ok: true, backups: listBackups() });
}));

app.post('/api/backups', api(async (req, res) => {
  const meta = await createBackup({
    name: req.body?.name || '',
    includeLogs: req.body?.includeLogs !== false
  });
  res.json({ ok: true, backup: meta, backups: listBackups() });
}));

app.get('/api/backups/:id/download', api(async (req, res) => {
  const meta = listBackups().find(item => item.id === req.params.id);
  if (!meta) return res.status(404).json({ error: 'Backup not found' });
  res.download(meta.archive, `dok-backup-${meta.id}.tar.gz`);
}));

app.delete('/api/backups/:id', api(async (req, res) => {
  const meta = listBackups().find(item => item.id === req.params.id);
  if (!meta) return res.status(404).json({ error: 'Backup not found' });
  try { fs.rmSync(meta.archive, { force: true }); } catch {}
  try { fs.rmSync(path.join(backupsDir, `${meta.id}.json`), { force: true }); } catch {}
  res.json({ ok: true, backups: listBackups() });
}));

app.post('/api/backups/:id/restore', api(async (req, res) => {
  const meta = listBackups().find(item => item.id === req.params.id);
  if (!meta) return res.status(404).json({ error: 'Backup not found' });
  const result = await restoreArchive(meta.archive, {
    overwrite: req.body?.overwrite === true,
    restart: req.body?.restart !== false
  });
  res.json({ ok: true, ...result });
}));

app.post('/api/backups/import', upload.single('file'), api(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose a backup archive' });
  const id = `${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${randomSecret(3)}`;
  const target = path.join(backupsDir, `${id}.tar.gz`);
  try {
    await run('tar', ['-tzf', req.file.path]);
    fs.copyFileSync(req.file.path, target);
    fs.chmodSync(target, 0o600);
    const meta = {
      id,
      schema: 'wickedafdok.maintenance-backup/v1',
      kind: 'backup',
      name: String(req.body?.name || req.file.originalname || `Imported backup ${id}`).slice(0, 100),
      created: new Date().toISOString(),
      imported: true,
      size: fs.statSync(target).size,
      archive: target,
      installationState: installationSummary()
    };
    writeJson(path.join(backupsDir, `${id}.json`), meta);
    res.json({ ok: true, backup: meta, backups: listBackups() });
  } finally {
    try { fs.rmSync(req.file.path, { force: true }); } catch {}
  }
}));

// ---------- updates ----------
function updateSnapshot() {
  if (!updateJob) return null;
  return jobSnapshot(updateJob);
}

async function runUpdate({ repo = '', branch = '', force = false }) {
  const job = updateJob;
  const log = (message) => {
    job.log.push(`${new Date().toISOString()} ${message}`);
    logLine('INFO', `[update] ${message}`);
  };
  try {
    job.running = true;
    job.phase = 'checking';
    if (repo && /^(https?:\/\/|git:\/\/|ssh:\/\/|git@)[^\s]+$/.test(repo)) {
      await run('git', ['remote', 'set-url', 'origin', repo], { cwd: DOK_ROOT }).catch(async () => {
        await run('git', ['remote', 'add', 'origin', repo], { cwd: DOK_ROOT });
      });
    }
    let resolvedBranch = branch;
    if (!resolvedBranch) {
      try { resolvedBranch = (await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: DOK_ROOT })).stdout.trim(); } catch {}
    }
    if (!resolvedBranch || resolvedBranch === 'HEAD') resolvedBranch = 'main';
    const dirty = (await run('git', ['status', '--porcelain'], { cwd: DOK_ROOT }).catch(() => ({ stdout: '' }))).stdout.trim();
    if (dirty && !force) {
      const err = new Error('The checkout has local changes. Re-run with force to discard them, or commit them first.');
      err.status = 409;
      err.dirty = true;
      throw err;
    }
    log(`Fetching ${resolvedBranch}...`);
    job.phase = 'fetching';
    try {
      await run('git', ['fetch', 'origin', resolvedBranch], { cwd: DOK_ROOT });
    } catch {
      await run('git', ['fetch', '--all', '--prune'], { cwd: DOK_ROOT });
    }
    job.phase = 'checkout';
    try {
      const out = await run('git', ['merge', '--ff-only', `origin/${resolvedBranch}`], { cwd: DOK_ROOT });
      log(out.stdout.trim() || 'Already up to date.');
    } catch (e) {
      if (!force) {
        const err = new Error(`Cannot fast-forward to origin/${resolvedBranch}. Re-run with force to reset the checkout.`);
        err.status = 409;
        throw err;
      }
      await run('git', ['reset', '--hard', `origin/${resolvedBranch}`], { cwd: DOK_ROOT });
      log('Checkout reset to origin.');
    }
    const commit = (await run('git', ['rev-parse', '--short', 'HEAD'], { cwd: DOK_ROOT }).catch(() => ({ stdout: '' }))).stdout.trim();
    job.phase = 'building';
    log(`Building Dok image at ${commit || 'HEAD'}...`);
    const composeArgs = ['compose', '-p', 'wickedafdok', '-f', path.join(DOK_COMPOSE_ROOT, 'docker-compose.yml')];
    for (const name of ['docker-compose.override.yml', 'data/.docker-socket-gid.yml']) {
      if (fs.existsSync(path.join(DOK_COMPOSE_ROOT, name))) composeArgs.push('-f', path.join(DOK_COMPOSE_ROOT, name));
    }
    const built = await run('docker', [...composeArgs, 'build'], { cwd: DOK_COMPOSE_ROOT, timeout: 0 });
    log(tail(built.stdout || built.stderr, 12000));
    job.phase = 'recreating';
    log('Recreating Dok...');
    await run('docker', [...composeArgs, 'up', '-d', '--remove-orphans'], { cwd: DOK_COMPOSE_ROOT, timeout: 0 });
    job.phase = 'waiting';
    await waitForDok(300000).catch(() => {});
    try { await dokApi('/api/installation/sync', { method: 'POST', body: { snapshot: true }, timeout: 120000 }); } catch {}
    // The update rebuilt the shared image. Recreate the Maintenance container
    // after this request finishes so its next start uses the new image.
    try {
      const generated = path.join(dataDir, 'wickedafdok', 'maintenance', 'docker-compose.yml');
      const composeFile = fs.existsSync(generated) ? generated : path.join(DOK_ROOT, 'maintenance', 'docker-compose.yml');
      if (fs.existsSync(composeFile)) {
        const socket = process.env.DOCKER_SOCK || '/var/run/docker.sock';
        const owner = dokOwner();
        const composePathInHelper = `/dok${composeFile.slice(DOK_ROOT.length)}`;
        const script = `sleep 3; docker compose -p wickedafdok-maintenance -f ${composePathInHelper} up -d --remove-orphans --force-recreate`;
        await run('docker', [
          'run', '--rm', '-d', '--name', 'wickedafdok-maintenance-refresh',
          '-v', `${socket}:/var/run/docker.sock`,
          '-v', `${DOK_ROOT}:/dok`,
          '-e', `DOK_PATH=${DOK_HOST_PATH}`,
          '-e', 'HOST_PATH=/',
          '-e', `DOCKER_SOCK=${socket}`,
          '-e', `PUID=${owner.uid}`,
          '-e', `PGID=${owner.gid}`,
          '--entrypoint', 'sh', DOK_IMAGE,
          '-c', script
        ]);
        log('Maintenance will restart with the updated image.');
      }
    } catch (e) {
      log(`Could not schedule the Maintenance refresh: ${e.message}`);
    }
    job.phase = 'done';
    job.result = { commit, branch: resolvedBranch, message: `Updated to ${commit || 'latest'}.` };
    job.finished = new Date().toISOString();
    job.running = false;
    log(job.result.message);
  } catch (e) {
    job.error = e.message;
    job.phase = 'error';
    job.running = false;
    job.finished = new Date().toISOString();
    log(`Update failed: ${e.message}`);
  }
}

app.get('/api/updates', api(async (req, res) => {
  let repo = '';
  let branch = '';
  let commit = '';
  let subject = '';
  let dirty = false;
  try { repo = (await run('git', ['remote', 'get-url', 'origin'], { cwd: DOK_ROOT })).stdout.trim(); } catch {}
  try { branch = (await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: DOK_ROOT })).stdout.trim(); } catch {}
  try { commit = (await run('git', ['rev-parse', '--short', 'HEAD'], { cwd: DOK_ROOT })).stdout.trim(); } catch {}
  try { subject = (await run('git', ['log', '-1', '--pretty=%s'], { cwd: DOK_ROOT })).stdout.trim(); } catch {}
  try { dirty = !!(await run('git', ['status', '--porcelain'], { cwd: DOK_ROOT })).stdout.trim(); } catch {}
  res.json({ ok: true, repo, branch, commit, subject, dirty, job: updateSnapshot() });
}));

app.post('/api/updates/run', api(async (req, res) => {
  if (updateJob?.running) return res.status(409).json({ error: 'An update is already running' });
  updateJob = {
    running: true,
    phase: 'starting',
    started: new Date().toISOString(),
    finished: '',
    log: [],
    result: null,
    error: ''
  };
  runUpdate({
    repo: String(req.body?.repo || '').trim(),
    branch: String(req.body?.branch || '').trim(),
    force: req.body?.force === true
  });
  res.json({ ok: true, started: true, job: updateSnapshot() });
}));

app.get('/api/updates/status', (req, res) => {
  res.json({ ok: true, job: updateSnapshot() });
});

// ---------- diagnostics/repair ----------
app.get('/api/diagnostics', api(async (req, res) => {
  const result = await repairInstallation({ fix: false });
  res.json({
    ok: result.ok,
    checks: result.checks,
    system: systemInfo(),
    docker: await dockerInfo(),
    dok: await dokStatus().catch(() => ({ exists: false })),
    containers: await containerList().catch(() => []),
    logs: tail(logCache.join('\n'), 100000)
  });
}));

app.post('/api/repair', api(async (req, res) => {
  const result = await repairInstallation({ fix: true });
  res.json({ ok: true, ...result });
}));

app.get('/api/logs', api(async (req, res) => {
  const lines = Math.max(20, Math.min(5000, Number(req.query.tail) || 500));
  let dok = '';
  try {
    const out = await docker(['logs', '--tail', String(lines), DOK_CONTAINER], { timeout: 15000 });
    dok = `${out.stdout}\n${out.stderr}`.trim();
  } catch (e) {
    dok = e.stdout || e.stderr || e.message;
  }
  let maintenance = '';
  try {
    maintenance = fs.readFileSync(path.join(logsDir, 'maintenance.log'), 'utf-8').split('\n').slice(-lines).join('\n');
  } catch {}
  res.json({ ok: true, dok, maintenance });
}));

// ---------- terminal / OpenCode ----------
const opencodeInfoCache = { at: 0, value: null };

function findExecutable(value) {
  if (!value) return null;
  if (value.includes('/')) {
    try { fs.accessSync(value, fs.constants.X_OK); return value; } catch { return null; }
  }
  for (const dir of String(process.env.PATH || '').split(':')) {
    if (!dir) continue;
    const candidate = path.join(dir, value);
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch {}
  }
  return null;
}

function opencodeBinary() {
  for (const candidate of [process.env.OPENCODE_BIN, '/usr/local/bin/opencode', '/usr/bin/opencode', '/opt/opencode/.opencode/bin/opencode']) {
    const found = findExecutable(candidate);
    if (found) return found;
  }
  return findExecutable('opencode');
}

async function opencodeInfo() {
  if (opencodeInfoCache.value && Date.now() - opencodeInfoCache.at < 60000) return opencodeInfoCache.value;
  const binary = opencodeBinary();
  if (!binary) {
    opencodeInfoCache.value = { installed: false, version: '', path: '' };
    opencodeInfoCache.at = Date.now();
    return opencodeInfoCache.value;
  }
  let version = '';
  try {
    const out = await run(binary, ['--version'], { cwd: DOK_ROOT, timeout: 15000 });
    version = String(out.stdout || out.stderr || '').trim().split('\n')[0];
  } catch {}
  opencodeInfoCache.value = { installed: true, version, path: binary };
  opencodeInfoCache.at = Date.now();
  return opencodeInfoCache.value;
}

function maintenanceOpencodeConfig(settings = readSettings()) {
  const service = settings.services?.opencode || {};
  const model = String(service.model || '').trim();
  const provider = String(service.provider || '').trim() || (model.includes('/') ? model.split('/')[0] : '');
  const config = {
    $schema: 'https://opencode.ai/config.json',
    autoupdate: false,
    default_agent: 'admin',
    permission: { '*': 'allow', external_directory: 'allow' },
    agent: {
      admin: {
        description: 'Dok Maintenance administrator with full host, Docker, backup, and repair access.',
        mode: 'primary',
        prompt: [
          'You are OpenCode running inside the Dok Maintenance container.',
          'You have full access to the host checkout at /dok, host paths under /host, the Docker socket, and maintenance storage at /maintenance-data.',
          'Use this power carefully. Read /dok/AGENTS.md before structural changes.',
          'When configuring Dok core services, call the Dok API at http://wickedafdok:8080 and verify the result.',
          'Never print stored secrets in chat. Prefer reversible changes and record what you changed.'
        ].join('\n')
      }
    }
  };
  if (model) config.model = model;
  if (provider && service.apiKey) {
    config.provider = { [provider]: { options: { apiKey: '{env:OPENCODE_PROVIDER_API_KEY}' } } };
  }
  return config;
}

function terminalEnv(appName, settings = readSettings()) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || value === null) continue;
    env[key] = String(value);
  }
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.WICKEDAFDOK_MAINTENANCE = '1';
  env.WICKEDAFDOK_TERMINAL = appName;
  for (const key of Object.keys(env)) {
    if (/^OPENCODE($|_)/.test(key)) delete env[key];
  }
  if (appName === 'opencode') {
    const home = path.join(opencodeDir, 'home');
    env.HOME = home;
    env.XDG_CONFIG_HOME = path.join(opencodeDir, 'config');
    env.XDG_STATE_HOME = path.join(opencodeDir, 'state');
    env.XDG_DATA_HOME = path.join(opencodeDir, 'data');
    env.XDG_CACHE_HOME = path.join(opencodeDir, 'cache');
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify(maintenanceOpencodeConfig(settings));
    env.OPENCODE_DISABLE_PROJECT_CONFIG = '1';
    env.OPENCODE_DISABLE_AUTOUPDATE = '1';
    const apiKey = String(settings.services?.opencode?.apiKey || '').trim();
    if (apiKey) env.OPENCODE_PROVIDER_API_KEY = apiKey;
  }
  return env;
}

function sessionSummary(session) {
  return {
    id: session.id,
    app: session.app,
    title: session.title,
    cwd: session.cwd,
    createdAt: session.createdAt,
    clients: session.clients.size,
    exited: session.exited,
    exitCode: session.exitCode
  };
}

function stopSession(id) {
  const session = sessions.get(id);
  if (!session) return false;
  sessions.delete(id);
  clearTimeout(session.cleanupTimer);
  try { session.pty.kill(); } catch {}
  const timer = setTimeout(() => { try { session.pty.kill('SIGKILL'); } catch {} }, 1500);
  if (timer.unref) timer.unref();
  for (const ws of session.clients) {
    try { ws.close(1000, 'session stopped'); } catch {}
  }
  session.clients.clear();
  return true;
}

function scheduleSessionCleanup(session) {
  clearTimeout(session.cleanupTimer);
  session.cleanupTimer = setTimeout(() => {
    if (!sessions.has(session.id)) return;
    if (session.clients.size) return;
    if (Date.now() - session.lastActivity < SESSION_IDLE_MS) return;
    stopSession(session.id);
  }, 60000);
  if (session.cleanupTimer.unref) session.cleanupTimer.unref();
}

app.post('/api/terminal/sessions', api(async (req, res) => {
  if (sessions.size >= SESSION_LIMIT) throw Object.assign(new Error('Too many terminal sessions are open'), { status: 429 });
  const appName = req.body?.app === 'opencode' ? 'opencode' : 'shell';
  const title = String(req.body?.title || '').trim();
  const prompt = String(req.body?.prompt || '').trim();
  let binary = '/bin/bash';
  let args = ['-i'];
  if (appName === 'opencode') {
    const info = await opencodeInfo();
    if (!info.installed) throw Object.assign(new Error('OpenCode is not available in the maintenance image. Rebuild the image.'), { status: 503 });
    binary = info.path;
    args = ['--agent', 'admin'];
    if (prompt) args.push('--prompt', prompt.slice(0, 12000));
  }
  const id = `mtn_${crypto.randomBytes(10).toString('hex')}`;
  const cwd = DOK_ROOT;
  const session = {
    id,
    app: appName,
    title: title || (appName === 'opencode' ? 'Maintenance · OpenCode Admin' : 'Maintenance shell'),
    cwd,
    createdAt: new Date().toISOString(),
    lastActivity: Date.now(),
    buffer: [],
    bufferBytes: 0,
    clients: new Set(),
    exited: false,
    exitCode: null,
    cleanupTimer: null
  };
  let child;
  try {
    child = pty.spawn(binary, args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 34,
      cwd,
      env: terminalEnv(appName)
    });
  } catch (e) {
    throw Object.assign(new Error(`Unable to start ${appName}: ${e.message}`), { status: 500 });
  }
  session.pty = child;
  sessions.set(id, session);
  child.onData(data => {
    session.lastActivity = Date.now();
    session.buffer.push(data);
    session.bufferBytes += Buffer.byteLength(data);
    while (session.bufferBytes > SESSION_BUFFER_LIMIT && session.buffer.length > 1) {
      const removed = session.buffer.shift();
      session.bufferBytes -= Buffer.byteLength(removed);
    }
    if (!session.clients.size) return;
    const payload = JSON.stringify({ type: 'output', data });
    for (const ws of session.clients) {
      try { ws.send(payload); } catch {}
    }
  });
  child.onExit(({ exitCode }) => {
    session.exited = true;
    session.exitCode = exitCode;
    const payload = JSON.stringify({ type: 'exit', code: exitCode });
    for (const ws of session.clients) {
      try { ws.send(payload); } catch {}
    }
    const timer = setTimeout(() => stopSession(id), 30000);
    if (timer.unref) timer.unref();
  });
  scheduleSessionCleanup(session);
  logLine('INFO', `terminal session ${id} started (${appName})`);
  res.json({ ok: true, session: sessionSummary(session) });
}));

app.get('/api/terminal', api(async (req, res) => {
  const info = await opencodeInfo();
  res.json({
    ok: true,
    installed: info.installed,
    version: info.version,
    sessions: [...sessions.values()].map(sessionSummary)
  });
}));

app.post('/api/terminal/sessions/:id/stop', (req, res) => {
  res.json({ ok: true, stopped: stopSession(req.params.id) });
});

app.post('/api/terminal/sessions/stop-all', (req, res) => {
  let stopped = 0;
  for (const session of [...sessions.values()]) {
    if (stopSession(session.id)) stopped += 1;
  }
  res.json({ ok: true, stopped });
});

app.get('/api/opencode', api(async (req, res) => {
  const info = await opencodeInfo();
  res.json({
    ok: true,
    installed: info.installed,
    version: info.version,
    sessions: [...sessions.values()].filter(item => item.app === 'opencode').map(sessionSummary)
  });
}));

// ---------- host helper replacement ----------
function hostPathInside(target) {
  const resolved = path.resolve(HOST_ROOT, '.' + path.sep + String(target).replace(/^[/\\]+/, ''));
  return resolved === HOST_ROOT || resolved.startsWith(HOST_ROOT + path.sep);
}

function realPathInside(target) {
  let rootReal = HOST_ROOT;
  try { rootReal = fs.realpathSync(HOST_ROOT); } catch {}
  let ancestor = path.dirname(target);
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) return false;
    ancestor = parent;
  }
  let realAncestor;
  try { realAncestor = fs.realpathSync(ancestor); } catch { return false; }
  if (realAncestor !== rootReal && !realAncestor.startsWith(rootReal + path.sep)) return false;
  if (fs.existsSync(target)) {
    const realTarget = fs.realpathSync(target);
    if (realTarget !== rootReal && !realTarget.startsWith(rootReal + path.sep)) return false;
  }
  return true;
}

function readHelperTokens() {
  const tokens = [];
  for (const file of [tokenPath, path.join(dataDir, 'host-helper', 'token'), path.join(DOK_ROOT, 'data', 'host-helper', 'token')]) {
    try {
      const token = fs.readFileSync(file, 'utf-8').trim();
      if (token && !tokens.includes(token)) tokens.push(token);
    } catch {}
  }
  return tokens;
}

function helperRespond(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function helperReadBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) return reject(new Error('Request body is too large'));
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf-8')) : {}); } catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

async function handleHelper(req, res) {
  if (req.method === 'GET' && req.url === '/ping') {
    return helperRespond(res, 200, { ok: true, hostRoot: HOST_ROOT, maintenance: true });
  }
  const tokens = readHelperTokens();
  const authorization = String(req.headers.authorization || '');
  if (!tokens.length || !tokens.some(token => authorization === `Bearer ${token}`)) {
    return helperRespond(res, 401, { error: 'Unauthorized' });
  }
  if (req.method === 'POST' && req.url === '/mkdir') {
    const body = await helperReadBody(req);
    const requested = String(body.path || '').trim();
    if (!requested || !path.isAbsolute(requested) || /[\0\r\n]/.test(requested)) {
      return helperRespond(res, 400, { error: 'An absolute host path is required' });
    }
    if (!hostPathInside(requested)) return helperRespond(res, 400, { error: 'Path escapes the host root' });
    const target = path.resolve(HOST_ROOT, '.' + path.sep + requested.replace(/^[/\\]+/, ''));
    if (!realPathInside(target)) return helperRespond(res, 400, { error: 'Resolved path escapes the host root' });
    try {
      fs.mkdirSync(target, { recursive: true });
      const real = fs.realpathSync(target);
      const rootReal = fs.realpathSync(HOST_ROOT);
      if (real !== rootReal && !real.startsWith(rootReal + path.sep)) return helperRespond(res, 400, { error: 'Resolved path escapes the host root' });
      if (Number.isInteger(body.uid) && Number.isInteger(body.gid)) {
        try { fs.chownSync(target, body.uid, body.gid); } catch {}
      }
      const mode = Number.isInteger(body.mode) ? body.mode : 0o775;
      try { fs.chmodSync(target, mode); } catch {}
      logLine('INFO', `host helper created ${real}`);
      return helperRespond(res, 200, { ok: true, path: requested });
    } catch (e) {
      return helperRespond(res, 500, { error: e.message });
    }
  }
  if (req.method === 'POST' && req.url === '/stat') {
    const body = await helperReadBody(req);
    const requested = String(body.path || '').trim();
    if (!requested || !path.isAbsolute(requested) || !hostPathInside(requested)) {
      return helperRespond(res, 400, { error: 'An absolute host path inside the host root is required' });
    }
    const target = path.resolve(HOST_ROOT, '.' + path.sep + requested.replace(/^[/\\]+/, ''));
    if (!realPathInside(target)) return helperRespond(res, 400, { error: 'Resolved path escapes the host root' });
    try {
      const stat = fs.statSync(target);
      return helperRespond(res, 200, { ok: true, exists: true, isDirectory: stat.isDirectory(), uid: stat.uid, gid: stat.gid, mode: stat.mode });
    } catch {
      return helperRespond(res, 200, { ok: true, exists: false });
    }
  }
  return helperRespond(res, 404, { error: 'Not found' });
}

function startHelperSocket(log) {
  const socketPath = path.join(dataDir, 'host-helper', 'agent.sock');
  try {
    fs.mkdirSync(path.dirname(socketPath), { recursive: true });
    // Keep the legacy Host Helper token path in sync so a running Dok keeps
    // sending a token this container accepts after it replaces the helper.
    const legacyToken = path.join(dataDir, 'host-helper', 'token');
    writePrivateFile(legacyToken, maintenanceToken({ create: true }));
    chownDokPath(path.dirname(legacyToken));
    chownDokPath(legacyToken);
  } catch {}
  try { fs.unlinkSync(socketPath); } catch {}
  const helper = http.createServer((req, res) => {
    handleHelper(req, res).catch(e => helperRespond(res, 500, { error: e.message }));
  });
  helper.on('error', e => log(`host helper socket error: ${e.message}`));
  helper.listen(socketPath, () => {
    try { fs.chmodSync(socketPath, 0o666); } catch {}
    try { fs.chmodSync(path.dirname(socketPath), 0o755); } catch {}
    log(`host helper listening on ${socketPath}`);
  });
  return helper;
}

// ---------- SPA ----------
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  const candidates = [path.join('/app/public/maintenance/index.html'), path.join(DOK_ROOT, 'public', 'maintenance', 'index.html')];
  const found = candidates.find(file => fs.existsSync(file));
  if (!found) return res.status(404).send('Maintenance UI not found');
  res.sendFile(found);
});

const server = http.createServer(app);
const helperServer = startHelperSocket(line => logLine('INFO', line));
// The Maintenance helper replaces the old Host Helper core service.
docker(['stop', 'wickedafdok-host-helper'], { timeout: 30000 })
  .catch(() => {})
  .then(() => logLine('INFO', 'Retired the old Host Helper container (if present)'));

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/api/terminal/ws') {
    socket.destroy();
    return;
  }
  if (MAINTENANCE_REQUIRE_TOKEN) {
    const expected = maintenanceToken();
    const token = url.searchParams.get('token') || '';
    if (expected && token !== expected) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
  }
  const session = sessions.get(url.searchParams.get('id'));
  if (!session) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, ws => {
    session.clients.add(ws);
    session.lastActivity = Date.now();
    clearTimeout(session.cleanupTimer);
    const replay = session.buffer.join('');
    ws.send(JSON.stringify({ type: 'ready', session: sessionSummary(session) }));
    if (replay) ws.send(JSON.stringify({ type: 'output', data: replay }));
    if (session.exited) ws.send(JSON.stringify({ type: 'exit', code: session.exitCode }));
    ws.on('message', raw => {
      let message;
      try { message = JSON.parse(String(raw)); } catch { return; }
      session.lastActivity = Date.now();
      if (message.type === 'input' && typeof message.data === 'string' && !session.exited) {
        try { session.pty.write(message.data); } catch {}
      } else if (message.type === 'resize') {
        const cols = Math.max(20, Math.min(400, Number(message.cols) || 0));
        const rows = Math.max(5, Math.min(200, Number(message.rows) || 0));
        if (cols && rows) { try { session.pty.resize(cols, rows); } catch {} }
      } else if (message.type === 'ping') {
        try { ws.send(JSON.stringify({ type: 'pong', at: Date.now() })); } catch {}
      }
    });
    ws.on('close', () => {
      session.clients.delete(ws);
      session.lastActivity = Date.now();
      scheduleSessionCleanup(session);
    });
    ws.on('error', () => session.clients.delete(ws));
  });
});

server.listen(MAINTENANCE_PORT, '0.0.0.0', () => {
  logLine('INFO', `Dok Maintenance listening on http://0.0.0.0:${MAINTENANCE_PORT}`);
  logLine('INFO', `Dok root ${DOK_ROOT}, host root ${HOST_ROOT}, maintenance data ${MAINT_DATA}`);
});

// Keep the repair data current: every time Maintenance is opened against an
// existing installation, record a snapshot before any repair or update runs.
const startupSnapshot = setTimeout(() => {
  if (!fs.existsSync(path.join(dataDir, 'settings.json'))) return;
  captureSnapshot({ reason: 'maintenance-open', label: 'Snapshot taken when Maintenance opened' })
    .then(item => logLine('INFO', `Maintenance snapshot ${item.id} captured`))
    .catch(e => logLine('WARN', `Maintenance snapshot skipped: ${e.message}`));
}, 3000);
if (startupSnapshot.unref) startupSnapshot.unref();

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    for (const session of [...sessions.values()]) stopSession(session.id);
    try { helperServer.close(); } catch {}
    server.close(() => process.exit(0));
    const timer = setTimeout(() => process.exit(0), 2500);
    if (timer.unref) timer.unref();
  });
}

export { app, server };
