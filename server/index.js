import express from 'express';
import Docker from 'dockerode';
import os from 'os';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { execFile, spawn } from 'child_process';
import crypto from 'crypto';
import http from 'http';
import net from 'net';
import multer from 'multer';
import { parse as parseShell } from 'shell-quote';
import { WebSocketServer } from 'ws';
import pty from 'node-pty';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.join(__dirname, '..');
const dataDir = path.join(root, 'data');
const sourcesDir = path.join(root, 'sources');
const uploadsDir = path.join(root, 'uploads');
const appsDir = path.join(root, 'apps');
const coreDir = path.join(root, 'core');
const backupsDir = path.join(dataDir, 'backups');
const logsDir = path.join(dataDir, 'logs');
const tmpDir = path.join(dataDir, 'tmp');
const opencodeDir = path.join(dataDir, 'opencode');
const designerDir = path.join(dataDir, 'designer');
const maintenanceContainer = 'wickedafdok-maintenance';
const maintenanceComposePath = path.join(dataDir, 'wickedafdok', 'maintenance', 'docker-compose.yml');
const maintenanceTokenPath = path.join(dataDir, '.maintenance-token');
const installationStatePath = path.join(dataDir, 'installation-state.json');
const installationPath = path.join(dataDir, 'installation.json');
const installationStateSchema = 'wickedafdok.installation-state/v1';
let installationStateTimer = null;
let installationStateWriting = false;
let lastMaintenanceStartAttempt = 0;

for (const dir of [dataDir, sourcesDir, uploadsDir, appsDir, coreDir, backupsDir, logsDir, tmpDir, opencodeDir, designerDir]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const upload = multer({ dest: uploadsDir, limits: { fileSize: 200 * 1024 * 1024, files: 200 } });

// ---------- logging ----------
const serverLogPath = path.join(logsDir, 'server.log');
const SERVER_LOG_LIMIT = 2000;
const serverLogBuffer = [];
let loggingInstalled = false;

function formatLogArg(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack || value.message;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function trimServerLog() {
  try {
    const stat = fs.statSync(serverLogPath);
    if (stat.size > 5 * 1024 * 1024) {
      const text = fs.readFileSync(serverLogPath, 'utf-8').split('\n').slice(-SERVER_LOG_LIMIT).join('\n');
      fs.writeFileSync(serverLogPath, text + '\n', { mode: 0o600 });
    }
  } catch {}
}

function appendServerLog(level, message) {
  const line = `${new Date().toISOString()} [${level}] ${String(message).replace(/\r?\n/g, '\n    ')}`;
  serverLogBuffer.push(line);
  if (serverLogBuffer.length > SERVER_LOG_LIMIT) serverLogBuffer.splice(0, serverLogBuffer.length - SERVER_LOG_LIMIT);
  try {
    fs.appendFileSync(serverLogPath, line + '\n', { mode: 0o600 });
    trimServerLog();
  } catch {}
  return line;
}

function readServerLog(tail = 500) {
  const count = Math.max(1, Math.min(SERVER_LOG_LIMIT, Number(tail) || 500));
  try {
    if (fs.existsSync(serverLogPath)) {
      const text = fs.readFileSync(serverLogPath, 'utf-8');
      const lines = text.replace(/\n$/, '').split('\n').filter(Boolean);
      return lines.slice(-count);
    }
  } catch {}
  return serverLogBuffer.slice(-count);
}

function installLogging() {
  if (loggingInstalled) return;
  loggingInstalled = true;
  for (const level of ['log', 'info', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args);
      appendServerLog(level === 'log' ? 'INFO' : level.toUpperCase(), args.map(formatLogArg).join(' '));
    };
  }
}
installLogging();

const docker = new Docker({ socketPath: '/var/run/docker.sock' });
const composeFiles = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use((req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const started = Date.now();
  res.on('finish', () => {
    appendServerLog(res.statusCode >= 400 ? 'WARN' : 'INFO',
      `${req.method} ${req.path} -> ${res.statusCode} (${Date.now() - started}ms)`);
  });
  next();
});
app.use('/vendor/xterm', express.static(path.join(root, 'node_modules/@xterm/xterm')));
app.use('/vendor/xterm-fit', express.static(path.join(root, 'node_modules/@xterm/addon-fit')));
app.use(express.static(path.join(root, 'public')));

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

// ---------- helpers ----------
let registryBackedUp = false;
function readRegistry() {
  try {
    if (!fs.existsSync(registryPath)) return [];
    const data = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
    if (!Array.isArray(data)) throw new Error('registry root must be an array');
    return data;
  } catch (e) {
    if (!registryBackedUp) {
      registryBackedUp = true;
      const backup = `${registryPath}.corrupt-${Date.now()}`;
      try {
        fs.copyFileSync(registryPath, backup);
        fs.chmodSync(backup, 0o600);
        console.error(`registry.json is invalid; preserved a copy at ${backup}: ${e.message}`);
      } catch (copyErr) {
        console.error(`registry.json is invalid and could not be backed up: ${e.message}`);
      }
    }
    return [];
  }
}
function writeRegistry(reg) {
  fs.writeFileSync(registryPath, JSON.stringify(reg, null, 2), { mode: 0o600 });
  try { fs.chmodSync(registryPath, 0o600); } catch {}
  scheduleInstallationState();
}
const registryPath = path.join(dataDir, 'registry.json');
const groupsPath = path.join(dataDir, 'groups.json');
const registriesPath = path.join(dataDir, 'registries.json');
const authPath = path.join(dataDir, 'auth.json');
const dnsPath = path.join(dataDir, 'dns.json');

function readJson(p, def) {
  try {
    if (!fs.existsSync(p)) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify(def, null, 2), { mode: 0o600 });
      return JSON.parse(JSON.stringify(def));
    }
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (def && typeof def === 'object' && !Array.isArray(def) &&
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ...def, ...parsed };
    }
    return parsed;
  } catch {
    return JSON.parse(JSON.stringify(def));
  }
}
function writeJson(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v, null, 2), { mode: 0o600 });
  try { fs.chmodSync(p, 0o600); } catch {}
}

if (!fs.existsSync(registryPath)) writeJson(registryPath, []);
if (!fs.existsSync(groupsPath)) writeJson(groupsPath, { groups: [] });
if (!fs.existsSync(registriesPath)) writeJson(registriesPath, { connections: [] });
if (!fs.existsSync(authPath)) writeJson(authPath, { enabled: false, users: [] });
if (!fs.existsSync(dnsPath)) writeJson(dnsPath, { enabled: false, provider: 'technitium', url: '', token: '' });

const settingsPath = path.join(dataDir, 'settings.json');
for (const privatePath of [registryPath, groupsPath, registriesPath, authPath, dnsPath, settingsPath]) {
  try { fs.chmodSync(privatePath, 0o600); } catch {}
}
function readSettings() {
  try {
    if (!fs.existsSync(settingsPath)) {
      const defaults = {
        services: {
          nginxProxy: { enabled: false, network: 'wicked', defaultVhostPort: 80, httpPort: 80, domain: '', acme: { enabled: false, email: '', staging: false } },
          cloudflared: { enabled: false, token: '' },
          authentik: { enabled: false, adminEmail: '', adminPassword: '', secretKey: '', postgresPassword: '', port: 9000, httpsPort: 9443, domain: '' },
          authelia: { enabled: false, domain: '', port: 9091, adminUser: 'admin', adminEmail: '', adminPassword: '', adminPasswordHash: '', sessionSecret: '', encryptionKey: '', jwtSecret: '', theme: 'auto' },
          dns: { provider: 'technitium' },
          technitium: { enabled: false, adminPassword: '', webPort: 5380, dnsPort: 53, domain: '' },
          adguard: { enabled: false, webPort: 3000, dnsPort: 53, domain: '' },
          mail: { host: '', port: 587, tls: 'starttls', username: '', password: '', sender: '', identifier: '' },
          mailpit: { enabled: false, smtpPort: 1025, webPort: 8025, domain: '', maxMessages: 500 },
          stalwart: { enabled: false, domain: '', adminUser: 'admin', adminPassword: '', webPort: 8088, smtpPort: 25, submissionPort: 587, imapsPort: 993 },
          hostHelper: { enabled: false, image: '' },
          opencode: { model: '', provider: '', apiKey: '' }
        },
        defaults: defaultsDefaults(),
        backups: { includeLogs: false },
        logs: { tail: 500 },
        designer: { name: 'WickedAFDok', tagline: 'Server & Docker control room', css: '', logo: '' }
      };
      fs.writeFileSync(settingsPath, JSON.stringify(defaults, null, 2), { mode: 0o600 });
      return defaults;
    }
    const cur = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    cur.services = cur.services || {};
    cur.services.nginxProxy = { enabled: false, network: 'wicked', defaultVhostPort: 80, httpPort: 80, domain: '', acme: nginxProxyAcme(cur.services.nginxProxy?.acme || {}), ...(cur.services.nginxProxy || {}) };
    cur.services.nginxProxy.acme = nginxProxyAcme(cur.services.nginxProxy.acme || {});
    // Migrate the legacy default network name.
    if (!cur.services.nginxProxy.network || cur.services.nginxProxy.network === 'proxy') {
      cur.services.nginxProxy.network = 'wicked';
      try { writeSettings(cur); } catch {}
    }
    cur.services.cloudflared = { enabled: false, token: '', ...(cur.services.cloudflared || {}) };
    cur.services.authentik = {
      enabled: false, adminEmail: '', adminPassword: '', secretKey: '', postgresPassword: '',
      port: 9000, httpsPort: 9443, domain: '', ...(cur.services.authentik || {})
    };
    cur.services.authelia = autheliaDefaults(cur.services.authelia || {});
    cur.services.dns = { provider: 'technitium', ...(cur.services.dns || {}) };
    cur.services.technitium = {
      enabled: false, adminPassword: '', webPort: 5380, dnsPort: 53, domain: '',
      ...(cur.services.technitium || {})
    };
    cur.services.adguard = {
      enabled: false, webPort: 3000, dnsPort: 53, domain: '',
      ...(cur.services.adguard || {})
    };
    cur.services.mail = mailDefaults(cur.services.mail || {});
    cur.services.mailpit = mailpitDefaults(cur.services.mailpit || {});
    cur.services.stalwart = stalwartDefaults(cur.services.stalwart || {});
    cur.services.hostHelper = { enabled: false, image: '', ...(cur.services.hostHelper || {}) };
    cur.services.opencode = { model: '', provider: '', apiKey: '', ...(cur.services.opencode || {}) };
    cur.defaults = defaultsDefaults(cur.defaults || {});
    cur.backups = { includeLogs: false, ...(cur.backups || {}) };
    cur.logs = { tail: 500, ...(cur.logs || {}) };
    cur.designer = {
      name: 'WickedAFDok', tagline: 'Server & Docker control room', css: '', logo: '',
      ...(cur.designer || {})
    };
    delete cur.clearSecrets;
    return decryptSettingsSecrets(cur);
  } catch {
    return {
      services: {
        nginxProxy: { enabled: false, network: 'wicked', defaultVhostPort: 80, httpPort: 80, domain: '', acme: { enabled: false, email: '', staging: false } },
        cloudflared: { enabled: false, token: '' },
        authentik: { enabled: false, adminEmail: '', adminPassword: '', secretKey: '', postgresPassword: '', port: 9000, httpsPort: 9443, domain: '' },
        authelia: { enabled: false, domain: '', port: 9091, adminUser: 'admin', adminEmail: '', adminPassword: '', adminPasswordHash: '', sessionSecret: '', encryptionKey: '', jwtSecret: '', theme: 'auto' },
        dns: { provider: 'technitium' },
        technitium: { enabled: false, adminPassword: '', webPort: 5380, dnsPort: 53, domain: '' },
        adguard: { enabled: false, webPort: 3000, dnsPort: 53, domain: '' },
        mail: { host: '', port: 587, tls: 'starttls', username: '', password: '', sender: '', identifier: '' },
        mailpit: { enabled: false, smtpPort: 1025, webPort: 8025, domain: '', maxMessages: 500 },
        stalwart: { enabled: false, domain: '', adminUser: 'admin', adminPassword: '', webPort: 8088, smtpPort: 25, submissionPort: 587, imapsPort: 993 },
        hostHelper: { enabled: false, image: '' },
        opencode: { model: '', provider: '', apiKey: '' }
      },
      defaults: defaultsDefaults(),
      backups: { includeLogs: false },
      logs: { tail: 500 },
      designer: { name: 'WickedAFDok', tagline: 'Server & Docker control room', css: '', logo: '' }
    };
  }
}

// Secret settings stay encrypted at rest with the same AES-256-GCM key used
// for registry connections. readSettings() decrypts for internal use and
// writeSettings() encrypts again, so callers keep working with plaintext.
const SETTINGS_SECRET_PATHS = [
  ['services', 'cloudflared', 'token'],
  ['services', 'authentik', 'adminPassword'],
  ['services', 'authentik', 'secretKey'],
  ['services', 'authentik', 'postgresPassword'],
  ['services', 'authelia', 'adminPassword'],
  ['services', 'authelia', 'adminPasswordHash'],
  ['services', 'authelia', 'sessionSecret'],
  ['services', 'authelia', 'encryptionKey'],
  ['services', 'authelia', 'jwtSecret'],
  ['services', 'technitium', 'adminPassword'],
  ['services', 'mail', 'password'],
  ['services', 'stalwart', 'adminPassword'],
  ['services', 'opencode', 'apiKey'],
  ['defaults', 'adminPassword']
];

function isStoredSecret(value) {
  if (typeof value !== 'string') return false;
  const parts = value.split(':');
  return parts.length === 4 && parts[0] === 'v1' &&
    parts.slice(1).every(part => /^[A-Za-z0-9+/=]+$/.test(part));
}

function mapSettingsSecrets(settings, transform) {
  if (!settings || typeof settings !== 'object') return settings;
  for (const parts of SETTINGS_SECRET_PATHS) {
    let target = settings;
    for (const part of parts.slice(0, -1)) {
      if (!target || typeof target !== 'object') { target = null; break; }
      target = target[part];
    }
    const key = parts[parts.length - 1];
    if (!target || typeof target !== 'object' || !(key in target)) continue;
    const value = target[key];
    if (!value) continue;
    try { target[key] = transform(String(value)); } catch {}
  }
  return settings;
}

function encryptSettingsSecrets(settings) {
  const clone = JSON.parse(JSON.stringify(settings || {}));
  return mapSettingsSecrets(clone, value => isStoredSecret(value) ? value : encryptSecret(value));
}

function decryptSettingsSecrets(settings) {
  return mapSettingsSecrets(settings, value => {
    if (!isStoredSecret(value)) return value;
    try { return decryptSecret(value); } catch { return ''; }
  });
}

function redactSettingsSecrets(settings) {
  const clone = JSON.parse(JSON.stringify(settings || {}));
  for (const parts of SETTINGS_SECRET_PATHS) {
    let target = clone;
    for (const part of parts.slice(0, -1)) {
      if (!target || typeof target !== 'object') { target = null; break; }
      target = target[part];
    }
    const key = parts[parts.length - 1];
    if (!target || typeof target !== 'object') continue;
    const hadValue = !!target[key];
    target[key] = '';
    target[`${key}Set`] = hadValue;
  }
  return clone;
}

function preserveEmptySettingsSecrets(next, current, clearSecrets = []) {
  const clear = new Set(Array.isArray(clearSecrets) ? clearSecrets.map(String) : []);
  for (const parts of SETTINGS_SECRET_PATHS) {
    const dot = parts.join('.');
    let nextTarget = next;
    let currentTarget = current;
    for (const part of parts.slice(0, -1)) {
      nextTarget = nextTarget?.[part];
      currentTarget = currentTarget?.[part];
    }
    const key = parts[parts.length - 1];
    if (!nextTarget || typeof nextTarget !== 'object') continue;
    if (clear.has(dot) || clear.has(key)) continue;
    if (!nextTarget[key] && currentTarget?.[key]) nextTarget[key] = currentTarget[key];
  }
  return next;
}

function redactServiceSecrets(service, value) {
  return redactSettingsSecrets({ services: { [service]: value || {} } }).services[service];
}

function writeSettings(s) {
  fs.writeFileSync(settingsPath, JSON.stringify(encryptSettingsSecrets(s), null, 2), { mode: 0o600 });
  try { fs.chmodSync(settingsPath, 0o600); } catch {}
  scheduleInstallationState();
}

function writePrivateFile(file, content) {
  fs.writeFileSync(file, content, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
}

// ---------- installation state ----------
// Dok writes a sanitized snapshot of the whole installation on every settings
// or registry change (and periodically). The Maintenance container copies it
// into maintenance-data, so an exact reinstall never needs the user to enter
// the same configuration twice.
function ensureInstallationId() {
  const settings = readSettings();
  const existing = String(settings.installation?.id || '').trim();
  if (existing) return existing;
  const id = `dok-${Date.now().toString(36)}-${randomSecret(3)}`;
  settings.installation = {
    ...(settings.installation || {}),
    id,
    installedAt: settings.installation?.installedAt || new Date().toISOString(),
    installedBy: settings.installation?.installedBy || 'dok'
  };
  writeSettings(settings);
  return id;
}

function installationComposeNames(dir) {
  return composeFiles.map(name => path.join(dir, name)).filter(file => {
    try { return fs.statSync(file).isFile(); } catch { return false; }
  });
}

function installationCoreServices() {
  const names = [];
  try {
    for (const entry of fs.readdirSync(coreDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'host-helper') continue;
      const dir = path.join(coreDir, entry.name);
      const compose = installationComposeNames(dir);
      names.push({
        name: entry.name,
        dir,
        compose: compose.map(file => path.relative(root, file)),
        exists: compose.length > 0
      });
    }
  } catch {}
  return names.sort((a, b) => a.name.localeCompare(b.name));
}

function installationRegistryApps() {
  return readRegistry().map(entry => {
    const appDir = entry.appDir || entry.path || '';
    const compose = appDir ? installationComposeNames(appDir) : [];
    return {
      id: entry.id || '',
      name: entry.name || '',
      appDir,
      compose: compose.map(file => path.relative(root, file)),
      dataPath: entry.dataPath || '',
      managedBy: entry.managedBy || 'dok',
      dok: entry.dok || null,
      library: entry.library || null,
      needsConfig: entry.needsConfig === true,
      launch: entry.launch || null
    };
  });
}

function buildInstallationState(settings = readSettings()) {
  const redacted = redactSettingsSecrets(settings);
  const defaults = redacted.defaults || {};
  const apps = installationRegistryApps();
  const coreServices = installationCoreServices();
  return {
    schema: installationStateSchema,
    installationId: ensureInstallationId(),
    updated: new Date().toISOString(),
    dok: {
      container: 'wickedafdok',
      image: process.env.WICKEDAFDOK_IMAGE || 'wickedafdok:latest',
      version: readJson(path.join(dataDir, '..', 'package.json'), {})?.version || '1.0.0',
      port: Number(process.env.PORT) || 8080,
      root: updateSourceDir()
    },
    summary: {
      apps: apps.length,
      coreServices: coreServices.filter(item => item.exists).map(item => item.name),
      registryConnections: (readJson(registriesPath, { connections: [] })?.connections || []).length,
      primaryDomain: defaults.primaryDomain || '',
      dokDomain: defaults.dokDomain || redacted.services?.nginxProxy?.domain || '',
      dokHttpPort: nginxProxyHttpPort(redacted.services?.nginxProxy?.httpPort),
      dataLocation: defaults.dataLocation || '',
      defaultNetwork: defaults.defaultNetwork || 'wicked'
    },
    settings: redacted,
    apps,
    coreServices,
    networks: { default: defaults.defaultNetwork || 'wicked' },
    paths: {
      data: dataDir,
      apps: appsDir,
      core: coreDir,
      sources: sourcesDir,
      uploads: uploadsDir,
      checkout: updateSourceDir()
    }
  };
}

function writeInstallationState() {
  if (installationStateWriting) return null;
  installationStateWriting = true;
  try {
    const settings = readSettings();
    const state = buildInstallationState(settings);
    writeJson(installationStatePath, state);
    let current = {};
    try { current = readJson(installationPath, {}) || {}; } catch {}
    writeJson(installationPath, {
      ...current,
      schema: 'wickedafdok.installation/v1',
      id: current.id || state.installationId,
      created: current.created || new Date().toISOString(),
      updated: new Date().toISOString(),
      type: current.type || settings.installation?.type || 'standalone',
      summary: state.summary,
      dok: { ...(current.dok || {}), container: 'wickedafdok', image: state.dok.image, url: current.dok?.url || '' },
      plan: current.plan || null,
      completedAt: current.completedAt || ''
    });
    return state;
  } catch (e) {
    appendServerLog('WARN', `Could not write installation state: ${e.message}`);
    return null;
  } finally {
    installationStateWriting = false;
  }
}

function scheduleInstallationState() {
  if (installationStateWriting) return;
  clearTimeout(installationStateTimer);
  installationStateTimer = setTimeout(() => {
    installationStateTimer = null;
    writeInstallationState();
  }, 500);
  if (installationStateTimer.unref) installationStateTimer.unref();
}

// Generated compose files are a few kilobytes. Reading an unbounded file here
// would let a corrupted (for example exponentially re-quoted) file exceed
// V8's maximum string length and take the whole request down with
// "Invalid string length", so keep compose reads small and recoverable.
const MAX_COMPOSE_FILE_BYTES = 2 * 1024 * 1024;

function readFileHead(file, bytes = 128) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(bytes);
    const read = fs.readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read).toString('utf-8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function readComposeText(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_COMPOSE_FILE_BYTES) return '';
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return '';
  }
}

// Managed core-service composes are generated by Dok. Reading one without a cap
// is what produced "Invalid string length" for nginx-proxy, so every core
// service reads through this helper: an oversized managed file is archived and
// treated as absent, and the caller regenerates it from saved settings.
function readManagedCompose(file) {
  recoverOversizedManagedCompose(file);
  return readComposeText(file);
}

function recoverOversizedManagedCompose(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size <= MAX_COMPOSE_FILE_BYTES) return false;
    if (!readFileHead(file).startsWith('# managed-by: wickedafdok')) return false;
    const backup = `${file}.corrupt-${Date.now()}`;
    fs.renameSync(file, backup);
    appendServerLog('WARN', `Compose file ${file} was oversized (${stat.size} bytes); archived it at ${backup}`);
    return true;
  } catch {
    return false;
  }
}

function ensureDokAppLabels(appDir, name, composeFile = 'docker-compose.yml') {
  try {
    const composeText = fs.readFileSync(path.join(appDir, composeFile), 'utf-8');
    const services = serviceNamesFromCompose(composeText);
    if (!services.length) return false;
    writePrivateFile(
      path.join(appDir, 'docker-compose.wickedafdok.yml'),
      buildComposeOverride(services, { labels: appDokLabels(name) })
    );
    return true;
  } catch {
    return false;
  }
}

function addRegistryEntry(entry) {
  const reg = readRegistry();
  const appName = projectName(entry.name || entry.appDir || entry.path, 'app');
  const installationId = ensureInstallationId();
  const metadata = {
    managedBy: 'dok',
    dok: {
      managed: true,
      installationId,
      app: appName,
      labels: appDokLabels(appName)
    }
  };
  const existing = (entry.appDir ? reg.find(r => r.appDir === entry.appDir) : null)
    || (entry.name ? reg.find(r => r.name === entry.name) : null);
  if (existing) {
    Object.assign(existing, entry, metadata, { id: existing.id, created: existing.created });
    writeRegistry(reg);
    return existing;
  }
  const full = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    created: new Date().toISOString(),
    ...entry,
    ...metadata
  };
  reg.unshift(full);
  writeRegistry(reg);
  return full;
}

// ---------- registry and git connections ----------
// Credentials are encrypted at rest with a key kept beside the data. The key
// file is 0600 and travels with data backups, so restoring data also restores
// usable connections.
const credentialsKeyPath = path.join(dataDir, '.credentials-key');
const managedDockerConfigDir = path.join(dataDir, 'docker-config');
const gitAskpassPath = path.join(tmpDir, 'git-askpass.sh');

function credentialKey() {
  try {
    if (fs.existsSync(credentialsKeyPath)) {
      const key = fs.readFileSync(credentialsKeyPath);
      if (key.length === 32) return key;
    }
  } catch {}
  const key = crypto.randomBytes(32);
  writePrivateFile(credentialsKeyPath, key);
  return key;
}

function encryptSecret(plain) {
  const text = String(plain ?? '');
  if (!text) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', credentialKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${encrypted.toString('base64')}`;
}

function decryptSecret(value) {
  const text = String(value ?? '');
  if (!text.startsWith('v1:')) return text;
  const [, iv, tag, payload] = text.split(':');
  if (!iv || !tag || !payload) throw new Error('Malformed stored credential');
  const decipher = crypto.createDecipheriv('aes-256-gcm', credentialKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(payload, 'base64')), decipher.final()]).toString('utf8');
}

function readRegistries() {
  const data = readJson(registriesPath, { connections: [] });
  if (!Array.isArray(data.connections)) data.connections = [];
  return data;
}

function writeRegistries(data) {
  writeJson(registriesPath, data);
  dockerConfigCache = { fingerprint: '', dir: '' };
  const hasRegistry = data.connections.some(c => c.kind !== 'git' && c.host && c.username && registrySecret(c));
  if (!hasRegistry) {
    try { fs.rmSync(managedDockerConfigDir, { recursive: true, force: true }); } catch {}
  }
}

function registrySecret(connection) {
  if (!connection) return '';
  if (connection.secretEnc) {
    try { return decryptSecret(connection.secretEnc); } catch { return ''; }
  }
  return String(connection.secret || '');
}

function normalizeRegistryHost(value) {
  let host = String(value || '').trim().toLowerCase();
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/\/.*$/, '').replace(/\/+$/, '');
  if (host === 'index.docker.io' || host === 'registry-1.docker.io') host = 'docker.io';
  return host;
}

function dockerAuthKey(host) {
  return normalizeRegistryHost(host) === 'docker.io' ? 'https://index.docker.io/v1/' : normalizeRegistryHost(host);
}

function publicRegistryConnection(connection) {
  return {
    id: connection.id,
    kind: connection.kind === 'git' ? 'git' : 'registry',
    provider: connection.provider || 'custom',
    name: connection.name || '',
    host: connection.host || '',
    username: connection.username || '',
    hasSecret: !!registrySecret(connection),
    created: connection.created || '',
    updated: connection.updated || ''
  };
}

let dockerConfigCache = { fingerprint: '', dir: '' };

function ensureDockerConfigForRegistries() {
  const connections = readRegistries().connections
    .filter(c => c.kind !== 'git' && normalizeRegistryHost(c.host) && c.username && registrySecret(c));
  if (!connections.length) {
    try { fs.rmSync(managedDockerConfigDir, { recursive: true, force: true }); } catch {}
    dockerConfigCache = { fingerprint: '', dir: '' };
    return null;
  }
  const fingerprint = crypto.createHash('sha256')
    .update(connections.map(c => `${c.id}:${normalizeRegistryHost(c.host)}:${c.username}:${registrySecret(c)}`).join('\n'))
    .digest('hex');
  const configPath = path.join(managedDockerConfigDir, 'config.json');
  if (dockerConfigCache.fingerprint === fingerprint && fs.existsSync(configPath)) {
    return managedDockerConfigDir;
  }

  fs.mkdirSync(managedDockerConfigDir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(managedDockerConfigDir, 0o700); } catch {}

  let config = {};
  const existingPath = process.env.DOCKER_CONFIG
    ? path.join(process.env.DOCKER_CONFIG, 'config.json')
    : path.join(process.env.HOME || '', '.docker', 'config.json');
  try {
    if (existingPath && path.resolve(existingPath) !== path.resolve(configPath) && fs.existsSync(existingPath)) {
      const parsed = JSON.parse(fs.readFileSync(existingPath, 'utf-8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) config = parsed;
    }
  } catch {}
  config.auths = config.auths && typeof config.auths === 'object' ? config.auths : {};
  for (const connection of connections) {
    config.auths[dockerAuthKey(connection.host)] = {
      auth: Buffer.from(`${connection.username}:${registrySecret(connection)}`).toString('base64')
    };
  }
  writePrivateFile(configPath, JSON.stringify(config, null, 2) + '\n');
  dockerConfigCache = { fingerprint, dir: managedDockerConfigDir };
  return managedDockerConfigDir;
}

function dockerEnvironment() {
  try {
    const dir = ensureDockerConfigForRegistries();
    if (!dir) return process.env;
    return { ...process.env, DOCKER_CONFIG: dir };
  } catch (e) {
    console.error(`Unable to prepare registry credentials: ${e.message}`);
    return process.env;
  }
}

function gitHostForUrl(repo) {
  const text = String(repo || '').trim();
  if (!text) return '';
  try {
    if (/^[^/@\s]+@[^:\s]+:/.test(text)) return text.split('@')[1].split(':')[0].toLowerCase();
    return new URL(text).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function hostMatches(connectionHost, targetHost) {
  const configured = normalizeRegistryHost(connectionHost);
  const target = String(targetHost || '').toLowerCase();
  return !!configured && (configured === target || configured.split(':')[0] === target);
}

function ensureGitAskpass() {
  if (!fs.existsSync(gitAskpassPath)) {
    writePrivateFile(gitAskpassPath,
      '#!/bin/sh\n' +
      'case "$1" in\n' +
      '  *Username*) printf \'%s\\n\' "$WICKEDAFDOK_GIT_USERNAME" ;;\n' +
      '  *) printf \'%s\\n\' "$WICKEDAFDOK_GIT_PASSWORD" ;;\n' +
      'esac\n');
  }
  try { fs.chmodSync(gitAskpassPath, 0o700); } catch {}
  return gitAskpassPath;
}

function gitEnvironment(repo) {
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    ...(process.env.WICKEDAFDOK_GIT_INSECURE === '1' ? { GIT_SSL_NO_VERIFY: 'true' } : {})
  };
  const host = gitHostForUrl(repo);
  if (!host) return env;
  const connection = readRegistries().connections
    .find(c => c.kind === 'git' && hostMatches(c.host, host));
  const secret = registrySecret(connection);
  if (!connection || !secret) return env;
  env.GIT_ASKPASS = ensureGitAskpass();
  env.WICKEDAFDOK_GIT_USERNAME = connection.username || 'x-access-token';
  env.WICKEDAFDOK_GIT_PASSWORD = secret;
  return env;
}

function updateSourceDir() {
  const hostSource = path.join(root, 'host-source');
  try {
    if (fs.existsSync(path.join(hostSource, 'Dockerfile')) &&
        fs.existsSync(path.join(hostSource, 'server', 'index.js'))) {
      return hostSource;
    }
  } catch {}
  return root;
}

function updateImageTag(value) {
  const text = String(value || '').trim();
  if (!text || text === '<none>' || text.startsWith('sha256:')) return 'wickedafdok:latest';
  return text;
}

function tailText(value, limit = 50000) {
  const text = String(value || '').replace(/\x1b\[[0-9;]*m/g, '');
  return text.length > limit ? text.slice(-limit) : text;
}

function appendUpdateLog(text) {
  if (!text) return;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const logPath = path.join(dataDir, 'update.log');
    fs.appendFileSync(logPath, text);
    try { fs.chmodSync(logPath, 0o600); } catch {}
  } catch {}
}

async function gitText(args, cwd, env = process.env) {
  const { stdout } = await run('git', args, { cwd, env });
  return String(stdout || '').trim();
}

// Git refuses to operate on a checkout owned by another user ("dubious
// ownership"). Dok commonly runs as a container UID while the checkout is
// owned by the host user, so every git command trusts exactly the directory
// it runs in instead of requiring a host-level safe.directory entry.
function gitArgsWithSafeDirectory(args, cwd) {
  const dirs = new Set();
  for (const candidate of [cwd, path.resolve(cwd || root)]) {
    if (!candidate) continue;
    const resolved = path.resolve(String(candidate));
    dirs.add(resolved);
    try { dirs.add(fs.realpathSync(resolved)); } catch {}
  }
  const prefix = [];
  for (const dir of dirs) prefix.push('-c', `safe.directory=${dir}`);
  return [...prefix, ...args];
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const env = opts.env || (cmd === 'docker' ? dockerEnvironment() : process.env);
    const execArgs = cmd === 'git' ? gitArgsWithSafeDirectory(args, opts.cwd || root) : args;
    execFile(cmd, execArgs, { cwd: root, env, maxBuffer: 1024 * 1024 * 50, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        const hint = dockerSocketHint(err);
        if (hint && !String(err.message).includes('cannot access /var/run/docker.sock')) {
          err.message = `${String(err.message).trim()}${hint}`;
        }
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
  });
}

function runInput(cmd, args, input, opts = {}) {
  return new Promise((resolve, reject) => {
    const env = opts.env || (cmd === 'docker' ? dockerEnvironment() : process.env);
    const child = spawn(cmd, args, { cwd: root, env, ...opts });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) return resolve({ stdout, stderr });
      const err = new Error(String(stderr || stdout || `${cmd} exited with code ${code}`).trim());
      err.code = code;
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    });
    if (input === undefined || input === null) child.stdin.end();
    else child.stdin.end(String(input));
  });
}

function dockerSocketHint(err) {
  const text = `${err?.message || ''} ${err?.stderr || ''}`;
  if (!/docker\.sock|docker API/i.test(text) || !/permission denied|EACCES/i.test(text)) return '';
  let gid = '';
  try { gid = String(fs.statSync('/var/run/docker.sock').gid); } catch {}
  const groupText = gid ? ` (socket GID ${gid})` : '';
  return ` The container user (UID/GID ${processIdentity()}) cannot access /var/run/docker.sock${groupText}. ` +
    'Run "sudo ./setup.sh" on the host and restart WickedAFDok with "./start.sh"; setup adds the Docker socket group to the container. ' +
    'If the socket GID changed, setup refreshes the compose override as well.';
}

function resolveSource(rel = '', { forWrite = false } = {}) {
  const base = fs.realpathSync(sourcesDir);
  const target = path.resolve(base, rel || '');
  const inside = p => p === base || p.startsWith(base + path.sep);
  if (!inside(target)) throw new Error('Invalid path');
  if (fs.existsSync(target)) {
    const real = fs.realpathSync(target);
    if (!inside(real)) throw new Error('Invalid path');
    return real;
  }
  if (!forWrite) throw new Error('Path not found');
  let parent = path.dirname(target);
  while (!fs.existsSync(parent) && parent !== base) parent = path.dirname(parent);
  if (!inside(parent)) throw new Error('Invalid path');
  const realParent = fs.realpathSync(parent);
  if (!inside(realParent)) throw new Error('Invalid path');
  return path.join(realParent, path.relative(parent, target));
}

function slugify(value, fallback = 'app') {
  const s = String(value || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '');
  return s || fallback;
}

function projectName(value, fallback) {
  return slugify(value, fallback).slice(0, 60);
}

// Flags that never consume the following token.
const RUN_BOOL_FLAGS = new Set([
  '-d', '--detach', '-i', '--interactive', '-t', '--tty', '-P', '--publish-all',
  '--rm', '--privileged', '--init', '--read-only', '--no-healthcheck',
  '--oom-kill-disable', '--sig-proxy', '--disable-content-trust', '--help',
  '--quiet'
]);

// Flags that consume a value (either --flag=value, --flag value, or -fvalue).
const RUN_VALUE_FLAGS = new Set([
  '-a', '--attach', '--add-host', '--annotation', '--blkio-weight', '--blkio-weight-device',
  '--cap-add', '--cap-drop', '--cgroup-parent', '--cgroupns', '--cidfile', '--cpu-period',
  '--cpu-quota', '--cpu-rt-period', '--cpu-rt-runtime', '-c', '--cpu-shares', '--cpus',
  '--cpuset-cpus', '--cpuset-mems', '--detach-keys', '--device', '--device-cgroup-rule',
  '--device-read-bps', '--device-read-iops', '--device-write-bps', '--device-write-iops',
  '--dns', '--dns-option', '--dns-search', '--domainname', '--entrypoint', '-e', '--env',
  '--env-file', '--expose', '--gpus', '--group-add', '--health-cmd', '--health-interval',
  '--health-retries', '--health-start-period', '--health-start-interval', '--health-timeout',
  '-h', '--hostname', '--ip', '--ip6', '--ipc', '--isolation', '--kernel-memory',
  '-l', '--label', '--label-file', '--link', '--link-local-ip', '--log-driver', '--log-opt',
  '--mac-address', '-m', '--memory', '--memory-reservation', '--memory-swap',
  '--memory-swappiness', '--mount', '--name', '--network', '--net', '--network-alias',
  '--oom-score-adj', '--pid', '--pids-limit', '--platform', '-p', '--publish', '--pull',
  '--restart', '--runtime', '--security-opt', '--shm-size', '--stop-signal',
  '--stop-timeout', '--storage-opt', '--sysctl', '--tmpfs', '--ulimit', '-u', '--user',
  '--userns', '--uts', '-v', '--volume', '--volume-driver', '--volumes-from', '-w', '--workdir'
]);

const RUN_SHORT_VALUE_FLAGS = new Set(['a', 'c', 'e', 'h', 'l', 'm', 'p', 'u', 'v', 'w']);
const RUN_SHORT_BOOL_FLAGS = new Set(['d', 'i', 't', 'P']);

function stripRunComment(input) {
  let quote = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === '\\' && quote === '"') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\\') { i++; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '#' && (i === 0 || /\s/.test(input[i - 1]))) {
      return input.slice(0, i).trimEnd();
    }
  }
  return input;
}

function tokenizeRunCommand(command) {
  let cleaned = String(command || '')
    .replace(/\\\r?\n/g, ' ')
    .replace(/\r?\n/g, ' ')
    .trim();
  if (/^[#$]\s+/.test(cleaned)) cleaned = cleaned.replace(/^[#$]\s+/, '').trimStart();
  cleaned = stripRunComment(cleaned).trim();
  if (!cleaned) throw new Error('Command is empty');
  // shell-quote expands $VAR to the host environment and treats mid-word # as a
  // comment; mask both so docker run arguments keep literal values.
  const dollar = '\u0001';
  const hash = '\u0002';
  const tokens = parseShell(cleaned.replace(/\$/g, dollar).replace(/#/g, hash))
    .map(t => typeof t === 'string' ? t.split(dollar).join('$').split(hash).join('#') : t);
  for (const token of tokens) {
    if (typeof token !== 'string') throw new Error('Shell operators are not supported. Paste a single docker run command.');
  }
  let args = tokens.filter(Boolean);
  if (args[0] === 'sudo') args = args.slice(1);
  if (args[0] === 'docker' && args[1] === 'container' && args[2] === 'run') args = args.slice(3);
  else if (args[0] === 'docker' && args[1] === 'run') args = args.slice(2);
  else if (args[0] === 'docker-run') args = args.slice(1);
  else throw new Error('Expected a docker run command');
  if (args.length === 0) throw new Error('Expected a docker run command');
  return args;
}

function yamlScalar(value) {
  // Double dollar signs so Compose interpolation preserves literal $ characters.
  return JSON.stringify(String(value ?? '').replace(/\r?\n/g, ' ').replace(/\$/g, () => '$$'));
}

// Compose v2 ignores the top-level version field and warns about short device
// mappings. Keep Dok-written compose files on the current syntax so those
// warnings cannot block validation or deployment.
function stripComposeVersion(composeText) {
  const lines = String(composeText || '').replace(/\r\n/g, '\n').split('\n');
  let removed = false;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(?:["']version["']|version)[ \t]*:[ \t]*(.*)$/);
    if (!match) continue;
    const rest = stripYamlComment(match[1]).trim();
    if (rest && /^[\[{]/.test(rest)) continue;
    let end = i + 1;
    if (!rest) {
      while (end < lines.length) {
        const child = lines[end];
        if (!child.trim()) { end++; continue; }
        if (lineIndent(child) === 0) break;
        end++;
      }
    }
    lines.splice(i, end - i);
    removed = true;
    i--;
  }
  if (!removed) return composeText;
  while (lines.length && !lines[0].trim()) lines.shift();
  return lines.join('\n');
}

function parseShortDeviceEntry(value) {
  const text = String(value ?? '').trim();
  if (!text || /^[\[{]/.test(text)) return null;
  const clean = unquoteYamlScalar(text);
  if (!clean || clean.includes('=') || /\s/.test(clean)) return null;
  const parts = clean.split(':');
  if (parts.length > 3) return null;
  const source = parts[0];
  const target = parts[1] || source;
  const permissions = parts[2] || 'rwm';
  if (!source || !target || !/^[rwm]+$/.test(permissions)) return null;
  return { source, target, permissions };
}

function composeDeviceEntryLines(value, indent = '  ') {
  const text = String(value ?? '').trim();
  const parsed = parseShortDeviceEntry(text);
  if (!parsed) return [`${indent}- ${yamlScalar(text)}`];
  return [
    `${indent}- source: ${yamlScalar(parsed.source)}`,
    `${indent}  target: ${yamlScalar(parsed.target)}`,
    `${indent}  permissions: ${yamlScalar(parsed.permissions)}`
  ];
}

function composeDevicesYaml(devices, indent = '    ') {
  const list = Array.isArray(devices) ? devices : [devices];
  if (!list.length) return '';
  let yaml = `${indent}devices:\n`;
  for (const device of list) {
    if (device && typeof device === 'object') {
      const source = String(device.source ?? device.src ?? '').trim();
      const target = String(device.target ?? device.dst ?? device.destination ?? source).trim();
      const permissions = String(device.permissions ?? device.perms ?? '').trim() || 'rwm';
      if (!source || !target) continue;
      yaml += `${indent}  - source: ${yamlScalar(source)}\n`;
      yaml += `${indent}    target: ${yamlScalar(target)}\n`;
      yaml += `${indent}    permissions: ${yamlScalar(permissions)}\n`;
      continue;
    }
    const text = String(device ?? '').trim();
    if (!text) continue;
    const parsed = parseShortDeviceEntry(text);
    if (!parsed) {
      yaml += `${indent}  - ${yamlScalar(text)}\n`;
      continue;
    }
    yaml += `${indent}  - source: ${yamlScalar(parsed.source)}\n`;
    yaml += `${indent}    target: ${yamlScalar(parsed.target)}\n`;
    yaml += `${indent}    permissions: ${yamlScalar(parsed.permissions)}\n`;
  }
  return yaml;
}

function normalizeComposeDevices(composeText) {
  const source = String(composeText || '');
  if (!source.trim()) return source;
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const header = line.match(/^([ \t]*)devices[ \t]*:[ \t]*(.*)$/);
    if (!header) { out.push(line); continue; }
    out.push(line);
    const baseIndent = header[1];
    if (stripYamlComment(header[2]).trim()) continue;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const child = lines[j];
      if (!child.trim()) { out.push(child); continue; }
      const indent = (child.match(/^[ \t]*/) || [''])[0];
      if (indent.length <= baseIndent.length) break;
      const item = child.match(/^([ \t]*)-[ \t]+(.*)$/);
      if (!item) { out.push(child); continue; }
      const content = stripYamlComment(item[2]).trim();
      const parsed = parseShortDeviceEntry(content);
      if (!parsed || !/^\/dev(?:\/|$)/.test(parsed.source)) { out.push(child); continue; }
      out.push(...composeDeviceEntryLines(content, item[1]));
      changed = true;
    }
    i = j - 1;
  }
  if (!changed) return composeText;
  let result = out.join('\n');
  if (/\r?\n$/.test(source) && !result.endsWith('\n')) result += '\n';
  return result;
}

function unquoteYamlScalar(value) {
  const text = String(value ?? '').trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    try { return JSON.parse(text); } catch { return text.slice(1, -1); }
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  return text;
}

function cleanVolumeMode(value) {
  // Keep the valid leading mode (ro, rw, z, cached, ...) and drop anything
  // that came from a previous, mangled quoting round.
  const match = /^[A-Za-z0-9_,.+\-=]+/.exec(String(value || '').trim());
  return match ? match[0] : '';
}

function setMountSource(compose, mountTarget, hostSource) {
  const source = String(hostSource || '').trim();
  if (!source) return compose;
  const target = String(mountTarget);
  const suffix = `:${target}`;
  const lines = String(compose || '').split('\n');
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const item = /^(\s*-\s*)(.+?)(\s*)$/.exec(lines[i]);
    if (!item) continue;
    // Decode quoted YAML scalars before inspecting them. The previous regex
    // treated the closing quote as part of the mode, so every repair pass
    // added another escaped quote and the file grew without bound.
    const value = unquoteYamlScalar(item[2]).replace(/\$\$/g, '$');
    let mountSource = '';
    let mode = '';
    if (value.endsWith(suffix)) {
      mountSource = value.slice(0, -suffix.length);
    } else {
      const marker = `${suffix}:`;
      const at = value.lastIndexOf(marker);
      if (at === -1) continue;
      mountSource = value.slice(0, at);
      mode = cleanVolumeMode(value.slice(at + marker.length));
    }
    if (!mountSource) continue;
    const nextValue = yamlScalar(`${source}:${target}${mode ? `:${mode}` : ''}`);
    const nextLine = `${item[1]}${nextValue}${item[3]}`;
    if (nextLine !== lines[i]) {
      lines[i] = nextLine;
      changed = true;
    }
  }
  return changed ? lines.join('\n') : String(compose || '');
}

function durationValue(value) {
  const v = String(value ?? '').trim();
  return /^\d+$/.test(v) ? `${v}s` : v;
}

function humanByteSize(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return text;
  let bytes = Number(text);
  if (!Number.isFinite(bytes) || bytes <= 0) return text;
  const units = ['b', 'kb', 'mb', 'gb', 'tb'];
  let unit = 0;
  while (bytes >= 1024 && unit < units.length - 1) {
    bytes /= 1024;
    unit += 1;
  }
  const rounded = Math.round(bytes * 100) / 100;
  return `${Number.isInteger(rounded) ? rounded : String(rounded).replace(/0+$/, '').replace(/\.$/, '')}${units[unit]}`;
}

function mountSpecToVolume(spec) {
  const parts = {};
  for (const item of String(spec || '').split(',')) {
    const idx = item.indexOf('=');
    if (idx === -1) parts[item.trim()] = true;
    else parts[item.slice(0, idx).trim()] = item.slice(idx + 1).trim();
  }
  const type = parts.type || 'volume';
  const source = parts.source || parts.src || '';
  const target = parts.target || parts.dst || parts.destination || '';
  if (!target) return null;
  if (type === 'tmpfs') return { tmpfs: target };
  if (type !== 'bind' && type !== 'volume') return null;
  const readOnly = parts.readonly === true || parts.readonly === 'true' || parts.readonly === '1' || parts.ro === true;
  return { volume: `${source ? source + ':' : ''}${target}${readOnly ? ':ro' : ''}` };
}

function envEntriesValue(entries, key) {
  let value = '';
  for (const entry of entries || []) {
    const text = String(entry);
    const idx = text.indexOf('=');
    if (idx === -1) continue;
    if (text.slice(0, idx) === key) value = text.slice(idx + 1);
  }
  return value;
}

function normalizeVhostEnv(entries, { vhost = '', vhostPort = '', clearVhost = false } = {}) {
  const existingVhost = envEntriesValue(entries, 'VIRTUAL_HOST');
  const existingPort = envEntriesValue(entries, 'VIRTUAL_PORT');
  const finalVhost = clearVhost ? '' : String(vhost || existingVhost || '').trim();
  const finalPort = String(vhostPort || existingPort || '').trim();
  const env = (entries || []).filter(entry => {
    const key = String(entry).split('=')[0];
    return key !== 'VIRTUAL_HOST' && key !== 'VIRTUAL_PORT';
  });
  if (finalVhost) {
    env.push(`VIRTUAL_HOST=${finalVhost}`);
    env.push(`VIRTUAL_PORT=${finalPort || 80}`);
  } else if (finalPort && existingVhost && !clearVhost) {
    env.push(`VIRTUAL_PORT=${finalPort}`);
  }
  return {
    env,
    vhost: finalVhost,
    vhostPort: finalVhost ? (finalPort || '80') : '',
    hadVhost: !!existingVhost
  };
}

function portHostKey(mapping) {
  const text = String(mapping || '').trim();
  if (!text) return '';
  const withoutProto = text.replace(/\/(?:tcp|udp|sctp)$/i, '');
  const protocol = (text.match(/\/(tcp|udp|sctp)$/i) || [null, 'tcp'])[1].toLowerCase();
  const parts = withoutProto.split(':');
  if (parts.length < 2) return '';
  const host = parts[parts.length - 2];
  return host ? `${host}/${protocol}` : '';
}

function mergePortMappings(basePorts, extraPorts) {
  const result = [];
  const hostIndex = new Map();
  const add = (mapping) => {
    const text = String(mapping || '').trim();
    if (!text) return;
    const key = portHostKey(text);
    if (key && hostIndex.has(key)) {
      result[hostIndex.get(key)] = text;
      return;
    }
    if (key) hostIndex.set(key, result.length);
    result.push(text);
  };
  for (const port of basePorts || []) add(port);
  for (const port of extraPorts || []) add(port);
  return [...new Set(result)];
}

function parseDockerRun(command) {
  const args = tokenizeRunCommand(command);
  const result = {
    name: '', image: '', command: [], ports: [], volumes: [], env: [],
    networks: [], restart: '', labels: [], user: '', workdir: '',
    entrypoint: '', hostname: '', privileged: false, init: false, readOnly: false,
    stdinOpen: false, tty: false,
    capAdd: [], capDrop: [], devices: [], tmpfs: [], addHosts: [], dns: [],
    dnsSearch: [], dnsOpt: [], securityOpt: [], sysctls: [], logDriver: '', logOpts: [],
    pid: '', ipc: '', platform: '', shmSize: '', memory: '', memoryReservation: '',
    memorySwap: '', cpus: '', cpuShares: '', cpusetCpus: '', pull: '', expose: [],
    volumesFrom: [], stopSignal: '', stopTimeout: '', domainname: '', groupAdd: [],
    runtime: '', healthCmd: '', healthInterval: '', healthTimeout: '', healthRetries: '',
    healthStartPeriod: '', noHealthcheck: false, ulimits: [], unsupported: []
  };

  let i = 0;
  for (; i < args.length; i++) {
    let arg = args[i];
    if (arg === '--') { i++; break; }
    if (!arg.startsWith('-') || arg === '-') break;

    if (/^-[A-Za-z]/.test(arg) && !arg.startsWith('--') && arg.length > 2) {
      const chars = arg.slice(1);
      const expanded = [];
      let valid = true;
      for (let j = 0; j < chars.length; j++) {
        const ch = chars[j];
        if (RUN_SHORT_BOOL_FLAGS.has(ch)) {
          expanded.push(`-${ch}`);
          continue;
        }
        if (RUN_SHORT_VALUE_FLAGS.has(ch)) {
          expanded.push(`-${ch}`);
          const rest = chars.slice(j + 1);
          if (rest) expanded.push(rest);
          j = chars.length;
          break;
        }
        valid = false;
        break;
      }
      if (valid) {
        args.splice(i, 1, ...expanded);
        i--;
        continue;
      }
    }

    let flag = arg;
    let value = null;

    if (arg.startsWith('--') && arg.includes('=')) {
      const idx = arg.indexOf('=');
      flag = arg.slice(0, idx);
      value = arg.slice(idx + 1);
    } else if (/^-[^-]/.test(arg) && arg.length > 2 && RUN_SHORT_VALUE_FLAGS.has(arg[1])) {
      flag = arg.slice(0, 2);
      value = arg.slice(2);
    }

    const short = flag.length === 2 && flag.startsWith('-') && !flag.startsWith('--');
    const isBool = RUN_BOOL_FLAGS.has(flag) || (short && RUN_SHORT_BOOL_FLAGS.has(flag[1]));
    const takesValue = RUN_VALUE_FLAGS.has(flag) || (short && RUN_SHORT_VALUE_FLAGS.has(flag[1]));

    if (takesValue && value === null) {
      if (i + 1 >= args.length) throw new Error(`Missing value for ${flag}`);
      value = args[++i];
    }
    const boolFlagValue = value === null ? true : !/^(?:false|0|no|off)$/i.test(String(value));

    switch (flag) {
      case '-P': case '--publish-all': result.unsupported.push(`${flag} is not supported; add explicit -p mappings`); break;
      case '--name': result.name = value; break;
      case '-p': case '--publish': result.ports.push(value); break;
      case '-v': case '--volume': result.volumes.push(value); break;
      case '-e': case '--env': result.env.push(value); break;
      case '--net': case '--network': result.networks.push(value); break;
      case '--restart': result.restart = value; break;
      case '-l': case '--label': result.labels.push(value); break;
      case '-u': case '--user': result.user = value; break;
      case '-w': case '--workdir': result.workdir = value; break;
      case '--entrypoint': result.entrypoint = value; break;
      case '-h': case '--hostname': result.hostname = value; break;
      case '--privileged': result.privileged = boolFlagValue; break;
      case '--init': result.init = boolFlagValue; break;
      case '--read-only': result.readOnly = boolFlagValue; break;
      case '--no-healthcheck': result.noHealthcheck = boolFlagValue; break;
      case '-i': case '--interactive': result.stdinOpen = boolFlagValue; break;
      case '-t': case '--tty': result.tty = boolFlagValue; break;
      case '--rm': if (boolFlagValue) result.unsupported.push('--rm has no Compose equivalent; remove the container policy instead'); break;
      case '--cap-add': result.capAdd.push(value); break;
      case '--cap-drop': result.capDrop.push(value); break;
      case '--device': result.devices.push(value); break;
      case '--tmpfs': result.tmpfs.push(value); break;
      case '--mount': {
        const mount = mountSpecToVolume(value);
        if (mount?.volume) result.volumes.push(mount.volume);
        else if (mount?.tmpfs) result.tmpfs.push(mount.tmpfs);
        else result.unsupported.push(`--mount ${value}`);
        break;
      }
      case '--add-host': result.addHosts.push(value); break;
      case '--dns': result.dns.push(value); break;
      case '--dns-search': result.dnsSearch.push(value); break;
      case '--dns-option': result.dnsOpt.push(value); break;
      case '--security-opt': result.securityOpt.push(value); break;
      case '--sysctl': result.sysctls.push(value); break;
      case '--log-driver': result.logDriver = value; break;
      case '--log-opt': result.logOpts.push(value); break;
      case '--pid': result.pid = value; break;
      case '--ipc': result.ipc = value; break;
      case '--platform': result.platform = value; break;
      case '--shm-size': result.shmSize = value; break;
      case '-m': case '--memory': result.memory = value; break;
      case '--memory-reservation': result.memoryReservation = value; break;
      case '--memory-swap': result.memorySwap = value; break;
      case '--cpus': result.cpus = value; break;
      case '-c': case '--cpu-shares': result.cpuShares = value; break;
      case '--cpuset-cpus': result.cpusetCpus = value; break;
      case '--expose': result.expose.push(value); break;
      case '--volumes-from': result.volumesFrom.push(value); break;
      case '--pull': result.pull = value; break;
      case '--stop-signal': result.stopSignal = value; break;
      case '--stop-timeout': result.stopTimeout = value; break;
      case '--domainname': result.domainname = value; break;
      case '--group-add': result.groupAdd.push(value); break;
      case '--runtime': result.runtime = value; break;
      case '--health-cmd': result.healthCmd = value; break;
      case '--health-interval': result.healthInterval = value; break;
      case '--health-timeout': result.healthTimeout = value; break;
      case '--health-retries': result.healthRetries = value; break;
      case '--health-start-period': result.healthStartPeriod = value; break;
      case '--ulimit': result.ulimits.push(value); break;
      default:
        if (!isBool) result.unsupported.push(value === null ? flag : `${flag} ${value}`);
        break;
    }
  }

  while (i < args.length && !args[i]) i++;
  if (i >= args.length) throw new Error('No image specified in docker run command');
  result.image = String(args[i]);
  result.command = args.slice(i + 1);

  if (!/^[A-Za-z0-9][A-Za-z0-9_.:/@-]*$/.test(result.image)) {
    throw new Error(`Invalid image name: ${result.image}`);
  }
  return result;
}

function runCommandToCompose(command, appName, opts = {}) {
  let parsed;
  try { parsed = parseDockerRun(command); } catch (e) { throw httpError(400, e.message); }
  const imageBase = parsed.image.split('/').pop().split(':')[0].split('@')[0];
  const name = projectName(appName || parsed.name || imageBase || 'app', 'app');
  const containerName = String(parsed.name || name)
    .replace(/[^a-zA-Z0-9_.-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '') || name;
  const restart = /^(no|always|unless-stopped|on-failure(:\d+)?)$/.test(parsed.restart || '')
    ? parsed.restart
    : 'unless-stopped';

  const extraPorts = (opts.extraPorts || []).map(p => String(p).trim()).filter(Boolean);
  const requestedPorts = opts.replacePorts ? extraPorts : mergePortMappings(parsed.ports, extraPorts);
  const networkMode = parsed.networks.find(n =>
    ['host', 'none', 'bridge'].includes(n) || n.startsWith('container:')
  );
  const dropsPorts = networkMode && networkMode !== 'bridge';
  const ports = dropsPorts ? [] : requestedPorts;
  if (dropsPorts && requestedPorts.length) {
    parsed.unsupported.push(`Port mappings are ignored because network_mode is ${networkMode}`);
  }
  // A docker run command can set VIRTUAL_HOST without VIRTUAL_PORT. Infer the
  // matching container port instead of defaulting every routed app to 80.
  let inferredVhostPort = String(opts.vhostPort || '').trim();
  if (!inferredVhostPort && !envEntriesValue(parsed.env, 'VIRTUAL_PORT')) {
    const publishedTarget = ports.map(composePortTarget).find(Boolean);
    const exposedTarget = (parsed.expose || [])
      .map(value => String(value).split(/[-\/]/)[0])
      .find(value => /^\d+$/.test(value));
    const envPort = envEntriesValue(parsed.env, 'PORT');
    inferredVhostPort = publishedTarget || exposedTarget || (/^\d+$/.test(envPort) ? envPort : '');
  }
  const envInfo = normalizeVhostEnv(parsed.env, {
    vhost: opts.vhost,
    vhostPort: inferredVhostPort,
    clearVhost: opts.clearVhost
  });
  const env = envInfo.env;

  const requestedNetworks = Array.isArray(opts.networks) ? opts.networks : parsed.networks;
  const appNetworks = networkMode ? [] : [...new Set(requestedNetworks.filter(n =>
    n && !['host', 'none', 'bridge', 'default'].includes(n) &&
    !n.startsWith('container:') && !n.startsWith('service:')
  ))];
  if (!networkMode && !appNetworks.length && opts.network && !['bridge', 'host', 'none', 'default'].includes(opts.network)) {
    appNetworks.push(opts.network);
  }

  let compose = `# managed-by: wickedafdok\nservices:\n  ${name}:\n`;
  compose += `    container_name: ${yamlScalar(containerName)}\n`;
  compose += `    image: ${yamlScalar(parsed.image)}\n`;
  compose += `    restart: ${yamlScalar(restart)}\n`;
  if (networkMode) compose += `    network_mode: ${yamlScalar(networkMode)}\n`;
  if (parsed.command.length) compose += `    command: ${JSON.stringify(parsed.command.map(a => String(a).replace(/\$/g, () => '$$')))}\n`;
  if (parsed.entrypoint) compose += `    entrypoint: ${yamlScalar(parsed.entrypoint)}\n`;
  if (parsed.user) compose += `    user: ${yamlScalar(parsed.user)}\n`;
  if (parsed.workdir) compose += `    working_dir: ${yamlScalar(parsed.workdir)}\n`;
  if (parsed.hostname) compose += `    hostname: ${yamlScalar(parsed.hostname)}\n`;
  if (parsed.domainname) compose += `    domainname: ${yamlScalar(parsed.domainname)}\n`;
  if (parsed.privileged) compose += '    privileged: true\n';
  if (parsed.init) compose += '    init: true\n';
  if (parsed.readOnly) compose += '    read_only: true\n';
  if (parsed.stdinOpen) compose += '    stdin_open: true\n';
  if (parsed.tty) compose += '    tty: true\n';
  if (parsed.platform) compose += `    platform: ${yamlScalar(parsed.platform)}\n`;
  if (parsed.pid) compose += `    pid: ${yamlScalar(parsed.pid)}\n`;
  if (parsed.ipc) compose += `    ipc: ${yamlScalar(parsed.ipc)}\n`;
  if (parsed.runtime) compose += `    runtime: ${yamlScalar(parsed.runtime)}\n`;
  if (parsed.shmSize) compose += `    shm_size: ${yamlScalar(humanByteSize(parsed.shmSize))}\n`;
  if (parsed.memory) compose += `    mem_limit: ${yamlScalar(parsed.memory)}\n`;
  if (parsed.memoryReservation) compose += `    mem_reservation: ${yamlScalar(parsed.memoryReservation)}\n`;
  if (parsed.memorySwap) compose += `    memswap_limit: ${yamlScalar(parsed.memorySwap)}\n`;
  if (parsed.cpus) compose += `    cpus: ${yamlScalar(parsed.cpus)}\n`;
  if (parsed.cpuShares) compose += `    cpu_shares: ${yamlScalar(parsed.cpuShares)}\n`;
  if (parsed.cpusetCpus) compose += `    cpuset: ${yamlScalar(parsed.cpusetCpus)}\n`;
  if (parsed.pull) compose += `    pull_policy: ${yamlScalar(parsed.pull)}\n`;
  if (parsed.stopSignal) compose += `    stop_signal: ${yamlScalar(parsed.stopSignal)}\n`;
  if (parsed.stopTimeout) compose += `    stop_grace_period: ${yamlScalar(durationValue(parsed.stopTimeout))}\n`;
  if (ports.length) {
    compose += `    ports:\n${ports.map(p => `      - ${yamlScalar(p)}`).join('\n')}\n`;
  }
  if (parsed.expose.length) {
    compose += `    expose:\n${parsed.expose.map(p => `      - ${yamlScalar(p)}`).join('\n')}\n`;
  }
  if (parsed.volumes.length) {
    compose += `    volumes:\n${parsed.volumes.map(v => `      - ${yamlScalar(v)}`).join('\n')}\n`;
  }
  if (parsed.tmpfs.length) {
    compose += `    tmpfs:\n${parsed.tmpfs.map(v => `      - ${yamlScalar(v)}`).join('\n')}\n`;
  }
  if (parsed.volumesFrom.length) {
    compose += `    volumes_from:\n${parsed.volumesFrom.map(v => `      - ${yamlScalar(v)}`).join('\n')}\n`;
  }
  if (env.length) {
    compose += `    environment:\n${env.map(e => `      - ${yamlScalar(e)}`).join('\n')}\n`;
  }
  if (parsed.labels.length) {
    compose += `    labels:\n${parsed.labels.map(l => `      - ${yamlScalar(l)}`).join('\n')}\n`;
  }
  if (parsed.capAdd.length) {
    compose += `    cap_add:\n${parsed.capAdd.map(v => `      - ${yamlScalar(v)}`).join('\n')}\n`;
  }
  if (parsed.capDrop.length) {
    compose += `    cap_drop:\n${parsed.capDrop.map(v => `      - ${yamlScalar(v)}`).join('\n')}\n`;
  }
  if (parsed.devices.length) compose += composeDevicesYaml(parsed.devices, '    ');
  if (parsed.addHosts.length) {
    compose += `    extra_hosts:\n${parsed.addHosts.map(v => `      - ${yamlScalar(v)}`).join('\n')}\n`;
  }
  if (parsed.dns.length) {
    compose += `    dns:\n${parsed.dns.map(v => `      - ${yamlScalar(v)}`).join('\n')}\n`;
  }
  if (parsed.dnsSearch.length) {
    compose += `    dns_search:\n${parsed.dnsSearch.map(v => `      - ${yamlScalar(v)}`).join('\n')}\n`;
  }
  if (parsed.dnsOpt.length) {
    compose += `    dns_opt:\n${parsed.dnsOpt.map(v => `      - ${yamlScalar(v)}`).join('\n')}\n`;
  }
  if (parsed.securityOpt.length) {
    compose += `    security_opt:\n${parsed.securityOpt.map(v => `      - ${yamlScalar(v)}`).join('\n')}\n`;
  }
  if (parsed.groupAdd.length) {
    compose += `    group_add:\n${parsed.groupAdd.map(v => `      - ${yamlScalar(v)}`).join('\n')}\n`;
  }
  const ulimits = parsed.ulimits.map(u => {
    const idx = u.indexOf('=');
    if (idx <= 0) return null;
    const name = u.slice(0, idx);
    const [soft, hard = soft] = u.slice(idx + 1).split(':');
    if (!soft) return null;
    return [name, soft, hard];
  }).filter(Boolean);
  if (ulimits.length) {
    compose += '    ulimits:\n';
    for (const [name, soft, hard] of ulimits) {
      compose += `      ${yamlScalar(name)}:\n        soft: ${yamlScalar(soft)}\n        hard: ${yamlScalar(hard)}\n`;
    }
  }
  const sysctls = parsed.sysctls.map(s => {
    const idx = s.indexOf('=');
    return idx > 0 ? [s.slice(0, idx), s.slice(idx + 1)] : null;
  }).filter(Boolean);
  if (sysctls.length) {
    compose += `    sysctls:\n${sysctls.map(([k, v]) => `      ${yamlScalar(k)}: ${yamlScalar(v)}`).join('\n')}\n`;
  }
  if (parsed.logDriver || parsed.logOpts.length) {
    compose += '    logging:\n';
    if (parsed.logDriver) compose += `      driver: ${yamlScalar(parsed.logDriver)}\n`;
    const logOpts = parsed.logOpts.map(o => {
      const idx = o.indexOf('=');
      return idx > 0 ? [o.slice(0, idx), o.slice(idx + 1)] : null;
    }).filter(Boolean);
    if (logOpts.length) {
      compose += `      options:\n${logOpts.map(([k, v]) => `        ${yamlScalar(k)}: ${yamlScalar(v)}`).join('\n')}\n`;
    }
  }
  if (parsed.noHealthcheck) {
    compose += '    healthcheck:\n      disable: true\n';
  } else if (parsed.healthCmd || parsed.healthInterval || parsed.healthTimeout || parsed.healthRetries || parsed.healthStartPeriod) {
    compose += '    healthcheck:\n';
    if (parsed.healthCmd) compose += `      test: ${yamlScalar(parsed.healthCmd)}\n`;
    if (parsed.healthInterval) compose += `      interval: ${yamlScalar(durationValue(parsed.healthInterval))}\n`;
    if (parsed.healthTimeout) compose += `      timeout: ${yamlScalar(durationValue(parsed.healthTimeout))}\n`;
    if (parsed.healthRetries) compose += `      retries: ${yamlScalar(parsed.healthRetries)}\n`;
    if (parsed.healthStartPeriod) compose += `      start_period: ${yamlScalar(durationValue(parsed.healthStartPeriod))}\n`;
  }
  if (appNetworks.length) {
    compose += `    networks:\n${appNetworks.map(n => `      - ${yamlScalar(n)}`).join('\n')}\n`;
    compose += `\nnetworks:\n`;
    for (const net of appNetworks) {
      compose += `  ${yamlScalar(net)}:\n    external: true\n    name: ${yamlScalar(net)}\n`;
    }
  }

  return {
    compose, name, containerName, image: parsed.image, ports, env,
    networks: appNetworks, requestedNetworks: parsed.networks, networkMode,
    vhost: envInfo.vhost, vhostPort: envInfo.vhostPort, hadVhost: envInfo.hadVhost,
    command: parsed.command, unsupported: parsed.unsupported
  };
}

function isPreservedAppRoot(name) {
  return name === 'data' || /^\.env($|\.)/.test(name);
}

function copySourceTree(src, dest, { preserveAppData = false } = {}) {
  if (!src || !fs.existsSync(src) || path.resolve(src) === path.resolve(dest)) return;
  const skipEntry = (entryPath) => {
    const base = path.basename(entryPath);
    if (base === '.git' || base === 'node_modules' || base === 'docker-compose.wickedafdok.yml') return true;
    if (!preserveAppData) return false;
    const rel = path.relative(src, entryPath);
    if (!rel || rel.startsWith('..')) return false;
    return isPreservedAppRoot(rel.split(path.sep)[0]);
  };
  try {
    if (typeof fs.cpSync === 'function') {
      fs.cpSync(src, dest, {
        recursive: true,
        force: true,
        filter: (p) => !skipEntry(p)
      });
      return;
    }
  } catch {}
  const srcResolved = fs.realpathSync(src);
  const destResolved = fs.existsSync(dest) ? fs.realpathSync(dest) : path.resolve(dest);
  if (srcResolved === destResolved) return;
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (skipEntry(path.join(src, entry.name))) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copySourceTree(s, d);
    } else if (entry.isSymbolicLink()) {
      try {
        const link = fs.readlinkSync(s);
        fs.symlinkSync(link, d);
      } catch {}
    } else {
      try { fs.copyFileSync(s, d); } catch {}
    }
  }
}

function directoryHasEntries(dir) {
  try {
    return !!dir && fs.existsSync(dir) && fs.statSync(dir).isDirectory() && fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

function clearAppDirectory(target, { preserveAppData = true } = {}) {
  if (!target || !fs.existsSync(target)) return;
  for (const child of fs.readdirSync(target)) {
    if (preserveAppData && isPreservedAppRoot(child)) continue;
    fs.rmSync(path.join(target, child), { recursive: true, force: true });
  }
}

function appDataRootForPath(source, defaults = configuredDefaults(), appDir = '') {
  const resolved = path.resolve(String(source || ''));
  if (!source) return '';
  if (appDir) {
    const localData = path.join(path.resolve(appDir), 'data');
    if (resolved === localData || resolved.startsWith(localData + path.sep)) return localData;
  }
  if (!defaults?.dataLocation) return '';
  const appsRoot = path.resolve(defaults.dataLocation, 'apps');
  if (!resolved.startsWith(appsRoot + path.sep)) return '';
  const parts = path.relative(appsRoot, resolved).split(path.sep);
  if (parts.length < 2 || parts[1] !== 'data') return '';
  return path.join(appsRoot, parts[0], 'data');
}

async function ensureNetwork(name) {
  if (!name || ['bridge', 'host', 'none'].includes(name)) return;
  const nets = await docker.listNetworks();
  if (!nets.find(n => n.Name === name)) {
    await docker.createNetwork({ Name: name, Driver: 'bridge' });
  }
}

function isUserNetworkName(name) {
  const text = String(name || '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(text) &&
    !['host', 'none', 'default'].includes(text);
}

async function dockerNetworkNames() {
  const nets = await docker.listNetworks();
  return nets.map(n => n.Name);
}

async function createNetworkStrict(name) {
  const text = String(name || '').trim();
  if (!isUserNetworkName(text)) throw httpError(400, `Invalid network name: ${text || '(empty)'}`);
  const nets = await docker.listNetworks();
  if (nets.find(n => n.Name === text)) return { existed: true, name: text };
  await docker.createNetwork({ Name: text, Driver: 'bridge' });
  return { created: true, name: text };
}

function volumeKey(service, target) {
  return `${service || ''}::${target || ''}`;
}

function isBlockedHostPath(value) {
  const abs = path.resolve(value);
  if (abs === path.parse(abs).root) return true;
  const blocked = ['/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/boot', '/dev', '/proc', '/sys', '/run', '/var/run', '/var/lib/docker'];
  return blocked.some(dir => abs === dir || abs.startsWith(dir + path.sep));
}

function safeHostPath(value) {
  const text = String(value || '').trim();
  if (!text || !path.isAbsolute(text)) throw httpError(400, `Host path must be absolute: ${text || '(empty)'}`);
  const abs = path.resolve(text);
  if (isBlockedHostPath(abs)) {
    throw httpError(400, `Refusing to create a protected host path: ${abs}`);
  }
  let existing = abs;
  const suffix = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    suffix.unshift(path.basename(existing));
    existing = parent;
  }
  let realExisting;
  try {
    realExisting = fs.realpathSync(existing);
  } catch {
    throw httpError(400, `Could not resolve host path: ${abs}`);
  }
  const resolved = path.join(realExisting, ...suffix);
  if (isBlockedHostPath(resolved)) {
    throw httpError(400, `Refusing to create a protected host path: ${resolved}`);
  }
  return abs;
}

async function composeConfig(composeTexts, { projectDir = '' } = {}) {
  const list = Array.isArray(composeTexts) ? composeTexts : [composeTexts];
  const workDir = projectDir && fs.existsSync(projectDir) ? projectDir : path.join(dataDir, 'tmp');
  try { fs.mkdirSync(workDir, { recursive: true }); } catch {}
  const tmpFiles = [];
  try {
    const args = ['compose'];
    list.forEach((text, index) => {
      const file = path.join(workDir, `.wickedafdok-inspect-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}.yml`);
      const normalized = normalizeComposeDevices(stripComposeVersion(String(text || '')));
      fs.writeFileSync(file, normalized);
      tmpFiles.push(file);
      args.push('-f', file);
    });
    args.push('config', '--format', 'json');
    const { stdout } = await run('docker', args, { cwd: workDir });
    return { ok: true, config: JSON.parse(stdout), issues: [] };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: true, unavailable: true, config: null, issues: [] };
    const detail = String(e.stderr || e.stdout || e.message || '')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .slice(0, 12)
      .join('\n');
    return { ok: false, config: null, issues: [detail || 'Compose inspection failed'] };
  } finally {
    for (const file of tmpFiles) {
      try { fs.unlinkSync(file); } catch {}
    }
  }
}

function runNetworkRefs(conv, networkNames = []) {
  if (!conv || conv.networkMode) return [];
  const existing = new Set(networkNames);
  return [...new Set((conv.requestedNetworks || []).filter(name =>
    name && !['host', 'none', 'bridge', 'default'].includes(name) &&
    !name.startsWith('container:') && !name.startsWith('service:')
  ))].map(name => ({ key: name, name, external: true, missing: !existing.has(name) }));
}

function isUserNetwork(name) {
  return !!name && !['host', 'none', 'bridge', 'default'].includes(name) &&
    !String(name).startsWith('container:') && !String(name).startsWith('service:');
}

// Resolve the networks requested by a docker run command. Networks that do not
// exist are dropped in favour of the setup-managed default network so the
// generated compose can be launched immediately.
function planRunNetworks(conv, networkNames = [], defaultNetwork = 'wicked') {
  if (!conv || conv.networkMode) {
    return { requested: [], existing: [], missing: [], networks: [], replacedNetworks: [] };
  }
  const known = new Set(networkNames || []);
  const requested = [...new Set((conv.requestedNetworks || []).filter(isUserNetwork))];
  const existing = [];
  const missing = [];
  for (const name of requested) {
    if (name === defaultNetwork || known.has(name)) {
      if (!existing.includes(name)) existing.push(name);
    } else if (!missing.includes(name)) {
      missing.push(name);
    }
  }
  const networks = [...existing];
  if ((missing.length || !networks.length) && !networks.includes(defaultNetwork)) {
    networks.push(defaultNetwork);
  }
  return {
    requested,
    existing,
    missing,
    networks,
    replacedNetworks: missing.map(name => ({ key: name, name }))
  };
}

function stripYamlComment(value) {
  const text = String(value ?? '');
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (quote === '"' && ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '#' && (i === 0 || /\s/.test(text[i - 1]))) return text.slice(0, i).trimEnd();
  }
  return text.trim();
}

function unquoteYamlValue(value) {
  const text = stripYamlComment(value).trim();
  if (text.startsWith('"') && text.endsWith('"')) {
    try { return JSON.parse(text); } catch { return text.slice(1, -1); }
  }
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replace(/''/g, "'");
  return text;
}

function formatYamlKey(value) {
  const text = String(value ?? '');
  return /^[A-Za-z0-9_.-]+$/.test(text) ? text : JSON.stringify(text);
}

function lineIndent(line) {
  const match = String(line || '').match(/^[ \t]*/);
  return (match ? match[0] : '').replace(/\t/g, '  ').length;
}

function splitFlowItems(value) {
  const text = String(value || '');
  const items = [];
  let current = '';
  let quote = null;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (quote === '"' && ch === '\\') { i++; if (i < text.length) current += text[i]; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === '{' || ch === '[') depth++;
    if (ch === '}' || ch === ']') depth--;
    if (ch === ',' && depth === 0) {
      if (current.trim()) items.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) items.push(current.trim());
  return items;
}

function parseInlineYamlMapping(value) {
  const text = stripYamlComment(value).trim();
  if (!text.startsWith('{') || !text.endsWith('}')) return null;
  const result = {};
  for (const item of splitFlowItems(text.slice(1, -1))) {
    const idx = item.indexOf(':');
    if (idx <= 0) continue;
    const key = unquoteYamlValue(item.slice(0, idx));
    if (!key) continue;
    result[key] = unquoteYamlValue(item.slice(idx + 1));
  }
  return result;
}

function parseNetworkListItem(line) {
  const match = String(line || '').match(/^[ \t]*-[ \t]+(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'|([^ \t#]+))/);
  if (!match) return '';
  if (match[1] !== undefined) {
    try { return JSON.parse(`"${match[1]}"`); } catch { return match[1]; }
  }
  if (match[2] !== undefined) return match[2].replace(/''/g, "'");
  return match[3];
}

function parseNetworkEntryLine(line) {
  const match = String(line || '').match(/^[ \t]*(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^:#]+?)[ \t]*:[ \t]*(.*)$/);
  if (!match) return null;
  const keyMatch = String(line).match(/^[ \t]*(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'|([^:#]+?))[ \t]*:[ \t]*(.*)$/);
  if (!keyMatch) return null;
  let key;
  if (keyMatch[1] !== undefined) {
    try { key = JSON.parse(`"${keyMatch[1]}"`); } catch { key = keyMatch[1]; }
  } else if (keyMatch[2] !== undefined) {
    key = keyMatch[2].replace(/''/g, "'");
  } else {
    key = keyMatch[3].trim();
  }
  return { key, rest: keyMatch[4] || '' };
}

function applyNetworkInlineProps(def, value, impliedExternal = false) {
  const inline = parseInlineYamlMapping(value);
  if (!inline) return false;
  if (inline.external !== undefined) {
    const externalValue = String(inline.external).trim();
    const nested = parseInlineYamlMapping(externalValue);
    if (nested) {
      def.external = true;
      if (nested.name) def.name = String(nested.name);
    } else {
      def.external = ['true', 'yes', 'on'].includes(externalValue.toLowerCase());
    }
  } else if (impliedExternal) {
    def.external = true;
  }
  if (inline.name) def.name = String(inline.name);
  return true;
}

function composeNetworkInfo(text) {
  const lines = String(text || '').split(/\r?\n/);
  const info = { lines, start: -1, end: lines.length, keyIndent: null, defs: [], header: '', inline: false };
  for (let i = 0; i < lines.length; i++) {
    if (/^networks[ \t]*:/.test(lines[i])) { info.start = i; break; }
  }
  if (info.start < 0) return info;
  info.header = lines[info.start];
  const headerRest = stripYamlComment(lines[info.start].replace(/^networks[ \t]*:/, '')).trim();
  if (headerRest) {
    info.inline = true;
    info.end = info.start + 1;
    return info;
  }
  for (let i = info.start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (lineIndent(line) === 0) { info.end = i; break; }
  }
  for (let i = info.start + 1; i < info.end; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (lineIndent(line) > 0) { info.keyIndent = lineIndent(line); break; }
  }
  if (info.keyIndent === null) {
    info.end = info.start + 1;
    return info;
  }
  let current = null;
  for (let i = info.start + 1; i < info.end; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = lineIndent(line);
    if (indent === info.keyIndent) {
      const parsed = parseNetworkEntryLine(line);
      if (!parsed) continue;
      if (current) { current.end = i; info.defs.push(current); }
      current = { key: parsed.key, start: i, end: info.end, external: false, name: parsed.key };
      if (parsed.rest) applyNetworkInlineProps(current, parsed.rest);
      continue;
    }
    if (!current || indent <= info.keyIndent) continue;
    const prop = String(line).match(/^[ \t]*([A-Za-z0-9_.-]+)[ \t]*:[ \t]*(.*)$/);
    if (!prop) continue;
    const name = prop[1];
    if (name === 'external') {
      if (!applyNetworkInlineProps(current, prop[2], true)) {
        current.external = ['true', 'yes', 'on'].includes(unquoteYamlValue(prop[2]).toLowerCase());
      }
    } else if (name === 'name') {
      const inline = parseInlineYamlMapping(prop[2]);
      const value = inline ? (inline.name || '') : unquoteYamlValue(prop[2]);
      if (value) current.name = String(value);
    }
  }
  if (current) { current.end = info.end; info.defs.push(current); }
  return info;
}

function networkDefinitionLines(keyIndent, propIndent, name) {
  const padKey = ' '.repeat(keyIndent);
  const padProp = ' '.repeat(propIndent);
  return [
    `${padKey}${formatYamlKey(name)}:`,
    `${padProp}external: true`,
    `${padProp}name: ${formatYamlKey(name)}`
  ];
}

// Replace external networks that do not exist on the host with the setup
// managed default network (wicked). Only network references are rewritten so
// the rest of the user's compose file is preserved.
function normalizeComposeNetworks(composeText, networkNames = [], defaultNetwork = 'wicked') {
  const text = String(composeText || '');
  const info = composeNetworkInfo(text);
  if (info.inline) {
    return { text, changed: false, replacedNetworks: [], removedNetworks: [] };
  }
  const existing = new Set(networkNames || []);
  existing.add(defaultNetwork);
  const defs = info.defs || [];
  if (!defs.length) {
    return { text, changed: false, replacedNetworks: [], removedNetworks: [] };
  }
  const byKey = new Map(defs.map(def => [def.key, def]));
  const missingDefs = defs.filter(def => def.external && !existing.has(def.name));
  if (!missingDefs.length) {
    return { text, changed: false, replacedNetworks: [], removedNetworks: [] };
  }
  const missingKeys = new Set(missingDefs.map(def => def.key));
  const lines = info.lines;
  const deleteLines = new Set();
  const replacements = new Map();
  const replacedNetworks = [];
  const replacedSeen = new Set();

  const recordReplaced = (key) => {
    if (replacedSeen.has(key)) return;
    replacedSeen.add(key);
    const def = byKey.get(key);
    replacedNetworks.push({ key, name: def?.name || key });
  };

  for (let i = 0; i < lines.length; i++) {
    if (info.start >= 0 && i >= info.start && i < info.end) continue;
    const header = String(lines[i]).match(/^([ \t]+)networks[ \t]*:[ \t]*(.*)$/);
    if (!header) continue;
    const headerIndent = lineIndent(lines[i]);

    const inlineList = String(lines[i]).match(/^([ \t]*)networks[ \t]*:[ \t]*\[(.*)\]([ \t]*(?:#.*)?)$/);
    if (inlineList) {
      const values = splitFlowItems(inlineList[2]).map(unquoteYamlValue);
      const next = [];
      let hasWicked = values.includes(defaultNetwork);
      let replacedHere = false;
      for (const value of values) {
        if (!missingKeys.has(value)) {
          if (!next.includes(value)) next.push(value);
          continue;
        }
        recordReplaced(value);
        replacedHere = true;
        if (hasWicked) continue;
        next.push(defaultNetwork);
        hasWicked = true;
      }
      if (replacedHere && !next.includes(defaultNetwork)) next.push(defaultNetwork);
      const rendered = next.map(value => formatYamlKey(value)).join(', ');
      replacements.set(i, [`${inlineList[1]}networks: [${rendered}]${inlineList[3] || ''}`]);
      continue;
    }

    if (stripYamlComment(header[2]).trim()) continue;

    let end = i + 1;
    for (; end < lines.length; end++) {
      const line = lines[end];
      if (!line.trim() || line.trim().startsWith('#')) continue;
      if (lineIndent(line) <= headerIndent) break;
    }
    let childIndent = null;
    let firstChild = '';
    for (let j = i + 1; j < end; j++) {
      const line = lines[j];
      if (!line.trim() || line.trim().startsWith('#')) continue;
      childIndent = lineIndent(line);
      firstChild = line;
      break;
    }
    if (childIndent === null) continue;

    const listMode = /^[ \t]*-[ \t]+/.test(firstChild);
    if (listMode) {
      const itemIndices = [];
      for (let j = i + 1; j < end; j++) {
        const line = lines[j];
        if (!line.trim()) continue;
        if (/^[ \t]*-[ \t]+/.test(line) && lineIndent(line) >= childIndent) itemIndices.push(j);
      }
      let hasWicked = itemIndices.some(j => parseNetworkListItem(lines[j]) === defaultNetwork);
      for (const j of itemIndices) {
        const value = parseNetworkListItem(lines[j]);
        if (!value || !missingKeys.has(value)) continue;
        recordReplaced(value);
        if (hasWicked) {
          deleteLines.add(j);
          continue;
        }
        const prefix = String(lines[j]).match(/^([ \t]*-[ \t]+)/);
        replacements.set(j, [`${prefix ? prefix[1] : '      - '}${formatYamlKey(defaultNetwork)}`]);
        hasWicked = true;
      }
      continue;
    }

    const entries = [];
    for (let j = i + 1; j < end; j++) {
      const line = lines[j];
      if (!line.trim() || line.trim().startsWith('#')) continue;
      if (lineIndent(line) !== childIndent) continue;
      if (!/^[ \t]*(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^:#]+?)[ \t]*:/.test(line)) continue;
      const parsed = parseNetworkEntryLine(line);
      if (parsed) entries.push({ key: parsed.key, start: j, end });
    }
    for (let j = 0; j < entries.length; j++) {
      if (j + 1 < entries.length) entries[j].end = entries[j + 1].start;
    }
    let hasWicked = entries.some(entry => entry.key === defaultNetwork);
    for (const entry of entries) {
      if (!missingKeys.has(entry.key)) continue;
      recordReplaced(entry.key);
      if (hasWicked) {
        for (let j = entry.start; j < entry.end; j++) deleteLines.add(j);
        continue;
      }
      const line = String(lines[entry.start]);
      const keyMatch = line.match(/^([ \t]*)(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^:#]+?)([ \t]*:[ \t]*.*)$/);
      if (keyMatch) {
        replacements.set(entry.start, [`${keyMatch[1]}${formatYamlKey(defaultNetwork)}${keyMatch[2]}`]);
        hasWicked = true;
      }
    }
  }

  for (const def of missingDefs) {
    if (!replacedSeen.has(def.key)) {
      replacedSeen.add(def.key);
      replacedNetworks.push({ key: def.key, name: def.name });
    }
  }

  const keyIndent = info.keyIndent || 2;
  const propIndent = keyIndent + 2;
  const needsWicked = missingDefs.length > 0;
  const blockLines = [];
  if (info.start >= 0) blockLines.push(info.header);
  let hasWickedDefinition = false;
  for (const def of defs) {
    if (missingDefs.includes(def)) continue;
    if (def.key === defaultNetwork && needsWicked) {
      blockLines.push(...networkDefinitionLines(keyIndent, propIndent, defaultNetwork));
      hasWickedDefinition = true;
      continue;
    }
    if (def.key === defaultNetwork) hasWickedDefinition = true;
    blockLines.push(...lines.slice(def.start, def.end));
  }
  if (needsWicked && !hasWickedDefinition) {
    blockLines.push(...networkDefinitionLines(keyIndent, propIndent, defaultNetwork));
  }
  if (info.start < 0) {
    if (blockLines.length) blockLines.unshift('networks:');
  } else if (blockLines.length === 1 && blockLines[0] === info.header) {
    blockLines.length = 0;
  }

  const output = [];
  for (let i = 0; i < lines.length; i++) {
    if (info.start >= 0 && i === info.start) {
      output.push(...blockLines);
      i = info.end - 1;
      continue;
    }
    if (deleteLines.has(i)) continue;
    if (replacements.has(i)) {
      output.push(...replacements.get(i));
      continue;
    }
    output.push(lines[i]);
  }
  if (info.start < 0 && needsWicked) {
    output.push('networks:', ...networkDefinitionLines(2, 4, defaultNetwork));
  }

  let result = output.join('\n');
  if (/\r?\n$/.test(text) && !result.endsWith('\n')) result += '\n';
  return {
    text: result,
    changed: true,
    replacedNetworks,
    removedNetworks: missingDefs
      .filter(def => !replacedSeen.has(def.key))
      .map(def => ({ key: def.key, name: def.name }))
  };
}

function stripComposeProjectName(composeText) {
  const lines = String(composeText || '').replace(/\r\n/g, '\n').split('\n');
  let removed = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/^name[ \t]*:/.test(line)) continue;
    const rest = stripYamlComment(line.replace(/^name[ \t]*:/, '')).trim();
    let end = i + 1;
    if (!rest) {
      while (end < lines.length) {
        const child = lines[end];
        if (!child.trim()) { end++; continue; }
        if (lineIndent(child) === 0) break;
        end++;
      }
    }
    lines.splice(i, end - i);
    removed = true;
    i--;
  }
  if (!removed) return composeText;
  while (lines.length && !lines[0].trim()) lines.shift();
  return lines.join('\n');
}

function ensureManagedComposeHeader(composeText) {
  const text = String(composeText || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!text.trim()) return text;
  if (/^#\s*managed-by:\s*wickedafdok\b/m.test(text.split('\n')[0] || '')) return text;
  return '# managed-by: wickedafdok\n' + text.replace(/^\n+/, '');
}

function ensureComposeServiceRestart(composeText) {
  const lines = String(composeText || '').replace(/\r\n/g, '\n').split('\n');
  let servicesLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^services[ \t]*:/.test(lines[i])) { servicesLine = i; break; }
  }
  if (servicesLine < 0) return composeText;
  let end = lines.length;
  for (let i = servicesLine + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (lineIndent(line) === 0) { end = i; break; }
  }
  let serviceIndent = null;
  for (let i = servicesLine + 1; i < end; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    serviceIndent = lineIndent(line);
    break;
  }
  if (serviceIndent === null) return composeText;
  const starts = [];
  for (let i = servicesLine + 1; i < end; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (lineIndent(line) !== serviceIndent) continue;
    if (!/^(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^:#]+?)[ \t]*:/.test(line)) continue;
    starts.push(i);
  }
  let changed = false;
  for (let s = starts.length - 1; s >= 0; s--) {
    const start = starts[s];
    const stop = s + 1 < starts.length ? starts[s + 1] : end;
    let childIndent = null;
    let hasRestart = false;
    let hasRuntime = false;
    for (let i = start + 1; i < stop; i++) {
      const line = lines[i];
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const indent = lineIndent(line);
      if (childIndent === null) childIndent = indent;
      if (indent !== childIndent) continue;
      const prop = String(line).match(/^[ \t]*([A-Za-z0-9_.-]+)[ \t]*:/);
      if (!prop) continue;
      if (prop[1] === 'restart') hasRestart = true;
      if (prop[1] === 'image' || prop[1] === 'build') hasRuntime = true;
    }
    if (hasRestart || !hasRuntime) continue;
    const indent = ' '.repeat(childIndent === null ? serviceIndent + 2 : childIndent);
    lines.splice(start + 1, 0, `${indent}restart: unless-stopped`);
    changed = true;
  }
  return changed ? lines.join('\n') : composeText;
}

// Every creator path runs this so a saved app follows the same portable
// standard as the app library contract: a Dok header, no top-level project
// name (Dok passes -p), a restart policy, and resolvable networks.
function standardizeAppCompose(composeText, { networkNames = null, defaultNetwork = 'wicked' } = {}) {
  let text = String(composeText || '').replace(/\r\n/g, '\n');
  if (!text.trim()) return text;
  text = stripComposeVersion(text);
  text = stripComposeProjectName(text);
  text = normalizeComposeDevices(text);
  text = ensureManagedComposeHeader(text);
  text = ensureComposeServiceRestart(text);
  if (Array.isArray(networkNames)) {
    text = normalizeComposeNetworks(text, networkNames, defaultNetwork).text;
  }
  return text;
}

async function launchNetworkNames() {
  try {
    return await dockerNetworkNames();
  } catch {
    return [];
  }
}

function networkNamesForAnalysis(networkNames, defaultNetwork = 'wicked') {
  const names = [...(networkNames || [])];
  if (!names.includes(defaultNetwork)) names.push(defaultNetwork);
  return names;
}

function analyzeComposeConfig(config, networkNames = []) {
  const names = new Set(networkNames || []);
  const usedKeys = new Set();
  for (const service of Object.values(config.services || {})) {
    for (const key of Object.keys(service.networks || {})) usedKeys.add(key);
  }

  const networks = [];
  for (const [key, def] of Object.entries(config.networks || {})) {
    if (!usedKeys.has(key)) continue;
    const external = def.external === true || String(def.external) === 'true' || (def.external && typeof def.external === 'object');
    if (!external) continue;
    const name = String(def.name || key);
    networks.push({ key, name, external: true, missing: !names.has(name) });
  }

  const bindVolumes = [];
  const missingVolumes = [];
  for (const [service, svc] of Object.entries(config.services || {})) {
    for (const volume of svc.volumes || []) {
      if (volume.type !== 'bind' || !volume.source) continue;
      bindVolumes.push({
        service,
        source: String(volume.source),
        target: String(volume.target || ''),
        readOnly: volume.read_only === true,
        key: volumeKey(service, volume.target)
      });
      if (!fs.existsSync(volume.source)) {
        missingVolumes.push({
          service,
          source: String(volume.source),
          target: String(volume.target || ''),
          readOnly: volume.read_only === true,
          key: volumeKey(service, volume.target)
        });
      }
    }
  }

  const publishedPorts = new Map();
  for (const [service, svc] of Object.entries(config.services || {})) {
    for (const port of svc.ports || []) {
      if (port.published === undefined || port.published === null || port.published === '') continue;
      const protocol = String(port.protocol || 'tcp');
      const key = `${port.published}/${protocol}`;
      if (!publishedPorts.has(key)) publishedPorts.set(key, new Set());
      publishedPorts.get(key).add(`${service}:${port.target}`);
    }
  }
  const portIssues = [];
  for (const [key, mappings] of publishedPorts) {
    if (mappings.size > 1) {
      portIssues.push(`Published port ${key} is mapped more than once (${[...mappings].join(', ')}); keep only one mapping.`);
    }
  }

  let vhost = '';
  let vhostPort = '';
  let vhostService = '';
  for (const [service, svc] of Object.entries(config.services || {})) {
    const env = svc.environment || {};
    if (env.VIRTUAL_HOST !== undefined && env.VIRTUAL_HOST !== null && String(env.VIRTUAL_HOST).trim()) {
      vhost = String(env.VIRTUAL_HOST).trim();
      vhostPort = env.VIRTUAL_PORT !== undefined && env.VIRTUAL_PORT !== null ? String(env.VIRTUAL_PORT).trim() : '';
      vhostService = service;
      break;
    }
  }

  return {
    ok: portIssues.length === 0,
    issues: [...portIssues],
    config,
    networks,
    missingNetworks: networks.filter(net => net.missing),
    bindVolumes,
    missingVolumes,
    vhost,
    vhostPort,
    vhostService,
    portIssues
  };
}

async function analyzeCompose(composeText, { projectDir = '', networkNames = null } = {}) {
  const model = await composeConfig(composeText, { projectDir });
  if (model.unavailable) {
    return {
      ok: true, unavailable: true, issues: [], networks: [], missingNetworks: [],
      bindVolumes: [], missingVolumes: [], vhost: '', vhostPort: '', vhostService: '', portIssues: []
    };
  }
  if (!model.ok) {
    return {
      ok: false, issues: model.issues, networks: [], missingNetworks: [],
      bindVolumes: [], missingVolumes: [], vhost: '', vhostPort: '', vhostService: '', portIssues: []
    };
  }
  const names = networkNames || await dockerNetworkNames();
  const result = analyzeComposeConfig(model.config || {}, names);
  return { ...result, issues: [...(model.issues || []), ...result.issues] };
}

function serviceNamesFromCompose(yaml) {
  const names = [];
  const lines = String(yaml).split(/\r?\n/);
  let inServices = false;
  let baseIndent = null;
  for (const line of lines) {
    if (/^services\s*:\s*(#.*)?$/.test(line)) { inServices = true; continue; }
    if (inServices) {
      if (/^\S/.test(line) && line.trim() && !line.startsWith('#')) { inServices = false; continue; }
      const m = line.match(/^(\s+)["']?([a-zA-Z0-9_.-]+)["']?\s*:\s*(#.*)?$/);
      if (m) {
        const indent = m[1].length;
        if (baseIndent === null) baseIndent = indent;
        if (indent === baseIndent) names.push(m[2]);
      }
    }
  }
  return names;
}

function composePortsFromText(yaml) {
  const ports = [];
  const add = (value) => {
    const text = String(value || '').trim().replace(/^["']|["']$/g, '');
    if (!/^(?:\d{1,3}(?:\.\d{1,3}){3}:)?\d+(?::\d+)?(?:\/(?:tcp|udp))?$/.test(text)) return;
    if (!ports.includes(text)) ports.push(text);
  };
  const text = String(yaml || '');
  const blockRe = /^([ \t]*)ports\s*:\s*(?:#.*)?$/gm;
  let match;
  while ((match = blockRe.exec(text))) {
    const baseIndent = match[1].replace(/\t/g, '  ').length;
    const rest = text.slice(blockRe.lastIndex);
    for (const line of rest.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const indent = (line.match(/^[ \t]*/) || [''])[0].replace(/\t/g, '  ').length;
      if (indent <= baseIndent) break;
      const item = line.match(/^\s*-\s*["']?([^"'\s#]+)["']?/);
      if (!item) continue;
      add(item[1]);
    }
  }
  const inlineRe = /^[ \t]*ports\s*:\s*\[([^\]]*)\]\s*(?:#.*)?$/gm;
  while ((match = inlineRe.exec(text))) {
    for (const item of match[1].split(',')) add(item);
  }
  return ports;
}

async function validateCompose(composeText, { projectDir = '' } = {}) {
  const text = String(composeText || '');
  const issues = [];
  if (!text.trim()) return { ok: false, issues: ['Compose file is empty'] };
  if (!/^services\s*:/m.test(text)) issues.push('Missing "services:" section');
  if (/^\t/m.test(text)) issues.push('Tabs are not allowed for indentation in YAML; use spaces');
  if (/^(?:["']version["']|version)[ \t]*:/m.test(text)) issues.push('Warning: "version" is obsolete in Compose v2 and can be removed');
  if (issues.some(i => !i.startsWith('Warning'))) return { ok: false, issues };

  const workDir = projectDir && fs.existsSync(projectDir) ? projectDir : path.join(dataDir, 'tmp');
  try { fs.mkdirSync(workDir, { recursive: true }); } catch {}
  const tmpFile = path.join(workDir, `.wickedafdok-validate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.yml`);
  try {
    fs.writeFileSync(tmpFile, normalizeComposeDevices(stripComposeVersion(text)));
    await run('docker', ['compose', '-f', tmpFile, 'config', '--quiet'], { cwd: workDir });
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      // Docker CLI is unavailable; keep the basic structural checks only.
    } else {
      const detail = String(e.stderr || e.stdout || e.message || '')
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(Boolean)
        .slice(0, 12)
        .join('\n');
      issues.push(detail || 'Compose validation failed');
    }
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
  return { ok: issues.every(i => i.startsWith('Warning')), issues };
}

// ---------- compose builder ----------
// The builder exposes Compose as editable fields instead of asking users to
// hand-edit YAML. Input is converted to Compose structures only when the model
// is rendered, so malformed values can be reported against their field.
const BUILDER_FIELD_MODES = {
  scalar: 'scalar',
  image: 'scalar',
  build: 'build',
  container_name: 'scalar',
  restart: 'scalar',
  command: 'args',
  entrypoint: 'args',
  ports: 'ports',
  environment: 'map',
  env_file: 'list',
  volumes: 'volumes',
  networks: 'list',
  depends_on: 'list',
  labels: 'map',
  expose: 'list',
  user: 'scalar',
  working_dir: 'scalar',
  hostname: 'scalar',
  domainname: 'scalar',
  network_mode: 'scalar',
  privileged: 'boolean',
  init: 'boolean',
  read_only: 'boolean',
  stdin_open: 'boolean',
  tty: 'boolean',
  devices: 'devices',
  cap_add: 'list',
  cap_drop: 'list',
  security_opt: 'list',
  sysctls: 'map',
  extra_hosts: 'hosts',
  dns: 'list',
  dns_search: 'list',
  dns_opt: 'list',
  tmpfs: 'list',
  ulimits: 'json',
  healthcheck: 'json',
  logging: 'json',
  deploy: 'json',
  mem_limit: 'scalar',
  mem_reservation: 'scalar',
  memswap_limit: 'scalar',
  cpus: 'scalar',
  cpu_shares: 'number',
  cpu_quota: 'number',
  cpu_percent: 'number',
  cpuset: 'scalar',
  pids_limit: 'number',
  shm_size: 'scalar',
  stop_signal: 'scalar',
  stop_grace_period: 'scalar',
  runtime: 'scalar',
  pid: 'scalar',
  ipc: 'scalar',
  isolation: 'scalar',
  userns_mode: 'scalar',
  uts: 'scalar',
  cgroup_parent: 'scalar',
  cgroup: 'scalar',
  cgroupns_mode: 'scalar',
  mac_address: 'scalar',
  scale: 'number',
  mem_swappiness: 'number',
  oom_score_adj: 'number',
  oom_kill_disable: 'boolean',
  platform: 'scalar',
  pull_policy: 'scalar',
  group_add: 'list',
  links: 'list',
  external_links: 'list',
  volumes_from: 'list',
  profiles: 'list',
  annotations: 'list',
  device_cgroup_rules: 'list',
  gpus: 'list',
  configs: 'json',
  secrets: 'json',
  credential_spec: 'json'
};

const BUILDER_COMMON_KEYS = [
  'image', 'build', 'container_name', 'restart', 'command', 'entrypoint',
  'ports', 'expose', 'environment', 'env_file', 'volumes', 'networks',
  'depends_on', 'labels', 'user', 'working_dir', 'hostname', 'domainname',
  'network_mode', 'privileged', 'init', 'read_only', 'stdin_open', 'tty',
  'devices', 'cap_add', 'cap_drop', 'security_opt', 'sysctls', 'extra_hosts',
  'dns', 'dns_search', 'dns_opt', 'tmpfs', 'ulimits', 'healthcheck',
  'logging', 'deploy', 'mem_limit', 'mem_reservation', 'memswap_limit',
  'cpus', 'cpu_shares', 'cpu_quota', 'cpu_percent', 'cpuset', 'pids_limit',
  'shm_size', 'stop_signal', 'stop_grace_period', 'runtime', 'pid', 'ipc',
  'isolation', 'userns_mode', 'uts', 'cgroup_parent', 'cgroup',
  'cgroupns_mode', 'mac_address', 'scale', 'mem_swappiness', 'oom_score_adj',
  'oom_kill_disable', 'platform', 'pull_policy', 'group_add', 'links',
  'external_links', 'volumes_from', 'profiles', 'annotations',
  'device_cgroup_rules', 'gpus', 'configs', 'secrets', 'credential_spec'
];

function builderFieldType(key) {
  return BUILDER_FIELD_MODES[key] ? key : 'raw';
}

function builderPortToString(port) {
  if (port === null || port === undefined) return '';
  if (typeof port !== 'object') return String(port);
  const protocol = port.protocol && port.protocol !== 'tcp' ? `/${port.protocol}` : '';
  const target = port.target === undefined || port.target === null ? '' : String(port.target);
  const published = port.published === undefined || port.published === null ? '' : String(port.published);
  if (!target) return '';
  if (!published) return `${target}${protocol}`;
  const host = port.host_ip ? `${port.host_ip}:` : '';
  return `${host}${published}:${target}${protocol}`;
}

function builderVolumeToString(volume) {
  if (volume === null || volume === undefined) return '';
  if (typeof volume !== 'object') return String(volume);
  const target = volume.target === undefined || volume.target === null ? '' : String(volume.target);
  if (!target) return '';
  if (volume.type === 'tmpfs') return target;
  const source = volume.source === undefined || volume.source === null ? '' : String(volume.source);
  const readOnly = volume.read_only === true || volume.readonly === true ? ':ro' : '';
  return `${source ? source + ':' : ''}${target}${readOnly}`;
}

function builderDeviceToString(device) {
  if (device === null || device === undefined) return '';
  if (typeof device !== 'object') return String(device);
  const source = String(device.source ?? device.src ?? '').trim();
  const target = String(device.target ?? device.dst ?? device.destination ?? source).trim();
  if (!source) return '';
  let text = source === target ? source : `${source}:${target}`;
  const permissions = String(device.permissions ?? device.perms ?? '').trim();
  if (permissions && permissions !== 'rwm') text += `:${permissions}`;
  return text;
}

function builderFieldValueToString(key, value, type) {
  const mode = type === 'raw' ? 'raw' : (BUILDER_FIELD_MODES[key] || (type ? BUILDER_FIELD_MODES[type] : undefined) || 'raw');
  if (mode === 'boolean') return value === true || value === 'true';
  if (mode === 'ports') {
    if (Array.isArray(value)) return value.map(builderPortToString).filter(Boolean).join('\n');
    return value === null || value === undefined ? '' : String(value);
  }
  if (mode === 'volumes') {
    if (Array.isArray(value)) return value.map(builderVolumeToString).filter(Boolean).join('\n');
    return value === null || value === undefined ? '' : String(value);
  }
  if (mode === 'args') {
    if (Array.isArray(value)) return value.map(v => String(v)).join('\n');
    return value === null || value === undefined ? '' : String(value);
  }
  if (mode === 'map') {
    if (Array.isArray(value)) return value.map(v => String(v)).join('\n');
    if (value && typeof value === 'object') {
      return Object.entries(value).map(([k, v]) => v === null || v === undefined ? String(k) : `${k}=${String(v)}`).join('\n');
    }
    return value === null || value === undefined ? '' : String(value);
  }
  if (mode === 'devices') {
    if (Array.isArray(value)) return value.map(builderDeviceToString).filter(Boolean).join('\n');
    return value === null || value === undefined ? '' : String(value);
  }
  if (mode === 'list') {
    if (Array.isArray(value)) return value.map(v => typeof v === 'object' ? JSON.stringify(v) : String(v)).join('\n');
    if (value && typeof value === 'object') return Object.keys(value).join('\n');
    return value === null || value === undefined ? '' : String(value);
  }
  if (mode === 'hosts') {
    if (Array.isArray(value)) return value.map(v => String(v)).join('\n');
    if (value && typeof value === 'object') {
      return Object.entries(value).map(([k, v]) => v === null || v === undefined ? String(k) : `${k}=${String(v)}`).join('\n');
    }
    return value === null || value === undefined ? '' : String(value);
  }
  if (mode === 'build') {
    if (value && typeof value === 'object') {
      const keys = Object.keys(value);
      if (keys.length === 1 && keys[0] === 'context') return String(value.context || '');
      return JSON.stringify(value, null, 2);
    }
    return value === null || value === undefined ? '' : String(value);
  }
  if (mode === 'json') {
    if (value === null || value === undefined || value === '') return '';
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  }
  if (mode === 'raw') {
    if (value === null || value === undefined) return '';
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  }
  if (key === 'shm_size') return humanByteSize(value);
  return value === null || value === undefined ? '' : String(value);
}

function builderFieldNeedsRaw(key, value) {
  if ((key === 'command' || key === 'entrypoint') && typeof value === 'string' && value.includes('\n')) return true;
  if (key === 'gpus' && typeof value === 'string') return true;
  if (!value || typeof value !== 'object') return false;
  if (key === 'depends_on' && !Array.isArray(value)) {
    return Object.values(value).some(item => item && typeof item === 'object');
  }
  if (key === 'networks' && !Array.isArray(value)) {
    return Object.values(value).some(item => item && typeof item === 'object');
  }
  if (key === 'env_file' && (!Array.isArray(value) || value.some(item => item && typeof item === 'object'))) {
    return true;
  }
  if (key === 'tmpfs' && (!Array.isArray(value) || value.some(item => item && typeof item === 'object'))) {
    return true;
  }
  if (key === 'annotations' && !Array.isArray(value)) return true;
  if (key === 'gpus' && !Array.isArray(value)) return true;
  if (key === 'ports' && Array.isArray(value)) {
    return value.some(port => {
      if (!port || typeof port !== 'object') return false;
      if (port.name || port.app_protocol) return true;
      if (port.protocol && !['tcp', 'udp'].includes(String(port.protocol).toLowerCase())) return true;
      return !!port.mode && port.mode !== 'ingress';
    });
  }
  if (key === 'volumes' && Array.isArray(value)) {
    return value.some(volume => {
      if (!volume || typeof volume !== 'object') return false;
      const type = String(volume.type || '');
      if (type && !['bind', 'volume', 'tmpfs'].includes(type)) return true;
      if (type === 'tmpfs') return true;
      if (volume.consistency) return true;
      if (volume.volume && typeof volume.volume === 'object' && Object.keys(volume.volume).length) return true;
      if (volume.tmpfs && typeof volume.tmpfs === 'object' && Object.keys(volume.tmpfs).length) return true;
      if (volume.bind && typeof volume.bind === 'object') {
        const keys = Object.keys(volume.bind).filter(item => item !== 'create_host_path');
        if (keys.length || volume.bind.create_host_path === false) return true;
      }
      return false;
    });
  }
  return false;
}

function builderMetaExtraJson(def, handled) {
  const extra = {};
  for (const [key, value] of Object.entries(def && typeof def === 'object' ? def : {})) {
    if (!handled.includes(key)) extra[key] = value;
  }
  return Object.keys(extra).length ? JSON.stringify(extra) : '';
}

function builderModelFromComposeConfig(config) {
  const model = { services: [], networks: [], volumes: [] };
  const services = config && typeof config === 'object' ? (config.services || {}) : {};
  for (const [name, svcValue] of Object.entries(services)) {
    const svc = svcValue && typeof svcValue === 'object' ? svcValue : {};
    const keys = [];
    for (const key of BUILDER_COMMON_KEYS) {
      if (svc[key] !== undefined) keys.push(key);
    }
    for (const key of Object.keys(svc)) {
      if (!keys.includes(key) && svc[key] !== undefined) keys.push(key);
    }
    const fields = keys.map(key => {
      const raw = builderFieldNeedsRaw(key, svc[key]);
      const known = !!BUILDER_FIELD_MODES[key];
      const type = raw ? 'raw' : (known ? builderFieldType(key) : (typeof svc[key] === 'string' ? 'scalar' : 'raw'));
      return {
        key,
        type,
        value: type === 'raw' ? JSON.stringify(svc[key], null, 2) : builderFieldValueToString(key, svc[key], type)
      };
    });
    const hasBuild = fields.some(field => field.key === 'build' && String(field.value || '').trim());
    if (!fields.some(field => field.key === 'image') && !hasBuild) {
      fields.unshift({ key: 'image', type: 'image', value: '' });
    }
    for (const field of fields) {
      field.required = field.key === 'image' && !hasBuild && !String(field.value || '').trim();
    }
    model.services.push({ name, fields });
  }
  if (!model.services.length) {
    model.services.push({
      name: 'app',
      fields: [{ key: 'image', type: 'image', value: '', required: true }]
    });
  }

  const networks = config && typeof config === 'object' ? (config.networks || {}) : {};
  for (const [key, networkValue] of Object.entries(networks)) {
    const def = networkValue && typeof networkValue === 'object' ? networkValue : {};
    const external = def.external === true || String(def.external) === 'true' || (def.external && typeof def.external === 'object');
    const externalName = def.external && typeof def.external === 'object' && def.external.name ? String(def.external.name) : '';
    model.networks.push({
      key,
      external,
      name: def.name ? String(def.name) : (externalName || (external ? key : '')),
      driver: def.driver ? String(def.driver) : '',
      extra: builderMetaExtraJson(def, ['external', 'name', 'driver'])
    });
  }

  const volumes = config && typeof config === 'object' ? (config.volumes || {}) : {};
  for (const [key, volumeValue] of Object.entries(volumes)) {
    const def = volumeValue && typeof volumeValue === 'object' ? volumeValue : {};
    const external = def.external === true || String(def.external) === 'true' || (def.external && typeof def.external === 'object');
    const externalName = def.external && typeof def.external === 'object' && def.external.name ? String(def.external.name) : '';
    model.volumes.push({
      key,
      external,
      name: def.name ? String(def.name) : (externalName || (external ? key : '')),
      driver: def.driver ? String(def.driver) : '',
      extra: builderMetaExtraJson(def, ['external', 'name', 'driver'])
    });
  }

  const handled = new Set(['services', 'networks', 'volumes', 'name', 'version']);
  const other = Object.create(null);
  for (const [key, value] of Object.entries(config && typeof config === 'object' ? config : {})) {
    if (handled.has(key)) continue;
    other[key] = value;
  }
  if (Object.keys(other).length) model.other = JSON.stringify(other, null, 2);
  return model;
}

function normalizeBuilderModel(input) {
  const src = input && typeof input === 'object' ? input : {};
  const normalized = { services: [], networks: [], volumes: [] };
  if (src.other !== undefined && src.other !== null) {
    normalized.other = typeof src.other === 'string' ? src.other : JSON.stringify(src.other, null, 2);
  }

  const rawServices = Array.isArray(src.services) ? src.services : [];
  for (const rawService of rawServices) {
    const svc = rawService && typeof rawService === 'object' ? rawService : {};
    let rawFields = Array.isArray(svc.fields) ? svc.fields : [];
    if (!Array.isArray(svc.fields) && svc.fields && typeof svc.fields === 'object') {
      rawFields = Object.entries(svc.fields).map(([key, value]) => ({ key, type: builderFieldType(key), value }));
    }
    const fields = [];
    for (const rawField of rawFields) {
      const field = rawField && typeof rawField === 'object' ? rawField : {};
      const key = String(field.key ?? '').trim();
      const type = String(field.type || builderFieldType(key));
      let value = field.value;
      if (value === undefined || value === null) value = type === 'boolean' ? false : '';
      if (value !== null && typeof value === 'object') {
        value = builderFieldValueToString(key || type, value, type);
      }
      fields.push({ key, type, value });
    }
    const serviceName = String(svc.name ?? '').trim();
    const hasBuild = fields.some(field => field.key === 'build' && String(field.value || '').trim());
    if (!fields.some(field => field.key === 'image') && !hasBuild) {
      fields.unshift({ key: 'image', type: 'image', value: '' });
    }
    for (const field of fields) {
      field.required = field.key === 'image' && !hasBuild && !String(field.value || '').trim();
    }
    normalized.services.push({ name: serviceName, fields });
  }
  if (!normalized.services.length) {
    normalized.services.push({
      name: 'app',
      fields: [{ key: 'image', type: 'image', value: '', required: true }]
    });
  }

  const rawNetworks = Array.isArray(src.networks)
    ? src.networks
    : (src.networks && typeof src.networks === 'object'
      ? Object.entries(src.networks).map(([key, value]) => ({ key, ...(value && typeof value === 'object' ? value : {}) }))
      : []);
  for (const raw of rawNetworks) {
    const item = raw && typeof raw === 'object' ? raw : {};
    const key = String(item.key ?? item.name ?? '').trim();
    if (!key) continue;
    normalized.networks.push({
      key,
      external: item.external === true || item.external === 'true',
      name: String(item.name ?? '').trim(),
      driver: String(item.driver ?? '').trim(),
      extra: typeof item.extra === 'string' ? item.extra.trim() : (item.extra && typeof item.extra === 'object' ? JSON.stringify(item.extra) : '')
    });
  }

  const rawVolumes = Array.isArray(src.volumes)
    ? src.volumes
    : (src.volumes && typeof src.volumes === 'object'
      ? Object.entries(src.volumes).map(([key, value]) => ({ key, ...(value && typeof value === 'object' ? value : {}) }))
      : []);
  for (const raw of rawVolumes) {
    const item = raw && typeof raw === 'object' ? raw : {};
    const key = String(item.key ?? item.name ?? '').trim();
    if (!key) continue;
    normalized.volumes.push({
      key,
      external: item.external === true || item.external === 'true',
      name: String(item.name ?? '').trim(),
      driver: String(item.driver ?? '').trim(),
      extra: typeof item.extra === 'string' ? item.extra.trim() : (item.extra && typeof item.extra === 'object' ? JSON.stringify(item.extra) : '')
    });
  }
  return normalized;
}

function builderListItems(value, splitCommas = false) {
  const text = String(value ?? '').replace(/\r/g, '');
  if (!text.trim()) return [];
  let items = text.split('\n').map(line => line.trim()).filter(Boolean);
  if (splitCommas && items.length === 1 && items[0].includes(',')) {
    items = items[0].split(',').map(item => item.trim()).filter(Boolean);
  }
  return items;
}

const BUILDER_OPTIONAL_BLANK_ENV = new Set(['VIRTUAL_HOST', 'VIRTUAL_PORT', 'ENABLE_AUTH', 'LETSENCRYPT_HOST', 'LETSENCRYPT_EMAIL']);

function builderMapEntries(value) {
  const map = Object.create(null);
  const errors = [];
  for (const line of String(value ?? '').replace(/\r/g, '').split('\n')) {
    const text = line.trim();
    if (!text || text.startsWith('#')) continue;
    const idx = text.indexOf('=');
    if (idx < 0) {
      if (Object.prototype.hasOwnProperty.call(map, text)) errors.push(`Duplicate key "${text}"`);
      map[text] = null;
      continue;
    }
    const key = text.slice(0, idx).trim();
    if (!key) {
      errors.push(`Invalid entry "${text}"`);
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(map, key)) errors.push(`Duplicate key "${key}"`);
    const entryValue = text.slice(idx + 1).trim();
    if (!entryValue && BUILDER_OPTIONAL_BLANK_ENV.has(key)) continue;
    map[key] = entryValue;
  }
  return { map, errors };
}

function builderPortKey(port) {
  const text = String(port && typeof port === 'object' ? builderPortToString(port) : (port || '')).trim();
  const protocolMatch = text.match(/\/(tcp|udp)$/i);
  const protocol = protocolMatch ? protocolMatch[1].toLowerCase() : 'tcp';
  const withoutProtocol = protocolMatch ? text.slice(0, -protocolMatch[0].length) : text;
  const parts = withoutProtocol.split(':');
  if (parts.length < 2) return '';
  const published = parts[parts.length - 2];
  const target = parts[parts.length - 1];
  if (!/^\d+$/.test(published) || !/^\d+$/.test(target)) return '';
  return `${Number(published)}/${protocol}`;
}

function builderPortIsValid(port) {
  const text = String(port && typeof port === 'object' ? builderPortToString(port) : (port || '')).trim();
  if (!text) return false;
  if (!/^(?:\[[0-9a-fA-F:]+\]:|[0-9a-fA-F:.]+:)?\d+(?:-\d+)?:\d+(?:-\d+)?(?:\/(?:tcp|udp))?$/.test(text) &&
      !/^\d+(?:-\d+)?(?:\/(?:tcp|udp))?$/.test(text)) return false;
  const clean = text.replace(/\/(?:tcp|udp)$/i, '');
  for (const part of clean.split(':')) {
    for (const value of part.split('-')) {
      if (!/^\d+$/.test(value)) continue;
      const num = Number(value);
      if (num < 1 || num > 65535) return false;
    }
  }
  return true;
}

function builderFieldToComposeValue(field, addIssue) {
  const key = String(field.key || '').trim();
  const mode = field.type === 'raw' ? 'raw' : (BUILDER_FIELD_MODES[key] || BUILDER_FIELD_MODES[field.type] || 'raw');
  const value = field.value;

  if (mode === 'boolean') return { value: value === true || value === 'true' || value === 1 };
  if (mode === 'args') {
    const text = String(value ?? '').replace(/\r/g, '');
    if (!text.trim()) return { skip: true };
    if (text.includes('\n')) {
      return { value: text.split('\n').map(line => line.trim()).filter(line => line !== '') };
    }
    return { value: text.trim() };
  }
  if (mode === 'ports') {
    const items = builderListItems(value, true);
    if (!items.length) return { skip: true };
    for (const item of items) {
      if (!builderPortIsValid(item)) addIssue(`Invalid port mapping "${item}"`);
    }
    return { value: items };
  }
  if (mode === 'volumes') {
    const items = builderListItems(value, true);
    if (!items.length) return { skip: true };
    return { value: items };
  }
  if (mode === 'devices') {
    const items = builderListItems(value);
    if (!items.length) return { skip: true };
    const devices = [];
    for (const item of items) {
      const text = String(item || '').trim();
      if (!text) continue;
      if (text.startsWith('{')) {
        try {
          const parsed = JSON.parse(text);
          if (parsed && typeof parsed === 'object' && parsed.source) { devices.push(parsed); continue; }
        } catch {}
      }
      const parsed = parseShortDeviceEntry(text);
      if (!parsed) { devices.push(text); continue; }
      devices.push({ source: parsed.source, target: parsed.target, permissions: parsed.permissions });
    }
    if (!devices.length) return { skip: true };
    return { value: devices };
  }
  if (mode === 'list') {
    const items = builderListItems(value);
    if (!items.length) return { skip: true };
    return { value: items };
  }
  if (mode === 'hosts') {
    const items = builderListItems(value);
    if (!items.length) return { skip: true };
    return { value: items };
  }
  if (mode === 'map') {
    const { map, errors } = builderMapEntries(value);
    for (const error of errors) addIssue(error);
    if (!Object.keys(map).length) return { skip: true };
    return { value: map };
  }
  if (mode === 'build') {
    const text = String(value ?? '').trim();
    if (!text) return { skip: true };
    if (text.startsWith('{') || text.startsWith('[')) {
      try { return { value: JSON.parse(text) }; } catch { addIssue('Build configuration must be valid JSON'); return { skip: true }; }
    }
    return { value: text };
  }
  if (mode === 'json') {
    const text = String(value ?? '').trim();
    if (!text) return { skip: true };
    try { return { value: JSON.parse(text) }; } catch { addIssue('Value must be valid JSON'); return { skip: true }; }
  }
  if (mode === 'number') {
    const text = String(value ?? '').trim();
    if (!text) return { skip: true };
    const num = Number(text);
    if (!Number.isFinite(num)) { addIssue('Value must be a number'); return { skip: true }; }
    return { value: num };
  }
  if (mode === 'raw') {
    const text = String(value ?? '').trim();
    if (!text) return { skip: true };
    try { return { value: JSON.parse(text) }; } catch { addIssue('Value must be valid JSON'); return { skip: true }; }
  }
  const text = String(value ?? '').trim();
  if (!text) return { skip: true };
  return { value: text };
}

function builderYamlScalar(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string' && value.includes('\n')) {
    return JSON.stringify(value.replace(/\$/g, () => '$$'));
  }
  return yamlScalar(value);
}

function builderYamlKey(key) {
  const text = String(key ?? '');
  return /^[A-Za-z0-9_.-]+$/.test(text) ? text : JSON.stringify(text).replace(/\$/g, () => '$$');
}

function builderYamlLines(value, indent = 0) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    if (!value.length) return [];
    const lines = [];
    for (const item of value) {
      if (item && typeof item === 'object') {
        const child = builderYamlLines(item, indent + 2);
        if (!child.length) lines.push(`${pad}- {}`);
        else {
          lines.push(`${pad}- ${child[0].slice(indent + 2)}`);
          lines.push(...child.slice(1));
        }
      } else {
        lines.push(`${pad}- ${builderYamlScalar(item)}`);
      }
    }
    return lines;
  }
  if (value && typeof value === 'object') {
    const lines = [];
    for (const [key, item] of Object.entries(value)) {
      const renderedKey = builderYamlKey(key);
      if (Array.isArray(item)) {
        if (!item.length) lines.push(`${pad}${renderedKey}: []`);
        else {
          lines.push(`${pad}${renderedKey}:`);
          lines.push(...builderYamlLines(item, indent + 2));
        }
      } else if (item && typeof item === 'object') {
        if (!Object.keys(item).length) lines.push(`${pad}${renderedKey}: {}`);
        else {
          lines.push(`${pad}${renderedKey}:`);
          lines.push(...builderYamlLines(item, indent + 2));
        }
      } else {
        lines.push(`${pad}${renderedKey}: ${builderYamlScalar(item)}`);
      }
    }
    return lines;
  }
  return [`${pad}${builderYamlScalar(value)}`];
}

function addBuilderFieldIssue(fieldIssues, issue) {
  const signature = [
    issue.section || 'service', issue.serviceIndex ?? '', issue.service || '',
    issue.fieldIndex ?? '', issue.key || '', issue.message || ''
  ].join('\u0000');
  if (fieldIssues.some(item => item.__signature === signature)) return;
  fieldIssues.push({ ...issue, __signature: signature });
}

function builderMetaExtra(value, addIssue) {
  const text = String(value ?? '').trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      addIssue('Advanced settings must be a JSON object');
      return {};
    }
    return parsed;
  } catch {
    addIssue('Advanced settings must be valid JSON');
    return {};
  }
}

async function buildComposeFromBuilderModel(input, { projectDir = '', validate = true } = {}) {
  const model = normalizeBuilderModel(input);
  const fieldIssues = [];
  const servicesObj = Object.create(null);
  const serviceNames = new Map();
  const containerNames = new Map();
  const portOwners = new Map();

  for (let serviceIndex = 0; serviceIndex < model.services.length; serviceIndex++) {
    const serviceModel = model.services[serviceIndex];
    const serviceName = String(serviceModel.name || '').trim();
    const addIssue = (message, fieldIndex = -1, key = '__service__') => {
      addBuilderFieldIssue(fieldIssues, {
        section: 'service', serviceIndex, service: serviceName,
        fieldIndex, key, message
      });
    };

    if (!serviceName) addIssue('Service name is required');
    else if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(serviceName)) {
      addIssue(`Invalid service name "${serviceName}"`);
    } else if (serviceNames.has(serviceName)) {
      addIssue(`Duplicate service name "${serviceName}"`);
    }
    if (serviceName) serviceNames.set(serviceName, serviceIndex);

    const service = {};
    const seenFields = new Set();
    for (let fieldIndex = 0; fieldIndex < serviceModel.fields.length; fieldIndex++) {
      const field = serviceModel.fields[fieldIndex];
      const key = String(field.key || '').trim();
      if (!key) {
        addIssue('Field name is required', fieldIndex, '__field__');
        continue;
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(key) && !/^x-[A-Za-z0-9_.-]+$/.test(key)) {
        addIssue(`Invalid field name "${key}"`, fieldIndex, key);
        continue;
      }
      if (seenFields.has(key)) {
        addIssue(`Duplicate field "${key}"`, fieldIndex, key);
        continue;
      }
      seenFields.add(key);
      const converted = builderFieldToComposeValue(field, message => addIssue(message, fieldIndex, key));
      if (!converted || converted.skip) continue;
      service[key] = converted.value;
    }

    const imageValue = typeof service.image === 'string' ? service.image.trim() : '';
    const buildValue = service.build;
    const hasBuild = buildValue !== undefined && (
      typeof buildValue === 'string' ? !!buildValue.trim() : !!Object.keys(buildValue || {}).length
    );
    if (!imageValue && !hasBuild) {
      const imageFieldIndex = serviceModel.fields.findIndex(field => String(field.key || '').trim() === 'image');
      addIssue('This service needs an image or a build context', imageFieldIndex, 'image');
    }

    const portsFieldIndex = serviceModel.fields.findIndex(field => String(field.key || '').trim() === 'ports');
    if (service.network_mode && Array.isArray(service.ports) && service.ports.length) {
      addIssue(`Ports cannot be published when network_mode is "${service.network_mode}"`, portsFieldIndex, 'ports');
    }
    if (Array.isArray(service.ports)) {
      for (const port of service.ports) {
        const portKey = builderPortKey(port);
        if (!portKey) continue;
        if (!portOwners.has(portKey)) portOwners.set(portKey, []);
        portOwners.get(portKey).push({ serviceIndex, service: serviceName, fieldIndex: portsFieldIndex, port });
      }
    }

    if (service.container_name) {
      const containerName = String(service.container_name).trim();
      if (containerNames.has(containerName)) {
        const fieldIndex = serviceModel.fields.findIndex(field => String(field.key || '').trim() === 'container_name');
        addIssue(`Container name "${containerName}" is already used by service "${containerNames.get(containerName)}"`, fieldIndex, 'container_name');
      } else {
        containerNames.set(containerName, serviceName);
      }
    }

    if (serviceName && !servicesObj[serviceName]) servicesObj[serviceName] = service;
  }

  for (const [portKey, owners] of portOwners) {
    if (owners.length < 2) continue;
    const names = [...new Set(owners.map(item => item.service || 'service'))].join(', ');
    for (const owner of owners) {
      addBuilderFieldIssue(fieldIssues, {
        section: 'service', serviceIndex: owner.serviceIndex, service: owner.service,
        fieldIndex: owner.fieldIndex, key: 'ports',
        message: `Published port ${portKey} is mapped more than once (${names})`
      });
    }
  }

  const compose = { services: servicesObj };
  const networksObj = Object.create(null);
  const networkKeys = new Set();
  for (let index = 0; index < model.networks.length; index++) {
    const network = model.networks[index];
    const key = String(network.key || '').trim();
    if (!key) {
      addBuilderFieldIssue(fieldIssues, {
        section: 'networks', networkIndex: index, key: '__key__',
        message: 'Network name is required'
      });
      continue;
    }
    if (networkKeys.has(key)) {
      addBuilderFieldIssue(fieldIssues, {
        section: 'networks', networkIndex: index, key,
        message: `Duplicate network "${key}"`
      });
      continue;
    }
    networkKeys.add(key);
    const def = builderMetaExtra(network.extra, message => addBuilderFieldIssue(fieldIssues, {
      section: 'networks', networkIndex: index, key: '__extra__', message
    }));
    if (network.external) {
      def.external = true;
      def.name = network.name || key;
    } else {
      if (network.driver) def.driver = network.driver;
      if (network.name && network.name !== key) def.name = network.name;
    }
    networksObj[key] = def;
  }
  if (Object.keys(networksObj).length) compose.networks = networksObj;

  const volumesObj = Object.create(null);
  const volumeKeys = new Set();
  for (let index = 0; index < model.volumes.length; index++) {
    const volume = model.volumes[index];
    const key = String(volume.key || '').trim();
    if (!key) {
      addBuilderFieldIssue(fieldIssues, {
        section: 'volumes', volumeIndex: index, key: '__key__',
        message: 'Volume name is required'
      });
      continue;
    }
    if (volumeKeys.has(key)) {
      addBuilderFieldIssue(fieldIssues, {
        section: 'volumes', volumeIndex: index, key,
        message: `Duplicate volume "${key}"`
      });
      continue;
    }
    volumeKeys.add(key);
    const def = builderMetaExtra(volume.extra, message => addBuilderFieldIssue(fieldIssues, {
      section: 'volumes', volumeIndex: index, key: '__extra__', message
    }));
    if (volume.external) {
      def.external = true;
      def.name = volume.name || key;
    } else {
      if (volume.driver) def.driver = volume.driver;
      if (volume.name && volume.name !== key) def.name = volume.name;
    }
    volumesObj[key] = def;
  }
  if (Object.keys(volumesObj).length) compose.volumes = volumesObj;

  if (model.other !== undefined && String(model.other).trim()) {
    try {
      const other = JSON.parse(String(model.other));
      if (!other || typeof other !== 'object' || Array.isArray(other)) {
        addBuilderFieldIssue(fieldIssues, {
          section: 'other', key: '__other__',
          message: 'Other top-level settings must be a JSON object'
        });
      } else {
        for (const [key, value] of Object.entries(other)) {
          if (key === 'name' || key === 'version') continue;
          if (['services', 'networks', 'volumes'].includes(key)) {
            addBuilderFieldIssue(fieldIssues, {
              section: 'other', key: '__other__',
              message: `Top-level "${key}" is already managed by the builder fields`
            });
            continue;
          }
          if (['__proto__', 'constructor', 'prototype'].includes(key)) {
            addBuilderFieldIssue(fieldIssues, {
              section: 'other', key: '__other__',
              message: `Top-level "${key}" is not allowed`
            });
            continue;
          }
          compose[key] = value;
        }
      }
    } catch {
      addBuilderFieldIssue(fieldIssues, {
        section: 'other', key: '__other__',
        message: 'Other top-level settings must be valid JSON'
      });
    }
  }

  let yaml = '# managed-by: wickedafdok\n';
  yaml += builderYamlLines(compose, 0).join('\n') + '\n';

  const validationIssues = [];
  if (validate) {
    const checked = await validateCompose(yaml, { projectDir });
    for (const issue of checked.issues || []) {
      if (!validationIssues.includes(issue)) validationIssues.push(issue);
    }
  }

  const fieldMessages = fieldIssues.map(issue => issue.message);
  const issues = [...new Set([...fieldMessages, ...validationIssues])];
  const ok = fieldIssues.length === 0 && validationIssues.every(issue => issue.startsWith('Warning'));
  const cleanFieldIssues = fieldIssues.map(({ __signature, ...issue }) => issue);
  return { ok, compose: yaml, issues, fieldIssues: cleanFieldIssues, model };
}

function splitBuilderYamlKeyValue(text) {
  const source = String(text || '');
  let quote = null;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (quote === '"' && ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === ':' && (i === source.length - 1 || /\s/.test(source[i + 1]))) {
      const key = unquoteYamlValue(source.slice(0, i));
      if (!key) return null;
      return { key, value: source.slice(i + 1).trim() };
    }
  }
  return null;
}

function parseBuilderYamlScalar(text) {
  const value = stripYamlComment(text).trim();
  if (!value) return '';
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return unquoteYamlValue(value);
  }
  if (value.startsWith('[') && value.endsWith(']')) {
    return splitFlowItems(value.slice(1, -1)).map(parseBuilderYamlScalar);
  }
  if (value.startsWith('{') && value.endsWith('}')) {
    const map = Object.create(null);
    for (const item of splitFlowItems(value.slice(1, -1))) {
      const kv = splitBuilderYamlKeyValue(item);
      if (!kv) continue;
      map[kv.key] = parseBuilderYamlScalar(kv.value);
    }
    return map;
  }
  const lower = value.toLowerCase();
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  if (lower === 'null' || value === '~') return null;
  if (/^-?\d+$/.test(value)) return Number(value);
  if (/^-?\d+\.\d+$/.test(value)) return Number(value);
  return value;
}

// Small block-style YAML reader used only when the Docker Compose CLI is not
// available. It intentionally supports the subset Compose files use in
// practice: nested mappings, sequences, flow collections, and scalars.
function parseBuilderComposeSubset(composeText) {
  const lines = [];
  for (const rawLine of String(composeText || '').replace(/\r/g, '').split('\n')) {
    const withoutComment = stripYamlComment(rawLine);
    const trimmed = withoutComment.trim();
    if (!trimmed || trimmed === '---' || trimmed === '...') continue;
    lines.push({
      indent: lineIndent(rawLine),
      content: trimmed,
      raw: rawLine.replace(/\s+$/, '')
    });
  }
  let index = 0;

  function parseBlock(indent) {
    if (index >= lines.length) return null;
    const line = lines[index];
    if (line.indent === indent && line.content.startsWith('-')) return parseSequence(indent);
    return parseMapping(indent);
  }

  function parseValue(text, parentIndent) {
    const value = stripYamlComment(text).trim();
    if (value === '|' || value === '|-') {
      const content = [];
      let blockIndent = null;
      while (index < lines.length && lines[index].indent > parentIndent) {
        if (blockIndent === null) blockIndent = lines[index].indent;
        content.push(lines[index].raw.slice(Math.max(0, blockIndent)));
        index++;
      }
      return content.join('\n');
    }
    if (value === '>' || value === '>-') {
      const content = [];
      while (index < lines.length && lines[index].indent > parentIndent) {
        content.push(lines[index].content);
        index++;
      }
      return content.join(' ').trim();
    }
    return parseBuilderYamlScalar(value);
  }

  function parseMapping(indent) {
    const obj = Object.create(null);
    while (index < lines.length) {
      const line = lines[index];
      if (line.indent !== indent || line.content.startsWith('-')) break;
      const kv = splitBuilderYamlKeyValue(line.content);
      if (!kv) { index++; continue; }
      index++;
      if (kv.value !== '') obj[kv.key] = parseValue(kv.value, indent);
      else if (index < lines.length && lines[index].indent > indent) obj[kv.key] = parseBlock(lines[index].indent);
      else obj[kv.key] = null;
    }
    return obj;
  }

  function parseSequence(indent) {
    const arr = [];
    while (index < lines.length) {
      const line = lines[index];
      if (line.indent !== indent || !line.content.startsWith('-')) break;
      const rest = line.content.slice(1).trim();
      index++;
      if (!rest) {
        arr.push(index < lines.length && lines[index].indent > indent ? parseBlock(lines[index].indent) : null);
        continue;
      }
      const kv = splitBuilderYamlKeyValue(rest);
      if (!kv) {
        arr.push(parseBuilderYamlScalar(rest));
        continue;
      }
      const item = Object.create(null);
      if (kv.value !== '') item[kv.key] = parseValue(kv.value, indent);
      else if (index < lines.length && lines[index].indent > indent) item[kv.key] = parseBlock(lines[index].indent);
      else item[kv.key] = null;
      if (index < lines.length && lines[index].indent > indent) {
        const extra = parseMapping(lines[index].indent);
        Object.assign(item, extra);
      }
      arr.push(item);
    }
    return arr;
  }

  const result = parseBlock(lines.length ? lines[0].indent : 0);
  return result && typeof result === 'object' ? result : {};
}

async function parseComposeToBuilderModel(composeText, { projectDir = '' } = {}) {
  const text = String(composeText || '');
  if (!text.trim()) return { ok: false, issues: ['Compose file is empty'], model: null };
  const parsed = await composeConfig(text, { projectDir });
  if (parsed.unavailable) {
    try {
      const config = parseBuilderComposeSubset(text);
      if (!config || !config.services || typeof config.services !== 'object') {
        return {
          ok: false,
          unavailable: true,
          issues: ['The visual builder could not read this compose file because it has no recognizable services section.'],
          model: null
        };
      }
      return {
        ok: true,
        fallback: true,
        issues: [],
        model: builderModelFromComposeConfig(config)
      };
    } catch (e) {
      return {
        ok: false,
        unavailable: true,
        issues: [`The visual builder could not read this compose file: ${e.message}`],
        model: null
      };
    }
  }
  if (!parsed.ok) return { ok: false, issues: parsed.issues, model: null };
  return { ok: true, issues: [], model: builderModelFromComposeConfig(parsed.config || {}) };
}

function isInsideDir(dir, rootDir) {
  if (!dir || !rootDir) return false;
  try {
    const root = fs.realpathSync(rootDir);
    const target = fs.realpathSync(dir);
    return target === root || target.startsWith(root + path.sep);
  } catch {
    return false;
  }
}

function isInsideApps(dir) {
  return isInsideDir(dir, appsDir);
}

function isSymlink(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

function containerToCompose(info, { serviceName = 'app', network = '', networks = [] } = {}) {
  const name = projectName(serviceName, 'app');
  const image = info.Config?.Image && info.Config.Image !== '<none>' ? info.Config.Image : info.Image;
  if (!image) throw new Error('Container has no image');
  const restart = info.HostConfig?.RestartPolicy?.Name || 'unless-stopped';
  const networkMode = info.HostConfig?.NetworkMode || '';
  const specialMode = ['host', 'none'].includes(networkMode) || networkMode.startsWith('container:') ? networkMode : '';
  const netList = (networks.length ? networks : (network ? [network] : []))
    .concat(Object.keys(info.NetworkSettings?.Networks || {}))
    .filter((n, i, all) => n && !['bridge', 'host', 'none', 'default'].includes(n) && all.indexOf(n) === i);

  const ports = [];
  for (const key of Object.keys(info.HostConfig?.PortBindings || {})) {
    const [containerPort, proto = 'tcp'] = String(key).split('/');
    for (const binding of info.HostConfig.PortBindings[key] || []) {
      if (!binding?.HostPort) continue;
      const host = binding.HostIp ? `${binding.HostIp}:` : '';
      ports.push(`${host}${binding.HostPort}:${containerPort}${proto === 'tcp' ? '' : '/' + proto}`);
    }
  }

  const volumes = [];
  const seen = new Set();
  for (const bind of info.HostConfig?.Binds || []) {
    if (bind && !seen.has(bind)) { volumes.push(bind); seen.add(bind); }
  }
  for (const mount of info.Mounts || []) {
    let value = '';
    if (mount.Type === 'bind' && mount.Source && mount.Destination) {
      value = `${mount.Source}:${mount.Destination}${mount.RW === false ? ':ro' : ''}`;
    } else if (mount.Type === 'volume' && mount.Name && mount.Destination) {
      value = `${mount.Name}:${mount.Destination}${mount.RW === false ? ':ro' : ''}`;
    }
    if (value && !seen.has(value)) { volumes.push(value); seen.add(value); }
  }

  const env = Array.isArray(info.Config?.Env) ? info.Config.Env : [];
  const command = Array.isArray(info.Config?.Cmd) && info.Config.Cmd.length ? info.Config.Cmd : null;
  const entrypoint = Array.isArray(info.Config?.Entrypoint) && info.Config.Entrypoint.length ? info.Config.Entrypoint : null;
  const devices = (info.HostConfig?.Devices || [])
    .map(device => ({
      source: String(device?.PathOnHost || '').trim(),
      target: String(device?.PathInContainer || device?.PathOnHost || '').trim(),
      permissions: String(device?.CgroupPermissions || '').trim() || 'rwm'
    }))
    .filter(device => device.source && device.target);

  let compose = `# managed-by: wickedafdok\nservices:\n  ${yamlScalar(name)}:\n`;
  compose += `    container_name: ${yamlScalar(info.Name ? info.Name.replace(/^\//, '') : name)}\n`;
  compose += `    image: ${yamlScalar(image)}\n`;
  compose += `    restart: ${yamlScalar(restart)}\n`;
  if (specialMode) compose += `    network_mode: ${yamlScalar(specialMode)}\n`;
  const cmdValue = v => String(v).replace(/\$/g, () => '$$');
  if (command) compose += `    command: ${JSON.stringify(command.map(cmdValue))}\n`;
  if (entrypoint) compose += `    entrypoint: ${JSON.stringify(entrypoint.map(cmdValue))}\n`;
  if (info.Config?.User) compose += `    user: ${yamlScalar(info.Config.User)}\n`;
  if (info.Config?.WorkingDir) compose += `    working_dir: ${yamlScalar(info.Config.WorkingDir)}\n`;
  if (!specialMode && ports.length) compose += `    ports:\n${ports.map(p => `      - ${yamlScalar(p)}`).join('\n')}\n`;
  if (volumes.length) compose += `    volumes:\n${volumes.map(v => `      - ${yamlScalar(v)}`).join('\n')}\n`;
  if (devices.length) compose += composeDevicesYaml(devices, '    ');
  if (env.length) compose += `    environment:\n${env.map(e => `      - ${yamlScalar(e)}`).join('\n')}\n`;
  if (!specialMode && netList.length) {
    compose += `    networks:\n${netList.map(n => `      - ${yamlScalar(n)}`).join('\n')}\n`;
    compose += `\nnetworks:\n`;
    for (const net of netList) {
      compose += `  ${yamlScalar(net)}:\n    external: true\n    name: ${yamlScalar(net)}\n`;
    }
  }
  return compose;
}

function nginxProxyAcme(raw = {}) {
  const settings = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    enabled: false,
    email: '',
    staging: false,
    ...settings
  };
}

function nginxProxyHttpPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 443) return 80;
  return port;
}

function nginxComposeHttpPort(compose) {
  const match = String(compose || '').match(/^\s*-\s*["']?(?:\d{1,5}:)?(\d+):80["']?\s*$/m);
  return match ? nginxProxyHttpPort(match[1]) : 80;
}

function nginxComposeHasHttpPort(compose, port) {
  return new RegExp(`^\\s*-\\s*["']?(?:\\d{1,5}:)?${nginxProxyHttpPort(port)}:80["']?\\s*$`, 'm').test(String(compose || ''));
}

function setNginxComposeHttpPort(compose, port) {
  const target = nginxProxyHttpPort(port);
  let changed = false;
  const next = String(compose || '').split('\n').map(line => {
    const match = line.match(/^(\s*-\s*)(["']?)(?:\d{1,5}:)?(\d+):80\2\s*$/);
    if (!match) return line;
    changed = true;
    return `${match[1]}${match[2]}${target}:80${match[2]}`;
  }).join('\n');
  return changed ? next : compose;
}

function nginxProxyPortConflict(error) {
  const text = [error?.message, error?.stdout, error?.stderr].filter(Boolean).join('\n');
  return /port is already allocated|address already in use|failed to bind|ports are not available|bind for 0\.0\.0\.0:\d+ failed/i.test(text);
}

async function publishedHostPorts() {
  const used = new Set();
  try {
    const containers = await docker.listContainers({ all: true });
    for (const container of containers) {
      for (const port of container.Ports || []) {
        if (port.PublicPort) used.add(Number(port.PublicPort));
      }
    }
  } catch {}
  return used;
}

function nextNginxProxyHttpPort(current, used = new Set()) {
  const dokPort = Number(process.env.PORT) || 8080;
  const maintenancePort = Number(process.env.MAINTENANCE_PORT) || 8090;
  const reserved = new Set([80, 443, dokPort, maintenancePort, 8088, nginxProxyHttpPort(current)]);
  for (let port = 8081; port <= 8180; port += 1) {
    if (!reserved.has(port) && !used.has(port)) return port;
  }
  return 0;
}

function nginxProxyCompose(network, domain, hostDir = '', acmeSettings = {}, httpPort = 80) {
  let host = normalizeDomain(domain);
  if (!host) host = normalizeDomain(configuredDefaults().dokDomain || '');
  const hostPort = nginxProxyHttpPort(httpPort);
  const acme = nginxProxyAcme(acmeSettings);
  const acmeEnabled = acme.enabled && String(acme.email || '').trim();
  const base = String(hostDir || '').trim() ? String(hostDir).replace(/[/\\]+$/, '') + '/' : './';
  const nginxEnv = [];
  if (host) nginxEnv.push(`DEFAULT_HOST=${host}`);
  if (acmeEnabled) nginxEnv.push('DHPARAM_GENERATION=false');
  const nginxEnvBlock = nginxEnv.length
    ? `    environment:\n${nginxEnv.map(item => `      - ${yamlScalar(item)}`).join('\n')}\n`
    : '';
  const nginxLabelBlock = acmeEnabled
    ? '    labels:\n      - com.github.jrcs.letsencrypt_nginx_proxy_companion.nginx_proxy=true\n'
    : '';
  const acmeEnv = [
    `DEFAULT_EMAIL=${String(acme.email || '').trim()}`,
    'NGINX_PROXY_CONTAINER=nginx-proxy'
  ];
  if (acme.staging) acmeEnv.push('ACME_CA_URI=https://acme-staging-v02.api.letsencrypt.org/directory');
  const acmeBlock = acmeEnabled ? `
  acme-companion:
    image: nginxproxy/acme-companion
    container_name: acme-companion
    restart: unless-stopped
    depends_on:
      - nginx-proxy
    environment:
${acmeEnv.map(item => `      - ${yamlScalar(item)}`).join('\n')}
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - ${yamlScalar(`${base}vhost.d:/etc/nginx/vhost.d`)}
      - ${yamlScalar(`${base}certs:/etc/nginx/certs:rw`)}
      - ${yamlScalar(`${base}html:/usr/share/nginx/html`)}
      - ${yamlScalar(`${base}acme:/etc/acme.sh`)}
    networks:
      - proxy_net
` : '';
  return `# managed-by: wickedafdok
services:
  nginx-proxy:
    image: nginxproxy/nginx-proxy
    container_name: nginx-proxy
    ports:
      - "${hostPort}:80"
      - "443:443"
    volumes:
      - /var/run/docker.sock:/tmp/docker.sock:ro
      - ${yamlScalar(`${base}vhost.d:/etc/nginx/vhost.d`)}
      - ${yamlScalar(`${base}certs:/etc/nginx/certs:ro`)}
      - ${yamlScalar(`${base}html:/usr/share/nginx/html:ro`)}
${nginxEnvBlock}${nginxLabelBlock}    restart: unless-stopped
    networks:
      - proxy_net
${acmeBlock}
networks:
  proxy_net:
    external: true
    name: ${yamlScalar(network)}
`;
}

const NGINX_ERROR_PAGES_MARKER = '# managed-by: wickedafdok:error-pages';

function nginxErrorPageHtml(code, heading, message) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${code} — ${heading}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    padding: 24px; color: #e8ecf4;
    background: radial-gradient(1200px 600px at 20% -10%, #23324d 0%, transparent 60%),
                radial-gradient(900px 500px at 110% 20%, #342347 0%, transparent 55%),
                #0b0f17;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
  }
  main {
    width: min(620px, 100%); padding: 40px; border: 1px solid rgba(255,255,255,.12);
    border-radius: 20px; background: rgba(15,21,33,.82);
    box-shadow: 0 24px 70px rgba(0,0,0,.45); text-align: center;
  }
  .code {
    margin: 0 0 8px; font-size: clamp(48px, 12vw, 96px); line-height: 1;
    font-weight: 800; letter-spacing: -.04em;
    background: linear-gradient(135deg, #7dd3fc, #a78bfa 55%, #f472b6);
    -webkit-background-clip: text; background-clip: text; color: transparent;
  }
  h1 { margin: 0 0 12px; font-size: clamp(22px, 4vw, 30px); }
  p { margin: 0; color: #a9b4c7; line-height: 1.6; }
  .hint { margin-top: 24px; font-size: 13px; color: #78859b; }
</style>
</head>
<body>
<main>
  <p class="code">${code}</p>
  <h1>${heading}</h1>
  <p>${message}</p>
  <p class="hint">You can customize this page in WickedAFDok → Settings → Dok Settings → Designer.</p>
</main>
</body>
</html>
`;
}

// Seed editable error pages and the vhost snippet that tells nginx to use them.
// Existing files are never overwritten, so user edits survive restarts.
function ensureNginxErrorPages() {
  const nginxDir = path.join(coreDir, 'nginx-proxy');
  const htmlDir = path.join(nginxDir, 'html');
  const errorsDir = path.join(htmlDir, 'errors');
  const vhostDir = path.join(nginxDir, 'vhost.d');
  for (const dir of [htmlDir, errorsDir, vhostDir]) {
    try { fs.mkdirSync(dir, { recursive: true, mode: 0o755 }); } catch {}
  }
  const pages = [
    ['404.html', nginxErrorPageHtml(404, 'Page not found', 'The page you requested does not exist or has moved.')],
    ['403.html', nginxErrorPageHtml(403, 'Access denied', 'You do not have permission to view this page.')],
    ['errors/50x.html', nginxErrorPageHtml('50x', 'Service unavailable', 'The service is temporarily unavailable. Please try again in a moment.')]
  ];
  for (const [rel, content] of pages) {
    const target = path.join(htmlDir, rel);
    if (fs.existsSync(target)) {
      try { fs.chmodSync(target, 0o644); } catch {}
      continue;
    }
    try {
      fs.writeFileSync(target, content, { mode: 0o644 });
      try { fs.chmodSync(target, 0o644); } catch {}
    } catch {}
  }
  const defaultConfig = path.join(vhostDir, 'default');
  if (fs.existsSync(defaultConfig)) {
    try { fs.chmodSync(defaultConfig, 0o644); } catch {}
  } else {
    const config = `${NGINX_ERROR_PAGES_MARKER}
# Edit the pages under html/ in Settings → Dok Settings → Designer.
proxy_intercept_errors on;
error_page 403 /403.html;
error_page 404 /404.html;
error_page 500 502 503 504 /50x.html;

location = /403.html {
    root /usr/share/nginx/html;
    internal;
}
location = /404.html {
    root /usr/share/nginx/html;
    internal;
}
location = /50x.html {
    root /usr/share/nginx/html/errors;
    internal;
}
`;
    try {
      fs.writeFileSync(defaultConfig, config, { mode: 0o644 });
      try { fs.chmodSync(defaultConfig, 0o644); } catch {}
    } catch {}
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function normalizeDomain(value) {
  return String(value || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function processIdentity() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'unknown';
  const gid = typeof process.getgid === 'function' ? process.getgid() : 'unknown';
  return `${uid}:${gid}`;
}

function randomSecret(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex').slice(0, bytes * 2);
}

function hostHelperPaths() {
  const dir = path.join(dataDir, 'host-helper');
  return {
    dir,
    socket: path.join(dir, 'agent.sock'),
    tokenFile: path.join(dir, 'token'),
    config: path.join(dir, 'config.json')
  };
}

function hostHelperToken({ create = true } = {}) {
  const paths = hostHelperPaths();
  try {
    const token = fs.readFileSync(paths.tokenFile, 'utf-8').trim();
    if (token) return token;
  } catch {}
  if (!create) return 'generated-on-launch';
  const token = randomSecret(24);
  try {
    fs.mkdirSync(paths.dir, { recursive: true });
    fs.writeFileSync(paths.tokenFile, token, { mode: 0o600 });
  } catch {}
  return token;
}

async function hostHelperRequest(method, endpoint, body, timeoutMs = 5000) {
  const paths = hostHelperPaths();
  const token = hostHelperToken();
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({
      socketPath: paths.socket,
      path: endpoint,
      method,
      timeout: timeoutMs,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        authorization: `Bearer ${token}`
      }
    }, (res) => {
      let data = '';
      res.setEncoding('utf-8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let parsed = {};
        try { parsed = data ? JSON.parse(data) : {}; } catch {}
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
        else reject(httpError(res.statusCode || 500, parsed.error || `Host helper returned ${res.statusCode}`));
      });
    });
    req.on('timeout', () => req.destroy(new Error('Host helper timed out')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function hostHelperAvailable() {
  const paths = hostHelperPaths();
  if (!fs.existsSync(paths.socket)) return false;
  try {
    await hostHelperRequest('GET', '/ping', undefined, 1500);
    return true;
  } catch {
    return false;
  }
}

async function hostMkdir(target, { uid, gid, mode } = {}) {
  const payload = {
    path: target,
    uid: uid ?? (typeof process.getuid === 'function' ? process.getuid() : null),
    gid: gid ?? (typeof process.getgid === 'function' ? process.getgid() : null),
    mode: mode ?? 0o775
  };
  try {
    return await hostHelperRequest('POST', '/mkdir', payload, 10000);
  } catch (e) {
    // The Maintenance container replaces the old Host Helper. Start it on
    // demand when a host path has to be created, then retry once.
    if (Date.now() - lastMaintenanceStartAttempt < 30000) throw e;
    lastMaintenanceStartAttempt = Date.now();
    try {
      await ensureMaintenanceService({ wait: true });
      return await hostHelperRequest('POST', '/mkdir', payload, 15000);
    } catch {
      throw e;
    }
  }
}

function permissionDenied(target, action = 'creating') {
  return httpError(403,
    `Permission denied while ${action} "${target}" as UID/GID ${processIdentity()}. ` +
    'Run "sudo ./setup.sh" on the host to fix ownership of the runtime directories, or create/chown this path with matching permissions. ' +
    'The Dok Maintenance container can also create host paths; start it from Settings → Maintenance.'
  );
}

function ensureWritableDirectory(target, { label = 'directory', action = 'creating' } = {}) {
  const dir = path.resolve(String(target || ''));
  if (!target) throw httpError(400, `${label} path is empty`);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    if (['EACCES', 'EPERM', 'EROFS'].includes(e.code)) throw permissionDenied(dir, action);
    if (['EEXIST', 'ENOTDIR'].includes(e.code)) throw httpError(400, `${label} is not a directory: ${dir}`);
    throw e;
  }
  try {
    if (!fs.statSync(dir).isDirectory()) throw httpError(400, `${label} is not a directory: ${dir}`);
    fs.accessSync(dir, fs.constants.W_OK);
  } catch (e) {
    if (['EACCES', 'EPERM', 'EROFS'].includes(e.code)) throw permissionDenied(dir, `writing to the ${label.toLowerCase()}`);
    throw e;
  }
  return dir;
}

async function ensureHostDirectory(target, { label = 'host path', action = 'creating', mode } = {}) {
  const dir = path.resolve(String(target || ''));
  if (!target) throw httpError(400, `${label} is empty`);
  const applyMode = () => {
    if (!Number.isInteger(mode)) return;
    try { fs.chmodSync(dir, mode); } catch {}
  };
  if (fs.existsSync(dir)) {
    try {
      if (!fs.statSync(dir).isDirectory()) throw httpError(400, `${label} is not a directory: ${dir}`);
      applyMode();
      return dir;
    } catch (e) {
      if (e.status) throw e;
      throw permissionDenied(dir, action);
    }
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    applyMode();
    return dir;
  } catch (e) {
    if (!['EACCES', 'EPERM', 'EROFS'].includes(e.code)) throw e;
  }
  try {
    await hostMkdir(dir, { mode });
    return dir;
  } catch {
    throw permissionDenied(dir, action);
  }
}

function buildWadCompose(info, { network, domain, port, serviceName = 'app', sourceCheckout = '' }) {
  const name = info.Name.replace(/^\//, '');
  const image = info.Config?.Image && info.Config.Image !== '<none>' ? info.Config.Image : info.Image;
  if (!image) throw new Error('WickedAFDok container has no image');
  const envList = Array.isArray(info.Config?.Env)
    ? info.Config.Env.filter(e => !/^(?:VIRTUAL_(?:HOST|PORT|PROTO)|DOK_SOURCE_HOST_PATH)=/.test(String(e)))
    : [];
  if (domain) {
    envList.push(`VIRTUAL_HOST=${domain}`);
    envList.push(`VIRTUAL_PORT=${port}`);
  }
  if (sourceCheckout) envList.push(`DOK_SOURCE_HOST_PATH=${sourceCheckout}`);
  const portBindings = info.HostConfig?.PortBindings || {};
  const ports = [];
  for (const key of Object.keys(portBindings)) {
    const [containerPort, proto = 'tcp'] = String(key).split('/');
    for (const binding of portBindings[key] || []) {
      if (!binding?.HostPort) continue;
      const host = binding.HostIp ? `${binding.HostIp}:` : '';
      ports.push(`${host}${binding.HostPort}:${containerPort}${proto === 'tcp' ? '' : '/' + proto}`);
    }
  }
  if (!ports.some(p => /(^|:)8080:/.test(p))) ports.push('8080:8080');

  const volumes = [];
  const seen = new Set();
  const bindDestination = value => {
    const parts = String(value || '').split(':');
    if (parts.length >= 3) parts.pop();
    return parts.length >= 2 ? parts.slice(1).join(':') : '';
  };
  for (const b of info.HostConfig?.Binds || []) {
    if (!b || bindDestination(b) === '/app/host-source') continue;
    if (!seen.has(b)) { volumes.push(b); seen.add(b); }
  }
  for (const m of info.Mounts || []) {
    if (m.Destination === '/app/host-source') continue;
    if (m.Type === 'bind' && m.Source && m.Destination) {
      const vol = `${m.Source}:${m.Destination}${m.RW === false ? ':ro' : ''}`;
      if (!seen.has(vol)) { volumes.push(vol); seen.add(vol); }
    } else if (m.Type === 'volume' && m.Name && m.Destination) {
      const vol = `${m.Name}:${m.Destination}${m.RW === false ? ':ro' : ''}`;
      if (!volumes.some(v => v.includes(m.Destination))) volumes.push(vol);
    }
  }
  if (sourceCheckout) {
    const volume = `${sourceCheckout}:/app/host-source`;
    if (!volumes.includes(volume)) volumes.push(volume);
  }

  const restart = info.HostConfig?.RestartPolicy?.Name || 'unless-stopped';
  const groupAdd = [];
  const seenGroups = new Set();
  const addGroup = value => {
    const group = String(value ?? '').trim();
    if (!group || seenGroups.has(group)) return;
    seenGroups.add(group);
    groupAdd.push(group);
  };
  for (const group of info.HostConfig?.GroupAdd || []) addGroup(group);
  // A recreated container must keep its supplementary groups, notably the
  // Docker socket group. Older generated compose files dropped GroupAdd, and
  // the socket GID can change after a host/Docker update, so always add the
  // live GID when the socket is mounted. This also covers root inside a
  // rootless/userns-remapped daemon, where being root is not enough.
  const hasDockerSocket = (info.Mounts || []).some(m => m.Destination === '/var/run/docker.sock') ||
    (info.HostConfig?.Binds || []).some(b => {
      const parts = String(b).split(':');
      return parts[1] === '/var/run/docker.sock';
    });
  if (hasDockerSocket) {
    try { addGroup(fs.statSync('/var/run/docker.sock').gid); } catch {}
  }
  const cmdValue = v => String(v).replace(/\$/g, () => '$$');
  const entrypoint = Array.isArray(info.Config?.Entrypoint) && info.Config.Entrypoint.length
    ? `    entrypoint: ${JSON.stringify(info.Config.Entrypoint.map(cmdValue))}\n` : '';
  const cmd = Array.isArray(info.Config?.Cmd) && info.Config.Cmd.length
    ? `    command: ${JSON.stringify(info.Config.Cmd.map(cmdValue))}\n` : '';

  let compose = `# managed-by: wickedafdok\nname: wickedafdok\nservices:\n  ${yamlScalar(serviceName)}:\n`;
  compose += `    container_name: ${yamlScalar(name)}\n`;
  compose += `    image: ${yamlScalar(image)}\n`;
  compose += `    restart: ${yamlScalar(restart)}\n`;
  compose += entrypoint + cmd;
  if (info.Config?.User) compose += `    user: ${yamlScalar(info.Config.User)}\n`;
  if (groupAdd.length) {
    compose += `    group_add:\n${groupAdd.map(g => `      - ${yamlScalar(g)}`).join('\n')}\n`;
  }
  if (info.HostConfig?.Privileged) compose += '    privileged: true\n';
  if (info.Config?.WorkingDir) compose += `    working_dir: ${yamlScalar(info.Config.WorkingDir)}\n`;
  if (ports.length) {
    compose += `    ports:\n${ports.map(p => `      - ${yamlScalar(p)}`).join('\n')}\n`;
  }
  if (volumes.length) {
    compose += `    volumes:\n${volumes.map(v => `      - ${yamlScalar(v)}`).join('\n')}\n`;
  }
  if (envList.length) {
    compose += `    environment:\n${envList.map(e => `      - ${yamlScalar(e)}`).join('\n')}\n`;
  }
  const useNetwork = network && !['bridge', 'host', 'none'].includes(network);
  if (useNetwork) {
    compose += `    networks:\n      - ${yamlScalar(network)}\n`;
    compose += `\nnetworks:\n  ${yamlScalar(network)}:\n    external: true\n    name: ${yamlScalar(network)}\n`;
  }
  return compose;
}

function looksLikeDokCheckout(dir) {
  try {
    return ['Dockerfile', path.join('server', 'index.js')]
      .every(file => fs.statSync(path.join(dir, file)).isFile());
  } catch {
    return false;
  }
}

async function scheduleSelfRecreate(domain, network) {
  const port = String(process.env.PORT || 8080);
  const containersAll = await docker.listContainers({ all: true });
  const dokCandidates = containersAll.filter(c => {
    const names = (c.Names || []).map(n => n.replace(/^\//, ''));
    if (c.Labels?.['dok.maintenance'] === 'true') return false;
    return names.some(nm => /wickedafdok/i.test(nm) && !/updater|helper|maintenance/i.test(nm));
  });
  const wad = dokCandidates.find(c => (c.Names || []).some(n => n.replace(/^\//, '') === 'wickedafdok')) || dokCandidates[0];
  if (!wad) return { scheduled: false, reason: 'wickedafdok container not found' };

  const cont = docker.getContainer(wad.Id);
  const info = await cont.inspect();
  if (String(info.HostConfig?.NetworkMode || '').startsWith('container:')) {
    return { scheduled: false, reason: 'wickedafdok shares another container network namespace' };
  }

  const name = info.Name.replace(/^\//, '');
  const onNetwork = !!info.NetworkSettings?.Networks?.[network];
  const portBindings = info.HostConfig?.PortBindings || {};
  const has8080 = Object.keys(portBindings).some(p => String(p).split('/')[0] === '8080' &&
    (portBindings[p] || []).some(b => String(b?.HostPort) === '8080'));

  if (domain) {
    const currentEnv = Array.isArray(info.Config?.Env) ? info.Config.Env : [];
    const hasVhost = currentEnv.includes(`VIRTUAL_HOST=${domain}`);
    const hasVport = currentEnv.includes(`VIRTUAL_PORT=${port}`);
    if (hasVhost && hasVport && onNetwork && has8080) {
      return { scheduled: false, already: true };
    }
    if (hasVhost && hasVport && has8080 && !onNetwork) {
      await docker.getNetwork(network).connect({ Container: wad.Id }).catch(() => {});
      return { scheduled: false, connected: true };
    }
  }

  await ensureNetwork(network);
  const wadDir = path.join(dataDir, 'wickedafdok');
  if (!fs.existsSync(wadDir)) fs.mkdirSync(wadDir, { recursive: true });
  const composePath = path.join(wadDir, 'docker-compose.yml');

  const helperImage = info.Image || info.Config?.Image;
  if (!helperImage) throw new Error('Unable to determine the WickedAFDok image for self-recreation');

  const sourceMount = (info.Mounts || []).find(m =>
    m.Destination === '/app/host-source' && m.Type === 'bind' && m.Source);
  const sourceCheckout = sourceMount?.Source && looksLikeDokCheckout('/app/host-source')
    ? sourceMount.Source
    : '';
  writePrivateFile(composePath, buildWadCompose(info, {
    network,
    domain: normalizeDomain(domain),
    port,
    serviceName: 'wickedafdok',
    sourceCheckout
  }));

  const script = ['set -u'];
  if (hostDataDir) {
    script.push('exec >>/updater/wickedafdok-update.log 2>&1');
  }
  script.push(`echo "--- $(date) ---"`);
  script.push('sleep 6');
  script.push('tries=0');
  script.push(`while docker container inspect ${shellQuote(name)} >/dev/null 2>&1; do`);
  script.push(`  docker stop -t 20 ${shellQuote(name)} >/dev/null 2>&1 || true`);
  script.push(`  docker rm -f ${shellQuote(name)} >/dev/null 2>&1 || true`);
  script.push('  tries=$((tries+1))');
  script.push('  [ "$tries" -ge 5 ] && break');
  script.push('  sleep 1');
  script.push('done');
  script.push(`cd ${shellQuote(wadDir)}`);
  script.push('sock_gid=$(stat -c %g /var/run/docker.sock 2>/dev/null || stat -f %g /var/run/docker.sock 2>/dev/null || true)');
  script.push('service=$(docker compose -f docker-compose.yml config --services 2>/dev/null | head -n 1 || true)');
  script.push('if [ -n "$sock_gid" ] && [ -n "$service" ]; then');
  script.push('  { echo "# managed-by: wickedafdok-updater"; echo "services:"; echo "  \\"$service\\":"; echo "    group_add:"; echo "      - \\"$sock_gid\\""; } > docker-compose.socket-gid.yml');
  script.push('fi');
  script.push('set -- docker compose -p wickedafdok -f docker-compose.yml');
  script.push('[ -f docker-compose.override.yml ] && set -- "$@" -f docker-compose.override.yml');
  script.push('[ -f docker-compose.socket-gid.yml ] && set -- "$@" -f docker-compose.socket-gid.yml');
  script.push('set -- "$@" up -d --force-recreate --remove-orphans');
  script.push('tries=0');
  script.push('while ! "$@"; do');
  script.push('  tries=$((tries+1))');
  script.push(`  docker rm -f ${shellQuote(name)} >/dev/null 2>&1 || true`);
  script.push('  [ "$tries" -ge 3 ] && exit 1');
  script.push('  sleep 2');
  script.push('done');
  script.push(`docker network connect ${shellQuote(network)} ${shellQuote(name)} >/dev/null 2>&1 || true`);
  const extraNetworks = Object.keys(info.NetworkSettings?.Networks || {})
    .filter(n => n !== network && !['bridge', 'host', 'none'].includes(n));
  for (const extra of extraNetworks) {
    script.push(`docker network connect ${shellQuote(extra)} ${shellQuote(name)} >/dev/null 2>&1 || true`);
  }
  script.push('echo "recreated"');
  const scriptText = script.join('\n');

  try {
    fs.writeFileSync(path.join(dataDir, 'recreate-wickedafdok.sh'), `#!/bin/sh\n${scriptText}\n`);
  } catch {}

  const helperName = 'wickedafdok-updater';
  await run('docker', ['rm', '-f', helperName]).catch(() => {});
  const helperArgs = [
    'run', '-d', '--rm', '--name', helperName,
    '-v', '/var/run/docker.sock:/var/run/docker.sock'
  ];
  if (hostDataDir) helperArgs.push('-v', `${hostDataDir}:/updater`);
  if (hostDataDir) {
    helperArgs.push('-v', `${path.join(hostDataDir, 'wickedafdok')}:${wadDir}`);
  } else if (dataMount?.Type === 'volume' && dataMount.Name) {
    helperArgs.push('-v', `${dataMount.Name}:/app/data`);
  } else {
    helperArgs.push('-v', `${wadDir}:${wadDir}`);
  }
  helperArgs.push('-w', wadDir);
  helperArgs.push('--entrypoint', 'sh', helperImage, '-c', scriptText);
  await run('docker', helperArgs, { cwd: root });

  // Let nginx-proxy notice the recreated container.
  try {
    const containers = await docker.listContainers({ all: true });
    const ngx = containers.find(c => (c.Names || []).some(n => n.replace(/^\//, '') === 'nginx-proxy'));
    if (ngx && ngx.State === 'running') {
      try { await docker.getContainer(ngx.Id).restart({ t: 10 }); } catch {}
    }
  } catch {}
  return { scheduled: true, url: `http://${domain}` };
}

function cloudflaredCompose(token) {
  const t = String(token || '').trim();
  return `# managed-by: wickedafdok
services:
  cloudflared:
    image: cloudflare/cloudflared:latest
    container_name: cloudflared
    restart: unless-stopped
    command: tunnel --no-autoupdate run
${t ? `    environment:
      - ${yamlScalar(`TUNNEL_TOKEN=${t}`)}
` : ''}`;
}

// Authentik publishes no `latest` tag on ghcr.io, and its database migrations
// are tied to a server version, so pin a known-good release. Operators can
// override it with `services.authentik.version` when they want to upgrade.
const AUTHENTIK_IMAGE_VERSION = '2026.8.5';

function authentikCompose(settings = {}, hostDir = '') {
  const version = /^[A-Za-z0-9._-]+$/.test(String(settings.version || '').trim())
    ? String(settings.version).trim()
    : AUTHENTIK_IMAGE_VERSION;
  const image = `ghcr.io/goauthentik/server:${version}`;
  const adminEmail = String(settings.adminEmail || '').trim();
  const adminPassword = String(settings.adminPassword || '').trim();
  const secretKey = String(settings.secretKey || '').trim() || randomSecret(32);
  const postgresPassword = String(settings.postgresPassword || '').trim() || randomSecret(24);
  const port = Number(settings.port) || 9000;
  const httpsPort = Number(settings.httpsPort) || 9443;
  const base = String(hostDir || '').trim() ? String(hostDir).replace(/[/\\]+$/, '') + '/' : './';
  const env = [
    'AUTHENTIK_REDIS__HOST=redis',
    'AUTHENTIK_POSTGRESQL__HOST=postgresql',
    'AUTHENTIK_POSTGRESQL__USER=authentik',
    'AUTHENTIK_POSTGRESQL__NAME=authentik',
    `AUTHENTIK_POSTGRESQL__PASSWORD=${postgresPassword}`,
    `AUTHENTIK_SECRET_KEY=${secretKey}`,
    'AUTHENTIK_ERROR_REPORTING__ENABLED=true',
    'AUTHENTIK_DISABLE_UPDATE_CHECK=false'
  ];
  if (adminPassword) env.push(`AUTHENTIK_BOOTSTRAP_PASSWORD=${adminPassword}`);
  if (adminEmail) env.push(`AUTHENTIK_BOOTSTRAP_EMAIL=${adminEmail}`);
  const envLines = env.map(item => `      - ${yamlScalar(item)}`).join('\n');
  // Only the HTTP server publishes a GUI port, so the reverse-proxy vhost
  // variables must not be shared with the worker service.
  const domain = normalizeDomain(settings.domain);
  const serverEnv = [...env];
  if (domain) {
    serverEnv.push(`VIRTUAL_HOST=${domain}`);
    serverEnv.push('VIRTUAL_PORT=9000');
  }
  const serverEnvLines = serverEnv.map(item => `      - ${yamlScalar(item)}`).join('\n');
  return `# managed-by: wickedafdok
services:
  postgresql:
    image: postgres:16-alpine
    container_name: authentik-postgresql
    restart: unless-stopped
    environment:
      - ${yamlScalar('POSTGRES_PASSWORD=' + postgresPassword)}
      - ${yamlScalar('POSTGRES_USER=authentik')}
      - ${yamlScalar('POSTGRES_DB=authentik')}
    volumes:
      - ${yamlScalar(`${base}postgres:/var/lib/postgresql/data`)}
    networks:
      - wicked
  redis:
    image: redis:7-alpine
    container_name: authentik-redis
    restart: unless-stopped
    networks:
      - wicked
  server:
    image: ${yamlScalar(image)}
    container_name: authentik-server
    restart: unless-stopped
    command: server
    environment:
${serverEnvLines}
    ports:
      - ${yamlScalar(`${port}:9000`)}
      - ${yamlScalar(`${httpsPort}:9443`)}
    volumes:
      - ${yamlScalar(`${base}media:/media`)}
      - ${yamlScalar(`${base}custom-templates:/templates`)}
    depends_on:
      - postgresql
      - redis
    networks:
      - wicked
  worker:
    image: ${yamlScalar(image)}
    container_name: authentik-worker
    restart: unless-stopped
    command: worker
    environment:
${envLines}
    volumes:
      - ${yamlScalar(`${base}media:/media`)}
      - ${yamlScalar(`${base}custom-templates:/templates`)}
      - /var/run/docker.sock:/var/run/docker.sock:ro
    depends_on:
      - postgresql
      - redis
    networks:
      - wicked

networks:
  wicked:
    external: true
    name: wicked
`;
}

// Authelia is a forward-auth provider for apps that set ENABLE_AUTH=true in
// their container environment. Its portal URL must be HTTPS: Authelia rejects
// insecure redirect/target URLs and marks its session cookies Secure, so
// nginx-proxy has to serve TLS for the portal and for protected vhosts.
const AUTHELIA_IMAGE = 'authelia/authelia:4.39';
const AUTH_VHOST_MARKER = '# managed-by: wickedafdok:authelia';
// Mailpit only captures mail for local inspection; it never delivers. Pinned so
// an unattended pull cannot change the SMTP/UI behaviour under the user.
const MAILPIT_IMAGE = 'axllent/mailpit:v1.32';
const MAIL_TLS_MODES = new Set(['none', 'starttls', 'tls']);

function autheliaDefaults(raw = {}) {
  const settings = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    enabled: false,
    domain: '',
    port: 9091,
    adminUser: 'admin',
    adminEmail: '',
    adminPassword: '',
    adminPasswordHash: '',
    sessionSecret: '',
    encryptionKey: '',
    jwtSecret: '',
    theme: 'auto',
    users: [],
    ...settings
  };
}

// Installation-wide defaults used to prefill new services and apps. These are
// deliberately conservative: an empty data location keeps the previous
// behaviour, and outside paths stay allowed until the user opts in.
function defaultsDefaults(raw = {}) {
  const settings = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {};
  delete settings.timezone;
  return {
    primaryDomain: '',
    dokDomain: '',
    dataLocation: '',
    storageRoot: '',
    dataMode: '0775',
    allowOutsideData: true,
    autoAppData: true,
    adminUser: 'admin',
    adminEmail: '',
    adminPassword: '',
    defaultNetwork: 'wicked',
    protectDok: false,
    ...settings
  };
}

// Outgoing mail settings shared by core services. `host` is empty until the
// user configures SMTP; Authelia then keeps writing notifications to disk.
function mailDefaults(raw = {}) {
  const settings = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    host: '',
    port: 587,
    tls: 'starttls',
    username: '',
    password: '',
    sender: '',
    identifier: '',
    ...settings
  };
}

function mailpitDefaults(raw = {}) {
  const settings = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    enabled: false,
    smtpPort: 1025,
    webPort: 8025,
    domain: '',
    maxMessages: 500,
    ...settings
  };
}

// Resolves the configured SMTP transport into the pieces Authelia needs. Returns
// null when no host is set so callers can fall back to the filesystem notifier.
function autheliaSmtpFrom(raw = {}) {
  const s = mailDefaults(raw);
  const host = String(s.host || '').trim();
  if (!host) return null;
  const port = Number(s.port) || 587;
  const tls = MAIL_TLS_MODES.has(String(s.tls)) ? String(s.tls) : 'starttls';
  return {
    host,
    port,
    tls,
    username: String(s.username || '').trim(),
    password: String(s.password || ''),
    sender: String(s.sender || '').trim(),
    identifier: String(s.identifier || '').trim(),
    // Authelia's address schemes only differ by default port and whether the
    // transport must be TLS: smtp (plain), submission (STARTTLS), submissions
    // (implicit TLS).
    address: `${tls === 'tls' ? 'submissions' : tls === 'starttls' ? 'submission' : 'smtp'}://${host}:${port}`
  };
}

function autheliaNotifierFingerprint(raw = {}) {
  // Keyed so the short digest kept in the nginx vhost state file cannot be used
  // to brute-force the SMTP password offline.
  return crypto.createHmac('sha256', credentialKey())
    .update(JSON.stringify(mailDefaults(raw)))
    .digest('hex')
    .slice(0, 16);
}

function mailpitCompose(raw = {}, hostDir = '') {
  const s = mailpitDefaults(raw);
  const smtpPort = Number(s.smtpPort) || 1025;
  const webPort = Number(s.webPort) || 8025;
  const maxMessages = Math.max(50, Math.min(50000, Number(s.maxMessages) || 500));
  const domain = normalizeDomain(s.domain);
  // Run as the Dok user so the bind-mounted data directory stays readable by
  // backups and setup.sh instead of being owned by root.
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const gid = typeof process.getgid === 'function' ? process.getgid() : 0;
  const base = String(hostDir || '').trim() ? String(hostDir).replace(/[/\\]+$/, '') + '/' : './';
  const env = [
    `MP_MAX_MESSAGES=${maxMessages}`,
    'MP_SMTP_AUTH_ACCEPT_ANY=1',
    'MP_SMTP_AUTH_ALLOW_INSECURE=1'
  ];
  if (domain) env.push(`VIRTUAL_HOST=${domain}`, 'VIRTUAL_PORT=8025');
  return `# managed-by: wickedafdok
services:
  mailpit:
    image: ${yamlScalar(MAILPIT_IMAGE)}
    container_name: mailpit
    restart: unless-stopped
    user: ${yamlScalar(`${uid}:${gid}`)}
    environment:
${env.map(item => `      - ${yamlScalar(item)}`).join('\n')}
    ports:
      - ${yamlScalar(`${smtpPort}:1025`)}
      - ${yamlScalar(`${webPort}:8025`)}
    volumes:
      - ${yamlScalar(`${base}data:/data`)}
    networks:
      - wicked

networks:
  wicked:
    external: true
    name: wicked
`;
}

// Creates/updates the Mailpit compose and starts it. Used by both the explicit
// launch endpoint and the "Use Mailpit" shortcut on the Email card.
async function launchMailpit(raw = {}) {
  const mailpit = mailpitDefaults(raw);
  await ensureNetwork('wicked');
  const composePath = coreServiceFile('mailpit');
  const coreHostDir = await selfMountSource('/app/core');
  const hostDir = coreHostDir ? path.join(coreHostDir, 'mailpit') : '';
  prepareHostBindDirs(hostDir, [['data', 0o775]]);
  writePrivateFile(composePath, mailpitCompose(mailpit, hostDir));
  return run('docker', ['compose', '-f', composePath, '-p', 'mailpit', 'up', '-d', '--remove-orphans'], {
    cwd: coreServiceDir('mailpit')
  });
}

// Rewrites Authelia's generated config with the current mail settings and
// restarts it only when the file actually changed. No-op until Authelia exists.
async function applyMailSettings() {
  const settings = readSettings();
  const authelia = autheliaDefaults(settings.services?.authelia || {});
  const composePath = path.join(coreServiceDir('authelia'), 'docker-compose.yml');
  if (!authelia.domain || !authelia.adminPasswordHash || !fs.existsSync(composePath)) {
    return { changed: false, restarted: false, installed: false };
  }
  const written = await writeAutheliaConfig(authelia, await authProtectedCookieDomains(authelia.domain));
  let restarted = false;
  if (written.changed) {
    const containers = await docker.listContainers({ all: false }).catch(() => []);
    if (containers.some(c => (c.Names || []).some(n => n.replace(/^\//, '') === 'authelia'))) {
      await run('docker', ['restart', 'authelia']).catch(() => {});
      restarted = true;
    }
  }
  return { changed: written.changed, restarted, installed: true };
}

// Validates an incoming SMTP settings body. A blank password keeps the stored
// one because the UI never receives it back.
function mailBodyToSettings(body = {}, current = {}) {
  const next = mailDefaults(current);
  if (body.host !== undefined) {
    const host = String(body.host || '').trim();
    if (host && (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(host) || host.length > 253)) {
      throw httpError(400, 'Invalid SMTP host');
    }
    next.host = host;
  }
  if (body.port !== undefined) {
    const port = Number(body.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw httpError(400, 'SMTP port must be between 1 and 65535');
    }
    next.port = port;
  }
  if (body.tls !== undefined) {
    const tls = String(body.tls || '').trim();
    if (!MAIL_TLS_MODES.has(tls)) throw httpError(400, 'SMTP TLS must be none, starttls, or tls');
    next.tls = tls;
  }
  if (body.username !== undefined) {
    const username = String(body.username || '').trim();
    if (/[\r\n]/.test(username)) throw httpError(400, 'Invalid SMTP username');
    next.username = username;
  }
  if (body.password !== undefined) {
    const password = String(body.password || '');
    if (/[\r\n]/.test(password)) throw httpError(400, 'Invalid SMTP password');
    if (password) next.password = password;
  }
  if (body.clearPassword === true) next.password = '';
  if (body.sender !== undefined) {
    const sender = String(body.sender || '').trim();
    if (sender && (!sender.includes('@') || /[\r\n<>]/.test(sender))) {
      throw httpError(400, 'Sender must be an email address');
    }
    next.sender = sender;
  }
  if (body.identifier !== undefined) {
    const identifier = String(body.identifier || '').trim();
    if (identifier && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(identifier)) {
      throw httpError(400, 'Invalid SMTP identifier');
    }
    next.identifier = identifier;
  }
  return next;
}

function autheliaCompose(raw = {}, hostDir = '') {
  const s = autheliaDefaults(raw);
  const domain = normalizeDomain(s.domain);
  const port = Number(s.port) || 9091;
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const gid = typeof process.getgid === 'function' ? process.getgid() : 0;
  const base = String(hostDir || '').trim() ? String(hostDir).replace(/[/\\]+$/, '') + '/' : './';
  const vhostEnv = domain
    ? `      - ${yamlScalar(`VIRTUAL_HOST=${domain}`)}\n      - ${yamlScalar('VIRTUAL_PORT=9091')}\n`
    : '';
  return `# managed-by: wickedafdok
services:
  authelia:
    image: ${yamlScalar(AUTHELIA_IMAGE)}
    container_name: authelia
    restart: unless-stopped
    environment:
      - ${yamlScalar(`PUID=${uid}`)}
      - ${yamlScalar(`PGID=${gid}`)}
${vhostEnv}    ports:
      - ${yamlScalar(`${port}:9091`)}
    volumes:
      - ${yamlScalar(`${base}config:/config`)}
    networks:
      - wicked

networks:
  wicked:
    external: true
    name: wicked
`;
}

// Authelia's cookie domain must contain a dot and cover the protected host, so
// use the registrable-looking parent (last two labels) and fall back to the
// host itself for two-label names and IP addresses.
function authCookieDomain(value) {
  const host = normalizeDomain(value).toLowerCase();
  if (!host) return '';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) return host;
  const parts = host.split('.').filter(Boolean);
  if (parts.length < 3) return host;
  return parts.slice(-2).join('.');
}

function argon2PhcHash(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.argon2('argon2id', {
      message: String(password),
      nonce: salt,
      parallelism: 4,
      tagLength: 32,
      memory: 65536,
      passes: 3
    }, (err, tag) => {
      if (err) return reject(err);
      const b64 = value => Buffer.from(value).toString('base64').replace(/=+$/, '');
      // Authelia expects a PHC string with its default parameters.
      resolve(`$argon2id$v=19$m=65536,t=3,p=4$${b64(salt)}$${b64(tag)}`);
    });
  });
}

async function autheliaPasswordHash(password) {
  // Node 24 can compute Argon2id in-process. Prefer that over `docker run`:
  // the Docker path starts a container from the Authelia image, which pulls on
  // first use and can outlive a reverse proxy's request timeout, leaving the
  // UI with a network error and no saved user.
  if (typeof crypto.argon2 === 'function') {
    try {
      return await argon2PhcHash(password);
    } catch (e) {
      appendServerLog('WARN', `Native Argon2 hashing failed, falling back to Docker: ${e.message}`);
    }
  }
  const { stdout } = await run('docker', [
    'run', '--rm', '--entrypoint', 'authelia', AUTHELIA_IMAGE,
    'crypto', 'hash', 'generate', 'argon2', '--password', String(password)
  ]);
  const match = /\$argon2id\$[^\s"']+/.exec(stdout || '');
  if (!match) throw new Error('Authelia did not return an Argon2id password hash');
  return match[0];
}

function autheliaConfiguration(raw = {}, cookieDomains = [], smtp = {}) {
  const s = autheliaDefaults(raw);
  const portal = normalizeDomain(s.domain);
  const portalUrl = `https://${portal}`;
  const user = String(s.adminUser || 'admin').replace(/[^A-Za-z0-9._@-]/g, '') || 'admin';
  const hash = String(s.adminPasswordHash || '').trim();
  if (!portal) throw httpError(400, 'Authelia requires a portal domain');
  if (!hash) throw httpError(400, 'Authelia admin password hash is missing');
  const email = String(s.adminEmail || '').trim();
  const mail = autheliaSmtpFrom(smtp);
  const notifier = mail
    ? `notifier:
  # A local Mailpit sink is optional, so a stopped sink must not prevent
  # Authelia (and every protected app) from starting. Real providers keep the
  # startup check, which validates credentials early.
  disable_startup_check: ${mail.host === 'mailpit' ? 'true' : 'false'}
  smtp:
    address: ${JSON.stringify(mail.address)}
    sender: ${JSON.stringify(mail.sender || `Authelia <authelia@${portal}>`)}
    identifier: ${JSON.stringify(mail.identifier || portal)}
    subject: '[Authelia] {title}'
${mail.username && mail.password ? `    username: ${JSON.stringify(mail.username)}\n    password: ${JSON.stringify(mail.password)}\n` : ''}${mail.tls === 'none' ? '    disable_require_tls: true\n' : ''}`
    : `notifier:
  filesystem:
    filename: '/config/notifications.txt'
`;
  const cookieSet = [...new Set([authCookieDomain(portal), ...cookieDomains.map(authCookieDomain)].filter(Boolean))];
  const cookieLines = cookieSet
    .map(d => `    - domain: ${JSON.stringify(d)}\n      authelia_url: ${JSON.stringify(portalUrl)}\n      default_redirection_url: ${JSON.stringify(`${portalUrl}/`)}\n`)
    .join('');
  const config = `---
theme: ${JSON.stringify(String(s.theme || 'auto'))}
server:
  address: 'tcp://0.0.0.0:9091/'
log:
  level: 'info'
totp:
  issuer: ${JSON.stringify(portal)}
  period: 30
  skew: 1
identity_validation:
  reset_password:
    jwt_secret: ${JSON.stringify(String(s.jwtSecret))}
authentication_backend:
  file:
    path: '/config/users.yml'
access_control:
  default_policy: 'one_factor'
  rules:
    - domain: ${JSON.stringify(portal)}
      policy: 'bypass'
session:
  name: 'authelia_session'
  secret: ${JSON.stringify(String(s.sessionSecret))}
  expiration: '1h'
  inactivity: '5m'
  same_site: 'lax'
  cookies:
${cookieLines}storage:
  encryption_key: ${JSON.stringify(String(s.encryptionKey))}
  local:
    path: '/config/db.sqlite3'
${notifier}`;
  const userLines = [];
  const seenUsers = new Set();
  const appendUser = (username, entry = {}) => {
    const name = String(username || '').trim();
    if (!name || seenUsers.has(name)) return;
    const storedHash = String(entry.passwordHash || '').trim();
    if (!storedHash) return;
    seenUsers.add(name);
    const displayname = String(entry.displayname || name).trim() || name;
    const lineEmail = String(entry.email || '').trim();
    let line = '  ' + name + ':\n';
    line += '    displayname: ' + JSON.stringify(displayname) + '\n';
    line += '    password: ' + JSON.stringify(storedHash) + '\n';
    if (lineEmail) line += '    email: ' + JSON.stringify(lineEmail) + '\n';
    line += '    disabled: ' + (entry.disabled ? 'true' : 'false');
    userLines.push(line);
  };
  appendUser(user, { displayname: user, passwordHash: hash, email });
  for (const entry of Array.isArray(s.users) ? s.users : []) {
    const name = String(entry?.username || '').trim();
    if (!name || !/^[A-Za-z0-9][A-Za-z0-9._@-]*$/.test(name)) continue;
    let storedHash = String(entry.passwordHash || '');
    if (entry.passwordHashEnc) {
      try { storedHash = decryptSecret(String(entry.passwordHashEnc)); } catch { storedHash = ''; }
    }
    appendUser(name, { ...entry, passwordHash: storedHash });
  }
  const users = 'users:\n' + userLines.join('\n') + '\n';
  return { config, users, cookieDomains: cookieSet };
}

async function writeAutheliaConfig(raw = {}, cookieDomains = []) {
  const s = autheliaDefaults(raw);
  const dir = path.join(coreServiceDir('authelia'), 'config');
  fs.mkdirSync(dir, { recursive: true });
  // Read mail settings here rather than threading them through every caller so
  // no path (startup sync, domain change, run, SMTP save) can silently drop the
  // notifier configuration.
  const mail = readSettings().services?.mail || {};
  const files = autheliaConfiguration(s, cookieDomains, mail);
  let changed = false;
  for (const [name, content] of [['configuration.yml', files.config], ['users.yml', files.users]]) {
    const target = path.join(dir, name);
    let current = '';
    try { current = fs.readFileSync(target, 'utf-8'); } catch {}
    if (current !== content) {
      writePrivateFile(target, content);
      changed = true;
    }
  }
  return { ...files, dir, changed };
}

async function listAuthProtectedHosts() {
  const hosts = new Set();
  // The Dok container cannot recreate itself just to receive ENABLE_AUTH, so
  // opt it in through settings instead. Add it before the Docker lookup so a
  // transient Docker failure does not drop the saved Dok protection.
  const settings = readSettings();
  const defaults = defaultsDefaults(settings.defaults || {});
  const dokHost = normalizeDomain(defaults.dokDomain || settings.services?.nginxProxy?.domain || '');
  if (defaults.protectDok && dokHost && !/[*~]/.test(dokHost)) hosts.add(dokHost);
  let containers = [];
  try {
    containers = await docker.listContainers({ all: false });
  } catch {
    // Docker is unavailable, so we cannot rediscover which apps currently opt
    // in. Keep the last generated set instead of pruning every protected app
    // vhost on a transient failure.
    try {
      const statePath = path.join(coreServiceDir('nginx-proxy'), 'vhost.d', '.wickedafdok-auth.json');
      const previous = JSON.parse(fs.readFileSync(statePath, 'utf-8')).hosts;
      for (const host of Array.isArray(previous) ? previous : []) {
        const clean = normalizeDomain(host);
        if (clean && !/[*~]/.test(clean) && (defaults.protectDok || clean !== dokHost)) hosts.add(clean);
      }
    } catch {}
    return [...hosts];
  }
  for (const container of containers) {
    let info;
    try {
      info = await docker.getContainer(container.Id).inspect();
    } catch {
      continue;
    }
    const env = Array.isArray(info.Config?.Env) ? info.Config.Env : [];
    const enabled = env.some(item => /^ENABLE_AUTH=(1|true|yes|on)$/i.test(String(item)));
    if (!enabled) continue;
    const vhost = env.find(item => /^VIRTUAL_HOST=/.test(String(item)));
    if (!vhost) continue;
    for (const host of String(vhost).slice('VIRTUAL_HOST='.length).split(',')) {
      const clean = normalizeDomain(host).toLowerCase();
      if (clean && !/[*~]/.test(clean)) hosts.add(clean);
    }
  }
  return [...hosts];
}

async function authProtectedCookieDomains(portal) {
  const clean = normalizeDomain(portal);
  if (!clean) return [];
  const cookie = authCookieDomain(clean);
  const hosts = (await listAuthProtectedHosts())
    .filter(h => h !== clean && authCookieDomain(h) === cookie);
  return [...new Set([cookie, ...hosts.map(authCookieDomain)].filter(Boolean))];
}

function authVhostServerConfig() {
  return `${AUTH_VHOST_MARKER}
location = /authelia {
    internal;
    proxy_pass http://authelia:9091/api/authz/auth-request;
    proxy_pass_request_body off;
    proxy_set_header Content-Length "";
    proxy_set_header X-Original-URL https://$http_host$request_uri;
    proxy_set_header X-Original-Method $request_method;
    proxy_set_header X-Forwarded-Method $request_method;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-Host $http_host;
    proxy_set_header X-Forwarded-Uri $request_uri;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Real-IP $remote_addr;
}
`;
}

function authVhostLocationConfig(portal) {
  return `${AUTH_VHOST_MARKER}
auth_request /authelia;
auth_request_set $target_url https://$http_host$request_uri;
auth_request_set $user $upstream_http_remote_user;
auth_request_set $groups $upstream_http_remote_groups;
auth_request_set $name $upstream_http_remote_name;
auth_request_set $email $upstream_http_remote_email;
auth_request_set $auth_status $upstream_status;
proxy_set_header Remote-User $user;
proxy_set_header Remote-Groups $groups;
proxy_set_header Remote-Name $name;
proxy_set_header Remote-Email $email;
proxy_set_header Remote-Status $auth_status;
error_page 401 =302 https://${portal}/?rd=$target_url;
`;
}

function authVhostFileBase(host) {
  const value = String(host || '').trim();
  // nginx-proxy handles wildcard/regexp hosts with special file naming that
  // differs between the server and location scopes, so protect literal hosts
  // only and skip patterns instead of writing files nginx-proxy would ignore.
  if (!value || /[*~]/.test(value)) return '';
  return value;
}

async function reloadNginxProxy() {
  // nginx-proxy's docker-gen only renders on container events and checks for
  // per-vhost files at render time. A plain `nginx -s reload` would re-read the
  // old default.conf, which may not include a host that was just protected.
  // Restarting the container forces a fresh render (and reload).
  try {
    const containers = await docker.listContainers({ all: false }).catch(() => []);
    const running = containers.some(c => (c.Names || []).some(n => n.replace(/^\//, '') === 'nginx-proxy'));
    if (!running) return false;
    await run('docker', ['restart', 'nginx-proxy']);
    return true;
  } catch (e) {
    appendServerLog('WARN', `nginx-proxy restart failed: ${String(e.stderr || e.message || '').trim()}`);
    return false;
  }
}

async function ensureNginxProxyCompose({ recreate = false } = {}) {
  const dir = coreServiceDir('nginx-proxy');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(dir, 'vhost.d'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'certs'), { recursive: true });
  } catch {}
  ensureNginxErrorPages();
  const composePath = path.join(dir, 'docker-compose.yml');
  const recovered = recoverOversizedManagedCompose(composePath);
  const compose = readComposeText(composePath);
  if (!recovered && !compose.startsWith('# managed-by: wickedafdok')) return { changed: false, recreated: false };
  const coreHostDir = await selfMountSource('/app/core');
  if (!coreHostDir) return { changed: false, recreated: false };
  const nginxHostDir = path.join(coreHostDir, 'nginx-proxy');
  let next = setMountSource(compose, '/etc/nginx/vhost.d', path.join(nginxHostDir, 'vhost.d'));
  next = setMountSource(next, '/etc/nginx/certs', path.join(nginxHostDir, 'certs'));
  next = setMountSource(next, '/usr/share/nginx/html', path.join(nginxHostDir, 'html'));
  const configured = readSettings().services?.nginxProxy || {};
  const httpPort = nginxProxyHttpPort(configured.httpPort);
  const acme = nginxProxyAcme(configured.acme || {});
  const wantsAcme = !!(acme.enabled && String(acme.email || '').trim());
  const hasAcme = /(^|\n)\s*acme-companion\s*:/.test(next);
  const acmeStale = wantsAcme !== hasAcme ||
    (wantsAcme && (!next.includes(`DEFAULT_EMAIL=${yamlScalar(String(acme.email || '').trim())}`) ||
      (acme.staging && !next.includes('acme-staging-v02.api.letsencrypt.org')) ||
      (!acme.staging && next.includes('acme-staging-v02.api.letsencrypt.org'))));
  if (acmeStale || !nginxComposeHasHttpPort(next, httpPort) ||
      !next.includes('/etc/nginx/vhost.d') || !next.includes('/etc/nginx/certs') ||
      !next.includes('/usr/share/nginx/html')) {
    // Older managed composes have no vhost/certs/error-page volumes or the
    // certificate companion setting changed; regenerate the whole file from
    // the saved nginx-proxy settings.
    if (wantsAcme) {
      try { fs.mkdirSync(path.join(dir, 'acme'), { recursive: true }); } catch {}
    }
    next = nginxProxyCompose(configured.network || 'wicked', configured.domain || '', nginxHostDir, acme, httpPort);
  }
  const changed = next !== compose;
  if (changed) writePrivateFile(composePath, next);
  let recreated = false;
  if (recreate) {
    // Compose changes only take effect when the container is recreated. Patch
    // the compose silently on page loads, but fix a live old container here so
    // existing installs pick up the vhost/certs/error-page mounts without user
    // action.
    try {
      const containers = await docker.listContainers({ all: false });
      const running = containers.some(c => (c.Names || []).some(n => n.replace(/^\//, '') === 'nginx-proxy'));
      if (running) {
        const info = await docker.getContainer('nginx-proxy').inspect();
        const destinations = (info.Mounts || []).map(m => m.Destination);
        const missing = !destinations.includes('/etc/nginx/vhost.d') ||
          !destinations.includes('/etc/nginx/certs') ||
          !destinations.includes('/usr/share/nginx/html');
        if (changed || missing) {
          await run('docker', ['compose', '-f', composePath, '-p', 'nginx-proxy', 'up', '-d', '--remove-orphans'], { cwd: dir });
          recreated = true;
          appendServerLog('INFO', 'nginx-proxy recreated to mount the vhost, certificate, and error-page directories');
        }
      }
    } catch (e) {
      appendServerLog('WARN', `nginx-proxy mount update failed: ${String(e.stderr || e.message || '').trim()}`);
    }
  }
  return { changed, recreated };
}

// Reconcile the per-vhost nginx config for every running container that opts
// into ENABLE_AUTH=true, prune files from containers that no longer do, and
// keep Authelia's cookie domains in sync with the protected hosts.
async function syncAuthVhosts() {
  const settings = readSettings();
  const authelia = autheliaDefaults(settings.services?.authelia || {});
  const portal = normalizeDomain(authelia.domain);
  const dir = path.join(coreServiceDir('nginx-proxy'), 'vhost.d');
  fs.mkdirSync(dir, { recursive: true });
  const statePath = path.join(dir, '.wickedafdok-auth.json');
  let state = { hosts: [], cookieDomains: [] };
  try {
    state = { ...state, ...JSON.parse(fs.readFileSync(statePath, 'utf-8')) };
  } catch {}
  const previousHosts = Array.isArray(state.hosts) ? state.hosts : [];
  const portalCookie = portal ? authCookieDomain(portal) : '';
  const discovered = portal ? (await listAuthProtectedHosts()).filter(h => h !== portal) : [];
  // A portal can only set a session cookie for the domain it is served from.
  // Protect hosts that share the portal's cookie domain; others would redirect
  // to the portal in a loop because the browser has no session for them.
  const hosts = discovered.filter(h => !portalCookie || authCookieDomain(h) === portalCookie);
  const skipped = discovered.filter(h => portalCookie && authCookieDomain(h) !== portalCookie);
  const previousSkipped = Array.isArray(state.skippedHosts) ? state.skippedHosts : [];
  if (skipped.slice().sort().join(',') !== previousSkipped.slice().sort().join(',')) {
    if (skipped.length) {
      appendServerLog('WARN', `Authelia skipped ${skipped.join(', ')}: protected hosts must share the portal cookie domain (${portalCookie})`);
    }
  }
  let nginxChanged = false;
  for (const host of previousHosts) {
    if (hosts.includes(host)) continue;
    const base = authVhostFileBase(host);
    if (!base) continue;
    for (const name of [base, `${base}_location`]) {
      const target = path.join(dir, name);
      try {
        if (fs.readFileSync(target, 'utf-8').startsWith(AUTH_VHOST_MARKER)) {
          fs.unlinkSync(target);
          nginxChanged = true;
        }
      } catch {}
    }
  }
  if (portal) {
    for (const host of hosts) {
      const base = authVhostFileBase(host);
      if (!base) continue;
      const files = [
        [base, authVhostServerConfig()],
        [`${base}_location`, authVhostLocationConfig(portal)]
      ];
      for (const [name, content] of files) {
        const target = path.join(dir, name);
        let current = '';
        try { current = fs.readFileSync(target, 'utf-8'); } catch {}
        if (current !== content) {
          fs.writeFileSync(target, content, { mode: 0o644 });
          try { fs.chmodSync(target, 0o644); } catch {}
          nginxChanged = true;
        }
      }
    }
  }
  let cookieDomains = [];
  let persistedCookieDomains = [];
  let smtpFingerprint = String(state.smtpFingerprint || '');
  let persistedSmtpFingerprint = smtpFingerprint;
  if (portal) {
    cookieDomains = [...new Set([authCookieDomain(portal), ...hosts.map(authCookieDomain)].filter(Boolean))];
    persistedCookieDomains = cookieDomains;
    const composePath = path.join(coreServiceDir('authelia'), 'docker-compose.yml');
    const configPath = path.join(coreServiceDir('authelia'), 'config', 'configuration.yml');
    const usersPath = path.join(coreServiceDir('authelia'), 'config', 'users.yml');
    const previousCookies = (Array.isArray(state.cookieDomains) ? state.cookieDomains : []).join(',');
    const nextCookies = cookieDomains.join(',');
    // Rewrite the generated Authelia config only when an input changes (or the
    // file is missing). This keeps manual edits from being overwritten on every
    // 60s sync while still picking up a new cookie-domain set or SMTP settings.
    smtpFingerprint = autheliaNotifierFingerprint(settings.services?.mail || {});
    if (fs.existsSync(composePath) && authelia.adminPasswordHash &&
        (previousCookies !== nextCookies || smtpFingerprint !== String(state.smtpFingerprint || '') || !fs.existsSync(configPath) || !fs.existsSync(usersPath))) {
      try {
        const written = await writeAutheliaConfig(authelia, cookieDomains);
        if (written.changed) {
          const containers = await docker.listContainers({ all: false }).catch(() => []);
          if (containers.some(c => (c.Names || []).some(n => n.replace(/^\//, '') === 'authelia'))) {
            await run('docker', ['restart', 'authelia']).catch(() => {});
          }
        }
        persistedSmtpFingerprint = smtpFingerprint;
      } catch (e) {
        // Keep the old values in the state so the next sync retries.
        persistedCookieDomains = Array.isArray(state.cookieDomains) ? state.cookieDomains : [];
        persistedSmtpFingerprint = String(state.smtpFingerprint || '');
        appendServerLog('WARN', `Authelia config sync failed: ${e.message}`);
      }
    }
  }
  const ensured = await ensureNginxProxyCompose({ recreate: !!portal });
  if (nginxChanged && !ensured.recreated) await reloadNginxProxy();
  fs.writeFileSync(statePath, JSON.stringify({ hosts, skippedHosts: skipped, cookieDomains: persistedCookieDomains, smtpFingerprint: persistedSmtpFingerprint, at: Date.now() }, null, 2), { mode: 0o600 });
  return { hosts, skippedHosts: skipped, cookieDomains: persistedCookieDomains, nginxChanged };
}

function technitiumCompose(settings = {}, hostDir = '') {
  const adminPassword = String(settings.adminPassword || '').trim() || randomSecret(12);
  const webPort = Number(settings.webPort) || 5380;
  const dnsPort = Number(settings.dnsPort) || 53;
  const base = String(hostDir || '').trim() ? String(hostDir).replace(/[/\\]+$/, '') + '/' : './';
  const env = [`DNS_SERVER_ADMIN_PASSWORD=${adminPassword}`];
  const domain = normalizeDomain(settings.domain);
  if (domain) {
    env.push(`VIRTUAL_HOST=${domain}`);
    env.push('VIRTUAL_PORT=5380');
  }
  const envLines = env.map(item => `      - ${yamlScalar(item)}`).join('\n');
  return `# managed-by: wickedafdok
services:
  technitium-dns:
    image: technitium/dns-server:latest
    container_name: technitium-dns
    restart: unless-stopped
    environment:
${envLines}
    ports:
      - ${yamlScalar(`${webPort}:5380`)}
      - ${yamlScalar(`${dnsPort}:53/udp`)}
      - ${yamlScalar(`${dnsPort}:53/tcp`)}
    volumes:
      - ${yamlScalar(`${base}config:/etc/dns`)}
    networks:
      - wicked

networks:
  wicked:
    external: true
    name: wicked
`;
}

function adguardDefaults(raw = {}) {
  const settings = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    enabled: false,
    webPort: 3000,
    dnsPort: 53,
    domain: '',
    ...settings
  };
}

function adguardCompose(settings = {}, hostDir = '') {
  const s = adguardDefaults(settings);
  const webPort = Number(s.webPort) || 3000;
  const dnsPort = Number(s.dnsPort) || 53;
  const domain = normalizeDomain(s.domain);
  const base = String(hostDir || '').trim() ? String(hostDir).replace(/[/\\]+$/, '') + '/' : './';
  const env = domain ? [`VIRTUAL_HOST=${domain}`, 'VIRTUAL_PORT=3000'] : [];
  const envBlock = env.length ? `    environment:\n${env.map(item => `      - ${yamlScalar(item)}`).join('\n')}\n` : '';
  return `# managed-by: wickedafdok
services:
  adguard:
    image: adguard/adguardhome:latest
    container_name: adguard
    restart: unless-stopped
${envBlock}    ports:
      - ${yamlScalar(`${webPort}:3000`)}
      - ${yamlScalar(`${dnsPort}:53/udp`)}
      - ${yamlScalar(`${dnsPort}:53/tcp`)}
    volumes:
      - ${yamlScalar(`${base}work:/opt/adguardhome/work`)}
      - ${yamlScalar(`${base}conf:/opt/adguardhome/conf`)}
    networks:
      - wicked

networks:
  wicked:
    external: true
    name: wicked
`;
}

function stalwartDefaults(raw = {}) {
  const settings = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    enabled: false,
    domain: '',
    adminUser: 'admin',
    adminPassword: '',
    webPort: 8088,
    smtpPort: 25,
    submissionPort: 587,
    imapsPort: 993,
    ...settings
  };
}

function stalwartCompose(settings = {}, hostDir = '') {
  const s = stalwartDefaults(settings);
  const adminPassword = String(s.adminPassword || '').trim() || randomSecret(16);
  const webPort = Number(s.webPort) || 8088;
  const smtpPort = Number(s.smtpPort) || 25;
  const submissionPort = Number(s.submissionPort) || 587;
  const imapsPort = Number(s.imapsPort) || 993;
  const hostname = normalizeDomain(s.domain);
  const base = String(hostDir || '').trim() ? String(hostDir).replace(/[/\\]+$/, '') + '/' : './';
  const env = [
    `STALWART_RECOVERY_ADMIN=${String(s.adminUser || 'admin').trim()}:${adminPassword}`
  ];
  if (hostname) env.push(`STALWART_HOSTNAME=${hostname}`);
  if (hostname) {
    env.push(`VIRTUAL_HOST=${hostname}`);
    env.push('VIRTUAL_PORT=8080');
  }
  return `# managed-by: wickedafdok
services:
  stalwart:
    image: stalwartlabs/stalwart:latest
    container_name: stalwart
    restart: unless-stopped
    environment:
${env.map(item => `      - ${yamlScalar(item)}`).join('\n')}
    ports:
      - ${yamlScalar(`${smtpPort}:25`)}
      - ${yamlScalar(`${submissionPort}:587`)}
      - "465:465"
      - ${yamlScalar(`${imapsPort}:993`)}
      - ${yamlScalar(`${webPort}:8080`)}
    volumes:
      - ${yamlScalar(`${base}data:/opt/stalwart`)}
    networks:
      - wicked

networks:
  wicked:
    external: true
    name: wicked
`;
}

// Adds, updates, or removes environment entries on one service in a compose
// file without disturbing user edits elsewhere in the document.
function setComposeServiceEnv(compose, serviceName, values = {}) {
  const entries = Object.entries(values);
  if (!entries.length) return compose;
  const lines = String(compose || '').split('\n');
  const indentOf = line => (line.match(/^ */) || [''])[0].length;
  const headerName = line => {
    const match = line.match(/^\s{2}(.+?):\s*$/);
    return match ? match[1].replace(/^['"]|['"]$/g, '') : '';
  };
  const start = lines.findIndex(line => indentOf(line) === 2 && headerName(line) === serviceName);
  if (start === -1) return compose;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() && indentOf(lines[i]) <= 2) { end = i; break; }
  }

  const serviceIndent = indentOf(lines[start]);
  let envIdx = -1;
  for (let i = start + 1; i < end; i++) {
    if (lines[i].trim() === 'environment:' && indentOf(lines[i]) > serviceIndent) { envIdx = i; break; }
  }

  const listKey = line => {
    let text = line.replace(/^\s*-\s*/, '');
    const quote = text[0];
    if (quote === '"' || quote === "'") {
      const close = text.indexOf(quote, 1);
      if (close > 0) text = text.slice(1, close);
    }
    return text.split('=')[0].trim();
  };

  if (envIdx === -1) {
    const additions = entries
      .filter(([, value]) => String(value ?? '') !== '')
      .map(([key, value]) => `${' '.repeat(serviceIndent + 4)}- ${yamlScalar(`${key}=${value}`)}`);
    if (!additions.length) return compose;
    lines.splice(start + 1, 0, `${' '.repeat(serviceIndent + 2)}environment:`, ...additions);
    return lines.join('\n');
  }

  const envIndent = indentOf(lines[envIdx]);
  let envEnd = end;
  for (let i = envIdx + 1; i < end; i++) {
    if (lines[i].trim() && indentOf(lines[i]) <= envIndent) { envEnd = i; break; }
  }
  const itemIndent = envIndent + 2;
  const block = lines.slice(envIdx + 1, envEnd);
  const mappingStyle = block.some(line => line.trim() && !line.trim().startsWith('-') && !line.trim().startsWith('#'));
  const mappingKey = line => line.trim().replace(/^['"]|['"]$/g, '').split(':')[0].trim();
  const keyOf = mappingStyle ? mappingKey : listKey;

  const next = [];
  const handled = new Set();
  for (const line of block) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) { next.push(line); continue; }
    const key = keyOf(line);
    const found = entries.find(([name]) => name === key);
    if (!found) { next.push(line); continue; }
    handled.add(key);
    const value = found[1];
    if (String(value ?? '') === '') continue;
    next.push(mappingStyle
      ? `${' '.repeat(itemIndent)}${key}: ${yamlScalar(value)}`
      : `${' '.repeat(itemIndent)}- ${yamlScalar(`${key}=${value}`)}`);
  }
  // Drop trailing blank lines left inside the environment block before
  // appending new keys, so they do not land between environment entries.
  while (next.length && !next[next.length - 1].trim()) next.pop();
  for (const [key, value] of entries) {
    if (handled.has(key) || String(value ?? '') === '') continue;
    next.push(mappingStyle
      ? `${' '.repeat(itemIndent)}${key}: ${yamlScalar(value)}`
      : `${' '.repeat(itemIndent)}- ${yamlScalar(`${key}=${value}`)}`);
  }

  if (!next.some(line => line.trim())) lines.splice(envIdx, envEnd - envIdx);
  else lines.splice(envIdx + 1, envEnd - (envIdx + 1), ...next);
  return lines.join('\n');
}

// nginx-proxy is treated as installed when it is enabled in settings or has a
// managed compose on disk. This matches the app-hints behavior so routing
// fields appear before the proxy is first started.
function nginxProxyInstalledSync() {
  try {
    if (readSettings().services?.nginxProxy?.enabled === true) return true;
    return fs.existsSync(path.join(coreServiceDir('nginx-proxy'), 'docker-compose.yml'));
  } catch {
    return false;
  }
}

function composeServiceRange(compose, serviceName) {
  const target = String(serviceName || '').trim();
  if (!target) return null;
  const lines = String(compose || '').replace(/\r\n/g, '\n').split('\n');
  let servicesLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^services\s*:\s*(?:#.*)?$/.test(lines[i])) { servicesLine = i; break; }
  }
  if (servicesLine < 0) return null;
  let serviceIndent = null;
  let start = -1;
  let end = lines.length;
  for (let i = servicesLine + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = lineIndent(line);
    if (indent === 0) {
      if (start >= 0) end = i;
      break;
    }
    if (start < 0) {
      if (serviceIndent === null) serviceIndent = indent;
      if (indent !== serviceIndent) continue;
      const match = line.trim().match(/^(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.-]+))\s*:\s*(?:#.*)?$/);
      if (match && (match[1] || match[2] || match[3]) === target) start = i;
    } else if (indent <= serviceIndent) {
      end = i;
      break;
    }
  }
  if (start < 0) return null;
  return { lines, start, end, serviceIndent };
}

function composeServiceChildBlock(compose, serviceName, key) {
  const range = composeServiceRange(compose, serviceName);
  if (!range) return null;
  let childIndent = null;
  for (let i = range.start + 1; i < range.end; i++) {
    const line = range.lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = lineIndent(line);
    if (indent <= range.serviceIndent) break;
    if (childIndent === null) childIndent = indent;
    if (indent !== childIndent) continue;
    const match = line.trim().match(/^(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.-]+))\s*:\s*(.*)$/);
    if (!match || (match[1] || match[2] || match[3]) !== key) continue;
    let end = range.end;
    for (let j = i + 1; j < range.end; j++) {
      const nextLine = range.lines[j];
      if (!nextLine.trim()) continue;
      if (lineIndent(nextLine) <= childIndent) { end = j; break; }
    }
    return {
      lines: range.lines,
      start: i,
      end,
      keyIndent: childIndent,
      rest: stripYamlComment(match[4] || '').trim()
    };
  }
  return null;
}

function composeServiceSeqValues(compose, serviceName, key) {
  const block = composeServiceChildBlock(compose, serviceName, key);
  if (!block) return [];
  if (block.rest) {
    if (block.rest.startsWith('[') && block.rest.endsWith(']')) {
      return splitFlowItems(block.rest.slice(1, -1))
        .map(item => unquoteYamlValue(stripYamlComment(item).trim()))
        .filter(Boolean);
    }
    if (/^[|>]/.test(block.rest)) return [];
    return [unquoteYamlValue(block.rest)].filter(Boolean);
  }
  const values = [];
  let current = '';
  for (let i = block.start + 1; i < block.end; i++) {
    const line = block.lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (/^-\s*/.test(trimmed)) {
      if (current) values.push(current);
      current = trimmed.replace(/^-\s*/, '');
    } else if (current) {
      current += ' ' + trimmed;
    }
  }
  if (current) values.push(current);
  return values.map(value => stripYamlComment(value).trim()).filter(Boolean);
}

function composeServiceEnvValue(compose, serviceName, key) {
  const block = composeServiceChildBlock(compose, serviceName, 'environment');
  if (!block) return '';
  const wanted = String(key || '').trim();
  if (!wanted) return '';
  const readEntry = (text) => {
    const clean = stripYamlComment(text).trim();
    if (!clean) return null;
    // A list entry is often written as `- "KEY=value"`. Unquote the whole entry
    // first so the value does not keep the closing quote.
    const dashless = unquoteYamlValue(clean.replace(/^-\s*/, ''));
    const idx = dashless.indexOf('=');
    if (idx >= 0) {
      const name = dashless.slice(0, idx).trim().replace(/^["']|["']$/g, '');
      return name === wanted ? unquoteYamlValue(dashless.slice(idx + 1).trim()) : null;
    }
    const match = dashless.match(/^(?:"([^"]+)"|'([^']+)'|([^:]+?))\s*:\s*(.*)$/);
    if (!match) return null;
    const name = (match[1] || match[2] || match[3] || '').trim();
    return name === wanted ? unquoteYamlValue(stripYamlComment(match[4] || '').trim()) : null;
  };
  if (block.rest) {
    const entries = block.rest.startsWith('[') && block.rest.endsWith(']')
      ? splitFlowItems(block.rest.slice(1, -1))
      : [block.rest];
    for (const entry of entries) {
      const value = readEntry(entry);
      if (value !== null) return String(value).trim();
    }
    return '';
  }
  for (let i = block.start + 1; i < block.end; i++) {
    const line = block.lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const value = readEntry(line);
    if (value !== null) return String(value).trim();
  }
  return '';
}

function composePortTarget(entry) {
  const text = String(entry || '').trim();
  if (!text) return '';
  const longTarget = text.match(/(?:^|\s)target\s*:\s*["']?(\d{1,5})/);
  if (longTarget) return longTarget[1];
  let value = unquoteYamlValue(text).replace(/\s+#.*$/, '').trim();
  value = value.replace(/\/(?:tcp|udp|sctp)$/i, '');
  const parts = value.split(':');
  let target = String(parts[parts.length - 1] || '').trim().replace(/^["']|["']$/g, '');
  const match = target.match(/^(\d{1,5})(?:-\d+)?$/);
  return match ? match[1] : '';
}

function composeServicePortTargets(compose, serviceName) {
  return composeServiceSeqValues(compose, serviceName, 'ports')
    .map(composePortTarget)
    .filter(Boolean);
}

function composeServiceExposeTargets(compose, serviceName) {
  return composeServiceSeqValues(compose, serviceName, 'expose')
    .map(value => String(unquoteYamlValue(value)).trim().split(/[-\/]/)[0])
    .filter(value => /^\d{1,5}$/.test(value));
}

function composeVhostPortForService(compose, serviceName, requested = '', fallback = 80) {
  const explicit = String(requested || '').trim();
  if (/^\d+$/.test(explicit) && Number(explicit) >= 1 && Number(explicit) <= 65535) return explicit;
  // Respect an explicit VIRTUAL_PORT already in the compose (docker run env,
  // OC Assist, imported app) before guessing from published ports.
  const existing = composeServiceEnvValue(compose, serviceName, 'VIRTUAL_PORT');
  if (/^\d+$/.test(existing) && Number(existing) >= 1 && Number(existing) <= 65535) return existing;
  const port = composeServicePortTargets(compose, serviceName)[0];
  if (port) return port;
  const exposed = composeServiceExposeTargets(compose, serviceName)[0];
  if (exposed) return exposed;
  const envPort = composeServiceEnvValue(compose, serviceName, 'PORT');
  if (/^\d+$/.test(envPort)) return envPort;
  return String(fallback || 80);
}

function removeComposeServiceKey(compose, serviceName, key) {
  const block = composeServiceChildBlock(compose, serviceName, key);
  if (!block) return compose;
  const lines = [...block.lines];
  lines.splice(block.start, block.end - block.start);
  return lines.join('\n');
}

function ensureComposeServiceNetwork(composeText, serviceName, key = 'default') {
  const text = String(composeText || '');
  if (!text.trim() || !serviceName) return text;
  if (composeServiceChildBlock(text, serviceName, 'network_mode')) return text;
  const block = composeServiceChildBlock(text, serviceName, 'networks');
  if (!block) return text;
  const lines = [...block.lines];
  if (block.rest) {
    if (!block.rest.startsWith('[') || !block.rest.endsWith(']')) return text;
    const values = splitFlowItems(block.rest.slice(1, -1))
      .map(item => unquoteYamlValue(stripYamlComment(item).trim()))
      .filter(Boolean);
    if (values.includes(key)) return text;
    const indent = ' '.repeat(block.keyIndent);
    const itemIndent = ' '.repeat(block.keyIndent + 2);
    lines.splice(block.start, block.end - block.start,
      `${indent}networks:`,
      ...values.map(value => `${itemIndent}- ${yamlScalar(value)}`),
      `${itemIndent}- ${yamlScalar(key)}`);
    return lines.join('\n');
  }
  let firstChild = '';
  for (let i = block.start + 1; i < block.end; i++) {
    if (block.lines[i].trim() && !block.lines[i].trim().startsWith('#')) {
      firstChild = block.lines[i];
      break;
    }
  }
  const itemIndent = ' '.repeat(firstChild ? lineIndent(firstChild) : block.keyIndent + 2);
  if (firstChild && !/^-\s*/.test(firstChild.trim())) {
    for (let i = block.start + 1; i < block.end; i++) {
      const match = block.lines[i].trim().match(/^(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.-]+))\s*:/);
      if (match && (match[1] || match[2] || match[3]) === key) return text;
    }
    lines.splice(block.end, 0, `${itemIndent}${yamlScalar(key)}:`);
    return lines.join('\n');
  }
  const values = composeServiceSeqValues(text, serviceName, 'networks')
    .map(value => unquoteYamlValue(value));
  if (values.includes(key)) return text;
  lines.splice(block.end, 0, `${itemIndent}- ${yamlScalar(key)}`);
  return lines.join('\n');
}

function setComposeDefaultNetworkName(composeText, network) {
  const text = String(composeText || '');
  const name = String(network || '').trim();
  if (!text.trim() || !name) return text;
  const info = composeNetworkInfo(text);
  if (info.inline || info.start < 0) return text;
  const def = (info.defs || []).find(item => item.key === 'default');
  if (!def) return text;
  const lines = info.lines;
  const entryRest = (parseNetworkEntryLine(lines[def.start]) || {}).rest || '';
  const inline = parseInlineYamlMapping(entryRest);
  if (inline) {
    if (!def.external && !inline.name) return text;
    if (String(inline.name || '').trim() === name) return text;
    const body = Object.entries({ ...inline, name }).map(([key, value]) => {
      const raw = String(value ?? '');
      const rendered = /^(?:true|false|null|~)$/i.test(raw) ? raw : formatYamlKey(raw);
      return `${formatYamlKey(key)}: ${rendered}`;
    }).join(', ');
    const prefix = lines[def.start].match(/^([ \t]*(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^:#]+?)[ \t]*:[ \t]*)/);
    const comment = (String(lines[def.start]).match(/[ \t]+#.*$/) || [''])[0];
    if (prefix) lines[def.start] = `${prefix[1]}{ ${body} }${comment}`;
    return lines.join('\n');
  }
  let nameLine = -1;
  let childIndent = null;
  for (let i = def.start + 1; i < def.end; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (childIndent === null) childIndent = lineIndent(line);
    const prop = line.match(/^([ \t]+)([A-Za-z0-9_.-]+)[ \t]*:[ \t]*(.*)$/);
    if (prop && prop[2] === 'name') { nameLine = i; break; }
  }
  if (!def.external && nameLine < 0) return text;
  if (nameLine >= 0) {
    const line = lines[nameLine];
    const prop = line.match(/^([ \t]*name[ \t]*:[ \t]*)(.*)$/);
    if (!prop || unquoteYamlValue(stripYamlComment(prop[2]).trim()) === name) return text;
    const comment = (String(line).match(/[ \t]+#.*$/) || [''])[0];
    lines[nameLine] = `${prop[1]}${formatYamlKey(name)}${comment}`;
    return lines.join('\n');
  }
  const indent = ' '.repeat((childIndent === null ? lineIndent(lines[def.start]) : childIndent) + 2);
  let insertAt = def.start + 1;
  for (let i = def.start + 1; i < def.end; i++) {
    if (/^[ \t]*external[ \t]*:/.test(lines[i])) { insertAt = i + 1; break; }
  }
  lines.splice(insertAt, 0, `${indent}name: ${formatYamlKey(name)}`);
  return lines.join('\n');
}

// Dok apps always join the configured default network (normally `wicked`).
// Defining it as Compose's external `default` network attaches every service
// that does not opt into a custom network and keeps the compose portable. When
// a service is named, its existing explicit network list also gets `default`
// so a routed app cannot be left outside nginx-proxy's network.
function ensureComposeDokNetwork(composeText, network = 'wicked', serviceName = '') {
  const text = String(composeText || '').replace(/\r\n/g, '\n');
  if (!text.trim()) return text;
  const name = String(network || 'wicked').trim() || 'wicked';
  let result = text;
  let networkKey = 'default';
  let attachService = true;
  const lines = text.split('\n');
  const networksLine = lines.findIndex(line => /^networks\s*:\s*(?:#.*)?$/.test(line));
  if (networksLine < 0) {
    // An inline top-level networks mapping cannot be edited safely line by
    // line; leave it untouched rather than emitting a duplicate key.
    if (/^networks\s*:/m.test(text)) attachService = false;
    else {
      result = text.replace(/\s*$/, '') +
        `\n\nnetworks:\n  default:\n    name: ${yamlScalar(name)}\n    external: true\n`;
    }
  } else {
    let end = lines.length;
    for (let i = networksLine + 1; i < lines.length; i++) {
      if (!lines[i].trim() || lines[i].trim().startsWith('#')) continue;
      if (lineIndent(lines[i]) === 0) { end = i; break; }
    }
    let childIndent = null;
    const keys = new Set();
    for (let i = networksLine + 1; i < end; i++) {
      const line = lines[i];
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const indent = lineIndent(line);
      if (childIndent === null) childIndent = indent;
      if (indent !== childIndent) continue;
      const match = line.trim().match(/^(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.-]+))\s*:/);
      if (match) keys.add(match[1] || match[2] || match[3]);
    }
    if (keys.has('default')) {
      networkKey = 'default';
      result = setComposeDefaultNetworkName(result, name);
    } else if (keys.has(name)) {
      networkKey = name;
    } else {
      const indent = ' '.repeat(childIndent === null ? 2 : childIndent);
      const propIndent = indent + '  ';
      lines.splice(end, 0,
        `${indent}default:`,
        `${propIndent}name: ${yamlScalar(name)}`,
        `${propIndent}external: true`);
      result = lines.join('\n');
    }
  }
  if (serviceName && attachService) result = ensureComposeServiceNetwork(result, serviceName, networkKey);
  return result;
}

// When nginx-proxy is installed the routed service is reached over the shared
// network. Publishing a host port is unnecessary and causes collisions, so the
// service keeps only VIRTUAL_PORT and its published mappings are removed.
function routedServiceFromCompose(composeText, preferred = '') {
  const services = serviceNamesFromCompose(composeText);
  const wanted = String(preferred || '').trim();
  if (wanted && services.includes(wanted)) {
    const host = composeServiceEnvValue(composeText, wanted, 'VIRTUAL_HOST');
    if (host) return { service: wanted, host };
  }
  const routed = services.find(name => composeServiceEnvValue(composeText, name, 'VIRTUAL_HOST'));
  if (routed) return { service: routed, host: composeServiceEnvValue(composeText, routed, 'VIRTUAL_HOST') };
  return { service: wanted && services.includes(wanted) ? wanted : (services[0] || ''), host: '' };
}

function applyNginxRoutingPolicy(compose, {
  service = '', vhost = '', vhostPort = '', fallbackPort = 80, removePorts = true, network = ''
} = {}) {
  const services = serviceNamesFromCompose(compose);
  const routed = routedServiceFromCompose(compose, service);
  const serviceName = routed.service || services[0] || '';
  if (!serviceName) return { compose, changed: false, service: '', vhost: '', vhostPort: '' };
  const host = String(vhost || '').trim() || routed.host || composeServiceEnvValue(compose, serviceName, 'VIRTUAL_HOST');
  if (!host) return { compose, changed: false, service: serviceName, vhost: '', vhostPort: '' };
  const port = composeVhostPortForService(compose, serviceName, vhostPort, fallbackPort);
  let next = setComposeServiceEnv(compose, serviceName, { VIRTUAL_HOST: host, VIRTUAL_PORT: port });
  if (removePorts) next = removeComposeServiceKey(next, serviceName, 'ports');
  if (network) next = ensureComposeDokNetwork(next, network, serviceName);
  return { compose: next, changed: next !== compose, service: serviceName, vhost: host, vhostPort: port };
}

function coreServiceUrl(domain, port) {
  const clean = normalizeDomain(domain);
  return clean ? `http://${clean}` : `http://localhost:${port}`;
}

let selfInfoCache = { at: 0, info: null };

async function selfContainerInfo() {
  if (selfInfoCache.info && Date.now() - selfInfoCache.at < 5000) return selfInfoCache.info;
  try {
    const containers = await docker.listContainers({ all: true });
    const matches = containers.filter(c => (c.Names || []).some(n => {
      const name = n.replace(/^\//, '');
      return /wickedafdok/i.test(name) && !/updater|helper|maintenance/i.test(name);
    }));
    const self = matches.find(c => (c.Names || []).some(n => n.replace(/^\//, '') === 'wickedafdok')) || matches[0];
    if (self?.Id) {
      const info = await docker.getContainer(self.Id).inspect();
      selfInfoCache = { at: Date.now(), info };
      return info;
    }
  } catch {}
  return null;
}

async function selfMountSource(destination) {
  const info = await selfContainerInfo();
  const mounts = info?.Mounts || [];
  const exact = mounts.find(m => m.Destination === destination);
  if (exact && exact.Type === 'bind' && exact.Source) return exact.Source;
  const parent = mounts
    .filter(m => destination.startsWith(m.Destination + '/') && m.Type === 'bind' && m.Source)
    .sort((a, b) => b.Destination.length - a.Destination.length)[0];
  if (parent) return path.join(parent.Source, destination.slice(parent.Destination.length + 1));
  return null;
}

async function selfMountRef(destination) {
  const info = await selfContainerInfo();
  const mounts = info?.Mounts || [];
  const exact = mounts.find(m => m.Destination === destination);
  if (!exact) return null;
  if (exact.Type === 'bind' && exact.Source) return exact.Source;
  if (exact.Type === 'volume' && exact.Name) return exact.Name;
  return null;
}

async function selfContainerImage() {
  const info = await selfContainerInfo();
  if (info?.Config?.Image) return info.Config.Image;
  try {
    const containers = await docker.listContainers({ all: true });
    const self = containers.find(c => (c.Names || []).some(n => {
      const name = n.replace(/^\//, '');
      return /wickedafdok/i.test(name) && !/updater|helper|maintenance/i.test(name);
    }));
    if (self?.Image) return self.Image;
  } catch {}
  return process.env.WICKEDAFDOK_IMAGE || 'wickedafdok:latest';
}

function maintenanceToken({ create = true } = {}) {
  try {
    const token = fs.readFileSync(maintenanceTokenPath, 'utf-8').trim();
    if (token) return token;
  } catch {}
  if (!create) return '';
  const token = randomSecret(24);
  try {
    writePrivateFile(maintenanceTokenPath, token);
    fs.chmodSync(maintenanceTokenPath, 0o600);
  } catch {}
  return token;
}

function maintenanceHostPort() {
  const value = Number(process.env.MAINTENANCE_PORT);
  return Number.isInteger(value) && value > 0 ? value : 8090;
}

async function maintenanceHostCheckout() {
  const info = await selfContainerInfo();
  const sourceMount = (info?.Mounts || []).find(m => m.Destination === '/app/host-source' && m.Type === 'bind' && m.Source);
  if (!sourceMount?.Source || !looksLikeDokCheckout('/app/host-source')) return null;
  return path.normalize(sourceMount.Source);
}

function maintenanceStorageHostPath(checkout) {
  const configured = String(process.env.DOK_STORAGE_ROOT || '').trim();
  if (configured && path.isAbsolute(configured)) return path.normalize(configured);
  try {
    const stored = String(defaultsDefaults(readSettings().defaults || {}).storageRoot || '').trim();
    if (stored && path.isAbsolute(stored)) return path.normalize(stored);
  } catch {}
  const resolved = path.resolve(String(checkout || ''));
  return resolved;
}

// After installation every Dok-owned directory lives under <data location>/Dok,
// so Maintenance data belongs at <storage root>/maintenance. Before an install
// the storage root is still the checkout; in that case setup.sh's sibling
// <checkout>-maintenance-data store is kept. MAINTENANCE_DATA_PATH is only
// authoritative while the storage root has not moved, otherwise a stale
// override from setup.sh would keep writing outside the Dok directory.
function maintenanceDataHostPath(checkout) {
  const resolvedCheckout = path.resolve(String(checkout || ''));
  const storage = maintenanceStorageHostPath(checkout);
  if (storage && storage !== resolvedCheckout) {
    return path.join(storage, 'maintenance');
  }
  const configured = String(process.env.MAINTENANCE_DATA_PATH || '').trim();
  if (configured && path.isAbsolute(configured)) return path.normalize(configured);
  return `${resolvedCheckout.replace(/[/\\]+$/, '')}-maintenance-data`;
}

function maintenanceComposeText({ checkout, storageRoot, image, installationId: id, hostPort, uid, gid, socket }) {
  const dataPath = maintenanceDataHostPath(checkout);
  const storage = storageRoot || maintenanceStorageHostPath(checkout);
  const lines = [
    '# managed-by: wickedafdok',
    'name: wickedafdok-maintenance',
    '',
    'services:',
    '  maintenance:',
    `    image: ${yamlScalar(image)}`,
    `    container_name: ${maintenanceContainer}`,
    '    restart: "no"',
    '    privileged: true',
    '    working_dir: /app',
    '    command: ["node", "/app/maintenance/server.js"]',
    '    environment:',
    `      - ${yamlScalar(`DOK_HOST_PATH=${checkout}`)}`,
    `      - ${yamlScalar(`DOK_STORAGE_HOST_PATH=${storage}`)}`,
    '    ports:',
    `      - ${yamlScalar(`${hostPort}:8090`)}`,
    '    volumes:',
    `      - ${yamlScalar(`${socket}:/var/run/docker.sock`)}`,
    `      - ${yamlScalar(`${checkout}:/dok-source`)}`,
    `      - ${yamlScalar(`${storage}:/dok`)}`,
    ...(checkout === '/dok-source' ? [] : [`      - ${yamlScalar(`${checkout}:${checkout}`)}`]),
    ...(storage === '/dok' ? [] : [`      - ${yamlScalar(`${storage}:${storage}`)}`]),
    `      - ${yamlScalar(`${dataPath}:/maintenance-data`)}`,
    '      - type: bind',
    '        source: /',
    '        target: /host',
    '        bind:',
    '          propagation: rslave',
    '    environment:',
    '      - DOK_ROOT=/dok',
    '      - DOK_SOURCE_ROOT=/dok-source',
    `      - ${yamlScalar(`DOK_STORAGE_HOST_PATH=${storage}`)}`,
    '      - MAINTENANCE_DATA=/maintenance-data',
    `      - ${yamlScalar(`MAINTENANCE_DATA_HOST_PATH=${dataPath}`)}`,
    '      - HOST_ROOT=/host',
    `      - ${yamlScalar(`DOK_HOST_PATH=${checkout}`)}`,
    '      - DOK_CONTAINER=wickedafdok',
    `      - ${yamlScalar(`DOK_PORT=${Number(process.env.PORT) || 8080}`)}`,
    `      - ${yamlScalar(`DOCKER_SOCK=${socket}`)}`,
    `      - ${yamlScalar(`DOK_UID=${uid}`)}`,
    `      - ${yamlScalar(`DOK_GID=${gid}`)}`,
    `      - ${yamlScalar(`MAINTENANCE_PORT=8090`)}`,
    `      - ${yamlScalar(`MAINTENANCE_URL=http://localhost:${hostPort}`)}`,
    '      - MAINTENANCE_REQUIRE_TOKEN=1',
    '      - MAINTENANCE_TOKEN_FILE=/dok/data/.maintenance-token',
    '      - OPENCODE_BIN=/usr/local/bin/opencode',
    '    networks:',
    '      - wicked',
    '    labels:',
    '      - dok.managed=true',
    '      - dok.maintenance=true',
    '      - dok.role=maintenance',
    `      - ${yamlScalar(`dok.installation=${id}`)}`,
    '    healthcheck:',
    '      test: ["CMD", "curl", "-fsS", "http://localhost:8090/api/health"]',
    '      interval: 15s',
    '      timeout: 5s',
    '      retries: 5',
    '      start_period: 15s',
    '',
    'networks:',
    '  wicked:',
    '    external: true',
    '    name: wicked',
    ''
  ];
  return lines.join('\n');
}

async function ensureMaintenanceCompose() {
  const checkout = await maintenanceHostCheckout();
  if (!checkout) {
    throw httpError(409, 'The Dok checkout is not available on the host. Run sudo ./setup.sh to configure the Maintenance container.');
  }
  let socket = process.env.DOCKER_SOCK || '/var/run/docker.sock';
  try {
    if (!/^[a-zA-Z0-9_./-]+$/.test(socket)) socket = '/var/run/docker.sock';
  } catch {}
  const image = await selfContainerImage();
  const id = ensureInstallationId();
  const token = maintenanceToken({ create: true });
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const gid = typeof process.getgid === 'function' ? process.getgid() : 0;
  const hostPort = maintenanceHostPort();
  const text = maintenanceComposeText({
    checkout, image, installationId: id, hostPort, uid, gid, socket
  });
  fs.mkdirSync(path.dirname(maintenanceComposePath), { recursive: true });
  writePrivateFile(maintenanceComposePath, text);
  // The store normally comes from setup.sh outside the checkout. An old Host
  // Helper can also create it with the right owner; without one, Docker will
  // create the bind source, and Maintenance (which runs privileged) migrates
  // any legacy data on start.
  const dataPath = maintenanceDataHostPath(checkout);
  try {
    if (await hostHelperAvailable()) await hostMkdir(dataPath, { mode: 0o700 });
  } catch {}
  return { composePath: maintenanceComposePath, checkout, image, hostPort, token, id, dataPath };
}

async function maintenanceContainerInfo() {
  try {
    return await docker.getContainer(maintenanceContainer).inspect();
  } catch {
    return null;
  }
}

async function waitForMaintenanceHelper(timeoutMs = 45000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      await hostHelperRequest('GET', '/ping', undefined, 1500);
      return true;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 750));
    }
  }
  return false;
}

async function ensureMaintenanceService({ wait = true, recreate = false } = {}) {
  const info = await maintenanceContainerInfo();
  if (info?.State?.Running && !recreate) {
    if (!wait || await waitForMaintenanceHelper(5000)) {
      return { started: false, running: true, already: true };
    }
    await docker.getContainer(maintenanceContainer).restart().catch(() => {});
  } else {
    // Recreate through the generated compose so mount changes (the relocated
    // Dok data root and Maintenance store) take effect on an existing container.
    try {
      const context = await ensureMaintenanceCompose();
      await ensureNetwork('wicked');
      const args = ['compose', '-p', 'wickedafdok-maintenance', '-f', context.composePath, 'up', '-d', '--remove-orphans'];
      if (recreate) args.push('--force-recreate');
      await run('docker', args, { cwd: root, timeout: 180000 });
    } catch (e) {
      if (!info) throw e;
      // A broken host-source mount must not lock the user out of an existing
      // Maintenance container; its updater can recover the checkout and repair
      // the mount from the host path recorded in its logs.
      console.warn(`Could not regenerate the Maintenance compose (${e.message}); starting the existing container.`);
      await docker.getContainer(maintenanceContainer).start();
    }
  }
  const ready = wait ? await waitForMaintenanceHelper(60000) : true;
  return { started: true, running: true, ready };
}

function maintenanceUrl(req) {
  const token = maintenanceToken({ create: true });
  const forwarded = String(req?.headers?.['x-forwarded-host'] || req?.headers?.host || '').split(',')[0].trim();
  let host = forwarded.replace(/:\d+$/, '') || 'localhost';
  if (host.startsWith('[') && host.includes(']')) host = host.slice(1, host.indexOf(']'));
  return `http://${host}:${maintenanceHostPort()}/?token=${encodeURIComponent(token)}`;
}

async function maintenanceStatus(req) {
  const info = await maintenanceContainerInfo();
  const running = info?.State?.Running === true;
  let dataPath = '';
  try {
    const checkout = await maintenanceHostCheckout();
    if (checkout) dataPath = maintenanceDataHostPath(checkout);
  } catch {}
  return {
    installed: !!info,
    running,
    state: info?.State?.Status || (info ? 'stopped' : 'not created'),
    container: maintenanceContainer,
    url: running ? maintenanceUrl(req) : '',
    startUrl: maintenanceUrl(req),
    tokenRequired: true,
    port: maintenanceHostPort(),
    composePath: maintenanceComposePath,
    dataPath,
    image: info?.Config?.Image || ''
  };
}

function hostHelperCompose(settings = {}, image = '', tokenOverride = '', hostDataDir = '') {
  const helperImage = String(image || settings.image || '').trim() || 'wickedafdok:latest';
  const token = String(tokenOverride || '').trim() || hostHelperToken();
  const dataRef = String(hostDataDir || '').trim() || '../../data';
  return `# managed-by: wickedafdok
services:
  host-helper:
    image: ${yamlScalar(helperImage)}
    container_name: wickedafdok-host-helper
    restart: unless-stopped
    command: ${JSON.stringify(['node', '/app/server/host-agent.js'])}
    privileged: true
    network_mode: none
    environment:
      - ${yamlScalar('HOST_ROOT=/host')}
      - ${yamlScalar('HOST_AGENT_SOCKET=/app/data/host-helper/agent.sock')}
      - ${yamlScalar('HOST_AGENT_TOKEN=' + token)}
    volumes:
      - /:/host
      - ${yamlScalar(`${dataRef}:/app/data`)}
`;
}

function coreServiceDir(name) {
  return path.join(coreDir, name);
}

function coreServiceFile(name) {
  const dir = coreServiceDir(name);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'docker-compose.yml');
}

function prepareHostBindDirs(base, entries = []) {
  if (!base) return;
  for (const [name, mode] of entries) {
    try {
      const dir = path.join(base, name);
      fs.mkdirSync(dir, { recursive: true });
      if (mode) fs.chmodSync(dir, mode);
    } catch {}
  }
}

// Core-service containers are part of the WickedAFDok installation rather than
// user workloads. They are grouped automatically and protected from deletion
// unless the user explicitly confirms the container name.
const CORE_COMPOSE_PROJECTS = new Set([
  'nginx-proxy',
  'cloudflared',
  'authentik',
  'authelia',
  'technitium',
  'adguard',
  'mailpit',
  'stalwart',
  'wickedafdok-host-helper'
]);

const CORE_CONTAINER_NAMES = [
  'nginx-proxy',
  'cloudflared',
  'authelia',
  'technitium-dns',
  'adguard',
  'mailpit',
  'stalwart',
  'wickedafdok-host-helper',
  'wickedafdok-updater',
  'authentik-server',
  'authentik-worker',
  'authentik-postgresql',
  'authentik-redis'
];

function coreContainerInfo(container) {
  const name = String(container?.name || (container?.Names || [])[0] || '').replace(/^\//, '');
  const labels = container?.Labels || {};
  const project = labels['com.docker.compose.project'] || '';
  if (labels['dok.maintenance'] === 'true' || name === maintenanceContainer) {
    return { core: true, protected: true, self: false, role: 'Dok Maintenance' };
  }
  const selfName = /^wickedafdok(-|$)/.test(name) && !/updater|helper|maintenance/.test(name);
  if (selfName || project === 'wickedafdok') {
    return { core: true, protected: true, self: true, role: 'Dok' };
  }
  if (CORE_COMPOSE_PROJECTS.has(project) || CORE_CONTAINER_NAMES.includes(name)) {
    return { core: true, protected: true, self: false, role: project || 'Core service' };
  }
  return { core: false, protected: false, self: false, role: '' };
}

async function coreServiceStatus(project, { nameHint = '', primaryHint = '' } = {}) {
  let running = false;
  let exists = false;
  let state = 'not created';
  let containerId = null;
  let lookupFailed = false;
  try {
    const containers = await docker.listContainers({ all: true });
    const containerName = value => String(value || '').replace(/^\//, '');
    const matches = containers.filter(c => {
      const labels = c.Labels || {};
      if (labels['com.docker.compose.project'] === project) return true;
      // Match only the exact expected names. A substring match would treat an
      // unrelated app such as "my-nginx-proxy-test" as the core service.
      return (c.Names || []).some(n => {
        const name = containerName(n);
        return (nameHint && name === nameHint) || (primaryHint && name === primaryHint);
      });
    });
    if (matches.length) {
      exists = true;
      const primary = matches.find(c => (c.Names || []).some(n => primaryHint && n.replace(/^\//, '') === primaryHint))
        || matches.find(c => c.State === 'running')
        || matches[0];
      containerId = primary?.Id || null;
      state = primary?.State || matches[0].State;
      running = matches.some(c => c.State === 'running');
    }
  } catch {
    // Callers must distinguish "Docker says nothing exists" from "Docker could
    // not be asked": the former reopens the install view, while the latter
    // keeps the last known installed state to avoid a transient UI flip.
    lookupFailed = true;
  }
  return { exists, running, state, containerId, lookupFailed, containers: [] };
}

async function startNginxProxyWithPortFallback() {
  const dir = coreServiceDir('nginx-proxy');
  const composePath = path.join(dir, 'docker-compose.yml');
  let compose = readManagedCompose(composePath);
  if (!compose) throw httpError(404, 'nginx-proxy has not been created yet');
  const configured = readSettings().services?.nginxProxy || {};
  let httpPort = nginxProxyHttpPort(configured.httpPort);
  const managed = compose.startsWith('# managed-by: wickedafdok');
  if (managed && !nginxComposeHasHttpPort(compose, httpPort)) {
    const patched = setNginxComposeHttpPort(compose, httpPort);
    if (patched !== compose) {
      compose = patched;
      writePrivateFile(composePath, compose);
    }
  } else if (!managed) {
    httpPort = nginxComposeHttpPort(compose);
  }
  const usedHostPorts = await publishedHostPorts();
  let portFallback = false;
  let portFallbackFrom = 0;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const out = await run('docker', ['compose', '-f', composePath, '-p', 'nginx-proxy', 'up', '-d', '--remove-orphans'], { cwd: dir });
      if (httpPort !== nginxProxyHttpPort(configured.httpPort)) {
        const settings = readSettings();
        settings.services = settings.services || {};
        settings.services.nginxProxy = { ...(settings.services.nginxProxy || {}), httpPort };
        writeSettings(settings);
      }
      return { ...out, httpPort, portFallback, portFallbackFrom };
    } catch (e) {
      if (!nginxProxyPortConflict(e)) throw e;
      const previousPort = httpPort;
      const fallbackPort = attempt >= 10 ? 0 : nextNginxProxyHttpPort(httpPort, usedHostPorts);
      if (!fallbackPort) throw e;
      const patched = setNginxComposeHttpPort(compose, fallbackPort);
      if (patched === compose) throw e;
      usedHostPorts.add(previousPort);
      if (!portFallbackFrom) portFallbackFrom = previousPort;
      portFallback = true;
      httpPort = fallbackPort;
      compose = patched;
      appendServerLog('WARN', `nginx-proxy could not bind host port ${previousPort}; retrying on ${fallbackPort}`);
      writePrivateFile(composePath, compose);
    }
  }
}

async function coreServiceAction(service, action) {
  const dnsProvider = dnsProviderName(readSettings());
  const map = {
    'nginx-proxy': { dir: 'nginx-proxy', project: 'nginx-proxy' },
    cloudflared: { dir: 'cloudflared', project: 'cloudflared' },
    auth: { dir: 'auth', project: 'authentik' },
    authelia: { dir: 'authelia', project: 'authelia' },
    dns: { dir: 'dns', project: dnsProvider === 'adguard' ? 'adguard' : 'technitium' },
    mailpit: { dir: 'mailpit', project: 'mailpit' },
    stalwart: { dir: 'stalwart', project: 'stalwart' },
    'host-helper': { dir: 'host-helper', project: 'wickedafdok-host-helper' }
  };
  const target = map[service];
  if (!target) throw httpError(404, `Unknown core service: ${service}`);
  const dir = coreServiceDir(target.dir);
  const composePath = path.join(dir, 'docker-compose.yml');
  if (!fs.existsSync(composePath)) throw httpError(404, `${service} has not been created yet`);
  const args = ['compose', '-f', composePath, '-p', target.project];
  if (action === 'up' || action === 'start') args.push('up', '-d', '--remove-orphans');
  else if (action === 'stop') args.push('stop');
  else if (action === 'restart') args.push('restart');
  else throw httpError(400, `Unsupported action: ${action}`);
  if (service === 'nginx-proxy' && (action === 'up' || action === 'start')) {
    return startNginxProxyWithPortFallback();
  }
  if (service === 'nginx-proxy' && action === 'restart') {
    try {
      return await run('docker', args, { cwd: dir });
    } catch (e) {
      if (!nginxProxyPortConflict(e)) throw e;
      return startNginxProxyWithPortFallback();
    }
  }
  return run('docker', args, { cwd: dir });
}

// ---------- backups ----------
function backupId() {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `${stamp}-${Math.random().toString(36).slice(2, 7)}`;
}

function backupArchivePath(id) {
  return path.join(backupsDir, `${id}.tar.gz`);
}

function backupMetaPath(id) {
  return path.join(backupsDir, `${id}.json`);
}

function safeBackupLabel(value, fallback = 'backup') {
  const text = String(value || '').trim().replace(/[^A-Za-z0-9._ -]+/g, '-').replace(/\s+/g, ' ').slice(0, 80);
  return text || fallback;
}

function listBackups() {
  const items = [];
  let names = [];
  try { names = fs.readdirSync(backupsDir); } catch {}
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(backupsDir, name), 'utf-8'));
      if (!meta || !meta.id) continue;
      const archive = backupArchivePath(meta.id);
      if (!fs.existsSync(archive)) continue;
      items.push({ ...meta, archive, size: fs.statSync(archive).size });
    } catch {}
  }
  return items.sort((a, b) => String(b.created || '').localeCompare(String(a.created || '')));
}

function validateArchiveEntries(entries) {
  for (const entry of entries) {
    const clean = String(entry).replace(/\\/g, '/');
    if (!clean || clean === '.') continue;
    if (clean.startsWith('/') || clean.split('/').includes('..')) {
      throw httpError(400, 'The backup archive contains an unsafe path');
    }
  }
}

async function extractBackup(archivePath) {
  const temp = fs.mkdtempSync(path.join(tmpDir, 'restore-'));
  try {
    const list = await run('tar', ['-tzf', archivePath]);
    validateArchiveEntries(String(list.stdout || '').split('\n').filter(Boolean));
    await run('tar', ['-xzf', archivePath, '-C', temp]);
    let manifest = null;
    for (const candidate of [path.join(temp, 'backup.json'), path.join(temp, 'data', '.backup-manifest.json')]) {
      if (!fs.existsSync(candidate)) continue;
      try { manifest = JSON.parse(fs.readFileSync(candidate, 'utf-8')); } catch { manifest = null; }
      if (manifest) break;
    }
    if (!manifest) throw httpError(400, 'The archive does not contain backup metadata');
    return { temp, manifest };
  } catch (e) {
    try { fs.rmSync(temp, { recursive: true, force: true }); } catch {}
    throw e;
  }
}

function copyMerge(src, dest, { skip = [], preserveRoot = [], preserveRootEnv = false, root = true } = {}) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip.includes(entry.name)) continue;
    if (root && (preserveRoot.includes(entry.name) || (preserveRootEnv && /^\.env($|\.)/.test(entry.name)))) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyMerge(from, to, { root: false });
    else if (entry.isSymbolicLink()) {
      try {
        const link = fs.readlinkSync(from);
        try { fs.unlinkSync(to); } catch {}
        fs.symlinkSync(link, to);
      } catch {}
    } else {
      fs.copyFileSync(from, to);
    }
  }
}

async function restoreBackupArchive(archivePath, { overwrite = false } = {}) {
  const { temp, manifest } = await extractBackup(archivePath);
  try {
    const scope = manifest.scope === 'app' ? 'app' : manifest.scope === 'custom' ? 'custom' : 'full';
    if (scope === 'app') {
      const appName = projectName(manifest.appName || path.basename(manifest.appDir || ''), 'app');
      const sourceDir = path.join(temp, 'apps', appName);
      if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
        throw httpError(400, 'The app backup does not contain the app files');
      }
      const target = path.join(appsDir, appName);
      if (isSymlink(target)) throw httpError(400, 'Invalid app directory');
      let occupied = false;
      try { occupied = fs.existsSync(target) && fs.readdirSync(target).length > 0; } catch { occupied = true; }
      const preserveData = directoryHasEntries(path.join(target, 'data'));
      const preserveEnv = (() => {
        try { return fs.existsSync(target) && fs.readdirSync(target).some(name => /^\.env($|\.)/.test(name)); } catch { return false; }
      })();
      if (occupied && !overwrite) {
        const dataNote = preserveData
          ? ` Existing app data at ${path.join(target, 'data')} will be preserved and reused.`
          : '';
        const err = httpError(409, `An app named "${appName}" already exists. Confirm that you want to overwrite its app files.${dataNote}`);
        err.needsOverwrite = true;
        err.appName = appName;
        throw err;
      }
      clearAppDirectory(target, { preserveAppData: true });
      copyMerge(sourceDir, target, {
        preserveRoot: preserveData ? ['data'] : [],
        preserveRootEnv: preserveEnv
      });
      const registry = manifest.registry && typeof manifest.registry === 'object' ? manifest.registry : {};
      addRegistryEntry({
        ...registry,
        name: appName,
        path: target,
        appDir: target,
        composeFile: registry.composeFile || 'docker-compose.yml'
      });
      return {
        ok: true, scope, appName, manifest,
        reuseData: preserveData ? [path.join(target, 'data')] : [],
        message: preserveData
          ? `Restored ${appName}. Existing app data at ${path.join(target, 'data')} was preserved and will be reused.`
          : `Restored ${appName}.`
      };
    }

    const components = scope === 'custom'
      ? {
          data: manifest.components?.data !== false,
          apps: manifest.components?.apps !== false,
          core: manifest.components?.core !== false,
          sources: manifest.components?.sources !== false,
          logs: manifest.components?.data !== false && manifest.components?.logs === true
        }
      : { data: true, apps: true, core: true, sources: true, logs: manifest.includeLogs === true };

    if (!overwrite) {
      const message = scope === 'custom'
        ? 'Restoring this backup overwrites the selected sections. Confirm to continue.'
        : 'Restoring a full backup overwrites apps, core services, sources, and settings. Confirm to continue.';
      const err = httpError(409, message);
      err.needsOverwrite = true;
      err.scope = scope;
      throw err;
    }

    if (components.data) {
      const dataSource = path.join(temp, 'data');
      if (fs.existsSync(dataSource)) {
        const skip = ['backups', 'tmp', '.backup-manifest.json'];
        if (!components.logs) skip.push('logs');
        copyMerge(dataSource, dataDir, { skip });
        try { fs.rmSync(path.join(dataDir, 'host-helper', 'agent.sock'), { force: true }); } catch {}
      }
    }
    if (components.apps) {
      const appsSource = path.join(temp, 'apps');
      const selectedApps = Array.isArray(manifest.apps) ? manifest.apps.filter(Boolean) : [];
      if (selectedApps.length) {
        for (const appName of selectedApps) {
          const source = path.join(appsSource, appName);
          if (fs.existsSync(source)) copyMerge(source, path.join(appsDir, appName));
        }
      } else if (fs.existsSync(appsSource)) {
        copyMerge(appsSource, appsDir);
      }
    }
    if (components.core) {
      const coreSource = path.join(temp, 'core');
      const selectedCore = Array.isArray(manifest.core) ? manifest.core.filter(Boolean) : [];
      if (selectedCore.length) {
        for (const service of selectedCore) {
          const source = path.join(coreSource, service);
          if (fs.existsSync(source)) copyMerge(source, path.join(coreDir, service));
        }
      } else if (fs.existsSync(coreSource)) {
        copyMerge(coreSource, coreDir);
      }
    }
    if (components.sources) {
      const source = path.join(temp, 'sources');
      if (fs.existsSync(source)) copyMerge(source, path.join(root, 'sources'));
    }
    for (const json of fs.readdirSync(dataDir).filter(name => name.endsWith('.json'))) {
      try { fs.chmodSync(path.join(dataDir, json), 0o600); } catch {}
    }
    return { ok: true, scope, components, manifest };
  } finally {
    try { fs.rmSync(temp, { recursive: true, force: true }); } catch {}
  }
}

function writeBackupMeta(meta) {
  writeJson(backupMetaPath(meta.id), meta);
}

function backupCoreServices() {
  return [
    { name: 'nginx-proxy', label: 'nginx-proxy' },
    { name: 'cloudflared', label: 'cloudflared' },
    { name: 'auth', label: 'Authentik' },
    { name: 'dns', label: 'DNS (Technitium / AdGuard Home)' },
    { name: 'mailpit', label: 'Mailpit' },
    { name: 'stalwart', label: 'Stalwart Mail Server' },
    { name: 'host-helper', label: 'Host Helper' }
  ];
}

function backupOptions() {
  const apps = readRegistry().map(entry => ({
    id: entry.id,
    name: entry.name || entry.id,
    appName: projectName(entry.name || entry.id, 'app')
  }));
  const core = backupCoreServices()
    .filter(service => fs.existsSync(path.join(coreDir, service.name)))
    .map(service => ({ ...service }));
  return { apps, core, components: ['data', 'apps', 'core', 'sources', 'logs'] };
}

async function createBackup({
  name = '', scope = 'full', app = '', includeLogs = false,
  components = {}, selectedApps = [], selectedCore = []
} = {}) {
  const id = backupId();
  const isCustom = scope === 'custom';
  const label = safeBackupLabel(name, isCustom
    ? `Custom backup ${id}`
    : scope === 'app' ? `App backup ${id}` : `Full backup ${id}`);
  const created = new Date().toISOString();
  let manifest;
  if (scope === 'app') {
    const entry = readRegistry().find(item => item.id === app || item.name === app);
    if (!entry) throw httpError(404, `App not found: ${app}`);
    const appName = projectName(entry.name, 'app');
    const sourceDir = appDirFor(entry);
    if (!fs.existsSync(sourceDir)) throw httpError(404, `App directory not found for ${entry.name}`);
    const stage = fs.mkdtempSync(path.join(tmpDir, 'backup-'));
    try {
      fs.mkdirSync(path.join(stage, 'apps'), { recursive: true });
      copyMerge(sourceDir, path.join(stage, 'apps', appName));
      manifest = {
        version: 1, id, name: label, scope: 'app', appName, created,
        registry: { ...entry, name: appName, path: '', appDir: '', launch: entry.launch || {} }
      };
      fs.writeFileSync(path.join(stage, 'backup.json'), JSON.stringify(manifest, null, 2));
      await run('tar', ['-czf', backupArchivePath(id), '-C', stage, 'backup.json', 'apps']);
    } finally {
      try { fs.rmSync(stage, { recursive: true, force: true }); } catch {}
    }
  } else if (isCustom) {
    const selected = {
      data: components.data !== false,
      apps: components.apps !== false,
      core: components.core !== false,
      sources: components.sources !== false,
      logs: components.data !== false && (components.logs !== undefined ? components.logs === true : includeLogs === true)
    };
    if (!selected.data && !selected.apps && !selected.core && !selected.sources) {
      throw httpError(400, 'Choose at least one section to include in the backup');
    }

    const appsWanted = Array.isArray(selectedApps) ? selectedApps.map(String).filter(Boolean) : [];
    for (const wanted of appsWanted) {
      const entry = readRegistry().find(item => item.id === wanted || item.name === wanted || projectName(item.name || '', 'app') === wanted);
      if (!entry) throw httpError(400, `App not found: ${wanted}`);
    }
    const appNames = [];
    const appTargets = [];
    if (selected.apps) {
      for (const entry of readRegistry()) {
        const appName = projectName(entry.name || entry.id, 'app');
        if (appsWanted.length && !appsWanted.includes(entry.id) && !appsWanted.includes(entry.name) && !appsWanted.includes(appName)) continue;
        const rel = `apps/${appName}`;
        if (!fs.existsSync(path.join(root, rel))) continue;
        appNames.push(appName);
        appTargets.push(rel);
      }
      if (appsWanted.length && appNames.length !== new Set(appsWanted).size) {
        throw httpError(400, 'One or more selected app directories were not found');
      }
    }

    const knownCore = backupCoreServices().map(service => service.name);
    const coreWanted = Array.isArray(selectedCore) ? selectedCore.map(String).filter(Boolean) : [];
    const unknownCore = coreWanted.filter(name => !knownCore.includes(name));
    if (unknownCore.length) throw httpError(400, `Unknown core service: ${unknownCore.join(', ')}`);
    const coreNames = [];
    const coreTargets = [];
    if (selected.core) {
      for (const service of knownCore) {
        if (coreWanted.length && !coreWanted.includes(service)) continue;
        const rel = `core/${service}`;
        if (!fs.existsSync(path.join(root, rel))) continue;
        coreNames.push(service);
        coreTargets.push(rel);
      }
      if (coreWanted.length && coreNames.length !== new Set(coreWanted).size) {
        throw httpError(400, 'One or more selected core service directories were not found');
      }
    }

    const manifestPath = path.join(dataDir, '.backup-manifest.json');
    manifest = {
      version: 1, id, name: label, scope: 'custom', created,
      components: selected,
      includeLogs: selected.logs,
      apps: appNames,
      appsAll: selected.apps && !appsWanted.length,
      core: coreNames,
      coreAll: selected.core && !coreWanted.length
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });

    const args = ['-czf', backupArchivePath(id)];
    const targets = [];
    if (selected.data) {
      args.push('--exclude=data/backups', '--exclude=data/tmp', '--exclude=data/docker-config', '--exclude=data/host-helper/agent.sock');
      if (!selected.logs) args.push('--exclude=data/logs');
      targets.push('data');
    } else {
      // The manifest must travel with the archive even when data is excluded.
      targets.push('data/.backup-manifest.json');
    }
    targets.push(...appTargets, ...coreTargets);
    if (selected.sources) targets.push('sources');
    args.push(...targets);
    try {
      await run('tar', args, { cwd: root });
    } finally {
      try { fs.unlinkSync(manifestPath); } catch {}
    }
  } else {
    manifest = { version: 1, id, name: label, scope: 'full', created, includeLogs: includeLogs === true };
    const manifestPath = path.join(dataDir, '.backup-manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    const args = ['-czf', backupArchivePath(id),
      '--exclude=data/backups', '--exclude=data/tmp', '--exclude=data/docker-config',
      '--exclude=data/host-helper/agent.sock'];
    if (!includeLogs) args.push('--exclude=data/logs');
    args.push('data', 'apps', 'core', 'sources');
    try {
      await run('tar', args, { cwd: root });
    } finally {
      try { fs.unlinkSync(manifestPath); } catch {}
    }
  }
  const meta = { ...manifest, archive: backupArchivePath(id), size: fs.statSync(backupArchivePath(id)).size };
  try { fs.chmodSync(backupArchivePath(id), 0o600); } catch {}
  writeBackupMeta(meta);
  return meta;
}

function appDokLabels(name) {
  return {
    'dok.managed': 'true',
    'dok.created-by': 'dok',
    'dok.app': projectName(name, 'app'),
    'dok.installation': ensureInstallationId()
  };
}

function buildComposeOverride(services, {
  network = '', networks = [], networkMappings = [], vhost = '', vhostPort = '',
  clearVhost = false, vhostService = '', ports = [], volumeMappings = [], baseText = '',
  labels = {}
} = {}) {
  const lines = ['services:'];
  const base = String(baseText || '');
  const existingPorts = composePortsFromText(base);
  const extraPorts = ports.filter(p => !existingPorts.includes(String(p)));
  const selectedNetworks = [...new Set([network, ...(networks || [])].filter(n =>
    n && !['bridge', 'host', 'none', 'default'].includes(n)
  ))];
  const mappingMap = new Map();
  for (const mapping of networkMappings || []) {
    if (mapping?.key && mapping?.name) mappingMap.set(String(mapping.key), String(mapping.name));
  }
  for (const net of selectedNetworks) {
    if (!mappingMap.has(net)) mappingMap.set(net, net);
  }
  const volumeByService = new Map();
  for (const mapping of volumeMappings || []) {
    if (!mapping?.service || !mapping?.target || !mapping?.source) continue;
    if (!volumeByService.has(mapping.service)) volumeByService.set(mapping.service, []);
    volumeByService.get(mapping.service).push(mapping);
  }
  const targetVhostService = services.includes(vhostService) ? vhostService : services[0];

  const labelEntries = Object.entries(labels || {})
    .filter(([key, value]) => key && value !== undefined && value !== null && String(value) !== '');
  services.forEach((svc) => {
    lines.push(`  ${yamlScalar(svc)}:`);
    if (labelEntries.length) {
      lines.push('    labels:');
      for (const [key, value] of labelEntries) {
        lines.push(`      ${yamlScalar(key)}: ${yamlScalar(value)}`);
      }
    }
    if (selectedNetworks.length) {
      lines.push('    networks:');
      for (const net of selectedNetworks) lines.push(`      - ${yamlScalar(net)}`);
    }
    if (svc === targetVhostService && (vhost || clearVhost)) {
      lines.push('    environment:');
      if (clearVhost) {
        lines.push(`      ${yamlScalar('VIRTUAL_HOST')}: ""`);
        lines.push(`      ${yamlScalar('VIRTUAL_PORT')}: ""`);
      } else {
        lines.push(`      ${yamlScalar('VIRTUAL_HOST')}: ${yamlScalar(vhost)}`);
        lines.push(`      ${yamlScalar('VIRTUAL_PORT')}: ${yamlScalar(vhostPort || 80)}`);
      }
    }
    if (svc === targetVhostService && extraPorts.length) {
      lines.push('    ports:');
      for (const port of extraPorts) lines.push(`      - ${yamlScalar(port)}`);
    }
    const volumes = volumeByService.get(svc) || [];
    if (volumes.length) {
      lines.push('    volumes:');
      for (const mapping of volumes) {
        lines.push(`      - ${yamlScalar(`${mapping.source}:${mapping.target}${mapping.readOnly ? ':ro' : ''}`)}`);
      }
    }
  });

  if (mappingMap.size) {
    lines.push('networks:');
    for (const [key, name] of mappingMap) {
      lines.push(`  ${yamlScalar(key)}:`);
      lines.push('    external: true');
      lines.push(`    name: ${yamlScalar(name)}`);
    }
  }
  return lines.join('\n') + '\n';
}

function findComposeFile(dir) {
  return composeFiles.map(f => path.join(dir, f)).find(f => fs.existsSync(f)) || null;
}

const APP_REFERENCE_MAX_URL = 500;
const APP_REFERENCE_LABELS = [
  'org.opencontainers.image.source',
  'org.opencontainers.image.url',
  'org.opencontainers.image.documentation',
  'org.label-schema.vcs-url',
  'org.label-schema.url'
];

// App metadata only needs a single official repository or website link. Keep
// it to normal web URLs so the Apps tab never renders an unsafe scheme and the
// value cannot grow into a large blob in registry.json.
function sanitizeAppReferenceUrl(value) {
  let raw = String(value ?? '').trim().replace(/^git\+/i, '');
  if (!raw || raw.length > APP_REFERENCE_MAX_URL * 2) return '';
  const scp = raw.match(/^(?:git@|ssh:\/\/git@)([^:/]+)[:/](.+)$/i);
  if (scp) {
    raw = `https://${scp[1]}/${scp[2]}`;
  } else if (/^(?:github|gitlab|bitbucket):/i.test(raw)) {
    const [provider, ...rest] = raw.split(':');
    raw = `https://${provider.toLowerCase()}.com/${rest.join(':')}`;
  } else if (/^git:\/\//i.test(raw)) {
    raw = raw.replace(/^git:\/\//i, 'https://');
  } else if (/^ssh:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw);
      raw = `https://${parsed.hostname}${parsed.pathname}`;
    } catch {
      return '';
    }
  }
  raw = raw.replace(/\.git$/i, '');
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    if (!url.hostname || url.username || url.password) return '';
    if (url.href.length > APP_REFERENCE_MAX_URL) return '';
    return url.href;
  } catch {
    return '';
  }
}

function referenceUrlFromGitUrl(repo) {
  return sanitizeAppReferenceUrl(repo);
}

function referenceUrlFromMetadataText(text) {
  const source = String(text || '');
  for (const label of APP_REFERENCE_LABELS) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = source.match(new RegExp(`${escaped}\\s*[:=]\\s*["']?([^\\s"'#\\\\]+)`, 'i'));
    if (match) {
      const url = sanitizeAppReferenceUrl(match[1]);
      if (url) return url;
    }
  }
  return '';
}

function referenceUrlFromPackageData(data) {
  if (!data || typeof data !== 'object') return '';
  const candidates = [];
  if (typeof data.repository === 'string') candidates.push(data.repository);
  else if (data.repository && typeof data.repository === 'object') candidates.push(data.repository.url);
  if (data.homepage) candidates.push(data.homepage);
  for (const candidate of candidates) {
    const url = sanitizeAppReferenceUrl(candidate);
    if (url) return url;
  }
  return '';
}

function referenceUrlFromProjectFiles(dir) {
  const read = (name, limit = 1024 * 1024) => {
    try {
      const file = path.join(dir, name);
      if (!fs.existsSync(file) || fs.statSync(file).size > limit) return '';
      return fs.readFileSync(file, 'utf-8');
    } catch {
      return '';
    }
  };
  for (const name of ['package.json', 'composer.json']) {
    const text = read(name);
    if (!text) continue;
    try {
      const url = referenceUrlFromPackageData(JSON.parse(text));
      if (url) return url;
    } catch {}
  }
  const pyproject = read('pyproject.toml');
  if (pyproject) {
    for (const key of ['Homepage', 'Repository', 'Source', 'Documentation', 'Website']) {
      const match = pyproject.match(new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, 'im'));
      const url = match ? sanitizeAppReferenceUrl(match[1]) : '';
      if (url) return url;
    }
  }
  const cargo = read('Cargo.toml');
  if (cargo) {
    const section = cargo.match(/\[package\]([\s\S]*?)(?=\n\[|$)/);
    if (section) {
      for (const key of ['repository', 'homepage']) {
        const match = section[1].match(new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, 'im'));
        const url = match ? sanitizeAppReferenceUrl(match[1]) : '';
        if (url) return url;
      }
    }
  }
  for (const name of ['README.md', 'README.markdown', 'README.rst', 'README.txt']) {
    const text = read(name);
    if (!text) continue;
    for (const line of text.split(/\r?\n/)) {
      if (!/^\s*(?:[-*]\s*)?(?:\*\*)?(?:official\s+)?(?:website|site|homepage|source(?:\s+code)?|repository|documentation|docs)(?:\*\*)?\s*[:|-]\s*/i.test(line)) continue;
      const match = line.match(/https?:\/\/[^\s)>\]]+/i);
      if (!match) continue;
      const url = sanitizeAppReferenceUrl(match[0]);
      if (url && !/(?:img\.shields\.io|badge|github\.com\/[^/]+\/[^/]+\/actions|discord\.(?:gg|com))/i.test(url)) return url;
    }
  }
  for (const name of ['Dockerfile', 'Containerfile']) {
    const text = read(name);
    if (!text) continue;
    const url = referenceUrlFromMetadataText(text);
    if (url) return url;
  }
  return '';
}

function composeImageReferences(compose) {
  const images = [];
  for (const match of String(compose || '').matchAll(/^\s*image:\s*["']?([^"'#\s]+)/gm)) {
    const image = match[1];
    if (image && image !== 'scratch' && !images.includes(image)) images.push(image);
  }
  return images.slice(0, 5);
}

async function referenceUrlFromImages(images) {
  for (const image of images) {
    try {
      const info = await docker.getImage(image).inspect();
      const labels = info?.Config?.Labels || {};
      for (const label of APP_REFERENCE_LABELS) {
        const url = sanitizeAppReferenceUrl(labels[label]);
        if (url) return url;
      }
    } catch {}
  }
  return '';
}

async function detectAppReferenceUrl({ dirs = [], compose = '', fallbackUrl = '' } = {}) {
  for (const dir of [...new Set(dirs.filter(Boolean))]) {
    const url = referenceUrlFromProjectFiles(dir);
    if (url) return url;
  }
  const metadataUrl = referenceUrlFromMetadataText(compose);
  if (metadataUrl) return metadataUrl;
  const imageUrl = await referenceUrlFromImages(composeImageReferences(compose));
  if (imageUrl) return imageUrl;
  return sanitizeAppReferenceUrl(fallbackUrl);
}

function appDirFor(entry) {
  const name = projectName(entry?.name, 'app');
  if (entry?.appDir && isInsideApps(entry.appDir)) return entry.appDir;
  return path.join(appsDir, name);
}

function composeContainerNames(compose) {
  const names = {};
  let service = '';
  for (const line of String(compose || '').split('\n')) {
    const header = line.match(/^  ([A-Za-z0-9_.-]+):\s*(?:#.*)?$/);
    if (header) { service = header[1]; continue; }
    const value = line.match(/^\s+container_name:\s*['"]?([^'"#\s]+)/);
    if (value && service) names[service] = value[1];
  }
  return names;
}

function containerListNames(container) {
  return (container?.Names || []).map(name => String(name).replace(/^\//, ''));
}

function nextContainerRename(name, id, containers, reserved = new Set()) {
  const shortId = String(id || '').slice(0, 8);
  let nextName = `${name}-previous-${shortId}`;
  let suffix = 1;
  while (reserved.has(nextName) ||
    containers.some(c => containerListNames(c).includes(nextName))) {
    nextName = `${name}-previous-${shortId}-${suffix++}`;
  }
  reserved.add(nextName);
  return nextName;
}

// Builds the list of changes a deploy would make to existing containers so
// the UI can ask for approval before the system renames another app's
// container or recreates running instances.
async function inspectComposeAmendments(project, compose) {
  const desired = composeContainerNames(compose);
  let containers = [];
  try { containers = await docker.listContainers({ all: true }); } catch {}
  const own = containers.filter(c => c.Labels?.['com.docker.compose.project'] === project);
  const renames = [];
  const blocked = [];
  const reserved = new Set();
  for (const [service, containerName] of Object.entries(desired)) {
    const existing = containers.find(c => containerListNames(c).includes(containerName));
    if (!existing) continue;
    const labels = existing.Labels || {};
    if (labels['com.docker.compose.project'] === project) continue;
    const protection = coreContainerInfo({ name: containerName, Labels: labels });
    if (protection.protected) {
      blocked.push({
        service,
        name: containerName,
        project: labels['com.docker.compose.project'] || '',
        state: existing.State || '',
        image: existing.Image || ''
      });
      continue;
    }
    renames.push({
      service,
      from: containerName,
      to: nextContainerRename(containerName, existing.Id, containers, reserved),
      containerId: existing.Id,
      state: existing.State || '',
      project: labels['com.docker.compose.project'] || '',
      image: existing.Image || ''
    });
  }
  const instances = [
    ...own.map(container => {
      const name = containerListNames(container)[0] || container.Id.slice(0, 12);
      return {
        name,
        state: container.State || '',
        project,
        service: container.Labels?.['com.docker.compose.service'] || '',
        image: container.Image || '',
        action: 'recreate'
      };
    }),
    ...renames.map(rename => ({
      name: rename.from,
      state: rename.state,
      project: rename.project,
      service: rename.service,
      image: rename.image,
      action: 'rename',
      nextName: rename.to
    }))
  ];
  const changes = [
    ...renames.map(rename => `Rename container "${rename.from}"${rename.project ? ` (project ${rename.project})` : ''} to "${rename.to}".`),
    ...own.map(container => {
      const name = containerListNames(container)[0] || container.Id.slice(0, 12);
      return `Recreate or update "${name}" in project "${project}".`;
    })
  ];
  return {
    app: project,
    requiresApproval: renames.length > 0,
    blocked,
    renames,
    instances,
    changes
  };
}

// Compose refuses to start when a container_name already belongs to another
// container. Rename the stale container instead of deleting it, which keeps
// its data and makes the deploy succeed after the user approves the change.
async function resolveProjectNameConflicts(project, compose, plan = null) {
  const amendment = plan || await inspectComposeAmendments(project, compose);
  if (amendment.blocked.length) {
    const item = amendment.blocked[0];
    throw httpError(409,
      `"${item.name}" belongs to a protected core service and cannot be reused by ${project}. ` +
      'Change container_name in the compose file or remove the conflicting service first.');
  }
  const renamed = [];
  for (const rename of amendment.renames) {
    try {
      await docker.getContainer(rename.containerId).rename({ name: rename.to });
      renamed.push({ service: rename.service, from: rename.from, to: rename.to });
      appendServerLog('INFO', `Deploy renamed conflicting container ${rename.from} to ${rename.to}`);
    } catch (e) {
      throw httpError(409, `Unable to resolve the container name conflict for "${rename.from}": ${e.message}`);
    }
  }
  return renamed;
}

async function composeAction(entry, action, { allowStartupGrace = false, confirmAmend = false } = {}) {
  const name = projectName(entry?.name, 'app');
  let appDir = appDirFor(entry);
  if (isSymlink(appDir)) throw httpError(400, 'Invalid app directory');
  ensureWritableDirectory(appDir, { label: 'app directory' });
  if (!isInsideApps(appDir)) throw httpError(400, 'Invalid app directory');

  let composeFile = findComposeFile(appDir);
  if (!composeFile && entry?.appDir && fs.existsSync(entry.appDir)) {
    try { copySourceTree(entry.appDir, appDir, { preserveAppData: true }); } catch {}
    composeFile = findComposeFile(appDir);
  }
  if (!composeFile) throw new Error('This app has no compose file in its app directory');

  let renamed = [];
  let amendment = null;
  if (action === 'up' || action === 'start') {
    const defaultsCfg = configuredDefaults();
    const defaultNetwork = String(defaultsCfg.defaultNetwork || 'wicked').trim() || 'wicked';
    const selectedNetwork = String(entry?.launch?.network || '').trim();
    const ensureNames = [...new Set([defaultNetwork, 'wicked', selectedNetwork].filter(isUserNetworkName))];
    for (const netName of ensureNames) {
      try {
        await ensureNetwork(netName);
      } catch (e) {
        throw httpError(500, `Could not create the Docker network "${netName}": ${e.message}`);
      }
    }
    const networkNames = await dockerNetworkNames().catch(() => []);
    for (const netName of ensureNames) {
      if (!networkNames.includes(netName)) networkNames.push(netName);
    }
    const fallbackNetwork = selectedNetwork || defaultNetwork;
    let composeText = fs.readFileSync(composeFile, 'utf-8');
    const normalized = normalizeComposeNetworks(composeText, networkNames, fallbackNetwork);
    let nextComposeText = normalized.changed ? normalized.text : composeText;
    if (selectedNetwork) nextComposeText = setComposeDefaultNetworkName(nextComposeText, selectedNetwork);
    if (nextComposeText !== composeText) {
      writePrivateFile(composeFile, nextComposeText);
      composeText = nextComposeText;
    }
    const deployOverridePath = path.join(appDir, 'docker-compose.wickedafdok.yml');
    if (fs.existsSync(deployOverridePath)) {
      try {
        const overrideText = fs.readFileSync(deployOverridePath, 'utf-8');
        const normalizedOverride = normalizeComposeNetworks(overrideText, networkNames, fallbackNetwork);
        if (normalizedOverride.changed) writePrivateFile(deployOverridePath, normalizedOverride.text);
      } catch {}
    }
    amendment = await inspectComposeAmendments(name, composeText);
    if (amendment.blocked.length) {
      const item = amendment.blocked[0];
      throw httpError(409,
        `"${item.name}" belongs to a protected core service and cannot be reused by ${name}. ` +
        'Change container_name in the compose file or remove the conflicting service first.');
    }
    if (amendment.requiresApproval && !confirmAmend) {
      const err = httpError(409,
        `${entry?.name || name} would amend existing containers. Review the changes and approve them to continue.`);
      err.needsAmendApproval = true;
      err.amendments = amendment;
      err.appName = name;
      throw err;
    }
    renamed = await resolveProjectNameConflicts(name, composeText, amendment);
  }

  const args = ['compose', '-f', composeFile, '-p', name];
  const overridePath = path.join(appDir, 'docker-compose.wickedafdok.yml');
  if (fs.existsSync(overridePath)) args.push('-f', overridePath);
  if (action === 'up' || action === 'start') args.push('up', '-d', '--remove-orphans');
  else args.push(action);

  try {
    const { stdout, stderr } = await run('docker', args, { cwd: appDir });
    return { stdout, stderr, appDir, composeFile, renamed, amended: amendment?.requiresApproval ? amendment.changes : [], amendment };
  } catch (e) {
    if (allowStartupGrace) {
      // A build or a slow first start can fail the compose command while the
      // project containers are already being created. Treat that as "still
      // starting" instead of reporting a hard failure to the user.
      const containers = await docker.listContainers({ all: true }).catch(() => []);
      const projectContainers = containers.filter(c =>
        c.Labels?.['com.docker.compose.project'] === name &&
        ['created', 'running', 'restarting'].includes(c.State));
      if (projectContainers.length) {
        return {
          stdout: e.stdout || '', stderr: e.stderr || e.message || '',
          appDir, composeFile, renamed, amended: amendment?.requiresApproval ? amendment.changes : [], amendment,
          pending: true,
          message: `${entry?.name || name} is still starting.`
        };
      }
    }
    throw e;
  }
}

// ---------- system ----------
let lastCpu = null;
function cpuUsage() {
  const cpus = os.cpus();
  let idle = 0, total = 0;
  for (const cpu of cpus) {
    for (const type of Object.keys(cpu.times)) total += cpu.times[type];
    idle += cpu.times.idle;
  }
  const current = { idle, total };
  let percent = null;
  if (lastCpu && current.total > lastCpu.total) {
    const idleDelta = current.idle - lastCpu.idle;
    const totalDelta = current.total - lastCpu.total;
    percent = Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100));
  }
  lastCpu = current;
  return percent;
}

app.get('/api/system/stats', async (req, res) => {
  try {
    const cpus = os.cpus();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const cpuPercent = cpuUsage();

    let disk = null;
    try {
      const st = await fsp.statfs(dataDir);
      const total = st.blocks * st.bsize;
      const free = st.bavail * st.bsize;
      disk = { total, free, used: total - free, usedPercent: total ? ((total - free) / total) * 100 : 0, path: dataDir };
    } catch { /* ignore */ }

    let dockerInfo = { connected: false };
    try {
      const [info, containers, images] = await Promise.all([
        docker.info(),
        docker.listContainers({ all: true }),
        docker.listImages({ all: false })
      ]);
      const running = containers.filter(c => c.State === 'running').length;
      dockerInfo = {
        connected: true,
        version: info.ServerVersion,
        containersRunning: running,
        containersStopped: containers.length - running,
        containersTotal: containers.length,
        images: images.length,
        storageDriver: info.Driver,
        memoryLimit: info.MemTotal
      };
    } catch (e) {
      dockerInfo = { connected: false, error: e.message };
    }

    res.json({
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      release: os.release(),
      uptime: os.uptime(),
      cpus: cpus.length,
      cpuModel: cpus[0]?.model || '',
      cpuPercent,
      loadavg: os.loadavg(),
      memory: {
        total: totalMem,
        free: freeMem,
        used: usedMem,
        usedPercent: (usedMem / totalMem) * 100
      },
      disk,
      docker: dockerInfo,
      networkInterfaces: os.networkInterfaces()
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- containers ----------
app.get('/api/containers', async (req, res) => {
  try {
    const containers = await docker.listContainers({ all: true });
    res.json(containers.map(c => {
      const name = (c.Names && c.Names[0]) ? c.Names[0].replace(/^\//, '') : '';
      const protection = coreContainerInfo({ name, Labels: c.Labels || {} });
      return {
        id: c.Id,
        shortId: c.Id.substring(0, 12),
        name,
        image: c.Image,
        state: c.State,
        status: c.Status,
        ports: c.Ports || [],
        created: c.Created,
        running: c.State === 'running',
        project: c.Labels?.['com.docker.compose.project'] || '',
        service: c.Labels?.['com.docker.compose.service'] || '',
        ...protection
      };
    }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/containers/:id/:action(start|stop|restart|pause|unpause)', async (req, res) => {
  try {
    const cont = docker.getContainer(req.params.id);
    await cont[req.params.action]();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/containers/:id/exec', async (req, res) => {
  try {
    const { cmd = '/bin/sh' } = req.body;
    const args = String(cmd).split(/\s+/).filter(Boolean);
    if (args.length === 0) return res.status(400).json({ error: 'cmd required' });
    const { stdout, stderr } = await run('docker', ['exec', req.params.id, ...args]);
    res.json({ ok: true, stdout, stderr });
  } catch (e) {
    res.status(500).json({ error: e.message, stdout: e.stdout, stderr: e.stderr });
  }
});

app.get('/api/containers/:id/inspect', async (req, res) => {
  try {
    const cont = docker.getContainer(req.params.id);
    const info = await cont.inspect();
    res.json(info);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/containers/:id/update-check', async (req, res) => {
  try {
    const cont = docker.getContainer(req.params.id);
    const info = await cont.inspect();
    const image = info.Config.Image;
    const { stdout } = await run('docker', ['pull', image]);
    res.json({ ok: true, image, stdout });
  } catch (e) {
    res.status(500).json({ error: e.message, stdout: e.stdout, stderr: e.stderr });
  }
});

app.post('/api/containers/:id/redeploy', async (req, res) => {
  try {
    const cont = docker.getContainer(req.params.id);
    const info = await cont.inspect();
    const name = info.Name.replace(/^\//, '');
    const image = req.body.image || info.Config.Image;
    const env = req.body.env || info.Config.Env || [];
    const cmd = req.body.cmd || info.Config.Cmd || [];
    const binds = info.HostConfig.Binds || [];
    const portBindings = req.body.ports || info.HostConfig.PortBindings || {};
    const restart = req.body.restart || info.HostConfig.RestartPolicy?.Name || 'unless-stopped';
    await run('docker', ['pull', image]).catch(() => {});
    await cont.stop().catch(() => {});
    await cont.remove().catch(() => {});
    const args = ['run', '-d', '--name', name, '--restart', restart];
    for (const p of Object.keys(portBindings || {})) {
      const pb = portBindings[p];
      if (Array.isArray(pb) && pb[0]) {
        const host = pb[0].HostIp ? `${pb[0].HostIp}:` : '';
        args.push('-p', `${host}${pb[0].HostPort}:${p.replace(/\/.*$/, '')}/${p.includes('/') ? p.split('/')[1] : 'tcp'}`.replace(/:tcp$/, ''));
      }
    }
    for (const b of binds) args.push('-v', b);
    for (const e of env) args.push('-e', e);
    if (req.body.network) args.push('--net', req.body.network);
    args.push(image);
    if (Array.isArray(cmd) && cmd.length) args.push(...cmd);
    const { stdout, stderr } = await run('docker', args);
    res.json({ ok: true, stdout, stderr });
  } catch (e) {
    res.status(500).json({ error: e.message, stdout: e.stdout, stderr: e.stderr });
  }
});

app.post('/api/containers/:id/save-to-registry', async (req, res) => {
  try {
    const cont = docker.getContainer(req.params.id);
    const info = await cont.inspect();
    const containerName = info.Name.replace(/^\//, '');
    const appName = projectName(containerName, 'app');
    const networkMode = info.HostConfig?.NetworkMode || '';
    const network = !['bridge', 'host', 'none', 'default'].includes(networkMode) &&
      !networkMode.startsWith('container:') ? networkMode : '';
    const appDir = path.join(appsDir, appName);
    if (isSymlink(appDir)) throw httpError(400, 'Invalid app directory');
    ensureWritableDirectory(appDir, { label: 'app directory' });
    if (!isInsideApps(appDir)) throw httpError(400, 'Invalid app directory');
    fs.writeFileSync(path.join(appDir, 'docker-compose.yml'), containerToCompose(info, { serviceName: appName, network }));
    ensureDokAppLabels(appDir, appName);

    const entry = addRegistryEntry({
      type: 'compose',
      name: appName,
      containerId: req.params.id,
      image: info.Config?.Image || info.Image,
      appDir,
      path: appDir,
      composeFile: 'docker-compose.yml',
      launch: { mode: 'compose', name: appName, appDir, network }
    });
    res.json({ ok: true, entry });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/containers/:id', async (req, res) => {
  try {
    const cont = docker.getContainer(req.params.id);
    const info = await cont.inspect();
    const name = String(info.Name || '').replace(/^\//, '');
    const protection = coreContainerInfo({ name, Labels: info.Config?.Labels || {} });
    if (protection.protected) {
      const confirmName = String(req.body?.confirmName || req.query?.confirmName || '').trim();
      if (confirmName !== name) {
        return res.status(403).json({
          error: protection.core
            ? `"${name}" is a protected core service. Type the container name to confirm removal.`
            : `"${name}" is protected. Type the container name to confirm removal.`,
          protected: true,
          core: protection.core,
          name
        });
      }
    }
    await cont.remove({ force: true });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/containers/:id/logs', async (req, res) => {
  try {
    const tail = String(Math.min(Math.max(Number(req.query.tail) || 300, 1), 5000));
    const { stdout, stderr } = await run('docker', ['logs', '--tail', tail, '--timestamps', req.params.id]);
    res.json({ logs: (stdout || '') + (stderr || '') });
  } catch (e) {
    res.status(500).json({ error: e.message, logs: (e.stdout || '') + (e.stderr || '') });
  }
});

// ---------- images ----------
app.get('/api/images', async (req, res) => {
  try {
    const images = await docker.listImages({ all: false });
    res.json(images.map(img => ({
      id: img.Id,
      shortId: img.Id.replace('sha256:', '').substring(0, 12),
      repoTags: img.RepoTags || ['<none>:<none>'],
      size: img.Size,
      created: img.Created
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/images/remove', async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'id required' });
    const img = docker.getImage(id);
    await img.remove({ force: true });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/images/pull', async (req, res) => {
  try {
    const { image } = req.body;
    if (!image || !/^[a-zA-Z0-9][a-zA-Z0-9_.:/@-]*$/.test(image)) {
      return res.status(400).json({ error: 'Invalid image name' });
    }
    const { stdout, stderr } = await run('docker', ['pull', image]);
    res.json({ ok: true, stdout, stderr });
  } catch (e) {
    res.status(500).json({ error: e.message, stdout: e.stdout, stderr: e.stderr });
  }
});

// ---------- app creation ----------
function ensureAppAgentsFile() {
  try {
    const source = path.join(__dirname, 'app-agents.md');
    if (!fs.existsSync(source)) return;
    const content = fs.readFileSync(source, 'utf-8');
    const target = path.join(appsDir, 'AGENTS.md');
    if (fs.existsSync(target)) {
      try { if (fs.readFileSync(target, 'utf-8') === content) return; } catch {}
    }
    fs.writeFileSync(target, content, { mode: 0o644 });
    try { fs.chmodSync(target, 0o644); } catch {}
  } catch (e) {
    appendServerLog('WARN', `Could not write the OC Assist AGENTS.md contract: ${e.message}`);
  }
}

function cleanupAppPreviews() {
  try {
    for (const name of fs.readdirSync(appsDir)) {
      if (!name.startsWith('.preview-')) continue;
      const dir = path.join(appsDir, name);
      try {
        if (Date.now() - fs.statSync(dir).mtimeMs > 24 * 60 * 60 * 1000) {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      } catch {}
    }
  } catch {}
}

function launchAppDirectory(appName) {
  // Always stage previews in a disposable directory. Writing the preview
  // directly into apps/<name> makes finalize mistake its own preview for an
  // existing app and ask the user to overwrite a brand-new install.
  cleanupAppPreviews();
  ensureWritableDirectory(appsDir, { label: 'apps directory' });
  const preview = path.join(appsDir,
    `.preview-${appName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  ensureWritableDirectory(preview, { label: 'app preview directory' });
  if (!isInsideApps(preview)) throw httpError(400, 'Invalid app directory');
  return preview;
}

function prepareAppFromDirectory(sourceDir, appName, { mode = 'auto', appDir: requestedAppDir = '' } = {}) {
  const appDir = requestedAppDir || launchAppDirectory(appName);
  if (isSymlink(appDir)) throw httpError(400, 'Invalid app directory');
  ensureWritableDirectory(appDir, { label: 'app directory' });
  if (!isInsideApps(appDir)) throw httpError(400, 'Invalid app directory');
  try {
    copySourceTree(sourceDir, appDir, {
      preserveAppData: directoryHasEntries(path.join(appDir, 'data')) || fs.existsSync(path.join(appDir, '.env'))
    });
  } catch {}

  let compose = null;
  const composeFile = findComposeFile(sourceDir);
  const hasDockerfile = fs.existsSync(path.join(sourceDir, 'Dockerfile'));
  const useBuild = (mode === 'build' && hasDockerfile) || (!composeFile && hasDockerfile);
  const baseCompose = useBuild ? null : composeFile;
  if (baseCompose) {
    compose = fs.readFileSync(baseCompose, 'utf-8');
    fs.writeFileSync(path.join(appDir, 'docker-compose.yml'), compose);
  } else if (hasDockerfile) {
    compose = `# managed-by: wickedafdok\nservices:\n  ${yamlScalar(appName)}:\n    build: .\n    container_name: ${yamlScalar(appName)}\n    restart: unless-stopped\n`;
    fs.writeFileSync(path.join(appDir, 'docker-compose.yml'), compose);
  }
  return { appDir, compose };
}

app.post('/api/launch/run', async (req, res) => {
  try {
    const { command, name = null } = req.body || {};
    if (!command) return res.status(400).json({ error: 'command required' });
    if (!String(name || '').trim()) return res.status(400).json({ error: 'App title is required' });
    const networkNames = await launchNetworkNames();
    const baseConv = runCommandToCompose(command, name || undefined);
    const plan = planRunNetworks(baseConv, networkNames);
    const conv = runCommandToCompose(command, name || undefined, {
      networks: plan.networks,
      network: 'wicked'
    });
    const appName = conv.name;
    const appDir = launchAppDirectory(appName);
    fs.writeFileSync(path.join(appDir, 'docker-compose.yml'), conv.compose);
    const analysis = await analyzeCompose(conv.compose, {
      projectDir: appDir,
      networkNames: networkNamesForAnalysis(networkNames)
    });
    const referenceUrl = await detectAppReferenceUrl({ dirs: [appDir], compose: conv.compose });
    res.json({
      ok: true,
      needsConfig: true,
      type: 'run',
      appName,
      appDir,
      command,
      referenceUrl,
      compose: conv.compose,
      generatedCompose: conv.compose,
      ports: conv.ports.join(','),
      unsupported: baseConv.unsupported,
      vhost: conv.vhost,
      vhostPort: conv.vhostPort,
      vhostService: appName,
      networks: plan.networks.map(net => ({ key: net, name: net, external: true, missing: false })),
      missingNetworks: [],
      replacedNetworks: plan.replacedNetworks,
      missingVolumes: analysis.missingVolumes,
      issues: analysis.issues
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, stdout: e.stdout, stderr: e.stderr });
  }
});

app.post('/api/launch/compose', async (req, res) => {
  try {
    const { yaml, name } = req.body || {};
    const yamlText = String(yaml || '');
    if (!yamlText.trim()) return res.status(400).json({ error: 'yaml required' });
    if (!String(name || '').trim()) return res.status(400).json({ error: 'App title is required' });
    const services = serviceNamesFromCompose(yamlText);
    const proj = projectName(name || services[0] || `app-${Date.now()}`, 'app');
    const appDir = launchAppDirectory(proj);
    const networkNames = await launchNetworkNames();
    const normalized = normalizeComposeNetworks(yamlText, networkNames);
    const launchCompose = standardizeAppCompose(normalized.text, { networkNames });
    fs.writeFileSync(path.join(appDir, 'docker-compose.yml'), launchCompose);
    const analysis = await analyzeCompose(launchCompose, {
      projectDir: appDir,
      networkNames: networkNamesForAnalysis(networkNames)
    });
    const referenceUrl = await detectAppReferenceUrl({ dirs: [appDir], compose: launchCompose });
    res.json({
      ok: true,
      needsConfig: true,
      type: 'compose',
      appName: proj,
      appDir,
      fileName: 'docker-compose.yml',
      referenceUrl,
      yaml: launchCompose,
      compose: launchCompose,
      generatedCompose: launchCompose,
      ports: composePortsFromText(launchCompose).join(','),
      vhost: analysis.vhost,
      vhostPort: analysis.vhostPort,
      vhostService: analysis.vhostService,
      networks: analysis.networks,
      missingNetworks: analysis.missingNetworks,
      replacedNetworks: normalized.replacedNetworks,
      missingVolumes: analysis.missingVolumes,
      issues: analysis.issues
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, stdout: e.stdout, stderr: e.stderr });
  }
});

app.post('/api/launch/git', async (req, res) => {
  try {
    const { repo, name, branch = null } = req.body || {};
    if (!repo) return res.status(400).json({ error: 'repo required' });
    if (!String(name || '').trim()) return res.status(400).json({ error: 'App title is required' });
    if (!/^(https?:\/\/|git:\/\/|ssh:\/\/|git@)[^\s]+$/.test(repo)) {
      return res.status(400).json({ error: 'Repo must be an http(s), git, ssh, or git@ URL' });
    }
    if (branch && !/^[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(branch)) {
      return res.status(400).json({ error: 'Invalid branch name' });
    }
    const repoBase = path.basename(String(repo).replace(/[/\\]+$/, '')).replace(/\.git$/, '');
    const proj = projectName(name || repoBase, `git-${Date.now()}`);
    const dir = path.join(sourcesDir, proj);
    if (fs.existsSync(dir) && !isInsideDir(dir, sourcesDir)) {
      throw httpError(400, 'Invalid project directory');
    }
    if (!fs.existsSync(dir)) ensureWritableDirectory(sourcesDir, { label: 'sources directory' });
    const gitEnv = gitEnvironment(repo);
    if (fs.existsSync(path.join(dir, '.git'))) {
      await run('git', ['remote', 'set-url', 'origin', repo], { cwd: dir, env: gitEnv }).catch(() => {});
      await run('git', ['fetch', '--all', '--prune'], { cwd: dir, env: gitEnv }).catch(() => {});
      const target = branch ? `origin/${branch}` : 'HEAD';
      try {
        await run('git', ['reset', '--hard', target], { cwd: dir, env: gitEnv });
      } catch {
        if (branch) await run('git', ['reset', '--hard', branch], { cwd: dir, env: gitEnv }).catch(() => {});
      }
    } else if (fs.existsSync(dir)) {
      throw httpError(400, `Project "${proj}" already exists and is not a git checkout`);
    } else {
      const args = ['clone', '--depth', '1'];
      if (branch) args.push('--branch', branch);
      args.push(repo, dir);
      await run('git', args, { env: gitEnv });
    }

    if (!isInsideDir(dir, sourcesDir)) throw httpError(400, 'Invalid project directory');
    const hasCompose = !!findComposeFile(dir);
    const hasDockerfile = fs.existsSync(path.join(dir, 'Dockerfile'));
    if (!hasCompose && !hasDockerfile) {
      return res.json({
        ok: true,
        needsConfig: false,
        toProjects: true,
        path: dir,
        appName: proj,
        type: 'git',
        message: 'No compose file or Dockerfile found; the clone is available in Projects.'
      });
    }

    const { appDir, compose } = prepareAppFromDirectory(dir, proj);
    const networkNames = await launchNetworkNames();
    const normalized = normalizeComposeNetworks(compose || '', networkNames);
    const launchCompose = standardizeAppCompose(normalized.text, { networkNames });
    if (launchCompose.trim()) fs.writeFileSync(path.join(appDir, 'docker-compose.yml'), launchCompose);
    const analysis = await analyzeCompose(launchCompose, {
      projectDir: appDir,
      networkNames: networkNamesForAnalysis(networkNames)
    });
    const referenceUrl = await detectAppReferenceUrl({
      dirs: [dir, appDir],
      compose: launchCompose,
      fallbackUrl: referenceUrlFromGitUrl(repo)
    });
    res.json({
      ok: true,
      needsConfig: true,
      path: dir,
      appDir,
      appName: proj,
      type: 'git',
      sourcePath: dir,
      sourceRel: proj,
      referenceUrl,
      compose: launchCompose,
      generatedCompose: launchCompose,
      ports: launchCompose ? composePortsFromText(launchCompose).join(',') : '',
      vhost: analysis.vhost,
      vhostPort: analysis.vhostPort,
      vhostService: analysis.vhostService,
      networks: analysis.networks,
      missingNetworks: analysis.missingNetworks,
      replacedNetworks: normalized.replacedNetworks,
      missingVolumes: analysis.missingVolumes,
      issues: analysis.issues
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, stdout: e.stdout, stderr: e.stderr });
  }
});

app.post('/api/launch/upload', upload.array('files', 200), async (req, res) => {
  const movedFiles = [];
  try {
    const { name, paths: rawPaths } = req.body || {};
    if (!String(name || '').trim()) {
      for (const file of req.files || []) {
        try { fs.rmSync(file.path, { force: true }); } catch {}
      }
      return res.status(400).json({ error: 'App title is required' });
    }
    let paths = [];
    try {
      const parsed = rawPaths ? JSON.parse(rawPaths) : [];
      if (Array.isArray(parsed)) paths = parsed;
    } catch { paths = []; }
    const files = req.files || [];
    paths = files.map((file, i) => {
      const value = paths[i];
      return value === undefined || value === null || value === ''
        ? (file.originalname || path.basename(file.path))
        : String(value);
    });
    if (paths.length) {
      const roots = paths.map(p => String(p).split(/[\\/]/)[0]);
      if (roots.every(r => r === roots[0])) {
        paths = paths.map(p => {
          const parts = String(p).split(/[\\/]/);
          return parts.length > 1 ? parts.slice(1).join('/') : parts[0];
        });
      }
    }
    const proj = projectName(name, `upload-${Date.now()}`);
    const dir = path.join(sourcesDir, proj);
    if (fs.existsSync(dir) && !fs.statSync(dir).isDirectory()) {
      throw httpError(400, `Project "${proj}" exists and is not a directory`);
    }
    ensureWritableDirectory(dir, { label: 'upload directory' });
    if (!isInsideDir(dir, sourcesDir)) throw httpError(400, 'Invalid upload destination');
    const base = fs.realpathSync(dir);
    const insideBase = (p) => p === base || p.startsWith(base + path.sep);
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const rel = paths[i] || file.originalname || path.basename(file.path);
      const discard = () => { try { fs.rmSync(file.path, { force: true }); } catch {} };
      if (String(rel).includes('\0')) {
        discard();
        continue;
      }
      const normalized = path.normalize(String(rel)).replace(/^(\.\.[/\\])+/, '');
      const dest = path.resolve(base, normalized);
      if (dest !== base && !insideBase(dest)) {
        discard();
        continue;
      }
      if (dest === base) {
        discard();
        continue;
      }
      const parent = path.dirname(dest);
      let existing = parent;
      const suffix = [];
      while (!fs.existsSync(existing)) {
        const up = path.dirname(existing);
        if (up === existing) break;
        suffix.unshift(path.basename(existing));
        existing = up;
      }
      let realExisting;
      let existingIsDir = false;
      try {
        realExisting = fs.realpathSync(existing);
        existingIsDir = fs.statSync(existing).isDirectory();
      } catch {
        discard();
        continue;
      }
      const resolvedParent = path.join(realExisting, ...suffix);
      if (!existingIsDir || !insideBase(resolvedParent)) {
        discard();
        continue;
      }
      try {
        fs.mkdirSync(parent, { recursive: true });
      } catch (e) {
        discard();
        if (['EACCES', 'EPERM', 'EROFS'].includes(e.code)) throw permissionDenied(parent, 'creating upload path');
        throw httpError(400, `Could not create upload path: ${e.message}`);
      }
      if (!isInsideDir(parent, base)) {
        discard();
        continue;
      }
      try {
        fs.renameSync(file.path, dest);
      } catch (e) {
        if (e.code === 'EXDEV') {
          fs.copyFileSync(file.path, dest);
          try { fs.unlinkSync(file.path); } catch {}
        } else {
          throw e;
        }
      }
      movedFiles.push(dest);
    }

    const hasCompose = !!findComposeFile(dir);
    const hasDockerfile = fs.existsSync(path.join(dir, 'Dockerfile'));
    if (!hasCompose && !hasDockerfile) {
      return res.json({
        ok: true,
        needsConfig: false,
        toProjects: true,
        path: dir,
        appName: proj,
        type: 'upload',
        count: movedFiles.length,
        message: 'No compose file or Dockerfile found; the upload is available in Projects.'
      });
    }

    const { appDir, compose } = prepareAppFromDirectory(dir, proj);
    const networkNames = await launchNetworkNames();
    const normalized = normalizeComposeNetworks(compose || '', networkNames);
    const launchCompose = standardizeAppCompose(normalized.text, { networkNames });
    if (launchCompose.trim()) fs.writeFileSync(path.join(appDir, 'docker-compose.yml'), launchCompose);
    const analysis = await analyzeCompose(launchCompose, {
      projectDir: appDir,
      networkNames: networkNamesForAnalysis(networkNames)
    });
    const referenceUrl = await detectAppReferenceUrl({ dirs: [dir, appDir], compose: launchCompose });
    res.json({
      ok: true,
      needsConfig: true,
      path: dir,
      appDir,
      appName: proj,
      type: 'upload',
      sourcePath: dir,
      sourceRel: proj,
      count: movedFiles.length,
      referenceUrl,
      compose: launchCompose,
      generatedCompose: launchCompose,
      ports: launchCompose ? composePortsFromText(launchCompose).join(',') : '',
      vhost: analysis.vhost,
      vhostPort: analysis.vhostPort,
      vhostService: analysis.vhostService,
      networks: analysis.networks,
      missingNetworks: analysis.missingNetworks,
      replacedNetworks: normalized.replacedNetworks,
      missingVolumes: analysis.missingVolumes,
      issues: analysis.issues
    });
  } catch (e) {
    for (const f of req.files || []) {
      if (!movedFiles.includes(f.path)) fs.rmSync(f.path, { force: true });
    }
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Create an app from an existing project under sources/
app.post('/api/launch/source', async (req, res) => {
  try {
    const { path: relPath, mode = 'auto', name, ports, command, vhost, vhostPort } = req.body || {};
    if (!relPath) return res.status(400).json({ error: 'path required' });
    if (!String(name || '').trim()) return res.status(400).json({ error: 'App title is required' });
    if (mode === 'run' && !String(command || '').trim()) {
      return res.status(400).json({ error: 'A docker run command is required for run mode' });
    }
    const dir = resolveSource(relPath);
    if (!fs.statSync(dir).isDirectory()) return res.status(400).json({ error: 'Not a directory' });
    if (dir === fs.realpathSync(sourcesDir)) {
      return res.status(400).json({ error: 'Choose a project folder, not the Projects root' });
    }
    const project = projectName(name, 'app');

    const hasCompose = !!findComposeFile(dir);
    const hasDockerfile = fs.existsSync(path.join(dir, 'Dockerfile'));
    if (!hasCompose && !hasDockerfile && !command) {
      return res.json({
        ok: true,
        needsConfig: false,
        toProjects: true,
        path: dir,
        appName: project,
        type: 'source',
        mode,
        message: 'No compose file or Dockerfile found; this project stays in Projects.'
      });
    }

    const { appDir, compose: baseCompose } = prepareAppFromDirectory(dir, project, { mode });
    const networkNames = await launchNetworkNames();
    let compose = baseCompose;
    let replacedNetworks = [];
    if ((mode === 'run' || !compose) && command) {
      const baseConv = runCommandToCompose(command, project);
      const plan = planRunNetworks(baseConv, networkNames);
      const conv = runCommandToCompose(command, project, {
        networks: plan.networks,
        network: 'wicked'
      });
      compose = conv.compose;
      replacedNetworks = plan.replacedNetworks;
      fs.writeFileSync(path.join(appDir, 'docker-compose.yml'), compose);
    } else if (compose) {
      const normalized = normalizeComposeNetworks(compose, networkNames);
      compose = standardizeAppCompose(normalized.text, { networkNames });
      replacedNetworks = normalized.replacedNetworks;
      fs.writeFileSync(path.join(appDir, 'docker-compose.yml'), compose);
    }
    const analysis = await analyzeCompose(compose, {
      projectDir: appDir,
      networkNames: networkNamesForAnalysis(networkNames)
    });
    const referenceUrl = await detectAppReferenceUrl({ dirs: [dir, appDir], compose });

    res.json({
      ok: true,
      needsConfig: true,
      path: dir,
      appDir,
      appName: project,
      type: 'source',
      mode,
      sourcePath: dir,
      sourceRel: path.relative(fs.realpathSync(sourcesDir), dir),
      referenceUrl,
      compose,
      generatedCompose: compose,
      ports: ports || (compose ? composePortsFromText(compose).join(',') : ''),
      vhost: normalizeDomain(vhost) || analysis.vhost,
      vhostPort: String(vhostPort || '').trim() || analysis.vhostPort,
      vhostService: analysis.vhostService,
      networks: analysis.networks,
      missingNetworks: analysis.missingNetworks,
      replacedNetworks,
      missingVolumes: analysis.missingVolumes,
      issues: analysis.issues
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, stdout: e.stdout, stderr: e.stderr });
  }
});


const assistStarts = new Set();

app.post('/api/assist/start', upload.array('files', 100), async (req, res) => {
  const tempFiles = (req.files || []).map(file => file.path);
  let started = false;
  let lockedName = '';
  try {
    const prompt = String(req.body?.prompt || '').trim();
    if (!prompt) throw httpError(400, 'Describe the app you want OC Assist to create');
    if (prompt.length > 20000) throw httpError(400, 'The prompt is too long (max 20000 characters)');
    const data = String(req.body?.data || '').trim();
    if (data.length > 200000) throw httpError(400, 'The pasted data is too long (max 200 KB)');
    const requestedName = String(req.body?.name || '').trim();
    if (!requestedName) throw httpError(400, 'App title is required');
    const info = await getOpencodeInfo();
    if (!info.installed) throw httpError(503, 'OpenCode is not installed in this container. Rebuild the WickedAFDok image and try again.');
    ensureAppAgentsFile();
    const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    // One-second resolution is not enough: two requests in the same second
    // would share an assist/upload directory and overwrite each other's brief.
    const unique = `${stamp}-${crypto.randomBytes(3).toString('hex')}`;
    const appName = projectName(requestedName, 'app');
    if (assistStarts.has(appName)) throw httpError(409, 'OC Assist is already preparing that app name');
    assistStarts.add(appName);
    lockedName = appName;
    const assistDir = path.join(opencodeDir, 'assist', unique);
    fs.mkdirSync(assistDir, { recursive: true });
    try { fs.chmodSync(assistDir, 0o700); } catch {}
    const uploadDir = path.join(sourcesDir, 'oc-assist-' + unique);
    const savedFiles = [];
    const files = Array.isArray(req.files) ? req.files : [];
    const paths = (() => {
      const raw = req.body?.paths;
      if (!raw) return [];
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.map(String) : [String(raw)];
      } catch {
        return [String(raw)];
      }
    })();
    if (files.length) {
      fs.mkdirSync(uploadDir, { recursive: true });
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const rel = String(paths[i] || file.originalname || path.basename(file.path)).replace(/^[/\\]+/, '');
        if (!rel || rel.includes('\0') || rel.split('/').includes('..')) {
          fs.rmSync(file.path, { force: true });
          continue;
        }
        const dest = path.resolve(uploadDir, rel);
        if (dest !== uploadDir && !dest.startsWith(uploadDir + path.sep)) {
          fs.rmSync(file.path, { force: true });
          continue;
        }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        try {
          fs.renameSync(file.path, dest);
        } catch (err) {
          if (err.code !== 'EXDEV') throw err;
          fs.copyFileSync(file.path, dest);
          fs.rmSync(file.path, { force: true });
        }
        tempFiles[i] = dest;
        savedFiles.push(dest);
      }
    }
    const briefPath = path.join(assistDir, 'brief.md');
    const defaultsCfg = configuredDefaults();
    const brief = [
      '# OC Assist app request',
      '',
      'App name: ' + appName,
      'Created: ' + new Date().toISOString(),
      '',
      '## Instructions',
      '',
      prompt,
      '',
      '## App library contract',
      '',
      'Follow ' + path.join(appsDir, 'AGENTS.md') + '. It defines the required layout, compose, routing, persistent-data, secrets, and library-export rules for every app.',
      '',
      '## Delivery rules',
      '',
      '- Use the required app title as the folder and compose project name.',
      '- The app must be complete, validated, and saved to the library in a functional, ready-to-launch state, but stopped. Never leave it running.',
      '- Include docker-compose.yml, a README, and .env.example when the app needs configuration. Keep user data under relative ./data paths and never reset it.',
      '- Use the publish command without --test to save it. Use --test only to verify that the app starts; the server stops it again before returning.',
      '- Always set VIRTUAL_PORT on the primary GUI service to the app\'s actual GUI container port, even when no domain was supplied. Inspect any repository/reference URL, README, compose files, Dockerfile EXPOSE lines, image docs, and default config to find the real port; for multi-port apps use the public web UI port, not a database, queue, metrics, or internal API port. Do not rely on Dok to infer it.',
      '- Identify the app\'s official repository or website from the user\'s reference data or upstream project metadata and pass it with --reference-url when publishing. Prefer the official source repository, homepage, or documentation site; omit the flag instead of inventing a link.',
      '- The user configures routing, paths, and secrets in the Dok compose editor before the real deploy from Apps. Dok can add VIRTUAL_HOST, ENABLE_AUTH, and certificate fields from the installed core services, so keep those installation-specific values portable unless the user supplied them.',
      '',
      '## Default admin account',
      '',
      'Username: ' + (defaultsCfg.adminUser || 'admin'),
      'Email: ' + (defaultsCfg.adminEmail || '_(not set)_'),
      'Password: use the default admin password from Dok Settings; ask the user if it is needed and never print it in chat.',
      '',
      '## Pasted data',
      '',
      data || '_(none)_',
      '',
      '## Uploaded files',
      '',
      savedFiles.length ? savedFiles.map(file => '- ' + file).join('\n') : '_(none)_',
      ''
    ].join('\n');
    writePrivateFile(briefPath, brief);
    const register = path.join(root, 'server', 'assist-register.mjs');
    const uploadedList = savedFiles.length
      ? 'Uploaded files:\n' + savedFiles.map(file => '- ' + file).join('\n')
      : 'Uploaded files: none';
    const dataPreview = data
      ? (data.length > 6000 ? data.slice(0, 6000) + '\n… (truncated; full text is in the brief)' : data)
      : '(none)';
    const startPrompt = [
      'OC Assist request for app "' + appName + '".',
      '',
      'User instructions:',
      prompt,
      '',
      'Pasted reference data:',
      dataPreview,
      '',
      uploadedList,
      '',
      'Brief: ' + briefPath,
      'App library contract: ' + path.join(appsDir, 'AGENTS.md'),
      'App directory: ' + path.join(appsDir, appName),
      'Default network: ' + (defaultsCfg.defaultNetwork || 'wicked'),
      '',
      'Read the app library contract before writing files. Build the app now. Create docker-compose.yml (and any needed files) in the app directory so it is complete, validated, and ready to launch after the user supplies installation-specific settings. Then save it to the library with:',
      'node ' + register + ' --name ' + appName + ' --dir ' + path.join(appsDir, appName),
      'Publishing saves the app stopped. If you need to verify it starts, rerun the command with --test; the server stops the app again and reports the container states. Never leave the app running.',
      'If publishing fails, read the error, fix the compose, and retry once.',
      'Always set VIRTUAL_PORT on the primary GUI service to the app GUI container port, even when the user did not supply a domain. Read any repository/reference link, README, compose files, Dockerfile EXPOSE lines, image docs, and default config to determine the port; for multi-port apps choose the public web UI port, not a database, queue, metrics, or internal API port. Do not guess and do not rely on Dok to infer it.',
      'Find the app\'s official repository or website from the supplied reference or upstream metadata. Prefer the official source repository, homepage, or documentation site. Add --reference-url <url> to the publish command when it is reliable; omit it rather than inventing a link.',
      'If the user supplied a domain, also set VIRTUAL_HOST on that same service (and LETSENCRYPT_HOST when requested), or pass --vhost and --vhost-port to the publish command.',
      'Use --network only when the app must join a specific existing Docker network.',
      'If the publish response asks for amendment approval (needsAmendApproval), summarize the listed containers and changes to the user and wait for approval before rerunning with --confirm-amend.',
      'If publishing reports reuseData or dataNotice, tell the user the app connects to existing app data and that it was not reset. Never delete or overwrite that data.',
      'Ask the user only when you genuinely need a domain, port, credential, or host path.',
      'When finished, tell the user the app is saved in the Apps tab and stopped. They must open Deploy to configure routing, ports, paths, and secrets, then deploy it.'
    ].join('\n');
    const chat = await createAssistChat({
      appName,
      prompt: startPrompt,
      title: 'OC Assist · ' + appName,
      briefPath,
      uploadDir: savedFiles.length ? uploadDir : ''
    });
    started = true;
    res.json({ ok: true, chat, appName, briefPath, uploadDir: savedFiles.length ? uploadDir : '' });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  } finally {
    if (!started) {
      for (const file of tempFiles) {
        try { fs.rmSync(file, { force: true }); } catch {}
      }
    }
    // The name lock only prevents two simultaneous starts; the session itself
    // owns the app from here.
    if (lockedName) assistStarts.delete(lockedName);
  }
});

// Finalize creation: everything is written into apps/<name> and managed by compose from there.
const finalizeLocks = new Map();

app.post('/api/launch/finalize', async (req, res) => {
  const body = req.body || {};
  const requestedTitle = String(body.appName || body.name || body.launch?.name || '').trim();
  if (!requestedTitle) {
    return res.status(400).json({ error: 'App title is required' });
  }
  const lockName = projectName(requestedTitle, 'app');
  if (finalizeLocks.has(lockName)) {
    return res.status(409).json({
      error: `${lockName} is already being created. Wait for the current request to finish instead of starting it again.`,
      alreadyFinalizing: true,
      appName: lockName
    });
  }
  finalizeLocks.set(lockName, Date.now());
  const releaseLock = () => finalizeLocks.delete(lockName);
  const lockTimer = setTimeout(releaseLock, 30 * 60 * 1000);
  lockTimer.unref?.();
  let finalizedAppName = '';
  let registrySaved = false;
  try {
    const {
      type = 'compose', appDir: rawAppDir, path: sourcePath, command = '',
      compose: composeYaml, network = '', ports = '', vhost = '', vhostPort = '',
      mode = 'auto', sourceRel = '', force = false, composeEdited = false,
      networkChoices = {}, volumeChoices = {}, vhostTouched = false,
      vhostService = '', createNetwork = false, overwrite = false, confirmAmend = false,
      testLaunch = false
    } = body;
    // Creation never leaves an app running. A test launch is allowed so the
    // user can confirm the app starts, but it is always stopped before the
    // response so the app is saved to the library ready for configuration.
    const shouldTest = testLaunch === true || body.launchNow === true;
    const composeBody = String(composeYaml || body.yaml || body.generatedCompose || '');
    const composeProvided = body.compose !== undefined || body.yaml !== undefined || body.generatedCompose !== undefined;
    const runMode = type === 'run' && !!command && (!composeBody || !composeEdited);
    if (!runMode && composeProvided && !composeBody.trim()) {
      throw httpError(400, 'Compose file is empty');
    }

    const name = projectName(requestedTitle, 'app');
    finalizedAppName = name;
    const targetDir = path.join(appsDir, name);
    if (isSymlink(targetDir)) throw httpError(400, 'Invalid app directory');
    if (rawAppDir && isSymlink(rawAppDir)) throw httpError(400, 'Invalid app directory');
    const targetReal = fs.existsSync(targetDir) ? fs.realpathSync(targetDir) : path.resolve(targetDir);

    let targetOccupied = false;
    try {
      targetOccupied = fs.existsSync(targetDir) && fs.readdirSync(targetDir).length > 0;
    } catch {
      targetOccupied = true;
    }
    const targetDataExisted = directoryHasEntries(path.join(targetDir, 'data'));
    const defaultsCfg = configuredDefaults();
    const appDataDirBefore = appDefaultDataDir(name);
    const appDataExisted = directoryHasEntries(appDataDirBefore);
    const existingData = [...new Set([targetDataExisted ? path.join(targetDir, 'data') : '', appDataExisted ? appDataDirBefore : ''].filter(Boolean))];
    if (targetOccupied && overwrite !== true) {
      const dataNote = existingData.length
        ? ` Existing app data at ${existingData.join(', ')} will be preserved and reused.`
        : '';
      const err = httpError(409,
        `An app named "${name}" already exists. Confirm that you want to overwrite its app files, or choose another app name.${dataNote}`);
      err.needsOverwrite = true;
      err.appName = name;
      err.existingData = existingData;
      throw err;
    }
    const netName = String(network || defaultsCfg.defaultNetwork || 'wicked').trim();
    if (['host', 'none', 'bridge', 'default'].includes(netName) || netName.startsWith('container:') || netName.startsWith('service:')) {
      throw httpError(400, 'Choose a named Docker network. Use network_mode in the compose file for host, none, bridge, or container networks.');
    }
    const useNetwork = netName;
    const portList = String(ports || '').split(',').map(p => p.trim()).filter(Boolean);
    for (const p of portList) {
      if (!/\d/.test(p) || /[^0-9A-Za-z.:[\]/-]/.test(p)) {
        throw httpError(400, `Invalid port mapping: ${p}`);
      }
    }
    const cleanVhost = normalizeDomain(vhost);
    if (cleanVhost && !/^[A-Za-z0-9*][A-Za-z0-9*._-]*$/.test(cleanVhost)) {
      throw httpError(400, 'Invalid domain name');
    }
    const settingsVhostPort = readSettings().services?.nginxProxy?.defaultVhostPort || 80;
    const requestedVhostPort = String(vhostPort || '').trim();
    let cleanVhostPort = requestedVhostPort || String(settingsVhostPort).trim() || '80';
    if (cleanVhost && (!/^\d+$/.test(cleanVhostPort) || Number(cleanVhostPort) < 1 || Number(cleanVhostPort) > 65535)) {
      throw httpError(400, 'VIRTUAL_PORT must be a port between 1 and 65535');
    }
    const clearVhost = vhostTouched === true && !cleanVhost;
    const nginxInstalled = nginxProxyInstalledSync();
    const runConv = runMode ? runCommandToCompose(command, name) : null;
    // Routing can come from the form quick fields or from the compose itself
    // (docker run env, pasted/imported compose, OC Assist). Either source must
    // produce the same paired network + VIRTUAL_HOST + VIRTUAL_PORT result.
    const nginxRoutingActive = nginxInstalled &&
      (!!cleanVhost || (!clearVhost && composeHasVhostKey(runConv?.compose || '')));
    // nginx-proxy reaches the routed service over the shared Docker network.
    // Keep VIRTUAL_HOST/VIRTUAL_PORT paired and remove published host ports so
    // independently created apps can listen on the same container port.
    const applyAppRoutingPolicy = (compose) => {
      const services = serviceNamesFromCompose(compose);
      const preferred = services.includes(String(vhostService || '').trim())
        ? String(vhostService).trim()
        : services.includes(name) ? name : services[0];
      if (!nginxInstalled) return ensureComposeDokNetwork(compose, useNetwork, preferred);
      const existing = routedServiceFromCompose(compose, preferred);
      const host = cleanVhost || (clearVhost ? '' : existing.host);
      if (!host) return ensureComposeDokNetwork(compose, useNetwork, preferred);
      const routed = applyNginxRoutingPolicy(compose, {
        service: cleanVhost ? preferred : (existing.service || preferred),
        vhost: host,
        vhostPort: requestedVhostPort,
        fallbackPort: settingsVhostPort,
        removePorts: true,
        network: useNetwork
      });
      if (routed.vhostPort) cleanVhostPort = routed.vhostPort;
      portList.splice(0, portList.length);
      return routed.compose;
    };

    const networkNames = await dockerNetworkNames();
    // The setup script creates the default network, but keep creation here so
    // generated compose files remain launchable on older installations too.
    if (!networkNames.includes('wicked')) {
      try {
        await createNetworkStrict('wicked');
        networkNames.push('wicked');
      } catch {}
    }
    if (useNetwork && !networkNames.includes(useNetwork)) {
      if (useNetwork === 'wicked' || useNetwork === defaultsCfg.defaultNetwork || createNetwork === true) {
        await createNetworkStrict(useNetwork);
        networkNames.push(useNetwork);
      } else {
        return res.status(400).json({
          error: `Network "${useNetwork}" does not exist. Choose an existing network or create it.`,
          missingNetworks: [{ key: useNetwork, name: useNetwork, form: true }]
        });
      }
    }

    // The compose editor removes host ports from routed services, so the run
    // command's VIRTUAL_PORT (explicit or inferred from its container port) is
    // the remaining source. Respect an explicit VPORT or form port list first.
    if (runMode && nginxRoutingActive && !requestedVhostPort && !portList.length && runConv?.vhostPort) {
      cleanVhostPort = runConv.vhostPort;
    }
    const runNetworkPlan = runConv ? planRunNetworks(runConv, networkNames) : null;

    let staged = '';
    if (rawAppDir) {
      try { staged = fs.realpathSync(rawAppDir); } catch {}
    }
    let stagedToRemove = '';
    const appsRoot = fs.existsSync(appsDir) ? fs.realpathSync(appsDir) : path.resolve(appsDir);
    const sourcesRoot = fs.existsSync(sourcesDir) ? fs.realpathSync(sourcesDir) : path.resolve(sourcesDir);
    const stagedIsAppDir = !!staged && staged !== appsRoot && path.dirname(staged) === appsRoot;
    if (stagedIsAppDir && staged !== targetReal && fs.existsSync(staged)) {
      try {
        copySourceTree(staged, targetDir, { preserveAppData: targetOccupied });
        if (fs.existsSync(targetDir)) stagedToRemove = staged;
      } catch {}
    }
    let sourceReal = '';
    if (sourcePath) {
      try { sourceReal = fs.realpathSync(sourcePath); } catch {}
    }
    let sourceIsDir = false;
    try { sourceIsDir = !!sourceReal && fs.statSync(sourceReal).isDirectory(); } catch {}
    if (sourceIsDir && sourceReal !== sourcesRoot && isInsideDir(sourceReal, sourcesDir) && sourceReal !== targetReal) {
      try { copySourceTree(sourceReal, targetDir, { preserveAppData: targetOccupied }); } catch {}
    }
    ensureWritableDirectory(targetDir, { label: 'app directory' });
    if (!isInsideApps(targetDir)) throw httpError(400, 'Invalid app directory');
    let appDataPath = '';
    try {
      appDataPath = await ensureAppDataDirectory(name);
    } catch (e) {
      throw e.status ? e : httpError(400, `Could not prepare the app data directory: ${e.message}`);
    }

    let finalCompose = composeBody;
    if (runMode) {
      finalCompose = runConv.compose;
    } else if (!finalCompose) {
      if (composeProvided) throw httpError(400, 'Compose file is empty');
      const existing = findComposeFile(targetDir);
      if (existing) {
        finalCompose = fs.readFileSync(existing, 'utf-8');
      } else if (fs.existsSync(path.join(targetDir, 'Dockerfile'))) {
        finalCompose = `# managed-by: wickedafdok\nservices:\n  ${name}:\n    build: .\n    container_name: ${yamlScalar(name)}\n    restart: unless-stopped\n`;
      } else if (command) {
        finalCompose = runCommandToCompose(command, name, {
          network: useNetwork, vhost: cleanVhost, vhostPort: cleanVhostPort,
          extraPorts: portList, replacePorts: true
        }).compose;
      }
    }
    if (!finalCompose || !String(finalCompose).trim()) {
      throw httpError(400, 'No compose file, Dockerfile, or run command found for this app');
    }
    if (!runMode) {
      // Keep hand-edited compose files launchable too: replace any external
      // network that does not exist with the setup-managed default network and
      // apply the shared app-compose standard before analysis and saving.
      finalCompose = standardizeAppCompose(finalCompose, { networkNames });
      finalCompose = applyAppRoutingPolicy(finalCompose);
    }

    let analysis = null;
    let refs = [];
    if (runMode) {
      // Missing run networks are already replaced with the default network in
      // runNetworkPlan, so there is nothing left for the user to resolve.
      refs = [];
    } else {
      analysis = await analyzeCompose(finalCompose, { projectDir: targetDir, networkNames });
      refs = analysis.missingNetworks;
    }
    const resolvedNetworks = [];
    const networkMappings = [];
    const unresolvedNetworks = [];
    for (const ref of refs) {
      if (!ref.missing) {
        resolvedNetworks.push(ref.name);
        continue;
      }
      const choice = String((networkChoices || {})[ref.key] || '').trim();
      if (!choice) {
        unresolvedNetworks.push(ref);
        continue;
      }
      if (choice === '__create__') {
        await createNetworkStrict(ref.name);
        if (!networkNames.includes(ref.name)) networkNames.push(ref.name);
        resolvedNetworks.push(ref.name);
      } else if (!networkNames.includes(choice)) {
        unresolvedNetworks.push({ ...ref, selected: choice });
      } else {
        resolvedNetworks.push(choice);
        if (!runMode) networkMappings.push({ key: ref.key, name: choice });
      }
    }
    if (unresolvedNetworks.length) {
      return res.status(400).json({
        error: 'Some networks do not exist. Choose an existing network or create them.',
        missingNetworks: unresolvedNetworks,
        compose: finalCompose
      });
    }

    if (runMode) {
      const finalNetworks = [...new Set([
        ...(runNetworkPlan?.networks || []),
        ...resolvedNetworks
      ])];
      if (useNetwork && !finalNetworks.includes(useNetwork)) finalNetworks.push(useNetwork);
      if (finalNetworks.includes('wicked')) await ensureNetwork('wicked');
      finalCompose = runCommandToCompose(command, name, {
        networks: finalNetworks,
        network: useNetwork,
        vhost: cleanVhost,
        vhostPort: cleanVhostPort,
        extraPorts: portList,
        replacePorts: true,
        clearVhost
      }).compose;
      finalCompose = applyAppRoutingPolicy(finalCompose);
      analysis = await analyzeCompose(finalCompose, {
        projectDir: targetDir,
        networkNames: networkNamesForAnalysis(networkNames)
      });
    }

    const volumeMappings = [];
    const unresolvedVolumes = [];
    for (const volume of analysis.missingVolumes || []) {
      const choice = (volumeChoices || {})[volume.key] || {};
      let source = String(choice.source || volume.source || '').trim();
      let create = choice.create === true;
      if (!choice.source && defaultsCfg.dataLocation && defaultsCfg.autoAppData !== false) {
        // Missing relative bind mounts (for example ./data) are project-local
        // paths that were never checked in. Put them under the configured data
        // location so app state survives updates and re-creation.
        const resolvedOriginal = path.resolve(String(volume.source || ''));
        const resolvedProject = path.resolve(targetDir);
        const projectLocal = resolvedOriginal === resolvedProject ||
          resolvedOriginal.startsWith(resolvedProject + path.sep);
        const autoSource = defaultVolumeSource(name, volume.target, defaultsCfg);
        if (projectLocal && autoSource) {
          source = autoSource;
          create = true;
        }
      }
      if (!source) {
        unresolvedVolumes.push(volume);
        continue;
      }
      if (!path.isAbsolute(source)) {
        unresolvedVolumes.push({ ...volume, source, reason: 'Host path must be absolute' });
        continue;
      }
      if (source.includes(':') || /[\r\n\0]/.test(source)) {
        unresolvedVolumes.push({ ...volume, source, reason: 'Host path contains characters that cannot be used in short volume syntax' });
        continue;
      }
      if (!fs.existsSync(source)) {
        if (defaultsCfg.dataLocation && defaultsCfg.allowOutsideData === false && !dataLocationContains(source, defaultsCfg)) {
          unresolvedVolumes.push({
            ...volume,
            source,
            reason: `Outside the configured data location (${defaultsCfg.dataLocation}). Enable outside paths in Dok Settings or choose a path inside it.`
          });
          continue;
        }
        if (!create) {
          unresolvedVolumes.push({ ...volume, source });
          continue;
        }
        const safe = safeHostPath(source);
        try {
          await ensureHostDirectory(safe, {
            label: 'host path',
            action: 'creating',
            mode: dataModeValue(defaultsCfg.dataMode)
          });
        } catch (e) {
          if (e.status) throw e;
          throw httpError(400, `Could not create host path ${safe}: ${e.message}`);
        }
        source = safe;
      }
      if (source !== volume.source) {
        volumeMappings.push({
          service: volume.service,
          target: volume.target,
          source,
          readOnly: volume.readOnly === true
        });
      }
    }
    if (unresolvedVolumes.length) {
      return res.status(400).json({
        error: 'Some host paths do not exist. Choose a valid path or create the directories.',
        missingVolumes: unresolvedVolumes,
        compose: finalCompose
      });
    }

    const reusedData = new Set(existingData);
    for (const volume of analysis.bindVolumes || []) {
      const mapped = volumeMappings.find(item => item.service === volume.service && item.target === volume.target);
      const source = mapped?.source || volume.source;
      const root = appDataRootForPath(source, defaultsCfg, targetDir);
      if (!root) continue;
      if (root === path.join(targetDir, 'data') && !targetDataExisted) continue;
      if (directoryHasEntries(root)) reusedData.add(root);
    }
    const dataReuse = [...reusedData];
    const dataNotice = dataReuse.length
      ? `Existing app data at ${dataReuse.join(', ')} will be reused. Dok preserves app data during updates and app-file overwrites; choose a different app name or data location for fresh data, or delete the existing data manually first.`
      : '';

    const validation = await validateCompose(finalCompose, { projectDir: targetDir });
    const validationIssues = [...new Set([...(validation.issues || []), ...(analysis.issues || [])])];
    if ((!validation.ok || (analysis.issues || []).length) && !force) {
      return res.status(400).json({
        error: 'Compose validation failed. Fix the issues or choose to save anyway.',
        issues: validationIssues,
        compose: finalCompose
      });
    }

    const hasNetworkMode = /^\s*network_mode\s*:/m.test(finalCompose);
    const overrideNetwork = hasNetworkMode ? '' : useNetwork;
    const overridePorts = hasNetworkMode ? [] : portList;
    const services = serviceNamesFromCompose(finalCompose);
    const targetService = services.includes(name) ? name : services[0];
    const orderedServices = targetService
      ? [targetService, ...services.filter(s => s !== targetService)]
      : [name];
    const effectiveVhostService = analysis.vhostService || vhostService;
    const overrideVhostService = services.includes(effectiveVhostService) ? effectiveVhostService : (targetService || '');
    const overrideClearVhost = clearVhost && !runMode;
    // Labels are always written so the Maintenance container can find every
    // app Dok created, even when no network/vhost/port override is needed.
    const overrideText = buildComposeOverride(orderedServices, {
      network: overrideNetwork,
      networkMappings,
      vhost: cleanVhost,
      vhostPort: cleanVhostPort,
      clearVhost: overrideClearVhost,
      vhostService: overrideVhostService,
      ports: overridePorts,
      volumeMappings,
      baseText: finalCompose,
      labels: appDokLabels(name)
    });

    let combinedIssues = [];
    let combinedMissingNetworks = [];
    let combinedMissingVolumes = [];
    if (overrideText) {
      const combined = await composeConfig([finalCompose, overrideText], { projectDir: targetDir });
      if (!combined.ok) {
        combinedIssues = combined.issues;
      } else {
        const combinedAnalysis = analyzeComposeConfig(combined.config || {}, networkNames);
        combinedMissingNetworks = combinedAnalysis.missingNetworks;
        combinedMissingVolumes = combinedAnalysis.missingVolumes;
        combinedIssues = [
          ...combinedAnalysis.issues,
          ...combinedMissingNetworks.map(net => `Network "${net.name}" still does not exist after applying the selected network.`),
          ...combinedMissingVolumes.map(vol => `Host path "${vol.source}" still does not exist after applying the selected volume.`)
        ];
      }
      if (combinedIssues.length && !force) {
        return res.status(400).json({
          error: 'The final compose configuration is invalid. Fix the issues or choose to save anyway.',
          issues: [...new Set([...validationIssues, ...combinedIssues])],
          missingNetworks: combinedMissingNetworks,
          missingVolumes: combinedMissingVolumes,
          compose: finalCompose
        });
      }
    }

    let amendment = null;
    if (shouldTest) {
      amendment = await inspectComposeAmendments(name, finalCompose);
      if (amendment.blocked.length) {
        const item = amendment.blocked[0];
        throw httpError(409,
          `"${item.name}" belongs to a protected core service and cannot be reused by ${name}. ` +
          'Change container_name in the compose file or remove the conflicting service first.');
      }
      if (amendment.requiresApproval && confirmAmend !== true) {
        const err = httpError(409,
          `${name} would amend existing containers. Review the changes and approve them to continue.`);
        err.needsAmendApproval = true;
        err.amendments = amendment;
        err.appName = name;
        throw err;
      }
    }

    const composePath = path.join(targetDir, 'docker-compose.yml');
    writePrivateFile(composePath, finalCompose);
    const overridePath = path.join(targetDir, 'docker-compose.wickedafdok.yml');
    if (overrideText) fs.writeFileSync(overridePath, overrideText);
    else { try { fs.unlinkSync(overridePath); } catch {} }

    // Keep the registry routing fields in sync with the saved compose even when
    // Docker Compose inspection is unavailable; the text helpers can still
    // read the paired VIRTUAL_HOST/VIRTUAL_PORT.
    const finalRouting = routedServiceFromCompose(finalCompose, effectiveVhostService || name);
    const finalVhost = analysis?.vhost || finalRouting.host || cleanVhost;
    const finalVhostPort = analysis?.vhostPort || (finalVhost
      ? composeVhostPortForService(finalCompose, finalRouting.service || targetService, cleanVhostPort, settingsVhostPort)
      : '');
    const referenceFieldProvided = Object.prototype.hasOwnProperty.call(body, 'referenceUrl');
    const requestedReferenceUrl = String(body.referenceUrl ?? '').trim();
    const normalizedReferenceUrl = sanitizeAppReferenceUrl(requestedReferenceUrl);
    if (referenceFieldProvided && requestedReferenceUrl && !normalizedReferenceUrl) {
      throw httpError(400, 'The app reference must be an http(s) repository or website URL');
    }
    const detectedReferenceUrl = referenceFieldProvided
      ? normalizedReferenceUrl
      : await detectAppReferenceUrl({ dirs: [targetDir], compose: finalCompose });
    const referencePatch = referenceFieldProvided || detectedReferenceUrl
      ? { referenceUrl: detectedReferenceUrl }
      : {};

    addRegistryEntry({
      type: type || 'compose',
      name,
      path: targetDir,
      sourcePath: sourceRel || (sourceIsDir && sourceReal !== sourcesRoot && isInsideDir(sourceReal, sourcesDir)
        ? path.relative(sourcesRoot, sourceReal)
        : ''),
      appDir: targetDir,
      composeFile: 'docker-compose.yml',
      command: command || '',
      dataPath: appDataPath,
      ...referencePatch,
      launch: {
        mode: type === 'run' ? 'compose' : mode,
        name,
        command: command || '',
        ports: portList,
        vhost: finalVhost,
        vhostPort: finalVhostPort,
        appDir: targetDir,
        network: useNetwork,
        type
      }
    });

    registrySaved = true;
    if (stagedToRemove) {
      try {
        fs.rmSync(stagedToRemove, { recursive: true, force: true });
        writeRegistry(readRegistry().filter(r => path.resolve(r.appDir || '') !== stagedToRemove));
      } catch {}
    }

    let result = { stdout: 'Saved to library', stderr: '' };
    let launchError = '';
    let launchPending = false;
    let renamed = [];
    let tested = false;
    let testHealthy = false;
    let testStopped = false;
    let testStopError = '';
    let testContainers = [];
    if (shouldTest) {
      renamed = await resolveProjectNameConflicts(name, finalCompose, amendment);
      const args = ['compose', '-f', composePath, '-p', name];
      if (fs.existsSync(overridePath)) args.push('-f', overridePath);
      args.push('up', '-d', '--remove-orphans');
      try {
        result = await run('docker', args, { cwd: targetDir });
      } catch (e) {
        // A first start often reports failure while the project containers are
        // still being created (image build, dependency startup). If they exist,
        // report a pending launch so the user knows the test did not complete.
        const containers = await docker.listContainers({ all: true }).catch(() => []);
        const projectContainers = containers.filter(c =>
          c.Labels?.['com.docker.compose.project'] === name &&
          ['created', 'running', 'restarting'].includes(c.State));
        if (projectContainers.length) {
          launchPending = true;
          result = { stdout: e.stdout || '', stderr: e.stderr || '' };
        } else {
          launchError = e.message;
          result = { stdout: e.stdout || '', stderr: e.stderr || '' };
        }
      }
      tested = true;
      const waitMs = Math.max(500, Number(process.env.WICKEDAFDOK_TEST_WAIT_MS) || 4000);
      await new Promise(resolve => setTimeout(resolve, waitMs));
      const containers = await docker.listContainers({ all: true }).catch(() => []);
      testContainers = containers
        .filter(c => c.Labels?.['com.docker.compose.project'] === name)
        .map(c => ({
          name: String((c.Names || [])[0] || c.Id || '').replace(/^\//, '') || 'container',
          state: c.State || 'unknown',
          status: c.Status || ''
        }));
      testHealthy = testContainers.some(c => c.state === 'running') &&
        !testContainers.some(c => c.state === 'restarting');
      // Leave the app saved and stopped so the user can configure it in the
      // compose editor before the real deploy.
      const stopArgs = ['compose', '-f', composePath, '-p', name];
      if (fs.existsSync(overridePath)) stopArgs.push('-f', overridePath);
      stopArgs.push('stop');
      try {
        await run('docker', stopArgs, { cwd: targetDir });
        testStopped = true;
      } catch (e) {
        testStopError = e.message;
      }
      launchPending = false;
    }

    res.json({
      ok: true, appDir: targetDir, appName: name, appDataPath, ...result,
      issues: [...new Set([...validationIssues, ...combinedIssues])], launchError,
      launchPending, renamed, amended: amendment?.requiresApproval ? amendment.changes : [],
      reuseData: dataReuse, dataNotice, tested,
      testHealthy, testContainers, testStopped, testStopError,
      stopped: shouldTest ? testStopped : true,
      message: tested
        ? (testStopped
          ? `${name} test launch finished and the app was stopped. Configure and deploy it from Apps.`
          : `${name} test launch finished, but Dok could not stop it. Stop it from Apps before configuring it.`)
        : `${name} was saved to the library. Configure and deploy it from Apps.`
    });
  } catch (e) {
    res.status(e.status || 500).json({
      error: e.message, stdout: e.stdout, stderr: e.stderr,
      needsOverwrite: !!e.needsOverwrite,
      needsAmendApproval: !!e.needsAmendApproval,
      amendments: e.amendments || null,
      existingData: Array.isArray(e.existingData) ? e.existingData : [],
      appName: e.appName || (registrySaved ? finalizedAppName : undefined),
      created: registrySaved
    });
  } finally {
    // Hold the lock until the request handler is done, not until the socket
    // closes. A client disconnect must not let a retry start a second finalize
    // while this one is still writing the app and registry.
    clearTimeout(lockTimer);
    releaseLock();
  }
});

// ---------- sources / files ----------
app.get('/api/sources/list', (req, res) => {
  try {
    const target = resolveSource(req.query.path || '');
    if (!fs.statSync(target).isDirectory()) return res.status(400).json({ error: 'Not a directory' });
    const base = fs.realpathSync(sourcesDir);
    const items = fs.readdirSync(target)
      .filter(name => name !== '.git')
      .map(name => {
        const p = path.join(target, name);
        let stat;
        try { stat = fs.statSync(p); } catch { return null; }
        return {
          name,
          type: stat.isDirectory() ? 'dir' : 'file',
          rel: path.relative(base, p),
          mtime: stat.mtime,
          size: stat.size
        };
      })
      .filter(Boolean)
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    const hasCompose = composeFiles.some(f => fs.existsSync(path.join(target, f)));
    const hasDockerfile = fs.existsSync(path.join(target, 'Dockerfile'));
    const composeFile = composeFiles.find(f => fs.existsSync(path.join(target, f)));
    res.json({ rel: path.relative(base, target) || '.', items, hasCompose, hasDockerfile, composeFile, isRoot: target === base });
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

app.get('/api/sources/file', (req, res) => {
  try {
    const target = resolveSource(req.query.path || '');
    if (fs.statSync(target).isDirectory()) return res.status(400).json({ error: 'Not a file' });
    const stat = fs.statSync(target);
    if (stat.size > 2 * 1024 * 1024) return res.status(400).json({ error: 'File is too large to edit (max 2 MB)' });
    const buffer = fs.readFileSync(target);
    if (buffer.includes(0)) return res.status(400).json({ error: 'Binary files cannot be edited' });
    res.json({ content: buffer.toString('utf-8') });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/sources/file', (req, res) => {
  try {
    const { path: relPath, content } = req.body;
    if (!relPath) return res.status(400).json({ error: 'path required' });
    const target = resolveSource(relPath, { forWrite: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content || '', 'utf-8');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- app library export/import ----------
// Library archives use this manifest. Apps in a library are installation
// neutral: Dok-specific launch data, domains, host paths, published ports,
// container names, and generated override files are removed before export.
const LIBRARY_SCHEMA = 'wickedafdok.library/v1';
const LIBRARY_KEEP_HOST_PATHS = new Set([
  '/var/run/docker.sock',
  '/var/run/docker.sock.raw',
  '/etc/localtime',
  '/etc/timezone'
]);
const LIBRARY_SKIP_DIRS = new Set([
  '.git', 'node_modules', '__pycache__', '.venv', 'venv', '.cache', '.npm', '.yarn', 'tmp'
]);
const LIBRARY_STRIP_ENV = new Set([
  'VIRTUAL_HOST', 'VIRTUAL_PORT', 'ENABLE_AUTH', 'LETSENCRYPT_HOST', 'LETSENCRYPT_EMAIL'
]);

function libraryPortScalar(value) {
  const text = String(value || '').trim().replace(/^['"]|['"]$/g, '');
  const match = text.match(/^(?:(.+):)?([0-9]+(?:-[0-9]+)?)(?:\/(tcp|udp))?$/i);
  if (!match) return { value: text, published: false };
  const container = match[2];
  const proto = match[3] ? `/${match[3].toLowerCase()}` : '';
  return {
    value: `${container}${proto}`,
    published: !!match[1],
    publishedValue: match[1] ? text : ''
  };
}

function libraryVolumeSlug(target) {
  const slug = String(target || '')
    .replace(/^[/\\]+/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === 'data' ? 'data' : (slug || 'data');
}

function libraryVolumeSource(source, target) {
  const text = String(source || '').trim().replace(/^['"]|['"]$/g, '');
  if (!text || (!text.startsWith('/') && !text.startsWith('~'))) {
    return { source: text, changed: false };
  }
  if (LIBRARY_KEEP_HOST_PATHS.has(text)) return { source: text, changed: false };
  const slug = libraryVolumeSlug(target);
  return {
    source: slug === 'data' ? './data' : `./data/${slug}`,
    changed: true
  };
}

function sanitizeComposeForLibrary(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  const requirements = { environment: [], volumes: [], ports: [], networks: [] };
  let top = '';
  let service = '';
  let sub = '';
  let networkKey = '';
  let networkKeepExternal = false;
  let volumeKey = '';
  let longVolume = null;
  let longPort = null;

  const addRequirement = (kind, value) => {
    if (!value) return;
    if (!requirements[kind].includes(value)) requirements[kind].push(value);
  };
  const applyLongVolume = () => {
    if (!longVolume || longVolume.mapped || !longVolume.source || !longVolume.target) return;
    if (longVolume.sourceIndex < 0) return;
    const mapped = libraryVolumeSource(longVolume.source, longVolume.target);
    longVolume.mapped = true;
    if (!mapped.changed) return;
    addRequirement('volumes', `${mapped.source} -> ${longVolume.target}`);
    out[longVolume.sourceIndex] = out[longVolume.sourceIndex]
      .replace(/(source\s*:\s*).+$/, `$1${yamlScalar(mapped.source)}`);
  };

  for (const original of lines) {
    const line = original.replace(/[ \t]+$/, '');
    if (!line.trim()) {
      out.push(line);
      continue;
    }
    if (/^[^\s#]/.test(line)) {
      const keyMatch = line.match(/^([A-Za-z0-9_.-]+)\s*:/);
      const key = keyMatch ? keyMatch[1] : '';
      if (key === 'name' || key === 'version') continue;
      top = key;
      service = '';
      sub = '';
      networkKey = '';
      networkKeepExternal = false;
      volumeKey = '';
      longVolume = null;
      longPort = null;
      out.push(line);
      continue;
    }
    if (top === 'services') {
      const serviceMatch = line.match(/^  ([A-Za-z0-9_.-]+):\s*(?:#.*)?$/);
      if (serviceMatch) {
        service = serviceMatch[1];
        sub = '';
        longVolume = null;
        longPort = null;
        out.push(line);
        continue;
      }
      if (/^    container_name\s*:/.test(line)) continue;
      const subMatch = line.match(/^    ([A-Za-z0-9_.-]+):\s*(?:#.*)?$/);
      if (subMatch) {
        sub = subMatch[1];
        longVolume = null;
        longPort = null;
        if (sub === 'container_name') continue;
        out.push(line);
        continue;
      }
      if (sub === 'environment') {
        const listValue = line.match(/^\s+-\s*['"]?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
        const mapValue = line.match(/^\s+['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?\s*:\s*(.*)$/);
        const listKeyOnly = line.match(/^\s+-\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?\s*$/);
        const key = listValue ? listValue[1] : (mapValue ? mapValue[1] : (listKeyOnly ? listKeyOnly[1] : ''));
        if (LIBRARY_STRIP_ENV.has(key) || key.startsWith('LETSENCRYPT_') || key.startsWith('VIRTUAL_')) {
          addRequirement('environment', key);
          continue;
        }
      }
      if (sub === 'ports') {
        const listItem = line.match(/^\s+-\s*(.+)$/);
        if (listItem) {
          const raw = listItem[1].trim();
          const keyTarget = raw.match(/^target\s*:\s*(.+)$/i);
          if (keyTarget) {
            longPort = longPort || { target: '', published: false, requirementAdded: false };
            longPort.target = keyTarget[1].trim().replace(/^['"]|['"]$/g, '');
            if (longPort.published && !longPort.requirementAdded) {
              addRequirement('ports', longPort.target);
              longPort.requirementAdded = true;
            }
            out.push(line);
            continue;
          }
          longPort = null;
          const parsed = libraryPortScalar(raw);
          if (parsed.published) {
            addRequirement('ports', parsed.value);
            out.push(line.replace(/(-\s*).+$/, `$1${yamlScalar(parsed.value)}`));
            continue;
          }
        } else {
          const published = line.match(/^\s+published\s*:\s*(.+)$/i);
          if (published) {
            longPort = longPort || { target: '', published: false, requirementAdded: false };
            longPort.published = true;
            if (longPort.target && !longPort.requirementAdded) {
              addRequirement('ports', longPort.target);
              longPort.requirementAdded = true;
            }
            continue;
          }
          const target = line.match(/^\s+target\s*:\s*(.+)$/i);
          if (target && longPort) {
            longPort.target = target[1].trim().replace(/^['"]|['"]$/g, '');
            if (longPort.published && !longPort.requirementAdded) {
              addRequirement('ports', longPort.target);
              longPort.requirementAdded = true;
            }
          }
        }
      }
      if (sub === 'volumes') {
        const listItem = line.match(/^\s+-\s*(.+)$/);
        if (listItem) {
          const raw = listItem[1].trim();
          const typeMatch = raw.match(/^type\s*:\s*(.+)$/i);
          if (typeMatch) {
            longVolume = { type: typeMatch[1].trim(), target: '', source: '', sourceIndex: -1, mapped: false };
            out.push(line);
            continue;
          }
          longVolume = null;
          const cleaned = raw.replace(/^['"]|['"]$/g, '');
          const firstColon = cleaned.indexOf(':');
          if (firstColon > 0) {
            const source = cleaned.slice(0, firstColon);
            const rest = cleaned.slice(firstColon + 1);
            const target = rest.split(':')[0];
            const mode = rest.split(':').slice(1).join(':');
            const mapped = libraryVolumeSource(source, target);
            if (mapped.changed) {
              addRequirement('volumes', `${mapped.source} -> ${target}`);
              out.push(line.replace(/(-\s*).+$/, `$1${yamlScalar(`${mapped.source}:${rest}`)}`));
              continue;
            }
          }
        } else {
          const source = line.match(/^\s+source\s*:\s*(.+)$/i);
          if (source && longVolume) {
            longVolume.source = source[1].trim().replace(/^['"]|['"]$/g, '');
            longVolume.sourceIndex = out.length;
            out.push(line);
            applyLongVolume();
            continue;
          }
          const target = line.match(/^\s+target\s*:\s*(.+)$/i);
          if (target && longVolume) {
            longVolume.target = target[1].trim().replace(/^['"]|['"]$/g, '');
            out.push(line);
            applyLongVolume();
            continue;
          }
        }
      }
      if (sub === 'networks') {
        const item = line.match(/^      -\s*(.+)$/);
        if (item) addRequirement('networks', item[1].trim().replace(/^['"]|['"]$/g, ''));
        else {
          const mapping = line.match(/^      ([A-Za-z0-9_.-]+)\s*:/);
          if (mapping) addRequirement('networks', mapping[1]);
        }
      }
      out.push(line);
      continue;
    }
    if (top === 'networks') {
      const netMatch = line.match(/^  ([A-Za-z0-9_.-]+):\s*(?:#.*)?$/);
      if (netMatch) {
        networkKey = netMatch[1];
        networkKeepExternal = networkKey === 'wicked';
        out.push(line);
        continue;
      }
      const netName = line.match(/^\s+name\s*:\s*(.+)$/i);
      if (netName) {
        const value = netName[1].trim().replace(/^['"]|['"]$/g, '');
        if (networkKey === 'wicked' || value === 'wicked') {
          networkKeepExternal = true;
          out.push(line);
        }
        continue;
      }
      if (/^\s+external\s*:/i.test(line)) {
        if (networkKey === 'wicked' || networkKeepExternal) out.push(line);
        continue;
      }
    }
    if (top === 'volumes') {
      const volumeMatch = line.match(/^  ([A-Za-z0-9_.-]+):\s*(?:#.*)?$/);
      if (volumeMatch) {
        volumeKey = volumeMatch[1];
        out.push(line);
        continue;
      }
      if (volumeKey && /^\s+(external|name)\s*:/i.test(line)) continue;
    }
    out.push(line);
  }

  // Drop service sub-section headers that lost all their entries (for example
  // an environment block that only contained VIRTUAL_HOST). Top-level network
  // and volume definitions stay even when they become empty, because Compose
  // uses the key itself to declare a project-scoped resource.
  const cleaned = [];
  for (let i = 0; i < out.length; i++) {
    const line = out[i];
    const header = line.match(/^(    )([A-Za-z0-9_.-]+):\s*$/);
    if (header) {
      let j = i + 1;
      while (j < out.length && !out[j].trim()) j++;
      const indent = out[j] ? (out[j].match(/^\s*/) || [''])[0].length : 0;
      if (j >= out.length || indent <= 4) continue;
    }
    cleaned.push(line);
  }
  return {
    compose: cleaned.join('\n').replace(/\s*$/, '') + '\n',
    requirements
  };
}

function libraryFiles(rootDir) {
  const files = [];
  const walk = (dir, rel) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (LIBRARY_SKIP_DIRS.has(entry.name)) continue;
        if (!rel && entry.name === 'data') continue;
        walk(path.join(dir, entry.name), relPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name === 'docker-compose.wickedafdok.yml') continue;
      if (entry.name === '.DS_Store') continue;
      if (/^\.env($|\.)/.test(entry.name) && entry.name !== '.env.example') continue;
      files.push(relPath);
    }
  };
  walk(rootDir, '');
  return files.sort();
}

function copyLibraryFile(source, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(source, dest);
}

function libraryManifestApp(entry, appDir) {
  const composePath = findComposeFile(appDir);
  if (!composePath) throw httpError(400, `${entry.name} has no compose file`);
  const files = libraryFiles(appDir);
  const composeRel = path.relative(appDir, composePath).replace(/\\/g, '/');
  const standardized = standardizeAppCompose(fs.readFileSync(composePath, 'utf-8'));
  const sanitized = sanitizeComposeForLibrary(standardized);
  return {
    name: projectName(entry.name, 'app'),
    description: String(entry.description || '').slice(0, 500),
    referenceUrl: sanitizeAppReferenceUrl(entry.referenceUrl),
    composeFile: composeRel,
    files,
    requirements: sanitized.requirements,
    sanitizedCompose: sanitized.compose,
    appDir
  };
}

app.post('/api/library/export', async (req, res) => {
  const temp = fs.mkdtempSync(path.join(tmpDir, 'library-export-'));
  const archive = path.join(tmpDir, `library-export-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.tar.gz`);
  try {
    const ids = Array.isArray(req.body?.apps) ? req.body.apps.map(String) : [];
    const registry = readRegistry();
    const selected = ids.length
      ? registry.filter(entry => ids.includes(String(entry.id)) || ids.includes(String(entry.name)))
      : [];
    if (!selected.length) throw httpError(400, 'Select at least one app to export');
    const appsOut = path.join(temp, 'apps');
    fs.mkdirSync(appsOut, { recursive: true });
    const apps = [];
    for (const entry of selected) {
      const appDir = appDirFor(entry);
      if (!isInsideApps(appDir) || isSymlink(appDir)) throw httpError(400, `Invalid app directory for ${entry.name}`);
      if (!fs.existsSync(appDir)) throw httpError(404, `${entry.name} is missing from apps/`);
      const manifestApp = libraryManifestApp(entry, appDir);
      const destDir = path.join(appsOut, manifestApp.name);
      for (const rel of manifestApp.files) {
        copyLibraryFile(path.join(appDir, rel), path.join(destDir, rel));
      }
      const composeDest = path.join(destDir, manifestApp.composeFile);
      fs.mkdirSync(path.dirname(composeDest), { recursive: true });
      fs.writeFileSync(composeDest, manifestApp.sanitizedCompose, 'utf-8');
      apps.push({
        name: manifestApp.name,
        description: manifestApp.description,
        referenceUrl: manifestApp.referenceUrl,
        composeFile: manifestApp.composeFile,
        files: manifestApp.files,
        requirements: manifestApp.requirements
      });
    }
    const manifest = {
      schema: LIBRARY_SCHEMA,
      kind: 'wickedafdok-app-library',
      version: 1,
      name: String(req.body?.name || 'Dok app library').slice(0, 120),
      created: new Date().toISOString(),
      apps
    };
    writePrivateFile(path.join(temp, 'dok-library.json'), JSON.stringify(manifest, null, 2) + '\n');
    await run('tar', ['-czf', archive, '-C', temp, '.']);
    const filename = `dok-library-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}.tar.gz`;
    res.download(archive, filename, () => {
      try { fs.rmSync(temp, { recursive: true, force: true }); } catch {}
      try { fs.rmSync(archive, { force: true }); } catch {}
    });
  } catch (e) {
    try { fs.rmSync(temp, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(archive, { force: true }); } catch {}
    if (!res.headersSent) res.status(e.status || 500).json({ error: e.message });
  }
});

function libraryManifestFromDirectory(rootDir, subdir = '') {
  const base = subdir ? path.resolve(rootDir, String(subdir)) : rootDir;
  if (base !== rootDir && !base.startsWith(rootDir + path.sep)) {
    throw httpError(400, 'Invalid library path in repository');
  }
  if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) {
    throw httpError(400, `The repository has no directory at ${subdir || '/'}`);
  }
  const manifestPath = [path.join(base, 'dok-library.json'), path.join(base, 'library.json')]
    .find(candidate => fs.existsSync(candidate));
  if (!manifestPath) return null;
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')); } catch {
    throw httpError(400, 'The library manifest is not valid JSON');
  }
  if (manifest?.schema !== LIBRARY_SCHEMA || manifest?.kind !== 'wickedafdok-app-library' || !Array.isArray(manifest.apps)) {
    throw httpError(400, `Unsupported library format. Expected ${LIBRARY_SCHEMA}.`);
  }
  return { manifest, appsRoot: path.join(base, 'apps') };
}

function copyDirectoryTree(source, dest, { skipTop = [] } = {}) {
  const skip = new Set(skipTop);
  fs.mkdirSync(dest, { recursive: true });
  const walk = (from, to, depth) => {
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      if (depth === 0 && skip.has(entry.name)) continue;
      if (entry.isSymbolicLink()) continue;
      const src = path.join(from, entry.name);
      const out = path.join(to, entry.name);
      if (entry.isDirectory()) {
        if (LIBRARY_SKIP_DIRS.has(entry.name)) continue;
        fs.mkdirSync(out, { recursive: true });
        walk(src, out, depth + 1);
      } else if (entry.isFile()) {
        fs.copyFileSync(src, out);
      }
    }
  };
  walk(source, dest, 0);
}

// Builds a library tree from a repository that has a compose file or
// Dockerfile but no dok-library.json. The repository becomes a single app.
function synthesizeLibraryFromRepository(repoDir, { name = '', description = '', referenceUrl = '' } = {}) {
  const repoBase = path.basename(String(repoDir).replace(/[/\\]+$/, ''));
  const appName = projectName(name || repoBase, `repo-${Date.now()}`);
  const composeFile = findComposeFile(repoDir);
  const hasDockerfile = fs.existsSync(path.join(repoDir, 'Dockerfile'));
  if (!composeFile && !hasDockerfile) {
    throw httpError(400, 'The repository has no dok-library.json, compose file, or Dockerfile to import');
  }
  const root = fs.mkdtempSync(path.join(tmpDir, 'library-repo-'));
  const appDir = path.join(root, 'apps', appName);
  copyDirectoryTree(repoDir, appDir, { skipTop: ['.git', 'node_modules', 'data'] });
  const composeRel = 'docker-compose.yml';
  if (composeFile) {
    const rel = path.relative(repoDir, composeFile).replace(/\\/g, '/');
    if (rel !== composeRel) fs.copyFileSync(composeFile, path.join(appDir, composeRel));
  } else {
    fs.writeFileSync(path.join(appDir, composeRel),
      `# managed-by: wickedafdok\nservices:\n  ${yamlScalar(appName)}:\n    build: .\n    container_name: ${yamlScalar(appName)}\n    restart: unless-stopped\n`);
  }
  const manifest = {
    schema: LIBRARY_SCHEMA,
    kind: 'wickedafdok-app-library',
    version: 1,
    name: String(name || repoBase || 'Repository app').slice(0, 120),
    created: new Date().toISOString(),
    apps: [{
      name: appName,
      description: String(description || '').slice(0, 500),
      referenceUrl: sanitizeAppReferenceUrl(referenceUrl),
      composeFile: composeRel,
      files: libraryFiles(appDir),
      requirements: {}
    }]
  };
  return { root, manifest, appsRoot: path.join(root, 'apps') };
}

async function importLibraryTree({ manifest, appsRoot, overwrite = false, defaultReferenceUrl = '' }) {
  const entries = [];
  for (const app of manifest.apps) {
    const name = String(app?.name || '').trim();
    if (!/^[a-z0-9][a-z0-9._-]{0,59}$/.test(name)) {
      throw httpError(400, `Invalid app name in library: ${name || '(empty)'}`);
    }
    if (entries.some(entry => entry.name === name)) throw httpError(400, `Duplicate app in library: ${name}`);
    const sourceDir = path.join(appsRoot, name);
    const rel = path.relative(appsRoot, sourceDir);
    if (rel.startsWith('..') || path.isAbsolute(rel) || isSymlink(sourceDir) || !fs.existsSync(sourceDir)) {
      throw httpError(400, `The library is missing the files for ${name}`);
    }
    const composeRel = String(app.composeFile || 'docker-compose.yml').replace(/\\/g, '/');
    const composePath = path.resolve(sourceDir, composeRel);
    if (composePath !== sourceDir && !composePath.startsWith(sourceDir + path.sep)) {
      throw httpError(400, `Invalid compose path for ${name}`);
    }
    if (!fs.existsSync(composePath) || !fs.statSync(composePath).isFile()) {
      throw httpError(400, `${name} is missing ${composeRel}`);
    }
    const sanitized = sanitizeComposeForLibrary(standardizeAppCompose(fs.readFileSync(composePath, 'utf-8')));
    if (!sanitized.compose.trim()) throw httpError(400, `${name} has an empty compose file`);
    const target = path.join(appsDir, name);
    let occupied = false;
    try { occupied = fs.existsSync(target) && fs.readdirSync(target).length > 0; } catch { occupied = true; }
    const existingData = [
      directoryHasEntries(path.join(target, 'data')) ? path.join(target, 'data') : '',
      directoryHasEntries(appDefaultDataDir(name)) ? appDefaultDataDir(name) : ''
    ].filter(Boolean);
    entries.push({
      name,
      sourceDir,
      composeRel,
      compose: sanitized.compose,
      target,
      occupied,
      existingData: [...new Set(existingData)],
      description: String(app.description || '').slice(0, 500),
      referenceUrl: sanitizeAppReferenceUrl(app.referenceUrl) || sanitizeAppReferenceUrl(defaultReferenceUrl),
      requirements: app.requirements && typeof app.requirements === 'object' ? app.requirements : sanitized.requirements
    });
  }
  const conflicts = entries.filter(entry => entry.occupied).map(entry => entry.name);
  if (conflicts.length && !overwrite) {
    const err = httpError(409, `These apps already exist: ${conflicts.join(', ')}. Confirm to overwrite their app files. Existing app data is preserved and reused.`);
    err.needsOverwrite = true;
    err.apps = conflicts;
    err.existingData = [...new Set(entries.flatMap(entry => entry.existingData))];
    throw err;
  }
  const imported = [];
  for (const entry of entries) {
    if (isSymlink(entry.target)) throw httpError(400, `Invalid app directory for ${entry.name}`);
    if (entry.occupied) clearAppDirectory(entry.target, { preserveAppData: true });
    fs.mkdirSync(entry.target, { recursive: true });
    for (const rel of libraryFiles(entry.sourceDir)) {
      const from = path.join(entry.sourceDir, rel);
      const to = path.resolve(entry.target, rel);
      if (to !== entry.target && !to.startsWith(entry.target + path.sep)) continue;
      copyLibraryFile(from, to);
    }
    const composeDest = path.resolve(entry.target, entry.composeRel);
    if (composeDest !== entry.target && !composeDest.startsWith(entry.target + path.sep)) {
      throw httpError(400, `Invalid compose path for ${entry.name}`);
    }
    fs.mkdirSync(path.dirname(composeDest), { recursive: true });
    writePrivateFile(composeDest, entry.compose);
    ensureDokAppLabels(entry.target, entry.name, entry.composeRel);
    addRegistryEntry({
      type: 'compose',
      name: entry.name,
      path: entry.target,
      appDir: entry.target,
      sourcePath: '',
      composeFile: entry.composeRel,
      command: '',
      dataPath: '',
      needsConfig: true,
      description: entry.description,
      referenceUrl: entry.referenceUrl,
      library: {
        schema: manifest.schema,
        name: String(manifest.name || ''),
        importedAt: new Date().toISOString(),
        requirements: entry.requirements
      },
      launch: {
        mode: 'compose',
        name: entry.name,
        command: '',
        ports: [],
        vhost: '',
        vhostPort: '',
        appDir: entry.target,
        network: '',
        type: 'compose'
      }
    });
    imported.push(entry.name);
  }
  const reuseData = [...new Set(entries.filter(entry => imported.includes(entry.name)).flatMap(entry => entry.existingData))];
  const dataNotice = reuseData.length
    ? ` Existing app data at ${reuseData.join(', ')} will be reused and was not overwritten. Choose a different app name or data location for fresh data, or delete the existing data manually first.`
    : '';
  return {
    ok: true,
    imported,
    reuseData,
    library: {
      schema: manifest.schema,
      name: String(manifest.name || ''),
      created: manifest.created || '',
      apps: entries.map(entry => entry.name)
    },
    message: (imported.length === 1
      ? `Imported ${imported[0]}. Open it in Apps and configure it before launching.`
      : `Imported ${imported.length} apps. Open each one in Apps and configure it before launching.`) + dataNotice
  };
}

app.post('/api/library/import', upload.single('file'), async (req, res) => {
  const uploadPath = req.file?.path || '';
  const temp = fs.mkdtempSync(path.join(tmpDir, 'library-import-'));
  try {
    if (!uploadPath) throw httpError(400, 'Choose a Dok library archive (.tar.gz)');
    const list = await run('tar', ['-tzf', uploadPath]);
    validateArchiveEntries(String(list.stdout || '').split('\n').filter(Boolean));
    await run('tar', ['-xzf', uploadPath, '-C', temp]);
    const loaded = libraryManifestFromDirectory(temp);
    if (!loaded) throw httpError(400, 'The archive does not contain dok-library.json');
    const result = await importLibraryTree({
      ...loaded,
      overwrite: req.body?.overwrite === 'true'
    });
    res.json(result);
  } catch (e) {
    res.status(e.status || 500).json({
      error: e.message,
      needsOverwrite: !!e.needsOverwrite,
      apps: e.apps || [],
      libraryName: e.libraryName || ''
    });
  } finally {
    try { fs.rmSync(temp, { recursive: true, force: true }); } catch {}
    if (uploadPath) { try { fs.rmSync(uploadPath, { force: true }); } catch {} }
  }
});

// Import a Dok app library (or a single compose/Dockerfile app) straight from
// a git repository such as GitHub. The repository is cloned into a temporary
// directory, so nothing is left behind in sources/.
app.post('/api/library/import-repo', async (req, res) => {
  const body = req.body || {};
  const repo = String(body.repo || '').trim();
  const branch = String(body.branch || '').trim();
  const subdir = String(body.path || '').trim().replace(/^[/\\]+|[/\\]+$/g, '');
  const overwrite = body.overwrite === true || body.overwrite === 'true';
  const temp = fs.mkdtempSync(path.join(tmpDir, 'library-repo-clone-'));
  try {
    if (!repo) throw httpError(400, 'Repository URL is required');
    if (!/^(https?:\/\/|git:\/\/|ssh:\/\/|git@)[^\s]+$/.test(repo)) {
      throw httpError(400, 'Repo must be an http(s), git, ssh, or git@ URL');
    }
    if (branch && !/^[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(branch)) {
      throw httpError(400, 'Invalid branch name');
    }
    if (subdir && (subdir.split('/').some(part => part === '..' || part === '') || path.isAbsolute(subdir))) {
      throw httpError(400, 'Invalid library path in repository');
    }
    const repoDir = path.join(temp, 'repo');
    const args = ['clone', '--depth', '1'];
    if (branch) args.push('--branch', branch);
    args.push(repo, repoDir);
    await run('git', args, { env: gitEnvironment(repo) });
    const repositoryReference = referenceUrlFromGitUrl(repo);
    let loaded = libraryManifestFromDirectory(repoDir, subdir);
    if (!loaded) {
      loaded = synthesizeLibraryFromRepository(repoDir, {
        name: body.name || '',
        description: body.description || '',
        referenceUrl: repositoryReference
      });
    }
    const result = await importLibraryTree({
      ...loaded,
      overwrite,
      defaultReferenceUrl: repositoryReference
    });
    if (loaded.root) { try { fs.rmSync(loaded.root, { recursive: true, force: true }); } catch {} }
    res.json({ ...result, source: 'repository', repo });
  } catch (e) {
    res.status(e.status || 500).json({
      error: e.message,
      needsOverwrite: !!e.needsOverwrite,
      apps: e.apps || [],
      libraryName: e.libraryName || ''
    });
  } finally {
    try { fs.rmSync(temp, { recursive: true, force: true }); } catch {}
  }
});

// ---------- registry ----------
app.get('/api/registry', (req, res) => {
  res.json(readRegistry());
});

async function registryAction(req, res, action) {
  try {
    const entry = readRegistry().find(r => r.id === req.params.id);
    if (!entry) return res.status(404).json({ error: 'App not found' });
    const result = await composeAction(entry, action, {
      allowStartupGrace: action === 'up',
      confirmAmend: req.body?.confirmAmend === true
    });
    try { await syncAuthVhosts(); } catch {}
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(e.status || 500).json({
      error: e.message, stdout: e.stdout, stderr: e.stderr,
      needsAmendApproval: !!e.needsAmendApproval,
      amendments: e.amendments || null,
      appName: e.appName || ''
    });
  }
}

// Legacy one-click deploy retained for the Maintenance proxy and older
// clients. Dok's Apps tab always deploys through the compose editor.
app.post('/api/registry/:id/deploy', (req, res) => registryAction(req, res, 'up'));
app.post('/api/registry/:id/:action(start|stop|restart)', (req, res) => registryAction(req, res, req.params.action));

function appEntryForRequest(req) {
  const entry = readRegistry().find(r => r.id === req.params.id);
  if (!entry) throw httpError(404, 'App not found');
  return entry;
}

// Shared by the Deploy compose editor. The saved compose becomes the app's
// new base configuration, so subsequent deploys use exactly what the user
// sees. The generated override is removed to avoid stale volume, network, or
// environment values winning over the edited base file.
function composeHasVhostKey(text) {
  return /(^|\n)\s*(?:-\s*)?['"]?VIRTUAL_HOST['"]?\s*[:=]/m.test(String(text || ''));
}

function normalizeEditedAppCompose(entry, compose, { vhostTouched = false, addDefaultNetwork = true } = {}) {
  let next = stripComposeVersion(String(compose || ''));
  next = normalizeComposeDevices(next);
  next = stripComposeProjectName(next);
  next = ensureManagedComposeHeader(next);
  const defaultNetwork = String(configuredDefaults().defaultNetwork || 'wicked').trim() || 'wicked';
  if (addDefaultNetwork && !/^networks\s*:/m.test(next) && !/\bnetwork_mode\s*:/.test(next)) {
    next = next.replace(/\s*$/, '') +
      `\n\nnetworks:\n  default:\n    name: ${yamlScalar(defaultNetwork)}\n    external: true\n`;
  }
  const vhost = String(entry?.launch?.vhost || '').trim();
  // Keep legacy routing for apps whose saved compose predates VIRTUAL_HOST, but
  // never overwrite a value the user just edited or deliberately removed.
  if (vhost && !vhostTouched && !composeHasVhostKey(next)) {
    const services = serviceNamesFromCompose(next);
    const preferred = String(entry?.launch?.name || '').trim();
    const service = services.includes(preferred) ? preferred : services[0];
    if (service) {
      // VIRTUAL_HOST and VIRTUAL_PORT are always written as a pair; the port is
      // resolved from the container mapping so nginx never receives a host
      // name without a target port.
      const vhostPort = composeVhostPortForService(next, service, entry?.launch?.vhostPort, 80);
      next = setComposeServiceEnv(next, service, { VIRTUAL_HOST: vhost, VIRTUAL_PORT: vhostPort });
    }
  }
  return next;
}

app.get('/api/apps/:id/compose', async (req, res) => {
  try {
    const entry = appEntryForRequest(req);
    const appDir = appDirFor(entry);
    const composeFile = findComposeFile(appDir);
    if (!composeFile) return res.status(404).json({ error: 'This app has no compose file' });
    let compose = fs.readFileSync(composeFile, 'utf-8');
    // The generated override may hold the routing env for compose-created apps.
    // Surface it in the editable base compose so Deploy shows the effective
    // domain and a deliberate clear can be detected by the frontend.
    compose = normalizeEditedAppCompose(entry, compose, { addDefaultNetwork: false });
    let analysis = null;
    try {
      analysis = await analyzeCompose(compose, { projectDir: appDir });
    } catch {}
    res.json({
      entry,
      appDir,
      composeFile,
      compose,
      network: entry.launch?.network || '',
      referenceUrl: sanitizeAppReferenceUrl(entry.referenceUrl),
      vhost: analysis?.vhost || entry.launch?.vhost || '',
      vhostPort: analysis?.vhostPort || entry.launch?.vhostPort || '',
      vhostService: analysis?.vhostService || '',
      issues: analysis?.issues || [],
      missingNetworks: analysis?.missingNetworks || [],
      missingVolumes: analysis?.missingVolumes || []
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.post('/api/apps/:id/compose', async (req, res) => {
  let savedComposePath = '';
  try {
    const entry = appEntryForRequest(req);
    const appDir = appDirFor(entry);
    if (isSymlink(appDir)) throw httpError(400, 'Invalid app directory');
    if (!isInsideApps(appDir)) throw httpError(400, 'Invalid app directory');
    ensureWritableDirectory(appDir, { label: 'app directory' });
    const deploy = req.body?.deploy === true;
    const force = req.body?.force === true;
    const vhostTouched = req.body?.vhostTouched === true;
    const referenceFieldProvided = Object.prototype.hasOwnProperty.call(req.body || {}, 'referenceUrl');
    const requestedReferenceUrl = String(req.body?.referenceUrl ?? '').trim();
    const normalizedReferenceUrl = sanitizeAppReferenceUrl(requestedReferenceUrl);
    if (referenceFieldProvided && requestedReferenceUrl && !normalizedReferenceUrl) {
      throw httpError(400, 'The app reference must be an http(s) repository or website URL');
    }
    const existingComposePath = findComposeFile(appDir);
    let compose = normalizeEditedAppCompose(entry, req.body?.compose || '', { vhostTouched });
    if (!compose.trim()) return res.status(400).json({ error: 'Compose file is empty' });
    const defaultsCfg = configuredDefaults();
    const requestedNetwork = String(req.body?.network || '').trim();
    const defaultNetwork = requestedNetwork || String(defaultsCfg.defaultNetwork || 'wicked').trim() || 'wicked';
    if (!isUserNetworkName(defaultNetwork) || ['bridge', 'host', 'none', 'default'].includes(defaultNetwork)) {
      throw httpError(400, 'Choose a named Docker network. Use network_mode in the compose file for host, none, bridge, or container networks.');
    }
    const networkNames = await dockerNetworkNames().catch(() => []);
    const autoCreateNetwork = defaultNetwork === 'wicked' ||
      defaultNetwork === String(defaultsCfg.defaultNetwork || 'wicked').trim() ||
      req.body?.createNetwork === true;
    if (!networkNames.includes(defaultNetwork)) {
      if (!autoCreateNetwork) {
        return res.status(400).json({
          error: `Network "${defaultNetwork}" does not exist. Create it or choose an existing network.`,
          missingNetworks: [{ key: defaultNetwork, name: defaultNetwork, form: true }]
        });
      }
      try {
        await createNetworkStrict(defaultNetwork);
        networkNames.push(defaultNetwork);
      } catch (e) {
        throw httpError(500, `Could not create the Docker network "${defaultNetwork}": ${e.message}`);
      }
    }
    if (!networkNames.includes('wicked')) {
      try {
        await createNetworkStrict('wicked');
        networkNames.push('wicked');
      } catch {}
    }
    compose = normalizeComposeNetworks(compose, networkNames, defaultNetwork).text;
    const services = serviceNamesFromCompose(compose);
    let routedService = String(req.body?.vhostService || '').trim();
    if (!services.includes(routedService)) {
      routedService = services.find(service => composeServiceEnvValue(compose, service, 'VIRTUAL_HOST')) || '';
    }
    const preferredService = services.includes(String(entry.launch?.name || entry.name || '').trim())
      ? String(entry.launch?.name || entry.name || '').trim()
      : services[0];
    if (nginxProxyInstalledSync() && routedService) {
      compose = applyNginxRoutingPolicy(compose, {
        service: routedService,
        vhostPort: String(req.body?.vhostPort || '').trim(),
        fallbackPort: readSettings().services?.nginxProxy?.defaultVhostPort || 80,
        removePorts: true,
        network: defaultNetwork
      }).compose;
    } else {
      compose = ensureComposeDokNetwork(compose, defaultNetwork, preferredService);
    }
    const validation = await validateCompose(compose, { projectDir: appDir });
    if (!validation.ok && !force) {
      return res.status(400).json({
        error: 'Compose validation failed. Fix the issues or choose to save anyway.',
        issues: validation.issues || []
      });
    }
    const composePath = existingComposePath || path.join(appDir, 'docker-compose.yml');
    writePrivateFile(composePath, compose);
    savedComposePath = composePath;
    const overridePath = path.join(appDir, 'docker-compose.wickedafdok.yml');
    try { fs.unlinkSync(overridePath); } catch {}
    // Keep the Dok ownership labels even after the routing override was
    // removed by a Deploy save.
    try {
      const services = serviceNamesFromCompose(compose);
      if (services.length) {
        writePrivateFile(overridePath, buildComposeOverride(services, {
          labels: appDokLabels(entry.name),
          baseText: compose
        }));
      }
    } catch {}
    try {
      const reg = readRegistry();
      const current = reg.find(item => item.id === entry.id);
      if (current) {
        current.needsConfig = false;
        current.composeFile = path.relative(appDir, composePath) || 'docker-compose.yml';
        if (referenceFieldProvided) current.referenceUrl = normalizedReferenceUrl;
        current.launch = current.launch || {};
        current.launch.network = defaultNetwork;
        let analyzed = false;
        try {
          const analysis = await analyzeCompose(compose, { projectDir: appDir });
          if (!analysis.unavailable && analysis.ok) {
            current.launch.vhost = analysis.vhost || '';
            current.launch.vhostPort = analysis.vhostPort || '';
            analyzed = true;
          }
        } catch {}
        if (!analyzed && vhostTouched && !composeHasVhostKey(compose)) {
          current.launch.vhost = '';
          current.launch.vhostPort = '';
        }
        writeRegistry(reg);
      }
    } catch {}
    entry.launch = entry.launch || {};
    entry.launch.network = defaultNetwork;
    let result = { stdout: 'Base configuration saved', stderr: '', renamed: [] };
    if (deploy) {
      result = await composeAction(entry, 'up', {
        allowStartupGrace: true,
        confirmAmend: req.body?.confirmAmend === true
      });
      try { await syncAuthVhosts(); } catch {}
    }
    res.json({
      ok: true,
      deploy,
      composePath,
      issues: validation.issues || [],
      ...result,
      message: result.pending
        ? (result.message || 'Changes saved; the app is still starting.')
        : deploy ? 'Changes saved and deployed.' : 'Base configuration saved.'
    });
  } catch (e) {
    res.status(e.status || 500).json({
      error: e.message, stdout: e.stdout, stderr: e.stderr,
      saved: !!savedComposePath, composePath: savedComposePath || undefined,
      needsAmendApproval: !!e.needsAmendApproval,
      amendments: e.amendments || null,
      appName: e.appName || ''
    });
  }
});

app.delete('/api/registry/:id', (req, res) => {
  try {
    writeRegistry(readRegistry().filter(r => r.id !== req.params.id));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/settings', (req, res) => {
  res.json(redactSettingsSecrets(readSettings()));
});

app.post('/api/compose/validate', async (req, res) => {
  try {
    const { compose = '', appDir = '', projectDir = '' } = req.body || {};
    const dir = projectDir || appDir;
    const result = await validateCompose(compose, { projectDir: dir && isInsideApps(dir) ? dir : '' });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/compose/parse', async (req, res) => {
  try {
    const { compose = '', appDir = '', projectDir = '' } = req.body || {};
    const dir = projectDir || appDir;
    const result = await parseComposeToBuilderModel(compose, {
      projectDir: dir && isInsideApps(dir) ? dir : ''
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, issues: [e.message], model: null });
  }
});

app.post('/api/compose/build', async (req, res) => {
  try {
    const { model, appDir = '', projectDir = '', validate = true } = req.body || {};
    const dir = projectDir || appDir;
    const result = await buildComposeFromBuilderModel(model, {
      projectDir: dir && isInsideApps(dir) ? dir : '',
      validate: validate !== false
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, issues: [e.message], fieldIssues: [], compose: '' });
  }
});

app.post('/api/settings', (req, res) => {
  try {
    const body = req.body || {};
    const current = readSettings();
    const next = { ...current, ...body };
    if (body.services) {
      next.services = { ...current.services, ...body.services };
      if (body.services.nginxProxy) next.services.nginxProxy = { ...current.services.nginxProxy, ...body.services.nginxProxy, acme: { ...(current.services.nginxProxy?.acme || {}), ...(body.services.nginxProxy.acme || {}) } };
      if (body.services.cloudflared) next.services.cloudflared = { ...current.services.cloudflared, ...body.services.cloudflared };
      if (body.services.authelia) next.services.authelia = { ...current.services.authelia, ...body.services.authelia };
      if (body.services.mail) next.services.mail = { ...current.services.mail, ...body.services.mail };
      if (body.services.mailpit) next.services.mailpit = { ...current.services.mailpit, ...body.services.mailpit };
      if (body.services.dns) next.services.dns = { ...current.services.dns, ...body.services.dns };
      if (body.services.adguard) next.services.adguard = { ...current.services.adguard, ...body.services.adguard };
      if (body.services.stalwart) next.services.stalwart = { ...current.services.stalwart, ...body.services.stalwart };
    }
    if (!next.services) next.services = {};
    if (!next.services.nginxProxy) next.services.nginxProxy = {};
    if (!next.services.nginxProxy.network) next.services.nginxProxy.network = 'wicked';
    preserveEmptySettingsSecrets(next, current, body.clearSecrets);
    delete next.clearSecrets;
    const ng = next.services.nginxProxy;
    if (ng.domain !== undefined) {
      ng.domain = normalizeDomain(ng.domain);
      if (ng.domain && !/^[A-Za-z0-9*][A-Za-z0-9*._-]*$/.test(ng.domain)) {
        return res.status(400).json({ error: 'Invalid domain name' });
      }
    }
    if (ng.defaultVhostPort !== undefined && ng.defaultVhostPort !== '') {
      const vp = Number(ng.defaultVhostPort);
      if (!Number.isInteger(vp) || vp < 1 || vp > 65535) {
        return res.status(400).json({ error: 'Default VIRTUAL_PORT must be between 1 and 65535' });
      }
      ng.defaultVhostPort = vp;
    }
    if (ng.httpPort === undefined || ng.httpPort === null || ng.httpPort === '') {
      ng.httpPort = 80;
    } else {
      const hp = Number(ng.httpPort);
      if (!Number.isInteger(hp) || hp < 1 || hp > 65535 || hp === 443) {
        return res.status(400).json({ error: 'nginx-proxy HTTP port must be between 1 and 65535 and cannot be 443' });
      }
      ng.httpPort = hp;
    }
    writeSettings(next);
    res.json(redactSettingsSecrets(next));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function dataModeValue(value) {
  const text = String(value ?? '').trim().replace(/^0o/i, '').replace(/^0+/, '') || '775';
  if (!/^[0-7]{3,4}$/.test(text)) throw httpError(400, 'Data directory permissions must be an octal mode such as 775 or 0775');
  const mode = parseInt(text, 8);
  if (mode < 0o700) throw httpError(400, 'Data directory permissions must allow the owner to read, write, and enter the directory (at least 700)');
  return mode;
}

function storedDataMode(value) {
  return '0' + dataModeValue(value).toString(8).padStart(3, '0');
}

function defaultsForClient(settings) {
  const source = settings || readSettings();
  const defaults = defaultsDefaults(source.defaults || {});
  if (!defaults.dokDomain) defaults.dokDomain = normalizeDomain(source.services?.nginxProxy?.domain || '');
  const redacted = redactSettingsSecrets({ defaults }).defaults;
  redacted.adminPasswordSet = !!defaults.adminPassword;
  return redacted;
}

function validateDefaultDomain(value, label) {
  const domain = normalizeDomain(value);
  if (domain && !/^[A-Za-z0-9*][A-Za-z0-9*._-]*$/.test(domain)) {
    throw httpError(400, `Invalid ${label}`);
  }
  return domain;
}

async function applyDefaultDataLocation(defaults, { includeApps = true } = {}) {
  const location = String(defaults?.dataLocation || '').trim();
  if (!location) return { path: '', mode: '' };
  if (!path.isAbsolute(location) || location === '/' || /[\r\n:\0]/.test(location)) {
    throw httpError(400, 'Data location must be a dedicated absolute host path without colons or newlines');
  }
  const mode = dataModeValue(defaults.dataMode);
  await ensureHostDirectory(location, { label: 'data location', action: 'creating', mode });
  if (includeApps) {
    const appsRoot = path.join(location, 'apps');
    await ensureHostDirectory(appsRoot, { label: 'data location apps directory', action: 'creating', mode });
  }
  return { path: location, mode: '0' + mode.toString(8).padStart(3, '0') };
}

function configuredDefaults() {
  return defaultsDefaults(readSettings().defaults || {});
}

function appDefaultDataDir(name) {
  const defaults = configuredDefaults();
  if (!defaults.dataLocation || defaults.autoAppData === false) return '';
  return path.join(defaults.dataLocation, 'apps', projectName(name, 'app'), 'data');
}

function dataLocationContains(target, defaults = configuredDefaults()) {
  if (!defaults.dataLocation || !target) return true;
  const root = path.resolve(defaults.dataLocation);
  const resolved = path.resolve(String(target));
  return resolved === root || resolved.startsWith(root + path.sep);
}

function defaultVolumeSource(name, target, defaults = configuredDefaults()) {
  if (!defaults.dataLocation) return '';
  const slug = String(target || '')
    .replace(/^[/\\]+/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'data';
  const base = path.join(defaults.dataLocation, 'apps', projectName(name, 'app'), 'data');
  return slug === 'data' ? base : path.join(base, slug);
}

async function ensureAppDataDirectory(name) {
  const dir = appDefaultDataDir(name);
  if (!dir) return '';
  const defaults = configuredDefaults();
  await ensureHostDirectory(dir, {
    label: 'app data directory',
    action: 'creating',
    mode: dataModeValue(defaults.dataMode)
  });
  return dir;
}

function defaultsPatch(current, body = {}) {
  const next = defaultsDefaults(current);
  if (body.primaryDomain !== undefined) next.primaryDomain = validateDefaultDomain(body.primaryDomain, 'primary domain');
  if (body.dokDomain !== undefined) next.dokDomain = validateDefaultDomain(body.dokDomain, 'Dok domain');
  if (body.dataLocation !== undefined) {
    const location = String(body.dataLocation || '').trim();
    if (location && !path.isAbsolute(location)) throw httpError(400, 'Data location must be an absolute path');
    if (/[\r\n:\0]/.test(location)) throw httpError(400, 'Data location contains unsupported characters');
    if (location === '/') throw httpError(400, 'Choose a dedicated data location directory, not the filesystem root');
    next.dataLocation = location ? path.resolve(location) : '';
  }
  if (body.dataMode !== undefined) next.dataMode = storedDataMode(body.dataMode);
  if (body.allowOutsideData !== undefined) next.allowOutsideData = body.allowOutsideData === true;
  if (body.autoAppData !== undefined) next.autoAppData = body.autoAppData === true;
  if (body.protectDok !== undefined) next.protectDok = body.protectDok === true;
  if (body.adminUser !== undefined) {
    const user = String(body.adminUser || '').trim();
    if (user && !/^[A-Za-z0-9._@-]+$/.test(user)) throw httpError(400, 'Invalid default admin username');
    next.adminUser = user || 'admin';
  }
  if (body.adminEmail !== undefined) {
    const email = String(body.adminEmail || '').trim();
    if (email && (!email.includes('@') || /[\r\n<>]/.test(email))) throw httpError(400, 'Invalid default admin email');
    next.adminEmail = email;
  }
  if (body.clearAdminPassword === true) next.adminPassword = '';
  else if (body.adminPassword) next.adminPassword = String(body.adminPassword);
  if (body.defaultNetwork !== undefined) {
    const network = String(body.defaultNetwork || '').trim() || 'wicked';
    if (!isUserNetworkName(network) || network === 'bridge') throw httpError(400, 'Invalid default network name');
    next.defaultNetwork = network;
  }
  const nginxDomain = normalizeDomain(body.nginxDomain || '');
  if (!next.dokDomain && nginxDomain) next.dokDomain = nginxDomain;
  if (next.protectDok && !next.dokDomain) {
    throw httpError(400, 'Set a Dok domain (or a nginx domain) before requiring auth on the Dok UI');
  }
  return next;
}

app.get('/api/settings/defaults', (req, res) => {
  try {
    res.json({ ok: true, defaults: defaultsForClient(readSettings()) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.post('/api/settings/defaults', async (req, res) => {
  try {
    const settings = readSettings();
    const defaults = defaultsPatch(settings.defaults || {}, { ...(req.body || {}), nginxDomain: settings.services?.nginxProxy?.domain || '' });
    if (defaults.protectDok && !normalizeDomain(settings.services?.authelia?.domain || '')) {
      throw httpError(400, 'Set the Authelia portal domain in Core Services before requiring login for the Dok UI');
    }
    const applied = await applyDefaultDataLocation(defaults);
    if (defaults.dokDomain && !normalizeDomain(settings.services?.nginxProxy?.domain || '')) {
      settings.services = settings.services || {};
      settings.services.nginxProxy = {
        ...(settings.services.nginxProxy || {}),
        domain: defaults.dokDomain
      };
    }
    settings.defaults = defaults;
    writeSettings(settings);
    const publicDefaults = defaultsForClient(settings);
    let synced = null;
    let syncError = '';
    if (req.body?.protectDok !== undefined || defaults.protectDok) {
      try { synced = await syncAuthVhosts(); } catch (e) {
        syncError = e.message;
        appendServerLog('WARN', `Authelia sync after defaults change failed: ${e.message}`);
      }
    }
    if (defaults.protectDok && (syncError || !(synced?.hosts || []).includes(defaults.dokDomain))) {
      // Do not report success when Authelia did not actually generate the
      // auth_request vhost (for example because the Dok domain is outside the
      // portal's cookie domain). Revert the setting so the UI cannot imply
      // protection that is not in place.
      defaults.protectDok = false;
      settings.defaults = defaults;
      writeSettings(settings);
      return res.status(syncError ? 500 : 400).json({
        error: syncError
          ? `Authelia protection could not be applied: ${syncError}`
          : `Authelia did not activate login for ${defaults.dokDomain}. The Dok domain must share the Authelia portal's cookie domain.`,
        protectDok: false,
        dokDomain: defaults.dokDomain,
        ...(synced || {})
      });
    }
    res.json({ ok: true, defaults: publicDefaults, dataLocation: applied.path, dataMode: applied.mode, protectDok: defaults.protectDok, synced });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.post('/api/settings/defaults/apply', async (req, res) => {
  try {
    const settings = readSettings();
    const defaults = defaultsDefaults(settings.defaults || {});
    const applied = await applyDefaultDataLocation(defaults);
    res.json({ ok: true, dataLocation: applied.path, dataMode: applied.mode });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

const BUILTIN_CORE_GROUP = { id: 'core-services', name: 'Core Services' };

// ---------- designer ----------
function designerLogoPath() {
  const logo = String(readSettings().designer?.logo || '').trim();
  if (!logo) return '';
  const target = path.resolve(designerDir, logo);
  if (!target.startsWith(designerDir + path.sep)) return '';
  return fs.existsSync(target) ? target : '';
}

function designerFilesRoot() {
  const rootDir = path.join(coreDir, 'nginx-proxy');
  fs.mkdirSync(rootDir, { recursive: true });
  return rootDir;
}

function designerFilePath(relPath, { forWrite = false } = {}) {
  const base = fs.realpathSync(designerFilesRoot());
  const target = path.resolve(base, '.' + path.sep + String(relPath || '').replace(/^[/\\]+/, ''));
  if (target !== base && !target.startsWith(base + path.sep)) throw httpError(400, 'Invalid designer path');
  // Check the real path of the file (or its parent for new files) so a symlink
  // inside core/nginx-proxy cannot be used to read or write outside it.
  const probe = fs.existsSync(target) ? target : path.dirname(target);
  let real = probe;
  try { real = fs.realpathSync(probe); } catch {}
  if (real !== base && !real.startsWith(base + path.sep)) throw httpError(400, 'Invalid designer path');
  if (!forWrite && !fs.existsSync(target)) throw httpError(404, 'File not found');
  return target;
}

app.get('/api/designer', (req, res) => {
  const settings = readSettings();
  const logo = designerLogoPath();
  res.json({
    ...(settings.designer || {}),
    logo: '',
    hasLogo: !!logo,
    logoUrl: logo ? `/api/designer/logo?v=${fs.statSync(logo).mtimeMs}` : ''
  });
});

app.post('/api/designer', (req, res) => {
  try {
    const body = req.body || {};
    const settings = readSettings();
    const current = { ...(settings.designer || {}) };
    if (body.name !== undefined) {
      const name = String(body.name || '').trim().slice(0, 60);
      current.name = name || 'WickedAFDok';
    }
    if (body.tagline !== undefined) current.tagline = String(body.tagline || '').trim().slice(0, 140);
    if (body.css !== undefined) {
      const css = String(body.css || '');
      if (css.length > 200 * 1024) return res.status(400).json({ error: 'CSS override is limited to 200 KB' });
      current.css = css;
    }
    if (body.removeLogo === true) {
      const logo = designerLogoPath();
      if (logo) { try { fs.unlinkSync(logo); } catch {} }
      current.logo = '';
    }
    settings.designer = current;
    writeSettings(settings);
    res.json({
      ok: true,
      designer: { ...current, logo: '', hasLogo: !!designerLogoPath(), logoUrl: designerLogoPath() ? '/api/designer/logo' : '' }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/designer/logo', upload.single('logo'), (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'Choose an image file' });
  try {
    const allowed = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/svg+xml': '.svg', 'image/x-icon': '.ico', 'image/vnd.microsoft.icon': '.ico' };
    let ext = allowed[file.mimetype] || path.extname(file.originalname || '').toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.webp', '.svg', '.ico'].includes(ext)) {
      try { fs.unlinkSync(file.path); } catch {}
      return res.status(400).json({ error: 'Logo must be a PNG, JPG, WebP, SVG, or ICO image' });
    }
    if (ext === '.jpeg') ext = '.jpg';
    const target = path.join(designerDir, `logo${ext}`);
    for (const name of fs.readdirSync(designerDir)) {
      if (/^logo\.[a-z0-9]+$/i.test(name) && path.join(designerDir, name) !== target) {
        try { fs.unlinkSync(path.join(designerDir, name)); } catch {}
      }
    }
    try {
      fs.renameSync(file.path, target);
    } catch {
      fs.copyFileSync(file.path, target);
      try { fs.unlinkSync(file.path); } catch {}
    }
    try { fs.chmodSync(target, 0o600); } catch {}
    const settings = readSettings();
    settings.designer = { ...(settings.designer || {}), logo: path.basename(target) };
    writeSettings(settings);
    res.json({ ok: true, logoUrl: `/api/designer/logo?v=${Date.now()}`, hasLogo: true });
  } catch (e) {
    try { if (file?.path) fs.unlinkSync(file.path); } catch {}
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/designer/logo', (req, res) => {
  const logo = designerLogoPath();
  if (!logo) return res.status(404).json({ error: 'No logo configured' });
  res.set('Cache-Control', 'no-cache');
  res.sendFile(logo);
});

app.get('/api/designer/files', (req, res) => {
  try {
    const base = designerFilesRoot();
    const items = [];
    const walk = (dir, prefix = '') => {
      if (items.length >= 800) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          items.push({ name: entry.name, rel, type: 'dir' });
          walk(full, rel);
        } else if (entry.isFile()) {
          const stat = fs.statSync(full);
          items.push({ name: entry.name, rel, type: 'file', size: stat.size });
        }
      }
    };
    walk(base);
    // Error pages come first so the Designer opens a page, not the compose
    // file. Other files keep the existing alphabetical order.
    const fileRank = (rel) => {
      if (rel === 'html/404.html') return 0;
      if (rel === 'html/403.html') return 1;
      if (rel === 'html/errors/50x.html') return 2;
      if (rel.startsWith('html/')) return 3;
      if (rel.startsWith('vhost.d/')) return 4;
      if (rel === 'docker-compose.yml' || rel === 'docker-compose.yaml') return 9;
      return 5;
    };
    items.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      if (a.type === 'file') {
        const rank = fileRank(a.rel) - fileRank(b.rel);
        if (rank) return rank;
      }
      return a.rel.localeCompare(b.rel);
    });
    res.json({ root: 'core/nginx-proxy', items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/designer/file', (req, res) => {
  try {
    const rel = String(req.query.path || '');
    if (!rel) return res.status(400).json({ error: 'path required' });
    if (/\.(key|pem)$/i.test(rel)) return res.status(403).json({ error: 'Private key files are not editable here' });
    const target = designerFilePath(rel);
    const stat = fs.statSync(target);
    if (!stat.isFile()) return res.status(400).json({ error: 'Not a file' });
    if (stat.size > 1024 * 1024) return res.status(400).json({ error: 'File is too large to edit (max 1 MB)' });
    const buffer = fs.readFileSync(target);
    if (buffer.includes(0)) return res.status(400).json({ error: 'Binary files cannot be edited' });
    res.json({ path: rel, content: buffer.toString('utf-8') });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.post('/api/designer/file', (req, res) => {
  try {
    const rel = String(req.body?.path || '');
    const content = String(req.body?.content ?? '');
    if (!rel) return res.status(400).json({ error: 'path required' });
    if (/\.(key|pem)$/i.test(rel)) return res.status(403).json({ error: 'Private key files are not editable here' });
    if (content.length > 1024 * 1024) return res.status(400).json({ error: 'File content is limited to 1 MB' });
    const target = designerFilePath(rel, { forWrite: true });
    // Existing extensionless files (for example nginx vhost snippets) are
    // editable; new files must use a known text extension.
    if (!fs.existsSync(target) &&
        (!/\.[A-Za-z0-9]+$/.test(rel) ||
         !/\.(html?|conf|txt|css|js|json|md|xml|svg|log)$/i.test(rel))) {
      return res.status(400).json({ error: 'Only text configuration, HTML, CSS, JavaScript, JSON, and log files can be edited' });
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // nginx workers serve HTML and read vhost configs as a non-root user, so
    // these files must stay world-readable. Paths are sandboxed above and
    // private key files are rejected, so 0644 is safe here.
    fs.writeFileSync(target, content, { mode: 0o644 });
    try { fs.chmodSync(target, 0o644); } catch {}
    res.json({ ok: true, path: rel, message: 'File saved. Restart nginx-proxy to reload configuration changes.' });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.get('/api/groups', async (req, res) => {
  try {
    const data = readJson(groupsPath, { groups: [] });
    if (!Array.isArray(data.groups)) data.groups = [];
    // The Core Services group is computed from live containers, so it always
    // includes every bundled service without the user maintaining a list.
    let coreIds = [];
    try {
      const containers = await docker.listContainers({ all: true });
      coreIds = containers
        .filter(c => coreContainerInfo({ name: (c.Names || [])[0], Labels: c.Labels || {} }).core)
        .map(c => c.Id);
    } catch {}
    const groups = data.groups
      .filter(g => g.id !== BUILTIN_CORE_GROUP.id && String(g.name || '').toLowerCase() !== 'core services')
      .map(g => ({ ...g, builtin: false }));
    res.json({ groups: [{ ...BUILTIN_CORE_GROUP, containers: coreIds, builtin: true, protected: true }, ...groups] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/groups', (req, res) => {
  try {
    const data = readJson(groupsPath, { groups: [] });
    if (!Array.isArray(data.groups)) data.groups = [];
    const { name, containers = [] } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name required' });
    if (String(name).trim().toLowerCase() === 'core services') {
      return res.status(400).json({ error: 'Core Services is a built-in group and cannot be edited' });
    }
    const list = Array.isArray(containers) ? containers : [];
    const existing = data.groups.find(g => g.name === name);
    if (existing) {
      existing.containers = list;
    } else {
      data.groups.push({ id: Date.now().toString(), name, containers: list });
    }
    writeJson(groupsPath, data);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/groups/:id', (req, res) => {
  try {
    if (req.params.id === BUILTIN_CORE_GROUP.id) {
      return res.status(403).json({ error: 'Core Services is a built-in group and cannot be deleted' });
    }
    const data = readJson(groupsPath, { groups: [] });
    if (!Array.isArray(data.groups)) data.groups = [];
    data.groups = data.groups.filter(g => g.id !== req.params.id);
    writeJson(groupsPath, data);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/registries', (req, res) => {
  const data = readRegistries();
  res.json({ connections: data.connections.map(publicRegistryConnection) });
});

app.post('/api/registries', (req, res) => {
  try {
    const body = req.body || {};
    const kind = body.kind === 'git' ? 'git' : 'registry';
    const host = normalizeRegistryHost(body.host);
    const provider = String(body.provider || 'custom').trim() || 'custom';
    const name = String(body.name || '').trim() || host;
    const username = String(body.username || '').trim() || (kind === 'git' ? 'x-access-token' : '');
    const secret = typeof body.secret === 'string' ? body.secret : '';
    const id = body.id ? String(body.id) : '';
    if (!host) return res.status(400).json({ error: 'Host is required' });
    if (!/^[a-z0-9][a-z0-9.:-]*$/.test(host)) {
      return res.status(400).json({ error: 'Host must be a hostname such as ghcr.io or github.com' });
    }
    if (kind === 'registry' && !username) {
      return res.status(400).json({ error: 'Username is required for container registries' });
    }
    if (!id && !secret) return res.status(400).json({ error: 'Password or access token is required' });

    const data = readRegistries();
    if (id) {
      const existing = data.connections.find(c => c.id === id);
      if (!existing) return res.status(404).json({ error: 'Connection not found' });
      Object.assign(existing, { kind, provider, name, host, username, updated: new Date().toISOString() });
      if (secret) existing.secretEnc = encryptSecret(secret);
      delete existing.secret;
      writeRegistries(data);
      return res.json({ connection: publicRegistryConnection(existing) });
    }

    const connection = {
      id: `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
      kind,
      provider,
      name,
      host,
      username,
      secretEnc: encryptSecret(secret),
      created: new Date().toISOString(),
      updated: new Date().toISOString()
    };
    data.connections.unshift(connection);
    writeRegistries(data);
    res.json({ connection: publicRegistryConnection(connection) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/registries/:id', (req, res) => {
  try {
    const data = readRegistries();
    const before = data.connections.length;
    data.connections = data.connections.filter(c => c.id !== req.params.id);
    if (data.connections.length === before) return res.status(404).json({ error: 'Connection not found' });
    writeRegistries(data);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/registries/:id/test', async (req, res) => {
  const data = readRegistries();
  const connection = data.connections.find(c => c.id === req.params.id);
  if (!connection) return res.status(404).json({ error: 'Connection not found' });
  const secret = registrySecret(connection);
  if (!secret) return res.status(400).json({ error: 'This connection has no stored secret' });
  const host = normalizeRegistryHost(connection.host);
  try {
    if (connection.kind === 'git') {
      if (host === 'github.com') {
        const response = await fetch('https://api.github.com/user', {
          headers: {
            Authorization: `Bearer ${secret}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'WickedAFDok'
          },
          signal: AbortSignal.timeout(15000)
        });
        if (!response.ok) {
          return res.status(400).json({ error: `GitHub rejected the token (HTTP ${response.status})` });
        }
        const user = await response.json().catch(() => ({}));
        return res.json({ ok: true, message: `Authenticated with GitHub${user.login ? ` as ${user.login}` : ''}` });
      }
      if (host === 'gitlab.com') {
        const response = await fetch('https://gitlab.com/api/v4/user', {
          headers: { 'PRIVATE-TOKEN': secret },
          signal: AbortSignal.timeout(15000)
        });
        if (!response.ok) {
          return res.status(400).json({ error: `GitLab rejected the token (HTTP ${response.status})` });
        }
        const user = await response.json().catch(() => ({}));
        return res.json({ ok: true, message: `Authenticated with GitLab${user.username ? ` as ${user.username}` : ''}` });
      }
      return res.json({
        ok: true,
        message: 'Connection saved. It will be used automatically for HTTPS git operations on this host.'
      });
    }

    const dir = fs.mkdtempSync(path.join(tmpDir, 'registry-login-'));
    try {
      await runInput(
        'docker',
        ['login', host, '--username', connection.username || 'token', '--password-stdin'],
        secret,
        { env: { ...process.env, DOCKER_CONFIG: dir } }
      );
      res.json({ ok: true, message: `Authenticated with ${host}` });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch (e) {
    res.status(400).json({ error: e.message, stdout: e.stdout, stderr: e.stderr });
  }
});

app.get('/api/auth', (req, res) => {
  const data = readJson(authPath, { enabled: false, users: [] });
  const users = (Array.isArray(data.users) ? data.users : []).map(user => {
    const { pass, ...rest } = user && typeof user === 'object' ? user : {};
    return { ...rest, hasPassword: !!pass };
  });
  res.json({ ...data, users });
});

app.post('/api/auth', (req, res) => {
  try {
    const data = readJson(authPath, { enabled: false, users: [] });
    const body = req.body || {};
    const existingUsers = Array.isArray(data.users) ? data.users : [];
    let users = body.users;
    if (Array.isArray(users)) {
      users = users.map(user => {
        const next = user && typeof user === 'object' ? { ...user } : {};
        const previous = existingUsers.find(existing => existing?.user === next.user);
        if (typeof next.pass !== 'string' || !next.pass) next.pass = previous?.pass || '';
        return next;
      });
    }
    const next = { ...data, ...body, ...(Array.isArray(users) ? { users } : {}) };
    writeJson(authPath, next);
    res.json({
      ...next,
      users: (Array.isArray(next.users) ? next.users : []).map(user => {
        const { pass, ...rest } = user && typeof user === 'object' ? user : {};
        return { ...rest, hasPassword: !!pass };
      })
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/dns', (req, res) => {
  res.json(readJson(dnsPath, { enabled: false, provider: 'technitium', url: '', token: '' }));
});

app.post('/api/dns', (req, res) => {
  try {
    const data = readJson(dnsPath, { enabled: false, provider: 'technitium', url: '', token: '' });
    const next = { ...data, ...req.body };
    writeJson(dnsPath, next);
    res.json(next);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/networks/create', async (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name required' });
    const result = await createNetworkStrict(name);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.get('/api/networks', async (req, res) => {
  try {
    const nets = await docker.listNetworks();
    res.json(nets);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Core services - nginx-proxy
app.get('/api/core/nginx-proxy', async (req, res) => {
  try {
    const settings = readSettings();
    const nginxDir = path.join(coreDir, 'nginx-proxy');
    if (!fs.existsSync(nginxDir)) fs.mkdirSync(nginxDir, { recursive: true });
    ensureNginxErrorPages();
    const composePath = path.join(nginxDir, 'docker-compose.yml');
    // Never create the compose file just by reading status: a generated file
    // would make a fresh install look "installed" before the user ever
    // launched nginx-proxy. Only an existing file counts as installed.
    const existingCompose = fs.existsSync(composePath);
    if (existingCompose) {
      try {
        await ensureNginxProxyCompose({ recreate: true });
      } catch (e) {
        appendServerLog('WARN', `nginx-proxy compose check failed: ${e.message}`);
      }
    }
    const composeExists = fs.existsSync(composePath);
    // A live (or stopped) container is what makes nginx-proxy "installed".
    // The compose file alone is not enough: if the container was removed, a
    // saved compose must not trap the card in manage mode. Only a failed
    // Docker lookup falls back to the compose file so a transient error does
    // not flip a running install back to the create view.
    let status = { exists: false, running: false, state: 'not created', containerId: null, lookupFailed: true };
    try {
      status = await coreServiceStatus('nginx-proxy', { nameHint: 'nginx-proxy', primaryHint: 'nginx-proxy' });
    } catch (e) {
      appendServerLog('WARN', `nginx-proxy status lookup failed: ${e.message}`);
    }
    res.json({
      ...status,
      installed: !!(status.exists || (status.lookupFailed && composeExists)),
      composeExists,
      dir: nginxDir,
      composePath,
      compose: composeExists ? readComposeText(composePath) : '',
      settings: settings.services?.nginxProxy || {},
      acme: nginxProxyAcme(settings.services?.nginxProxy?.acme || {})
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/core/nginx-proxy/compose', async (req, res) => {
  try {
    const { compose } = req.body || {};
    if (!compose) return res.status(400).json({ error: 'compose required' });
    const nginxDir = path.join(coreDir, 'nginx-proxy');
    if (!fs.existsSync(nginxDir)) fs.mkdirSync(nginxDir, { recursive: true });
    const composePath = path.join(nginxDir, 'docker-compose.yml');
    writePrivateFile(composePath, String(compose));
    res.json({ ok: true, path: composePath });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/core/nginx-proxy/acme', async (req, res) => {
  try {
    const settings = readSettings();
    const current = nginxProxyAcme(settings.services?.nginxProxy?.acme || {});
    const body = req.body || {};
    const next = nginxProxyAcme({
      ...current,
      enabled: body.enabled !== undefined ? body.enabled === true : current.enabled,
      email: body.email !== undefined ? String(body.email || '').trim() : current.email,
      staging: body.staging !== undefined ? body.staging === true : current.staging
    });
    next.enabled = !!next.enabled && !!next.email;
    if (next.enabled && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next.email)) {
      return res.status(400).json({ error: 'A valid certificate email is required' });
    }
    settings.services = settings.services || {};
    settings.services.nginxProxy = { ...(settings.services.nginxProxy || {}), acme: next };
    writeSettings(settings);
    const ensured = await ensureNginxProxyCompose({ recreate: true });
    res.json({
      ok: true,
      acme: next,
      message: next.enabled
        ? `acme-companion is enabled${next.staging ? ' (staging certificates)' : ''}. ${ensured.recreated ? 'nginx-proxy was recreated.' : 'It will be used the next time nginx-proxy starts.'}`
        : 'acme-companion is disabled. Place certificates in core/nginx-proxy/certs or use another certificate method.'
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});


app.post('/api/core/nginx-proxy/run', async (req, res) => {
  try {
    const body = req.body || {};
    const settings = readSettings();
    const configured = settings.services?.nginxProxy || {};
    const installDefaults = configuredDefaults();
    const network = String(body.network || configured.network || installDefaults.defaultNetwork || 'wicked').trim() || 'wicked';
    const configuredDomain = configured.domain || installDefaults.dokDomain || '';
    const domain = normalizeDomain(body.domain !== undefined ? body.domain : configuredDomain);
    if (domain && !/^[A-Za-z0-9*][A-Za-z0-9*._-]*$/.test(domain)) {
      return res.status(400).json({ error: 'Invalid domain name' });
    }
    const configuredAcme = nginxProxyAcme(configured.acme || {});
    const acme = nginxProxyAcme(body.acme && typeof body.acme === 'object'
      ? { ...configuredAcme, ...body.acme }
      : configuredAcme);
    acme.email = String(acme.email || '').trim();
    acme.enabled = !!acme.enabled && !!acme.email;
    if (acme.enabled && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(acme.email)) {
      return res.status(400).json({ error: 'A valid certificate email is required for acme-companion' });
    }
    const port = process.env.PORT || 8080;
    if (body.httpPort !== undefined && body.httpPort !== null && body.httpPort !== '') {
      const requestedPort = Number(body.httpPort);
      if (!Number.isInteger(requestedPort) || requestedPort < 1 || requestedPort > 65535 || requestedPort === 443) {
        return res.status(400).json({ error: 'nginx-proxy HTTP port must be between 1 and 65535 and cannot be 443' });
      }
    }
    let httpPort = nginxProxyHttpPort(body.httpPort !== undefined ? body.httpPort : configured.httpPort);
    let portFallback = false;
    let portFallbackFrom = 0;
    await ensureNetwork(network);

    const nginxDir = path.join(coreDir, 'nginx-proxy');
    if (!fs.existsSync(nginxDir)) fs.mkdirSync(nginxDir, { recursive: true });
    fs.mkdirSync(path.join(nginxDir, 'vhost.d'), { recursive: true });
    fs.mkdirSync(path.join(nginxDir, 'certs'), { recursive: true });
    if (acme.enabled) fs.mkdirSync(path.join(nginxDir, 'acme'), { recursive: true });
    ensureNginxErrorPages();
    const composePath = path.join(nginxDir, 'docker-compose.yml');
    recoverOversizedManagedCompose(composePath);
    const existingCompose = readComposeText(composePath);
    const managedCompose = existingCompose.startsWith('# managed-by: wickedafdok');
    const networkLine = `name: ${network}`;
    const quotedNetworkLine = `name: ${yamlScalar(network)}`;
    const hostLine = `DEFAULT_HOST=${domain}`;
    const quotedHostLine = `DEFAULT_HOST=${yamlScalar(domain)}`;
    const hasAcme = /(^|\n)\s*acme-companion\s*:/.test(existingCompose);
    const acmeStale = managedCompose && (acme.enabled !== hasAcme ||
      (acme.enabled && (!existingCompose.includes(`DEFAULT_EMAIL=${yamlScalar(acme.email)}`) ||
        (acme.staging && !existingCompose.includes('acme-staging-v02.api.letsencrypt.org')) ||
        (!acme.staging && existingCompose.includes('acme-staging-v02.api.letsencrypt.org')))));
    const staleCompose = managedCompose && (
      (!existingCompose.includes(networkLine) && !existingCompose.includes(quotedNetworkLine)) ||
      (domain
        ? !existingCompose.includes(hostLine) && !existingCompose.includes(quotedHostLine)
        : existingCompose.includes('DEFAULT_HOST=')) ||
      !existingCompose.includes('/etc/nginx/vhost.d') ||
      !existingCompose.includes('/etc/nginx/certs') ||
      !existingCompose.includes('/usr/share/nginx/html') ||
      !nginxComposeHasHttpPort(existingCompose, httpPort) ||
      acmeStale
    );
    // Docker resolves bind sources on the daemon's side, so a compose file in
    // the app container must name host paths. A relative ./vhost.d would point
    // at /app/... on the daemon host (or a new root-owned dir), hiding the
    // generated configs from nginx-proxy.
    const coreHostDir = await selfMountSource('/app/core');
    const nginxHostDir = coreHostDir ? path.join(coreHostDir, 'nginx-proxy') : '';
    let nextCompose = existingCompose;
    if (managedCompose && nginxHostDir) {
      nextCompose = setMountSource(nextCompose, '/etc/nginx/vhost.d', path.join(nginxHostDir, 'vhost.d'));
      nextCompose = setMountSource(nextCompose, '/etc/nginx/certs', path.join(nginxHostDir, 'certs'));
      nextCompose = setMountSource(nextCompose, '/usr/share/nginx/html', path.join(nginxHostDir, 'html'));
    }
    if (!managedCompose) httpPort = nginxComposeHttpPort(existingCompose);
    if (!nextCompose || staleCompose) {
      nextCompose = nginxProxyCompose(network, domain, nginxHostDir, acme, httpPort);
    }
    if (nextCompose !== existingCompose) writePrivateFile(composePath, nextCompose);

    try {
      const list = await docker.listContainers({ all: true });
      const stale = list.find(c => (c.Names || []).some(n => n.replace(/^\//, '') === 'nginx-proxy') &&
        c.State !== 'running' && c.Labels?.['com.docker.compose.project'] !== 'nginx-proxy');
      if (stale) await docker.getContainer(stale.Id).remove({ force: true });
    } catch {}

    const usedHostPorts = await publishedHostPorts();
    let resOut = { stdout: '', stderr: '' };
    for (let attempt = 0; ; attempt += 1) {
      try {
        resOut = await run('docker', ['compose', '-f', composePath, '-p', 'nginx-proxy', 'up', '-d', '--remove-orphans'], { cwd: nginxDir });
        break;
      } catch (upError) {
        if (!nginxProxyPortConflict(upError)) {
          resOut = await run('docker', ['compose', '-f', composePath, '-p', 'nginx-proxy', 'up', '-d'], { cwd: nginxDir });
          break;
        }
        const previousPort = httpPort;
        const fallbackPort = attempt >= 10 ? 0 : nextNginxProxyHttpPort(httpPort, usedHostPorts);
        if (!fallbackPort) throw upError;
        usedHostPorts.add(previousPort);
        if (!portFallbackFrom) portFallbackFrom = previousPort;
        portFallback = true;
        httpPort = fallbackPort;
        appendServerLog('WARN', `nginx-proxy could not bind host port ${previousPort}; retrying on ${fallbackPort}`);
        nextCompose = managedCompose && nginxHostDir
          ? nginxProxyCompose(network, domain, nginxHostDir, acme, httpPort)
          : setNginxComposeHttpPort(nextCompose, httpPort);
        writePrivateFile(composePath, nextCompose);
      }
    }
    try { await syncAuthVhosts(); } catch {}

    const nextSettings = readSettings();
    nextSettings.services = nextSettings.services || {};
    nextSettings.services.nginxProxy = {
      ...(nextSettings.services.nginxProxy || {}),
      enabled: true,
      network,
      domain,
      httpPort,
      acme
    };
    writeSettings(nextSettings);

    let selfUpdate = null;
    if (domain) {
      try {
        selfUpdate = await scheduleSelfRecreate(domain, network);
      } catch (e) {
        console.error('wickedafdok self-update failed', e.message);
        selfUpdate = { scheduled: false, error: e.message };
      }
      try {
        const ngxList = await docker.listContainers({ all: true });
        const ngx = ngxList.find(c => (c.Names || []).some(n => n.replace(/^\//, '') === 'nginx-proxy'));
        if (ngx) await docker.getContainer(ngx.Id).restart().catch(() => {});
      } catch {}
      try {
        const wadList = await docker.listContainers({ all: true });
        const dokList = wadList.filter(c => {
          const names = (c.Names || []).map(n => (n || '').replace(/^\//, ''));
          if (c.Labels?.['dok.maintenance'] === 'true') return false;
          return names.some(n => /wickedafdok/i.test(n) && !/updater|helper|maintenance/i.test(n));
        });
        const wad2 = dokList.find(c => (c.Names || []).some(n => n.replace(/^\//, '') === 'wickedafdok')) || dokList[0];
        if (wad2) {
          try { await docker.getNetwork(network).connect({ Container: wad2.Id }); } catch {}
        }
      } catch {}
      try {
        const rootCompose = path.join(root, 'docker-compose.yml');
        if (fs.existsSync(rootCompose)) {
          const rc = fs.readFileSync(rootCompose, 'utf-8');
          if (!rc.includes('image: wickedafdok:latest')) {
            fs.writeFileSync(rootCompose, rc.replace(/build:\s*\.\s*/g, 'image: wickedafdok:latest\n    build: .\n'));
          }
        }
      } catch {}
    }

    const host = req.hostname || 'localhost';
    const domainOrigin = domain ? `http://${domain}${httpPort !== 80 ? `:${httpPort}` : ''}` : '';
    let message = 'nginx-proxy launched';
    if (selfUpdate?.scheduled) {
      message = `WickedAFDok will be updated with the new domain and recreated. Access it at ${domainOrigin} or http://${host}:${port} if the domain is not working yet.`;
    } else if (selfUpdate?.connected) {
      message = `nginx-proxy launched. WickedAFDok joined the ${network} network. Access it at ${domainOrigin} or http://${host}:${port}.`;
    } else if (selfUpdate?.already) {
      message = `nginx-proxy launched. WickedAFDok is already configured for ${domainOrigin}. It is also available at http://${host}:${port}.`;
    } else if (selfUpdate?.error) {
      message = `nginx-proxy launched, but WickedAFDok could not be reconfigured: ${selfUpdate.error}`;
    } else if (domain) {
      message = `nginx-proxy launched. Access WickedAFDok at http://${host}:${port}.`;
    }
    if (httpPort !== 80) {
      message += ` nginx-proxy is published on host port ${httpPort}${portFallbackFrom === 80 ? ' because port 80 was unavailable' : ''}; include the port in domain links.`;
    }

    return res.json({
      ok: true,
      stdout: resOut.stdout,
      stderr: resOut.stderr,
      message,
      domain,
      httpPort,
      portFallback,
      portFallbackFrom,
      port,
      selfUpdate
    });
  } catch (e) {
    res.status(500).json({ error: e.message, stdout: e.stdout, stderr: e.stderr });
  }
});

// Core services - cloudflared
app.get('/api/core/cloudflared', async (req, res) => {
  try {
    const settings = readSettings();
    const cfDir = path.join(coreDir, 'cloudflared');
    if (!fs.existsSync(cfDir)) fs.mkdirSync(cfDir, { recursive: true });
    const composePath = path.join(cfDir, 'docker-compose.yml');
    const existingCompose = readManagedCompose(composePath);
    if (!existingCompose) {
      writePrivateFile(composePath, cloudflaredCompose(settings.services?.cloudflared?.token || ''));
    }
    let running = false;
    let exists = false;
    let state = 'not created';
    let containerId = null;
    let lookupFailed = false;
    try {
      const containers = await docker.listContainers({ all: true });
      const found = containers.find(c =>
        c.Labels?.['com.docker.compose.project'] === 'cloudflared' ||
        (c.Names || []).some(n => n.replace(/^\//, '') === 'cloudflared')
      );
      if (found) {
        exists = true;
        state = found.State;
        containerId = found.Id;
        running = found.State === 'running';
      }
    } catch {
      lookupFailed = true;
    }
    res.json({
      exists,
      running,
      state,
      containerId,
      lookupFailed,
      dir: cfDir,
      composePath,
      compose: readManagedCompose(composePath),
      settings: redactServiceSecrets('cloudflared', settings.services?.cloudflared || {})
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/core/cloudflared/compose', async (req, res) => {
  try {
    const { compose } = req.body || {};
    if (!compose) return res.status(400).json({ error: 'compose required' });
    const cfDir = path.join(coreDir, 'cloudflared');
    if (!fs.existsSync(cfDir)) fs.mkdirSync(cfDir, { recursive: true });
    const composePath = path.join(cfDir, 'docker-compose.yml');
    writePrivateFile(composePath, String(compose));
    res.json({ ok: true, path: composePath });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/core/cloudflared/run', async (req, res) => {
  try {
    const { token } = req.body || {};
    const settings = readSettings();
    const newToken = String(token || '').trim();
    if (newToken) {
      settings.services = settings.services || {};
      settings.services.cloudflared = { ...(settings.services.cloudflared || {}), token: newToken, enabled: true };
      writeSettings(settings);
    }
    const cfDir = path.join(coreDir, 'cloudflared');
    if (!fs.existsSync(cfDir)) fs.mkdirSync(cfDir, { recursive: true });
    const composePath = path.join(cfDir, 'docker-compose.yml');
    const existingCompose = readManagedCompose(composePath);
    if (!existingCompose || newToken) {
      const s = readSettings();
      writePrivateFile(composePath, cloudflaredCompose(s.services?.cloudflared?.token || ''));
    }
    const s2 = readSettings();
    s2.services = s2.services || {};
    s2.services.cloudflared = { ...(s2.services.cloudflared || {}), enabled: true };
    writeSettings(s2);
    const { stdout, stderr } = await run('docker', ['compose', '-f', composePath, '-p', 'cloudflared', 'up', '-d', '--remove-orphans'], { cwd: cfDir });
    res.json({ ok: true, stdout, stderr });
  } catch (e) {
    res.status(500).json({ error: e.message, stdout: e.stdout, stderr: e.stderr });
  }
});

// Core services - Authentik
app.get('/api/core/auth', async (req, res) => {
  try {
    const settings = readSettings();
    const dir = path.join(coreDir, 'auth');
    const composePath = path.join(dir, 'docker-compose.yml');
    const authSettings = settings.services?.authentik || {};
    const secretKey = authSettings.secretKey || randomSecret(32);
    const postgresPassword = authSettings.postgresPassword || randomSecret(24);
    const existing = readManagedCompose(composePath);
    const coreHostDir = await selfMountSource('/app/core');
    const compose = existing.trim() ? existing : authentikCompose({ ...authSettings, secretKey, postgresPassword }, coreHostDir ? path.join(coreHostDir, 'auth') : '');
    const status = await coreServiceStatus('authentik', { nameHint: 'authentik', primaryHint: 'authentik-server' });
    res.json({
      ...status,
      dir,
      composePath,
      compose,
      settings: redactServiceSecrets('authentik', settings.services?.authentik || {}),
      url: coreServiceUrl(settings.services?.authentik?.domain, settings.services?.authentik?.port || 9000)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/core/auth/compose', async (req, res) => {
  try {
    const { compose } = req.body || {};
    if (!compose) return res.status(400).json({ error: 'compose required' });
    const composePath = coreServiceFile('auth');
    writePrivateFile(composePath, String(compose));
    res.json({ ok: true, path: composePath });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/core/auth/run', async (req, res) => {
  try {
    const body = req.body || {};
    const settings = readSettings();
    const installDefaults = configuredDefaults();
    const auth = { ...(settings.services?.authentik || {}) };
    if (body.adminEmail !== undefined) auth.adminEmail = String(body.adminEmail || '').trim();
    else if (!auth.adminEmail) auth.adminEmail = installDefaults.adminEmail;
    if (body.adminPassword) auth.adminPassword = String(body.adminPassword);
    else if (!auth.adminPassword && installDefaults.adminPassword) auth.adminPassword = installDefaults.adminPassword;
    if (body.domain === undefined && !auth.domain && installDefaults.primaryDomain) {
      auth.domain = normalizeDomain('sso.' + installDefaults.primaryDomain);
    }
    if (body.domain !== undefined) {
      const domain = normalizeDomain(body.domain);
      if (domain && !/^[A-Za-z0-9*][A-Za-z0-9*._-]*$/.test(domain)) return res.status(400).json({ error: 'Invalid domain name' });
      auth.domain = domain;
    }
    if (body.port !== undefined) {
      const port = Number(body.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return res.status(400).json({ error: 'Invalid HTTP port' });
      auth.port = port;
    }
    if (!auth.secretKey) auth.secretKey = randomSecret(32);
    if (!auth.postgresPassword) auth.postgresPassword = randomSecret(24);
    auth.enabled = true;
    await ensureNetwork('wicked');
    const composePath = coreServiceFile('auth');
    const coreHostDir = await selfMountSource('/app/core');
    const authHostDir = coreHostDir ? path.join(coreHostDir, 'auth') : '';
    prepareHostBindDirs(authHostDir, [['postgres', 0o700], ['media', 0o777], ['custom-templates', 0o755]]);
    writePrivateFile(composePath, authentikCompose(auth, authHostDir));
    const { stdout, stderr } = await run('docker', ['compose', '-f', composePath, '-p', 'authentik', 'up', '-d', '--remove-orphans'], { cwd: coreServiceDir('auth') });
    settings.services = settings.services || {};
    settings.services.authentik = auth;
    writeSettings(settings);
    res.json({ ok: true, stdout, stderr, message: 'Authentik is starting. Open the Authentik UI to manage users and protect applications.', url: coreServiceUrl(auth.domain, auth.port) });
  } catch (e) {
    res.status(500).json({ error: e.message, stdout: e.stdout, stderr: e.stderr });
  }
});

app.post('/api/core/auth/domain', async (req, res) => {
  try {
    const settings = readSettings();
    const auth = { ...(settings.services?.authentik || {}) };
    const domain = normalizeDomain(req.body?.domain);
    if (domain && !/^[A-Za-z0-9*][A-Za-z0-9*._-]*$/.test(domain)) {
      return res.status(400).json({ error: 'Invalid domain name' });
    }
    auth.domain = domain;
    settings.services = settings.services || {};
    settings.services.authentik = auth;
    writeSettings(settings);
    const dir = coreServiceDir('auth');
    const composePath = path.join(dir, 'docker-compose.yml');
    const status = await coreServiceStatus('authentik', { nameHint: 'authentik', primaryHint: 'authentik-server' });
    let stdout = '';
    let stderr = '';
    const compose = readManagedCompose(composePath);
    if (compose.trim()) {
      writePrivateFile(composePath, setComposeServiceEnv(compose, 'server', {
        VIRTUAL_HOST: domain,
        VIRTUAL_PORT: domain ? '9000' : ''
      }));
      if (status.running) {
        ({ stdout, stderr } = await run('docker', ['compose', '-f', composePath, '-p', 'authentik', 'up', '-d', '--remove-orphans'], { cwd: dir }));
      }
    }
    res.json({ ok: true, domain, restarted: status.running, url: coreServiceUrl(domain, auth.port || 9000), stdout, stderr });
  } catch (e) {
    res.status(500).json({ error: e.message, stdout: e.stdout, stderr: e.stderr });
  }
});

// Core services - Authelia
app.get('/api/core/authelia', async (req, res) => {
  try {
    const settings = readSettings();
    const dir = coreServiceDir('authelia');
    const composePath = path.join(dir, 'docker-compose.yml');
    const stored = autheliaDefaults(settings.services?.authelia || {});
    const preview = {
      ...stored,
      sessionSecret: stored.sessionSecret || randomSecret(32),
      encryptionKey: stored.encryptionKey || randomSecret(32),
      jwtSecret: stored.jwtSecret || randomSecret(32)
    };
    const existing = readManagedCompose(composePath);
    const coreHostDir = await selfMountSource('/app/core');
    const compose = existing.trim()
      ? existing
      : autheliaCompose(preview, coreHostDir ? path.join(coreHostDir, 'authelia') : '');
    const status = await coreServiceStatus('authelia', { nameHint: 'authelia', primaryHint: 'authelia' });
    let protectedHosts = [];
    try {
      const state = JSON.parse(fs.readFileSync(path.join(coreServiceDir('nginx-proxy'), 'vhost.d', '.wickedafdok-auth.json'), 'utf-8'));
      protectedHosts = Array.isArray(state.hosts) ? state.hosts : [];
    } catch {}
    res.json({
      ...status,
      dir,
      composePath,
      compose,
      settings: redactServiceSecrets('authelia', stored),
      protectedHosts,
      url: stored.domain ? `https://${stored.domain}` : `http://localhost:${stored.port || 9091}`
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/core/authelia/compose', async (req, res) => {
  try {
    const { compose } = req.body || {};
    if (!compose) return res.status(400).json({ error: 'compose required' });
    const composePath = coreServiceFile('authelia');
    writePrivateFile(composePath, String(compose));
    res.json({ ok: true, path: composePath });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/core/authelia/run', async (req, res) => {
  try {
    const body = req.body || {};
    const settings = readSettings();
    const authelia = autheliaDefaults(settings.services?.authelia || {});
    const installDefaults = configuredDefaults();
    let domain = normalizeDomain(body.domain !== undefined ? body.domain : authelia.domain);
    if (!domain && installDefaults.primaryDomain) domain = normalizeDomain('auth.' + installDefaults.primaryDomain);
    if (!domain) return res.status(400).json({ error: 'Authelia needs a portal domain, for example auth.example.com' });
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(domain) || !domain.includes('.')) {
      return res.status(400).json({ error: 'Invalid domain name (Authelia needs a domain with a dot)' });
    }
    if (body.port !== undefined) {
      const port = Number(body.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return res.status(400).json({ error: 'Invalid HTTP port' });
      authelia.port = port;
    }
    if (body.adminUser !== undefined) {
      const user = String(body.adminUser || '').trim();
      if (user && !/^[A-Za-z0-9._@-]+$/.test(user)) return res.status(400).json({ error: 'Invalid admin username' });
      authelia.adminUser = user || 'admin';
    }
    if (body.adminEmail !== undefined) authelia.adminEmail = String(body.adminEmail || '').trim();
    else if (!authelia.adminEmail) authelia.adminEmail = installDefaults.adminEmail;
    if (body.adminUser === undefined && (!authelia.adminUser || authelia.adminUser === 'admin')) {
      authelia.adminUser = installDefaults.adminUser || 'admin';
    }
    const providedPassword = body.adminPassword ? String(body.adminPassword) : '';
    if (providedPassword) authelia.adminPassword = providedPassword;
    if (!authelia.adminPassword) authelia.adminPassword = installDefaults.adminPassword || randomSecret(12);
    if (!authelia.sessionSecret) authelia.sessionSecret = randomSecret(32);
    if (!authelia.encryptionKey) authelia.encryptionKey = randomSecret(32);
    if (!authelia.jwtSecret) authelia.jwtSecret = randomSecret(32);
    let generatedPassword = '';
    if (!authelia.adminPasswordHash || providedPassword) {
      authelia.adminPasswordHash = await autheliaPasswordHash(authelia.adminPassword);
      if (!providedPassword) generatedPassword = authelia.adminPassword;
    }
    authelia.domain = domain;
    authelia.enabled = true;
    await ensureNetwork('wicked');
    settings.services = settings.services || {};
    settings.services.authelia = authelia;
    writeSettings(settings);
    const composePath = coreServiceFile('authelia');
    const coreHostDir = await selfMountSource('/app/core');
    writePrivateFile(composePath, autheliaCompose(
      authelia,
      coreHostDir ? path.join(coreHostDir, 'authelia') : ''
    ));
    await writeAutheliaConfig(authelia, await authProtectedCookieDomains(domain));
    const synced = await syncAuthVhosts();
    const { stdout, stderr } = await run('docker', ['compose', '-f', composePath, '-p', 'authelia', 'up', '-d', '--remove-orphans'], { cwd: coreServiceDir('authelia') });
    await syncAuthVhosts();
    const credentials = generatedPassword ? { username: authelia.adminUser, password: generatedPassword } : null;
    res.json({
      ok: true,
      stdout,
      stderr,
      url: `https://${domain}`,
      credentials,
      protectedHosts: synced.hosts,
      message: `Authelia is starting at https://${domain}.${generatedPassword ? ` Sign in as ${authelia.adminUser} with the generated password shown here.` : ''} Apps that set ENABLE_AUTH=true are protected automatically.`
    });
  } catch (e) {
    res.status(500).json({ error: e.message, stdout: e.stdout, stderr: e.stderr });
  }
});

app.post('/api/core/authelia/domain', async (req, res) => {
  try {
    const settings = readSettings();
    const authelia = autheliaDefaults(settings.services?.authelia || {});
    const domain = normalizeDomain(req.body?.domain);
    if (domain && (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(domain) || !domain.includes('.'))) {
      return res.status(400).json({ error: 'Invalid domain name (Authelia needs a domain with a dot)' });
    }
    authelia.domain = domain;
    settings.services = settings.services || {};
    settings.services.authelia = authelia;
    writeSettings(settings);
    const composePath = path.join(coreServiceDir('authelia'), 'docker-compose.yml');
    const status = await coreServiceStatus('authelia', { nameHint: 'authelia', primaryHint: 'authelia' });
    let stdout = '';
    let stderr = '';
    const compose = readManagedCompose(composePath);
    if (compose.trim()) {
      let next = compose;
      const coreHostDir = await selfMountSource('/app/core');
      if (coreHostDir) {
        next = setMountSource(next, '/config', path.join(coreHostDir, 'authelia', 'config'));
      }
      next = setComposeServiceEnv(next, 'authelia', {
        VIRTUAL_HOST: domain,
        VIRTUAL_PORT: domain ? '9091' : ''
      });
      writePrivateFile(composePath, next);
      if (domain && authelia.adminPasswordHash) {
        await writeAutheliaConfig(authelia, await authProtectedCookieDomains(domain));
      }
      if (status.running) {
        ({ stdout, stderr } = await run('docker', ['compose', '-f', composePath, '-p', 'authelia', 'up', '-d', '--remove-orphans'], { cwd: coreServiceDir('authelia') }));
      }
    }
    const synced = await syncAuthVhosts();
    res.json({ ok: true, domain, restarted: status.running, url: domain ? `https://${domain}` : '', protectedHosts: synced.hosts, stdout, stderr });
  } catch (e) {
    res.status(500).json({ error: e.message, stdout: e.stdout, stderr: e.stderr });
  }
});


function autheliaUsersForClient(raw = {}) {
  const authelia = autheliaDefaults(raw);
  const admin = {
    username: authelia.adminUser || 'admin',
    email: authelia.adminEmail || '',
    admin: true,
    passwordSet: !!authelia.adminPasswordHash,
    disabled: false
  };
  const users = (Array.isArray(authelia.users) ? authelia.users : [])
    .filter(entry => entry && entry.username && entry.username !== admin.username)
    .map(entry => ({
      username: String(entry.username),
      displayname: String(entry.displayname || entry.username),
      email: String(entry.email || ''),
      disabled: entry.disabled === true,
      passwordSet: !!(entry.passwordHashEnc || entry.passwordHash),
      admin: false
    }));
  return { admin, users };
}

async function refreshAutheliaConfig(raw = null, { restart = true } = {}) {
  const settings = raw || readSettings();
  const authelia = autheliaDefaults(settings.services?.authelia || {});
  if (!authelia.domain) throw httpError(400, 'Set the Authelia portal domain first');
  if (!authelia.adminPasswordHash) throw httpError(400, 'Set the Authelia admin password first');
  const cookieDomains = await authProtectedCookieDomains(authelia.domain);
  const written = await writeAutheliaConfig(authelia, cookieDomains);
  let restarted = false;
  if (restart && written.changed) {
    const containers = await docker.listContainers({ all: false }).catch(() => []);
    if (containers.some(c => (c.Names || []).some(n => n.replace(/^\//, '') === 'authelia'))) {
      await run('docker', ['restart', 'authelia']).catch(() => {});
      restarted = true;
    }
  }
  return { changed: written.changed, restarted };
}

function validAutheliaUsername(value) {
  const username = String(value || '').trim();
  if (!username || !/^[A-Za-z0-9][A-Za-z0-9._@-]*$/.test(username)) {
    throw httpError(400, 'Usernames may only contain letters, numbers, dots, underscores, @, and hyphens');
  }
  return username;
}

function validAutheliaEmail(value) {
  const email = String(value || '').trim();
  if (email && (!email.includes('@') || /[\r\n<>]/.test(email))) throw httpError(400, 'Invalid email address');
  return email;
}


app.post('/api/core/authelia/admin', async (req, res) => {
  try {
    const body = req.body || {};
    const settings = readSettings();
    const authelia = autheliaDefaults(settings.services?.authelia || {});
    if (body.username !== undefined) authelia.adminUser = validAutheliaUsername(body.username);
    if (body.email !== undefined) authelia.adminEmail = validAutheliaEmail(body.email);
    if (body.password) {
      const password = String(body.password);
      if (password.length < 8) return res.status(400).json({ error: 'Passwords must be at least 8 characters' });
      authelia.adminPassword = password;
      authelia.adminPasswordHash = await autheliaPasswordHash(password);
    }
    settings.services = settings.services || {};
    settings.services.authelia = authelia;
    writeSettings(settings);
    let applied = false;
    let message;
    if (authelia.domain) {
      try {
        await refreshAutheliaConfig(settings, { restart: true });
        applied = true;
        message = 'Admin account saved and Authelia restarted.';
      } catch (e) {
        appendServerLog('WARN', `Authelia admin refresh failed: ${e.message}`);
        message = `Admin saved, but Authelia could not be updated: ${e.message}`;
      }
    } else {
      message = 'Admin account saved. Set the Authelia portal domain in Core Services to apply it.';
    }
    try { await syncAuthVhosts(); } catch {}
    res.json({ ok: true, applied, message, ...autheliaUsersForClient(authelia) });
  } catch (e) {
    appendServerLog('WARN', `Authelia admin save failed: ${e.message}`);
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.get('/api/core/authelia/users', (req, res) => {
  try {
    const settings = readSettings();
    res.json({ ok: true, ...autheliaUsersForClient(settings.services?.authelia || {}) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.post('/api/core/authelia/users', async (req, res) => {
  try {
    const body = req.body || {};
    const settings = readSettings();
    const authelia = autheliaDefaults(settings.services?.authelia || {});
    const username = validAutheliaUsername(body.username);
    const original = body.originalUsername ? validAutheliaUsername(body.originalUsername) : username;
    if (username === String(authelia.adminUser || 'admin')) {
      return res.status(400).json({ error: 'Use the admin credentials section to change the admin account' });
    }
    const users = Array.isArray(authelia.users) ? authelia.users.slice() : [];
    const index = users.findIndex(entry => String(entry?.username || '') === original);
    if (users.some((entry, entryIndex) => entryIndex !== index && String(entry?.username || '') === username)) {
      return res.status(409).json({ error: 'A user with that name already exists' });
    }
    const existing = index >= 0 ? users[index] : {};
    const email = validAutheliaEmail(body.email);
    const displayname = String(body.displayname || username).trim() || username;
    let passwordHashEnc = String(existing.passwordHashEnc || '');
    const password = body.password ? String(body.password) : '';
    if (password) {
      if (password.length < 8) return res.status(400).json({ error: 'Passwords must be at least 8 characters' });
      passwordHashEnc = encryptSecret(await autheliaPasswordHash(password));
    }
    if (!passwordHashEnc && !existing.passwordHash) {
      return res.status(400).json({ error: 'A password is required for a new Authelia user' });
    }
    const entry = { username, displayname, email, disabled: body.disabled === true, passwordHashEnc };
    if (index >= 0) users[index] = entry;
    else users.push(entry);
    authelia.users = users;
    settings.services = settings.services || {};
    settings.services.authelia = authelia;
    writeSettings(settings);
    let applied = false;
    let message;
    if (authelia.domain && authelia.adminPasswordHash) {
      try {
        await refreshAutheliaConfig(settings, { restart: true });
        applied = true;
        message = 'Saved. Authelia was refreshed.';
      } catch (e) {
        appendServerLog('WARN', `Authelia user refresh failed: ${e.message}`);
        message = `Saved, but Authelia could not be updated: ${e.message}`;
      }
    } else {
      message = authelia.domain
        ? 'Saved, but the Authelia admin password is not set. Save the admin account to apply users.'
        : 'Saved. Set the Authelia portal domain in Core Services to apply users.';
    }
    try { await syncAuthVhosts(); } catch {}
    res.json({ ok: true, applied, message, ...autheliaUsersForClient(authelia) });
  } catch (e) {
    appendServerLog('WARN', `Authelia user save failed: ${e.message}`);
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.delete('/api/core/authelia/users/:username', async (req, res) => {
  try {
    const settings = readSettings();
    const authelia = autheliaDefaults(settings.services?.authelia || {});
    const username = validAutheliaUsername(req.params.username);
    if (username === String(authelia.adminUser || 'admin')) {
      return res.status(400).json({ error: 'The admin account cannot be removed' });
    }
    authelia.users = (Array.isArray(authelia.users) ? authelia.users : [])
      .filter(entry => String(entry?.username || '') !== username);
    settings.services = settings.services || {};
    settings.services.authelia = authelia;
    writeSettings(settings);
    let applied = false;
    let message;
    if (authelia.domain && authelia.adminPasswordHash) {
      try {
        await refreshAutheliaConfig(settings, { restart: true });
        applied = true;
        message = 'User removed. Authelia was refreshed.';
      } catch (e) {
        appendServerLog('WARN', `Authelia user refresh failed: ${e.message}`);
        message = `User removed, but Authelia could not be updated: ${e.message}`;
      }
    } else {
      message = 'User removed. Set the Authelia portal domain and admin password to apply users.';
    }
    try { await syncAuthVhosts(); } catch {}
    res.json({ ok: true, applied, message, ...autheliaUsersForClient(authelia) });
  } catch (e) {
    appendServerLog('WARN', `Authelia user delete failed: ${e.message}`);
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.post('/api/core/authelia/dok-protection', async (req, res) => {
  try {
    const settings = readSettings();
    const protect = req.body?.protect === true;
    const defaults = defaultsDefaults(settings.defaults || {});
    const dokDomain = normalizeDomain(defaults.dokDomain || settings.services?.nginxProxy?.domain || '');
    if (protect && !dokDomain) {
      return res.status(400).json({ error: 'Set the Dok domain in Dok Settings before requiring authentication' });
    }
    if (protect && !normalizeDomain(settings.services?.authelia?.domain || '')) {
      return res.status(400).json({ error: 'Set the Authelia portal domain in Core Services before requiring authentication' });
    }
    defaults.protectDok = protect;
    if (!defaults.dokDomain && dokDomain) defaults.dokDomain = dokDomain;
    settings.defaults = defaults;
    writeSettings(settings);
    let synced;
    try {
      synced = await syncAuthVhosts();
    } catch (e) {
      if (protect) {
        defaults.protectDok = false;
        settings.defaults = defaults;
        writeSettings(settings);
      }
      throw e;
    }
    if (protect && !(synced.hosts || []).includes(dokDomain)) {
      defaults.protectDok = false;
      settings.defaults = defaults;
      writeSettings(settings);
      return res.status(400).json({
        error: `Authelia did not activate login for ${dokDomain}. The Dok domain must share the Authelia portal's cookie domain.`,
        protectDok: false,
        dokDomain,
        ...synced
      });
    }
    res.json({ ok: true, protectDok: protect, active: protect, dokDomain, ...synced });
  } catch (e) {
    // Report the setting as it now stands so the checkbox cannot disagree with
    // the saved state after a failed sync.
    let protectDok = false;
    try { protectDok = !!defaultsDefaults(readSettings().defaults || {}).protectDok; } catch {}
    res.status(e.status || 500).json({ error: e.message, protectDok });
  }
});

app.post('/api/core/authelia/sync', async (req, res) => {
  try {
    const synced = await syncAuthVhosts();
    res.json({ ok: true, ...synced });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function containerHasEnv(info, key, value) {
  const env = info?.Config?.Env || [];
  const prefix = `${key}=`;
  const found = env.find(item => item.startsWith(prefix));
  if (found === undefined) return false;
  return value === undefined || found.slice(prefix.length) === value;
}

// Recreate a standalone container with an added environment variable while
// keeping its image, command, mounts, ports, labels, and networks. The new
// container is created under a temporary name first so a failed create leaves
// the original untouched.
async function recreateContainerWithEnv(info, envPatch) {
  const name = String(info.Name || '').replace(/^\//, '');
  const tempName = `${name}-auth-${crypto.randomBytes(3).toString('hex')}`;
  const env = (info.Config?.Env || [])
    .filter(item => !Object.keys(envPatch).some(key => item.startsWith(`${key}=`)));
  for (const [key, value] of Object.entries(envPatch)) env.push(`${key}=${value}`);
  const endpoints = {};
  for (const [network, config] of Object.entries(info.NetworkSettings?.Networks || {})) {
    endpoints[network] = { Aliases: Array.isArray(config.Aliases) && config.Aliases.length ? config.Aliases : undefined };
  }
  const createOptions = {
    name: tempName,
    Image: info.Config?.Image,
    Env: env,
    Cmd: info.Config?.Cmd,
    Entrypoint: info.Config?.Entrypoint,
    WorkingDir: info.Config?.WorkingDir,
    User: info.Config?.User,
    Tty: info.Config?.Tty === true,
    OpenStdin: info.Config?.OpenStdin === true,
    StdinOnce: info.Config?.StdinOnce === true,
    AttachStdin: false,
    AttachStdout: false,
    AttachStderr: false,
    Labels: info.Config?.Labels || {},
    ExposedPorts: info.Config?.ExposedPorts || {},
    StopSignal: info.Config?.StopSignal,
    StopTimeout: info.Config?.StopTimeout,
    Healthcheck: info.Config?.Healthcheck,
    HostConfig: info.HostConfig || {},
    NetworkingConfig: { EndpointsConfig: endpoints }
  };
  let created;
  try {
    created = await docker.createContainer(createOptions);
  } catch (e) {
    throw new Error(`Could not prepare the updated container: ${e.message}`);
  }
  const old = docker.getContainer(info.Id);
  try {
    await old.stop({ t: 20 }).catch(() => {});
    await old.remove({ force: false });
    await created.rename({ name });
    await created.start();
  } catch (e) {
    // Try to leave the user with a usable container rather than a half-removed
    // one. The temporary container keeps the updated configuration.
    try { await created.start(); } catch {}
    throw new Error(
      `The updated container was created as "${tempName}" but could not replace "${name}": ${e.message}`
    );
  }
  return { name, container: tempName };
}

async function addAuthEnvToProject(project, serviceName, composeFile, appDir) {
  const compose = fs.readFileSync(composeFile, 'utf-8');
  if (!serviceNamesFromCompose(compose).includes(serviceName)) {
    throw new Error(`Service "${serviceName}" was not found in the app compose file`);
  }
  const next = setComposeServiceEnv(compose, serviceName, { ENABLE_AUTH: 'true' });
  const patched = next !== compose;
  if (patched) writePrivateFile(composeFile, next);
  const overridePath = path.join(appDir, 'docker-compose.wickedafdok.yml');
  const args = ['compose', '-f', composeFile, '-p', project];
  if (fs.existsSync(overridePath)) args.push('-f', overridePath);
  args.push('up', '-d', '--remove-orphans');
  await run('docker', args, { cwd: appDir });
  return patched;
}

app.post('/api/core/auth/apply', async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
    if (!ids.length) return res.status(400).json({ error: 'Select at least one container' });
    const results = [];
    const projects = new Map();
    for (const id of ids) {
      try {
        const info = await docker.getContainer(id).inspect();
        const name = String(info.Name || '').replace(/^\//, '');
        const protection = coreContainerInfo({ name, Labels: info.Config?.Labels || {} });
        if (protection.protected) {
          results.push({ id, name, ok: false, skipped: true, reason: 'Protected core service' });
          continue;
        }
        if (containerHasEnv(info, 'ENABLE_AUTH', 'true')) {
          results.push({ id, name, ok: true, already: true, reason: 'Already protected' });
          continue;
        }
        const labels = info.Config?.Labels || {};
        const project = labels['com.docker.compose.project'] || '';
        const service = labels['com.docker.compose.service'] || '';
        if (project && service) {
          const entry = readRegistry().find(item =>
            projectName(item.name, 'app') === project ||
            path.basename(appDirFor(item)) === project);
          const appDir = entry ? appDirFor(entry) : path.join(appsDir, project);
          const composeFile = findComposeFile(appDir);
          if (composeFile) {
            if (!projects.has(project)) projects.set(project, { appDir, composeFile, ids: [] });
            projects.get(project).ids.push({ id, name, service });
            continue;
          }
        }
        await recreateContainerWithEnv(info, { ENABLE_AUTH: 'true' });
        results.push({ id, name, ok: true, method: 'recreate' });
      } catch (e) {
        results.push({ id, name: id, ok: false, error: e.message });
      }
    }
    for (const [project, target] of projects) {
      try {
        let patched = false;
        for (const item of target.ids) {
          if (await addAuthEnvToProject(project, item.service, target.composeFile, target.appDir)) patched = true;
        }
        for (const item of target.ids) {
          results.push({ id: item.id, name: item.name, ok: true, method: 'compose', patched });
        }
      } catch (e) {
        for (const item of target.ids) {
          results.push({ id: item.id, name: item.name, ok: false, error: e.message });
        }
      }
    }
    let syncError = '';
    try { await syncAuthVhosts(); } catch (e) {
      syncError = e.message;
      appendServerLog('WARN', `Authelia sync after enabling auth failed: ${e.message}`);
    }
    const applied = results.filter(item => item.ok && !item.already).length;
    const already = results.filter(item => item.already).length;
    const failed = results.filter(item => !item.ok && !item.skipped);
    // ENABLE_AUTH only produces nginx forward-auth configs once Authelia has a
    // portal domain. Tell the user instead of leaving them with a silent no-op.
    const authelia = autheliaDefaults(readSettings().services?.authelia || {});
    const portalReady = !!normalizeDomain(authelia.domain);
    const suffix = applied && !portalReady ? ' Set the Authelia portal domain in Core Services to activate the protection.' : '';
    const syncSuffix = syncError ? ` Protected-host sync failed: ${syncError}` : '';
    res.json({
      ok: failed.length === 0 && !syncError,
      applied,
      already,
      failed: failed.length,
      syncError,
      results,
      message: applied
        ? `Enabled auth on ${applied} container${applied === 1 ? '' : 's'}.${suffix}${syncSuffix}`
        : already ? `Those containers already have auth enabled.${syncSuffix}` : `No containers were changed.${syncSuffix}`
    });
  } catch (e) {
    res.status(500).json({ error: e.message, stdout: e.stdout, stderr: e.stderr });
  }
});

// Core services - DNS (Technitium or AdGuard Home)
function dnsProviderName(settings = {}) {
  return settings.services?.dns?.provider === 'adguard' ? 'adguard' : 'technitium';
}

function dnsServiceMeta(provider) {
  if (provider === 'adguard') {
    return { provider, project: 'adguard', service: 'adguard', nameHint: 'adguard', label: 'AdGuard Home', webPort: 3000 };
  }
  return { provider, project: 'technitium', service: 'technitium-dns', nameHint: 'technitium-dns', label: 'Technitium DNS', webPort: 5380 };
}

app.get('/api/core/dns', async (req, res) => {
  try {
    const settings = readSettings();
    const provider = dnsProviderName(settings);
    const meta = dnsServiceMeta(provider);
    const dir = path.join(coreDir, 'dns');
    const composePath = path.join(dir, 'docker-compose.yml');
    const providerSettings = provider === 'adguard'
      ? adguardDefaults(settings.services?.adguard || {})
      : { ...(settings.services?.technitium || {}) };
    if (provider !== 'adguard' && !providerSettings.adminPassword) providerSettings.adminPassword = randomSecret(12);
    const existing = readManagedCompose(composePath);
    const coreHostDir = await selfMountSource('/app/core');
    const hostDir = coreHostDir ? path.join(coreHostDir, 'dns') : '';
    const existingProvider = /(^|\n)\s*adguard\s*:/.test(existing) ? 'adguard' : 'technitium';
    const compose = existing.trim() && existingProvider === provider
      ? existing
      : (provider === 'adguard' ? adguardCompose(providerSettings, hostDir) : technitiumCompose(providerSettings, hostDir));
    const status = await coreServiceStatus(meta.project, { nameHint: meta.nameHint, primaryHint: meta.nameHint });
    res.json({
      ...status,
      provider,
      dir,
      composePath,
      compose,
      settings: provider === 'adguard'
        ? adguardDefaults(settings.services?.adguard || {})
        : redactServiceSecrets('technitium', settings.services?.technitium || {}),
      providers: {
        technitium: redactServiceSecrets('technitium', settings.services?.technitium || {}),
        adguard: adguardDefaults(settings.services?.adguard || {})
      },
      url: coreServiceUrl(providerSettings.domain, providerSettings.webPort || meta.webPort)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/core/dns/compose', async (req, res) => {
  try {
    const { compose } = req.body || {};
    if (!compose) return res.status(400).json({ error: 'compose required' });
    const composePath = coreServiceFile('dns');
    writePrivateFile(composePath, String(compose));
    res.json({ ok: true, path: composePath });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/core/dns/run', async (req, res) => {
  try {
    const body = req.body || {};
    const settings = readSettings();
    const provider = body.provider === 'adguard' || body.provider === 'technitium'
      ? body.provider
      : dnsProviderName(settings);
    const meta = dnsServiceMeta(provider);
    const installDefaults = configuredDefaults();
    const dns = provider === 'adguard'
      ? adguardDefaults(settings.services?.adguard || {})
      : { ...(settings.services?.technitium || {}) };
    if (provider !== 'adguard') {
      if (body.adminPassword) dns.adminPassword = String(body.adminPassword);
      else if (!dns.adminPassword && installDefaults.adminPassword) dns.adminPassword = installDefaults.adminPassword;
    }
    if (body.domain === undefined && !dns.domain && installDefaults.primaryDomain) {
      dns.domain = normalizeDomain('dns.' + installDefaults.primaryDomain);
    }
    if (body.webPort !== undefined) {
      const port = Number(body.webPort);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return res.status(400).json({ error: 'Invalid web port' });
      dns.webPort = port;
    }
    if (body.dnsPort !== undefined) {
      const port = Number(body.dnsPort);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return res.status(400).json({ error: 'Invalid DNS port' });
      dns.dnsPort = port;
    }
    if (body.domain !== undefined) {
      const domain = normalizeDomain(body.domain);
      if (domain && !/^[A-Za-z0-9*][A-Za-z0-9*._-]*$/.test(domain)) return res.status(400).json({ error: 'Invalid domain name' });
      dns.domain = domain;
    }
    if (provider !== 'adguard' && !dns.adminPassword) dns.adminPassword = randomSecret(12);
    dns.enabled = true;
    await ensureNetwork('wicked');
    const composePath = coreServiceFile('dns');
    const previousProvider = dnsProviderName(settings);
    if (previousProvider !== provider && fs.existsSync(composePath)) {
      const previousMeta = dnsServiceMeta(previousProvider);
      await run('docker', ['compose', '-f', composePath, '-p', previousMeta.project, 'down', '--remove-orphans'], { cwd: coreServiceDir('dns') }).catch(() => {});
    }
    const coreHostDir = await selfMountSource('/app/core');
    const dnsHostDir = coreHostDir ? path.join(coreHostDir, 'dns') : '';
    if (provider === 'adguard') {
      prepareHostBindDirs(dnsHostDir, [['work', 0o775], ['conf', 0o775]]);
      writePrivateFile(composePath, adguardCompose(dns, dnsHostDir));
    } else {
      prepareHostBindDirs(dnsHostDir, [['config', 0o775]]);
      writePrivateFile(composePath, technitiumCompose(dns, dnsHostDir));
    }
    const { stdout, stderr } = await run('docker', ['compose', '-f', composePath, '-p', meta.project, 'up', '-d', '--remove-orphans'], { cwd: coreServiceDir('dns') });
    settings.services = settings.services || {};
    settings.services.dns = { provider };
    if (provider === 'adguard') settings.services.adguard = dns;
    else settings.services.technitium = dns;
    writeSettings(settings);
    const url = coreServiceUrl(dns.domain, dns.webPort || meta.webPort);
    const message = provider === 'adguard'
      ? `AdGuard Home is starting. Open ${url} and finish the setup wizard (choose port 3000 if asked).`
      : `Technitium DNS is starting. Open ${url} to finish setup.`;
    res.json({ ok: true, provider, stdout, stderr, message, url });
  } catch (e) {
    res.status(500).json({ error: e.message, stdout: e.stdout, stderr: e.stderr });
  }
});

app.post('/api/core/dns/domain', async (req, res) => {
  try {
    const settings = readSettings();
    const provider = req.body?.provider === 'adguard' || req.body?.provider === 'technitium'
      ? req.body.provider
      : dnsProviderName(settings);
    const meta = dnsServiceMeta(provider);
    const dns = provider === 'adguard'
      ? adguardDefaults(settings.services?.adguard || {})
      : { ...(settings.services?.technitium || {}) };
    const domain = normalizeDomain(req.body?.domain);
    if (domain && !/^[A-Za-z0-9*][A-Za-z0-9*._-]*$/.test(domain)) {
      return res.status(400).json({ error: 'Invalid domain name' });
    }
    dns.domain = domain;
    settings.services = settings.services || {};
    settings.services.dns = { provider };
    if (provider === 'adguard') settings.services.adguard = dns;
    else settings.services.technitium = dns;
    writeSettings(settings);
    const dir = coreServiceDir('dns');
    const composePath = path.join(dir, 'docker-compose.yml');
    const status = await coreServiceStatus(meta.project, { nameHint: meta.nameHint, primaryHint: meta.nameHint });
    let stdout = '';
    let stderr = '';
    const compose = readManagedCompose(composePath);
    if (compose.trim()) {
      writePrivateFile(composePath, setComposeServiceEnv(compose, meta.service, {
        VIRTUAL_HOST: domain,
        VIRTUAL_PORT: domain ? String(meta.webPort) : ''
      }));
      if (status.running) {
        ({ stdout, stderr } = await run('docker', ['compose', '-f', composePath, '-p', meta.project, 'up', '-d', '--remove-orphans'], { cwd: dir }));
      }
    }
    res.json({ ok: true, provider, domain, restarted: status.running, url: coreServiceUrl(domain, dns.webPort || meta.webPort), stdout, stderr });
  } catch (e) {
    res.status(500).json({ error: e.message, stdout: e.stdout, stderr: e.stderr });
  }
});

// ---------- Email: SMTP delivery + Mailpit sink ----------
app.get('/api/core/mail', async (req, res) => {
  try {
    const settings = readSettings();
    const mail = mailDefaults(settings.services?.mail || {});
    const mailpit = mailpitDefaults(settings.services?.mailpit || {});
    const dir = path.join(coreDir, 'mailpit');
    const composePath = path.join(dir, 'docker-compose.yml');
    const existing = readComposeText(composePath);
    const coreHostDir = await selfMountSource('/app/core');
    const compose = existing.trim()
      ? existing
      : mailpitCompose(mailpit, coreHostDir ? path.join(coreHostDir, 'mailpit') : '');
    const status = await coreServiceStatus('mailpit', { nameHint: 'mailpit', primaryHint: 'mailpit' });
    const authelia = autheliaDefaults(settings.services?.authelia || {});
    res.json({
      ...status,
      dir,
      composePath,
      compose,
      smtp: redactServiceSecrets('mail', mail),
      smtpAddress: autheliaSmtpFrom(mail)?.address || '',
      settings: mailpit,
      authelia: { installed: !!authelia.domain, domain: authelia.domain || '' },
      url: coreServiceUrl(mailpit.domain, mailpit.webPort || 8025)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/core/mail/smtp', async (req, res) => {
  try {
    const settings = readSettings();
    const next = mailBodyToSettings(req.body || {}, settings.services?.mail || {});
    if (next.host && !next.sender) {
      const authelia = autheliaDefaults(settings.services?.authelia || {});
      next.sender = `authelia@${authelia.domain || 'localhost'}`;
    }
    settings.services = settings.services || {};
    settings.services.mail = next;
    writeSettings(settings);
    const applied = await applyMailSettings();
    res.json({
      ok: true,
      smtp: redactServiceSecrets('mail', next),
      address: autheliaSmtpFrom(next)?.address || '',
      applied,
      message: next.host
        ? `Outgoing mail set to ${next.host}:${next.port}${applied.installed ? applied.restarted ? ' · Authelia restarted' : ' · Authelia config updated' : ''}`
        : 'SMTP disabled. Authelia will write notifications to disk.'
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.post('/api/core/mail/use-mailpit', async (req, res) => {
  try {
    const settings = readSettings();
    const mailpit = mailpitDefaults(settings.services?.mailpit || {});
    mailpit.enabled = true;
    const { stdout, stderr } = await launchMailpit(mailpit);
    const mail = mailDefaults(settings.services?.mail || {});
    mail.host = 'mailpit';
    mail.port = 1025;
    mail.tls = 'none';
    mail.username = '';
    mail.password = '';
    if (!mail.sender) {
      const authelia = autheliaDefaults(settings.services?.authelia || {});
      mail.sender = `authelia@${authelia.domain || 'localhost'}`;
    }
    settings.services = settings.services || {};
    settings.services.mailpit = mailpit;
    settings.services.mail = mail;
    writeSettings(settings);
    const applied = await applyMailSettings();
    res.json({
      ok: true,
      stdout,
      stderr,
      smtp: redactServiceSecrets('mail', mail),
      applied,
      url: coreServiceUrl(mailpit.domain, mailpit.webPort || 8025),
      message: `Mailpit is capturing mail at mailpit:1025. Open ${coreServiceUrl(mailpit.domain, mailpit.webPort || 8025)} to read it.${applied.installed ? ' Authelia now sends notifications here.' : ''}`
    });
  } catch (e) {
    res.status(500).json({ error: e.message, stdout: e.stdout, stderr: e.stderr });
  }
});

app.get('/api/core/mailpit', async (req, res) => {
  try {
    const settings = readSettings();
    const dir = path.join(coreDir, 'mailpit');
    const composePath = path.join(dir, 'docker-compose.yml');
    const mailpit = mailpitDefaults(settings.services?.mailpit || {});
    const existing = readComposeText(composePath);
    const coreHostDir = await selfMountSource('/app/core');
    const compose = existing.trim()
      ? existing
      : mailpitCompose(mailpit, coreHostDir ? path.join(coreHostDir, 'mailpit') : '');
    const status = await coreServiceStatus('mailpit', { nameHint: 'mailpit', primaryHint: 'mailpit' });
    res.json({
      ...status,
      dir,
      composePath,
      compose,
      settings: mailpit,
      url: coreServiceUrl(mailpit.domain, mailpit.webPort || 8025)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/core/mailpit/compose', async (req, res) => {
  try {
    const { compose } = req.body || {};
    if (!compose) return res.status(400).json({ error: 'compose required' });
    const composePath = coreServiceFile('mailpit');
    writePrivateFile(composePath, String(compose));
    res.json({ ok: true, path: composePath });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/core/mailpit/run', async (req, res) => {
  try {
    const body = req.body || {};
    const settings = readSettings();
    const mailpit = mailpitDefaults(settings.services?.mailpit || {});
    if (body.smtpPort !== undefined) {
      const port = Number(body.smtpPort);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return res.status(400).json({ error: 'Invalid SMTP port' });
      mailpit.smtpPort = port;
    }
    if (body.webPort !== undefined) {
      const port = Number(body.webPort);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return res.status(400).json({ error: 'Invalid web port' });
      mailpit.webPort = port;
    }
    if (mailpit.smtpPort === mailpit.webPort) return res.status(400).json({ error: 'SMTP and web ports must differ' });
    if (body.maxMessages !== undefined) {
      const max = Number(body.maxMessages);
      if (!Number.isInteger(max) || max < 50 || max > 50000) return res.status(400).json({ error: 'Max messages must be between 50 and 50000' });
      mailpit.maxMessages = max;
    }
    if (body.domain !== undefined) {
      const domain = normalizeDomain(body.domain);
      if (domain && !/^[A-Za-z0-9*][A-Za-z0-9*._-]*$/.test(domain)) return res.status(400).json({ error: 'Invalid domain name' });
      mailpit.domain = domain;
    }
    mailpit.enabled = true;
    const { stdout, stderr } = await launchMailpit(mailpit);
    settings.services = settings.services || {};
    settings.services.mailpit = mailpit;
    writeSettings(settings);
    const url = coreServiceUrl(mailpit.domain, mailpit.webPort);
    res.json({ ok: true, stdout, stderr, url, message: `Mailpit is starting. Open ${url} and send mail to mailpit:1025.` });
  } catch (e) {
    res.status(500).json({ error: e.message, stdout: e.stdout, stderr: e.stderr });
  }
});

app.post('/api/core/mailpit/domain', async (req, res) => {
  try {
    const settings = readSettings();
    const mailpit = mailpitDefaults(settings.services?.mailpit || {});
    const domain = normalizeDomain(req.body?.domain);
    if (domain && !/^[A-Za-z0-9*][A-Za-z0-9*._-]*$/.test(domain)) {
      return res.status(400).json({ error: 'Invalid domain name' });
    }
    mailpit.domain = domain;
    settings.services = settings.services || {};
    settings.services.mailpit = mailpit;
    writeSettings(settings);
    const dir = coreServiceDir('mailpit');
    const composePath = path.join(dir, 'docker-compose.yml');
    const status = await coreServiceStatus('mailpit', { nameHint: 'mailpit', primaryHint: 'mailpit' });
    let stdout = '';
    let stderr = '';
    const existing = readManagedCompose(composePath);
    if (existing.trim()) {
      const compose = setComposeServiceEnv(existing, 'mailpit', {
        VIRTUAL_HOST: domain,
        VIRTUAL_PORT: domain ? '8025' : ''
      });
      writePrivateFile(composePath, compose);
      if (status.running) {
        ({ stdout, stderr } = await run('docker', ['compose', '-f', composePath, '-p', 'mailpit', 'up', '-d', '--remove-orphans'], { cwd: dir }));
      }
    }
    res.json({ ok: true, domain, restarted: status.running, url: coreServiceUrl(domain, mailpit.webPort || 8025), stdout, stderr });
  } catch (e) {
    res.status(500).json({ error: e.message, stdout: e.stdout, stderr: e.stderr });
  }
});

// ---------- Email: Stalwart mail server ----------
app.get('/api/core/stalwart', async (req, res) => {
  try {
    const settings = readSettings();
    const dir = path.join(coreDir, 'stalwart');
    const composePath = path.join(dir, 'docker-compose.yml');
    const stalwart = stalwartDefaults(settings.services?.stalwart || {});
    const existing = readManagedCompose(composePath);
    const coreHostDir = await selfMountSource('/app/core');
    const compose = existing.trim()
      ? existing
      : stalwartCompose(stalwart, coreHostDir ? path.join(coreHostDir, 'stalwart') : '');
    const status = await coreServiceStatus('stalwart', { nameHint: 'stalwart', primaryHint: 'stalwart' });
    res.json({
      ...status,
      dir,
      composePath,
      compose,
      settings: redactServiceSecrets('stalwart', settings.services?.stalwart || {}),
      url: coreServiceUrl(stalwart.domain, stalwart.webPort || 8088)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/core/stalwart/compose', async (req, res) => {
  try {
    const { compose } = req.body || {};
    if (!compose) return res.status(400).json({ error: 'compose required' });
    const composePath = coreServiceFile('stalwart');
    writePrivateFile(composePath, String(compose));
    res.json({ ok: true, path: composePath });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/core/stalwart/run', async (req, res) => {
  try {
    const body = req.body || {};
    const settings = readSettings();
    const stalwart = stalwartDefaults(settings.services?.stalwart || {});
    const installDefaults = configuredDefaults();
    if (body.domain !== undefined) {
      const domain = normalizeDomain(body.domain);
      if (domain && !/^[A-Za-z0-9*][A-Za-z0-9*._-]*$/.test(domain)) return res.status(400).json({ error: 'Invalid domain name' });
      stalwart.domain = domain;
    } else if (!stalwart.domain && installDefaults.primaryDomain) {
      stalwart.domain = normalizeDomain('mail.' + installDefaults.primaryDomain);
    }
    if (body.adminUser) stalwart.adminUser = String(body.adminUser).trim() || 'admin';
    if (body.adminPassword) stalwart.adminPassword = String(body.adminPassword);
    if (!stalwart.adminPassword) stalwart.adminPassword = randomSecret(16);
    for (const [field, label] of [['webPort', 'Web port'], ['smtpPort', 'SMTP port'], ['submissionPort', 'Submission port'], ['imapsPort', 'IMAPS port']]) {
      if (body[field] === undefined) continue;
      const port = Number(body[field]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return res.status(400).json({ error: `Invalid ${label.toLowerCase()}` });
      stalwart[field] = port;
    }
    const ports = [stalwart.smtpPort, stalwart.submissionPort, stalwart.imapsPort, stalwart.webPort];
    if (new Set(ports).size !== ports.length) return res.status(400).json({ error: 'Each published port must be unique' });
    stalwart.enabled = true;
    await ensureNetwork('wicked');
    const composePath = coreServiceFile('stalwart');
    const coreHostDir = await selfMountSource('/app/core');
    const stalwartHostDir = coreHostDir ? path.join(coreHostDir, 'stalwart') : '';
    prepareHostBindDirs(stalwartHostDir, [['data', 0o775]]);
    writePrivateFile(composePath, stalwartCompose(stalwart, stalwartHostDir));
    const { stdout, stderr } = await run('docker', ['compose', '-f', composePath, '-p', 'stalwart', 'up', '-d', '--remove-orphans'], { cwd: coreServiceDir('stalwart') });
    settings.services = settings.services || {};
    settings.services.stalwart = stalwart;
    writeSettings(settings);
    const url = coreServiceUrl(stalwart.domain, stalwart.webPort || 8088);
    res.json({
      ok: true,
      stdout,
      stderr,
      url,
      message: `Stalwart is starting. Open ${url} to complete the admin setup, then set the SMTP host in this Email card to point Authelia at it.`
    });
  } catch (e) {
    res.status(500).json({ error: e.message, stdout: e.stdout, stderr: e.stderr });
  }
});

app.post('/api/core/stalwart/domain', async (req, res) => {
  try {
    const settings = readSettings();
    const stalwart = stalwartDefaults(settings.services?.stalwart || {});
    const domain = normalizeDomain(req.body?.domain);
    if (domain && !/^[A-Za-z0-9*][A-Za-z0-9*._-]*$/.test(domain)) {
      return res.status(400).json({ error: 'Invalid domain name' });
    }
    stalwart.domain = domain;
    settings.services = settings.services || {};
    settings.services.stalwart = stalwart;
    writeSettings(settings);
    const dir = coreServiceDir('stalwart');
    const composePath = path.join(dir, 'docker-compose.yml');
    const status = await coreServiceStatus('stalwart', { nameHint: 'stalwart', primaryHint: 'stalwart' });
    let stdout = '';
    let stderr = '';
    const existing = readManagedCompose(composePath);
    if (existing.trim()) {
      const compose = setComposeServiceEnv(existing, 'stalwart', {
        VIRTUAL_HOST: domain,
        VIRTUAL_PORT: domain ? '8080' : ''
      });
      writePrivateFile(composePath, compose);
      if (status.running) {
        ({ stdout, stderr } = await run('docker', ['compose', '-f', composePath, '-p', 'stalwart', 'up', '-d', '--remove-orphans'], { cwd: dir }));
      }
    }
    res.json({ ok: true, domain, restarted: status.running, url: coreServiceUrl(domain, stalwart.webPort || 8088), stdout, stderr });
  } catch (e) {
    res.status(500).json({ error: e.message, stdout: e.stdout, stderr: e.stderr });
  }
});

// Core services - Host helper
app.get('/api/core/host-helper', async (req, res) => {
  try {
    const settings = readSettings();
    const dir = path.join(coreDir, 'host-helper');
    const composePath = path.join(dir, 'docker-compose.yml');
    const existing = readManagedCompose(composePath);
    const compose = existing.trim()
      ? existing
      : hostHelperCompose(settings.services?.hostHelper || {}, await selfContainerImage(), hostHelperToken({ create: false }), await selfMountRef('/app/data'));
    const status = await coreServiceStatus('wickedafdok-host-helper', { nameHint: 'wickedafdok-host-helper', primaryHint: 'wickedafdok-host-helper' });
    const available = await hostHelperAvailable();
    res.json({
      ...status,
      available,
      dir,
      composePath,
      compose,
      settings: settings.services?.hostHelper || {}
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/core/host-helper/compose', async (req, res) => {
  try {
    const { compose } = req.body || {};
    if (!compose) return res.status(400).json({ error: 'compose required' });
    const composePath = coreServiceFile('host-helper');
    writePrivateFile(composePath, String(compose));
    res.json({ ok: true, path: composePath });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/core/host-helper/run', async (req, res) => {
  try {
    const settings = readSettings();
    const helper = { ...(settings.services?.hostHelper || {}) };
    const image = String(req.body?.image || helper.image || '').trim() || await selfContainerImage();
    helper.image = image;
    helper.enabled = true;
    hostHelperToken();
    const composePath = coreServiceFile('host-helper');
    writePrivateFile(composePath, hostHelperCompose(helper, image, '', await selfMountRef('/app/data')));
    const { stdout, stderr } = await run('docker', ['compose', '-f', composePath, '-p', 'wickedafdok-host-helper', 'up', '-d', '--remove-orphans'], { cwd: coreServiceDir('host-helper') });
    settings.services = settings.services || {};
    settings.services.hostHelper = helper;
    writeSettings(settings);
    let available = false;
    for (let i = 0; i < 10; i++) {
      available = await hostHelperAvailable();
      if (available) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    res.json({ ok: true, stdout, stderr, available, message: 'Host helper launched. WickedAFDok can now create host paths through it.' });
  } catch (e) {
    res.status(500).json({ error: e.message, stdout: e.stdout, stderr: e.stderr });
  }
});

// ---------- OpenCode and terminal sessions ----------
const OPENCODE_MAX_SESSIONS = 8;
const TERMINAL_BUFFER_LIMIT = 2 * 1024 * 1024;
const TERMINAL_IDLE_MS = 30 * 60 * 1000;
// OC Assist must finish building the app even when the browser cannot attach to
// the chat. A short detach grace killed long builds while OpenCode was still
// working (and background tabs can stop polling for minutes), so keep an
// unattached OpenCode session alive for an hour. The session count is capped
// and exited sessions are reaped, so this stays bounded.
const TERMINAL_OPENCODE_DETACHED_MS = 60 * 60 * 1000;
const TERMINAL_HEARTBEAT_MS = 25 * 1000;
const TERMINAL_MODES = {
  admin: {
    label: 'Admin',
    description: 'Full access to WickedAFDok, Docker, apps, and the host-facing tools available in this container.'
  },
  user: {
    label: 'User',
    description: 'Restricted to the apps workspace and safe diagnostics. Docker and WickedAFDok source files are off limits.'
  }
};
const terminalSessions = new Map();
let opencodeInfoCache = { at: 0, value: null };

function findExecutable(name) {
  const value = String(name || '').trim();
  if (!value) return null;
  if (value.includes('/')) {
    try {
      fs.accessSync(value, fs.constants.X_OK);
      return value;
    } catch {
      return null;
    }
  }
  for (const dir of String(process.env.PATH || '').split(':')) {
    if (!dir) continue;
    const candidate = path.join(dir, value);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

function resolveOpencodeBinary() {
  const candidates = [
    process.env.OPENCODE_BIN,
    '/usr/local/bin/opencode',
    path.join(root, 'node_modules/.bin/opencode'),
    path.join(root, 'node_modules/opencode-ai/bin/opencode.exe'),
    '/usr/bin/opencode'
  ];
  for (const candidate of candidates) {
    const found = findExecutable(candidate);
    if (found) return found;
  }
  return findExecutable('opencode');
}

async function getOpencodeInfo() {
  if (opencodeInfoCache.value && Date.now() - opencodeInfoCache.at < 60000) return opencodeInfoCache.value;
  const binary = resolveOpencodeBinary();
  if (!binary) {
    opencodeInfoCache = { at: Date.now(), value: { installed: false, version: '', path: '' } };
    return opencodeInfoCache.value;
  }
  let version = '';
  try {
    const { stdout, stderr } = await run(binary, ['--version'], { timeout: 10000, cwd: root });
    version = String(stdout || stderr || '').trim().split('\n')[0];
  } catch {}
  const value = { installed: true, version, path: binary };
  opencodeInfoCache = { at: Date.now(), value };
  return value;
}

function userOpencodePermissions() {
  return {
    '*': 'allow',
    external_directory: 'deny',
    edit: 'allow',
    read: {
      '*': 'allow',
      '*.env': 'deny',
      '*.env.*': 'deny',
      '*.env.example': 'allow',
      '**/settings.json': 'deny',
      '**/auth.json': 'deny'
    },
    bash: {
      '*': 'deny',
      ls: 'allow',
      'ls *': 'allow',
      pwd: 'allow',
      'cat *': 'allow',
      'head *': 'allow',
      'tail *': 'allow',
      'grep *': 'allow',
      'rg *': 'allow',
      'find *': 'allow',
      'wc *': 'allow',
      'du *': 'allow',
      'df *': 'allow',
      'file *': 'allow',
      'stat *': 'allow',
      'tree *': 'allow',
      'sed *': 'allow',
      'awk *': 'allow',
      'sort *': 'allow',
      'uniq *': 'allow',
      'cut *': 'allow',
      'mkdir *': 'allow',
      'touch *': 'allow',
      'cp *': 'allow',
      'mv *': 'allow',
      'ln *': 'allow',
      'npm': 'allow',
      'npm *': 'allow',
      'npx *': 'allow',
      'node': 'allow',
      'node *': 'allow',
      'git status*': 'allow',
      'git diff*': 'allow',
      'git log*': 'allow',
      'git show*': 'allow',
      'git branch*': 'allow',
      'curl *': 'allow',
      'wget *': 'allow',
      'ping *': 'allow',
      hostname: 'allow',
      whoami: 'allow',
      id: 'allow',
      date: 'allow',
      'uname *': 'allow',
      'echo *': 'allow',
      'printf *': 'allow',
      'which *': 'allow',
      'rm *': 'deny',
      'rmdir *': 'deny',
      docker: 'deny',
      'docker *': 'deny',
      'sudo *': 'deny',
      'su *': 'deny',
      'apk *': 'deny',
      'chmod *': 'deny',
      'chown *': 'deny',
      'mount *': 'deny',
      'umount *': 'deny',
      'kill *': 'deny',
      'pkill *': 'deny',
      'printenv*': 'deny'
    },
    webfetch: 'allow',
    websearch: 'allow',
    task: 'allow',
    skill: 'allow',
    lsp: 'allow',
    todowrite: 'allow',
    question: 'allow',
    doom_loop: 'ask'
  };
}

function userAssistPermissions() {
  return {
    '*': 'deny',
    external_directory: {
      '*': 'deny',
      [path.join(root, 'server', 'assist-register.mjs')]: 'allow',
      [path.join(opencodeDir, 'assist', '**')]: 'allow',
      [path.join(sourcesDir, 'oc-assist-*', '**')]: 'allow'
    },
    edit: {
      '*': 'allow',
      '.env': 'deny',
      '**/.env': 'deny',
      '*.env': 'deny',
      '**/.env.*': 'deny',
      '*.env.*': 'deny',
      '**/.env.example': 'allow',
      '*.env.example': 'allow'
    },
    read: {
      '*': 'allow',
      '.env': 'deny',
      '**/.env': 'deny',
      '*.env': 'deny',
      '**/.env.*': 'deny',
      '*.env.*': 'deny',
      '**/.env.example': 'allow',
      '*.env.example': 'allow',
      '**/settings.json': 'deny',
      '**/auth.json': 'deny'
    },
    glob: 'allow',
    grep: 'allow',
    list: 'allow',
    bash: {
      '*': 'deny',
      ls: 'allow',
      'ls *': 'allow',
      pwd: 'allow',
      'cat *': 'allow',
      'head *': 'allow',
      'tail *': 'allow',
      'grep *': 'allow',
      'rg *': 'allow',
      'find *': 'allow',
      'wc *': 'allow',
      'du *': 'allow',
      'df *': 'allow',
      'file *': 'allow',
      'stat *': 'allow',
      'tree *': 'allow',
      'sed *': 'allow',
      'awk *': 'allow',
      'sort *': 'allow',
      'uniq *': 'allow',
      'cut *': 'allow',
      'mkdir *': 'allow',
      'touch *': 'allow',
      'cp *': 'allow',
      'mv *': 'allow',
      'ln *': 'allow',
      npm: 'allow',
      'npm *': 'allow',
      'npx *': 'allow',
      node: 'allow',
      'node *': 'allow',
      'git clone *': 'allow',
      'git status*': 'allow',
      'git diff*': 'allow',
      'git log*': 'allow',
      'git show*': 'allow',
      'curl *': 'allow',
      'wget *': 'allow',
      hostname: 'allow',
      whoami: 'allow',
      id: 'allow',
      date: 'allow',
      'uname *': 'allow',
      'echo *': 'allow',
      'printf *': 'allow',
      'which *': 'allow',
      'rm *': 'deny',
      'rmdir *': 'deny',
      docker: 'deny',
      'docker *': 'deny',
      'sudo *': 'deny',
      'su *': 'deny',
      'apk *': 'deny',
      'chmod *': 'deny',
      'chown *': 'deny',
      'mount *': 'deny',
      'umount *': 'deny',
      'kill *': 'deny',
      'pkill *': 'deny',
      'printenv*': 'deny'
    },
    webfetch: 'allow',
    websearch: 'allow',
    task: 'deny',
    skill: 'deny',
    lsp: 'allow',
    todowrite: 'allow',
    question: 'allow',
    doom_loop: 'ask'
  };
}

function opencodeConfigForMode(mode, settings = {}) {
  const service = settings.services?.opencode || {};
  const model = String(service.model || '').trim();
  const apiKey = String(service.apiKey || '').trim();
  const provider = String(service.provider || '').trim() ||
    (model.includes('/') ? model.split('/')[0].trim() : '');
  const config = {
    $schema: 'https://opencode.ai/config.json',
    autoupdate: false,
    default_agent: mode
  };
  if (model) config.model = model;
  if (provider && apiKey) {
    config.provider = {
      [provider]: {
        options: { apiKey: '{env:OPENCODE_PROVIDER_API_KEY}' }
      }
    };
  }
  if (mode === 'user') {
    const permissions = userOpencodePermissions();
    config.permission = permissions;
    config.agent = {
      user: {
        description: 'Create and troubleshoot apps without changing the WickedAFDok installation.',
        mode: 'primary',
        prompt: [
          'You are OpenCode running in User mode inside WickedAFDok.',
          'Your working directory is /app/apps. You may create, edit, and troubleshoot application files there.',
          'Do not modify WickedAFDok itself (/app/server, /app/public, /app/core, /app/data) and do not use Docker or system administration commands.',
          'Prefer clear, minimal changes. Explain what you changed and how the user can launch or test the app through WickedAFDok.',
          'If a task requires changing WickedAFDok or Docker, tell the user to switch to Admin mode.'
        ].join('\n'),
        permission: permissions
      },
      assist: {
        description: 'OC Assist: create, configure, and publish one app in the WickedAFDok Apps library.',
        mode: 'primary',
        prompt: [
          'You are OC Assist, the app builder inside WickedAFDok.',
          'Your working directory is ' + appsDir + '. You only create, edit, and launch application files in that directory.',
          'Read AGENTS.md in ' + appsDir + ' before building. It defines the required app layout, compose rules, routing variables, persistent-data protection, and library export rules.',
          'Use the user request in the first message as the source of truth. Read the assistant brief it points to and any uploaded files before building.',
          'Create apps/<name>/docker-compose.yml. Prefer the configured Dok default network. Do not touch WickedAFDok source files, Docker configuration, or core services.',
          'When the app is ready, publish it to the Apps library with the command provided in the brief. Never print secrets in chat.',
          'Ask the user only for information you genuinely need (domains, ports, credentials, host paths). Otherwise finish the app and report that it is in Apps.'
        ].join('\n'),
        permission: userAssistPermissions()
      }
    };
  } else {
    const permissions = { '*': 'allow', external_directory: 'allow' };
    config.permission = permissions;
    config.agent = {
      admin: {
        description: 'Maintain, troubleshoot, and change WickedAFDok with full access.',
        mode: 'primary',
        prompt: [
          'You are OpenCode running in Admin mode inside WickedAFDok.',
          'You have full access to this installation at /app, including the server, frontend, core services, apps, and Docker socket.',
          'Use that access carefully: the server you are editing is the application hosting this terminal, and restarting containers can interrupt the session.',
          'Read AGENTS.md before making structural changes. Keep changes consistent with the existing style and verify them when possible.'
        ].join('\n'),
        permission: permissions
      }
    };
  }
  return config;
}

function ensureOpencodePaths() {
  for (const dir of [opencodeDir, path.join(opencodeDir, 'shared')]) {
    fs.mkdirSync(dir, { recursive: true });
    try { fs.chmodSync(dir, 0o700); } catch {}
  }
  const modeDirs = {};
  for (const mode of Object.keys(TERMINAL_MODES)) {
    const dir = path.join(opencodeDir, mode);
    for (const child of [dir, path.join(dir, 'config'), path.join(dir, 'state')]) {
      fs.mkdirSync(child, { recursive: true });
      try { fs.chmodSync(child, 0o700); } catch {}
    }
    modeDirs[mode] = dir;
  }
  for (const child of [path.join(opencodeDir, 'shared', 'data'), path.join(opencodeDir, 'shared', 'cache')]) {
    fs.mkdirSync(child, { recursive: true });
    try { fs.chmodSync(child, 0o700); } catch {}
  }
  return modeDirs;
}

function writeOpencodeConfigs(settings = {}) {
  const dirs = ensureOpencodePaths();
  const paths = {};
  for (const mode of Object.keys(TERMINAL_MODES)) {
    const file = path.join(dirs[mode], 'opencode.json');
    writePrivateFile(file, JSON.stringify(opencodeConfigForMode(mode, settings), null, 2) + '\n');
    paths[mode] = file;
  }
  return paths;
}

function terminalEnv(mode, app, settings = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || value === null) continue;
    env[key] = String(value);
  }
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.WICKEDAFDOK_MODE = mode;
  env.WICKEDAFDOK_TERMINAL = app;

  if (mode === 'user') {
    for (const key of Object.keys(env)) {
      if (/^(DOCKER_|HOST_AGENT_|CLOUDFLARE_|CF_|AUTHENTIK_|TECHNITIUM_)/i.test(key) ||
          /(TOKEN|SECRET|PASSWORD|API_KEY)$/i.test(key)) {
        delete env[key];
      }
    }
  }

  // Do not let a host/desktop OpenCode environment leak into managed sessions.
  // A plain shell should not inherit a desktop session id or config override.
  for (const key of Object.keys(env)) {
    if (/^OPENCODE($|_)/.test(key)) delete env[key];
  }
  // Never let a child dev server inherit Dok's listen port. App scaffolding
  // commands that honour PORT would otherwise bind 8080 inside this container
  // and can leave the UI unreachable. Assist helpers get the real port through
  // WICKEDAFDOK_PORT instead.
  env.WICKEDAFDOK_PORT = String(process.env.PORT || 8080);
  delete env.PORT;
  delete env.HOST;

  if (app === 'opencode') {
    const modeDir = path.join(opencodeDir, mode);
    const config = opencodeConfigForMode(mode, settings);
    env.HOME = modeDir;
    env.XDG_CONFIG_HOME = path.join(modeDir, 'config');
    env.XDG_STATE_HOME = path.join(modeDir, 'state');
    env.XDG_DATA_HOME = path.join(opencodeDir, 'shared', 'data');
    env.XDG_CACHE_HOME = path.join(opencodeDir, 'shared', 'cache');
    env.OPENCODE_CONFIG = path.join(modeDir, 'opencode.json');
    // Inline content wins over OPENCODE_CONFIG and any global/project file, so
    // the mode permissions generated here cannot be widened by another config.
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
    // Project-level opencode.json has higher precedence than OPENCODE_CONFIG and
    // could widen User-mode permissions. Ignore project config for both modes.
    env.OPENCODE_DISABLE_PROJECT_CONFIG = '1';
    env.OPENCODE_DISABLE_AUTOUPDATE = '1';
    const apiKey = String(settings.services?.opencode?.apiKey || '').trim();
    if (apiKey) env.OPENCODE_PROVIDER_API_KEY = apiKey;
  }
  return env;
}

const ASSIST_CHAT_MAX = 8;
const ASSIST_CHAT_IDLE_STOP_MS = 30 * 60 * 1000;
const assistChats = new Map();
let opencodeServer = null;
let opencodeServerStarting = null;

function clipAssistText(value, max = 40000) {
  const text = String(value ?? '');
  return text.length > max ? text.slice(0, max) + '\n… (truncated)' : text;
}

function assistChatSummary(chat) {
  return {
    id: chat.id,
    appName: chat.appName,
    title: chat.title,
    transport: 'chat',
    createdAt: chat.createdAt,
    lastActivity: new Date(chat.lastActivity).toISOString(),
    status: chat.lastStatus || 'idle',
    waiting: chat.lastWaiting || 0,
    error: chat.lastError || ''
  };
}

function findFreeTcpPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address()?.port;
      server.close(() => port ? resolve(port) : reject(new Error('Could not allocate a local port')));
    });
  });
}

function opencodeServerUrl(server, pathname, withDirectory = true) {
  const url = new URL(`http://127.0.0.1:${server.port}${pathname.startsWith('/') ? pathname : '/' + pathname}`);
  if (withDirectory) url.searchParams.set('directory', appsDir);
  return url;
}

async function opencodeServerRequest(server, pathname, { method = 'GET', body, timeout = 20000, label = 'request', withDirectory = true } = {}) {
  let response;
  try {
    response = await fetch(opencodeServerUrl(server, pathname, withDirectory), {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      signal: AbortSignal.timeout(timeout)
    });
  } catch (e) {
    throw httpError(502, `OpenCode server ${label} failed: ${e.message}`);
  }
  if (response.status === 204) return null;
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) {
    const detail = data && typeof data === 'object'
      ? (data.message || data.error?.message || data.error || JSON.stringify(data))
      : text;
    throw httpError(502, `OpenCode server ${label} failed (${response.status})${detail ? `: ${String(detail).slice(0, 2000)}` : ''}`);
  }
  return data;
}

async function waitForOpencodeServer(server, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (server.exited) {
      throw new Error(server.error || `OpenCode exited with code ${server.exitCode ?? 'unknown'}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/global/health`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(1500)
      });
      if (response.ok) {
        const health = await response.json().catch(() => null);
        if (health?.healthy) return;
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Timed out waiting for the OpenCode server');
}

function scheduleOpencodeServerIdleStop(server) {
  if (!server || server.exited) return;
  if (server.stopTimer) clearTimeout(server.stopTimer);
  server.stopTimer = setTimeout(() => {
    server.stopTimer = null;
    if (opencodeServer !== server) return;
    const busy = Array.from(assistChats.values()).some(chat =>
      chat.lastStatus === 'busy' || chat.lastStatus === 'retry' || (chat.lastWaiting || 0) > 0);
    if (busy) {
      scheduleOpencodeServerIdleStop(server);
      return;
    }
    stopOpencodeServer('idle');
  }, ASSIST_CHAT_IDLE_STOP_MS);
  if (server.stopTimer.unref) server.stopTimer.unref();
}

async function startOpencodeServer() {
  const info = await getOpencodeInfo();
  if (!info.installed) {
    throw httpError(503, 'OpenCode is not installed in this container. Rebuild the WickedAFDok image and try again.');
  }
  const settings = readSettings();
  writeOpencodeConfigs(settings);
  const port = await findFreeTcpPort();
  const child = spawn(info.path, [
    'serve', '--hostname', '127.0.0.1', '--port', String(port), '--print-logs', '--log-level', 'INFO'
  ], {
    cwd: appsDir,
    env: terminalEnv('user', 'opencode', settings),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const server = {
    child,
    port,
    version: info.version,
    ready: false,
    exited: false,
    exitCode: null,
    error: '',
    startedAt: Date.now(),
    logs: [],
    stopTimer: null
  };
  const capture = chunk => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (!line.trim()) continue;
      server.logs.push(line);
      if (server.logs.length > 120) server.logs.shift();
      if (/error|panic|fatal|failed/i.test(line)) appendServerLog('WARN', `OpenCode server: ${line}`);
    }
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  child.on('error', err => {
    server.exited = true;
    server.error = err.message;
  });
  child.on('exit', (code, signal) => {
    server.exited = true;
    server.exitCode = code;
    server.ready = false;
    if (opencodeServer === server) opencodeServer = null;
    if (server.stopTimer) clearTimeout(server.stopTimer);
    const tail = server.logs.slice(-8).join('\n');
    appendServerLog(code === 0 ? 'INFO' : 'WARN',
      `OpenCode server exited (code ${code ?? 'unknown'}${signal ? `, ${signal}` : ''})${tail ? `: ${tail}` : ''}`);
    for (const chat of assistChats.values()) {
      chat.lastError = `OpenCode server stopped (code ${code ?? 'unknown'}). It will restart on the next request.`;
    }
  });
  opencodeServer = server;
  try {
    await waitForOpencodeServer(server);
  } catch (e) {
    server.exited = true;
    try { child.kill('SIGKILL'); } catch {}
    if (opencodeServer === server) opencodeServer = null;
    const tail = server.logs.slice(-8).join('\n');
    throw httpError(502, `OpenCode server failed to start: ${e.message}${tail ? `\n${tail}` : ''}`);
  }
  server.ready = true;
  appendServerLog('INFO', `OpenCode server ready on 127.0.0.1:${port} (pid ${child.pid})`);
  scheduleOpencodeServerIdleStop(server);
  return server;
}

async function ensureOpencodeServer() {
  if (opencodeServer?.ready && !opencodeServer.exited) return opencodeServer;
  if (opencodeServerStarting) return opencodeServerStarting;
  opencodeServerStarting = startOpencodeServer().finally(() => {
    opencodeServerStarting = null;
  });
  return opencodeServerStarting;
}

function stopOpencodeServer(reason = 'stopped') {
  const server = opencodeServer;
  opencodeServer = null;
  if (!server) return false;
  server.ready = false;
  if (server.stopTimer) clearTimeout(server.stopTimer);
  try { server.child.kill('SIGTERM'); } catch {}
  const force = setTimeout(() => {
    try { server.child.kill('SIGKILL'); } catch {}
  }, 3000);
  if (force.unref) force.unref();
  appendServerLog('INFO', `OpenCode server ${reason} (pid ${server.child.pid})`);
  return true;
}

function compactAssistMessages(records) {
  const list = Array.isArray(records) ? records : [];
  return list.map(record => {
    const info = record?.info || {};
    const parts = [];
    for (const part of Array.isArray(record?.parts) ? record.parts : []) {
      if (!part || !part.type) continue;
      if (part.type === 'text') {
        if (part.synthetic === true) continue;
        parts.push({ id: part.id, type: 'text', text: clipAssistText(part.text, 200000) });
      } else if (part.type === 'reasoning') {
        parts.push({ id: part.id, type: 'reasoning', text: clipAssistText(part.text, 20000) });
      } else if (part.type === 'tool') {
        parts.push({
          id: part.id,
          type: 'tool',
          tool: part.tool,
          callID: part.callID,
          state: {
            status: part.state?.status || '',
            title: clipAssistText(part.state?.title, 500),
            input: part.state?.input,
            output: clipAssistText(part.state?.output, 40000),
            error: clipAssistText(part.state?.error, 10000)
          }
        });
      } else if (part.type === 'file') {
        parts.push({ id: part.id, type: 'file', filename: part.filename || '', mime: part.mime || '' });
      } else if (part.type === 'patch') {
        parts.push({ id: part.id, type: 'patch', files: Array.isArray(part.files) ? part.files.slice(0, 50) : [] });
      } else if (part.type === 'agent') {
        parts.push({ id: part.id, type: 'agent', name: part.name || '' });
      }
    }
    return {
      id: info.id || '',
      info: {
        id: info.id || '',
        role: info.role || '',
        agent: info.agent || '',
        model: info.modelID || '',
        created: info.time?.created || 0,
        completed: info.time?.completed || 0,
        error: info.error ? clipAssistText(info.error.message || JSON.stringify(info.error), 4000) : ''
      },
      parts
    };
  });
}

function assistQuestionSummary(question) {
  return {
    id: question.id,
    questions: (Array.isArray(question.questions) ? question.questions : []).map(item => ({
      question: String(item.question || ''),
      header: String(item.header || ''),
      multiple: item.multiple === true,
      custom: item.custom === true,
      options: (Array.isArray(item.options) ? item.options : []).map(option => ({
        label: String(option.label || ''),
        description: String(option.description || '')
      }))
    }))
  };
}

function assistPermissionSummary(permission) {
  return {
    id: permission.id,
    permission: String(permission.permission || ''),
    patterns: Array.isArray(permission.patterns) ? permission.patterns.map(String).slice(0, 50) : [],
    always: Array.isArray(permission.always) ? permission.always.map(String).slice(0, 50) : [],
    metadata: permission.metadata || {}
  };
}

async function assistChatSnapshot(chat) {
  const server = await ensureOpencodeServer();
  const sessionPath = `/session/${encodeURIComponent(chat.id)}`;
  const [records, statuses, questions, permissions] = await Promise.all([
    opencodeServerRequest(server, `${sessionPath}/message`, { timeout: 30000, label: 'message read' }),
    opencodeServerRequest(server, '/session/status', { timeout: 15000, label: 'status read' }),
    opencodeServerRequest(server, '/question', { timeout: 15000, label: 'question read' }).catch(() => []),
    opencodeServerRequest(server, '/permission', { timeout: 15000, label: 'permission read' }).catch(() => [])
  ]);
  const messages = compactAssistMessages(records);
  const status = statuses && typeof statuses === 'object' && statuses[chat.id]
    ? statuses[chat.id]
    : { type: 'idle' };
  const chatQuestions = (Array.isArray(questions) ? questions : [])
    .filter(question => question?.sessionID === chat.id)
    .map(assistQuestionSummary);
  const chatPermissions = (Array.isArray(permissions) ? permissions : [])
    .filter(permission => permission?.sessionID === chat.id)
    .map(assistPermissionSummary);
  const busy = status.type === 'busy' || status.type === 'retry';
  const waiting = chatQuestions.length + chatPermissions.length;
  chat.lastStatus = status.type || 'idle';
  chat.lastWaiting = waiting;
  chat.lastError = '';
  if (busy || waiting) chat.lastActivity = Date.now();
  scheduleOpencodeServerIdleStop(server);
  const revision = crypto.createHash('sha1').update(JSON.stringify({
    status: status.type,
    messages,
    questions: chatQuestions.map(question => question.id),
    permissions: chatPermissions.map(permission => permission.id)
  })).digest('hex');
  return {
    ok: true,
    chat: assistChatSummary(chat),
    status,
    messages,
    questions: chatQuestions,
    permissions: chatPermissions,
    revision
  };
}

function requireAssistChat(id) {
  const chat = assistChats.get(String(id || ''));
  if (!chat) throw httpError(404, 'This OC Assist chat is no longer running. Start it again from App Creation.');
  return chat;
}

async function createAssistChat({ appName, prompt, title, briefPath = '', uploadDir = '' } = {}) {
  if (assistChats.size >= ASSIST_CHAT_MAX) {
    const idle = Array.from(assistChats.values())
      .filter(chat => chat.lastStatus === 'idle' && !(chat.lastWaiting || 0))
      .sort((a, b) => a.lastActivity - b.lastActivity)[0];
    if (idle) assistChats.delete(idle.id);
    else throw httpError(429, `Too many OC Assist chats are open (max ${ASSIST_CHAT_MAX}). Stop one first.`);
  }
  const server = await ensureOpencodeServer();
  const session = await opencodeServerRequest(server, '/session', {
    method: 'POST',
    body: { title, agent: 'assist' },
    timeout: 30000,
    label: 'session create'
  });
  if (!session?.id) throw httpError(502, 'OpenCode did not return a chat session');
  const now = Date.now();
  const chat = {
    id: session.id,
    appName,
    title: title || `OC Assist · ${appName}`,
    briefPath,
    uploadDir,
    createdAt: new Date(now).toISOString(),
    lastActivity: now,
    lastStatus: 'busy',
    lastWaiting: 0,
    lastError: ''
  };
  assistChats.set(chat.id, chat);
  try {
    await opencodeServerRequest(server, `/session/${encodeURIComponent(chat.id)}/prompt_async`, {
      method: 'POST',
      body: { agent: 'assist', parts: [{ type: 'text', text: prompt }] },
      timeout: 30000,
      label: 'prompt'
    });
  } catch (e) {
    assistChats.delete(chat.id);
    opencodeServerRequest(server, `/session/${encodeURIComponent(chat.id)}`, { method: 'DELETE', timeout: 15000 }).catch(() => {});
    throw e;
  }
  scheduleOpencodeServerIdleStop(server);
  appendServerLog('INFO', `OC Assist chat ${chat.id} started for ${appName}`);
  return assistChatSummary(chat);
}

async function stopAllAssistChats() {
  const chats = Array.from(assistChats.values());
  assistChats.clear();
  if (opencodeServer?.ready) {
    await Promise.allSettled(chats.map(chat =>
      opencodeServerRequest(opencodeServer, `/session/${encodeURIComponent(chat.id)}/abort`, {
        method: 'POST',
        timeout: 10000,
        label: 'abort'
      })));
  }
  stopOpencodeServer('stopped with all chats');
  return chats.length;
}

function scheduleTerminalCleanup(session, delay = 30000) {
  if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
  session.cleanupTimer = setTimeout(() => {
    session.cleanupTimer = null;
    if (!terminalSessions.has(session.id)) return;
    const now = Date.now();
    if (session.clients.size) {
      // Output from a running agent counts as activity, so a long build is not
      // mistaken for an idle session. Only stop an interactive session that has
      // truly been silent for the full idle window.
      if (now - (session.lastActivity || now) >= TERMINAL_IDLE_MS) {
        appendServerLog('INFO', `terminal session ${session.id} reached the idle limit; stopping`);
        stopTerminalSession(session.id);
        return;
      }
      scheduleTerminalCleanup(session, 60000);
      return;
    }
    // No client attached. Shells are only useful while someone is watching, so
    // reap them after the idle window. OpenCode may still be building the app,
    // so keep it alive through the detached grace even if the chat never
    // attached or the browser stopped polling while in the background.
    const detachedFor = now - (session.lastClientAt || session.createdAtMs || now);
    const grace = session.app === 'opencode' ? TERMINAL_OPENCODE_DETACHED_MS : TERMINAL_IDLE_MS;
    if (detachedFor >= grace) {
      appendServerLog('INFO', `terminal session ${session.id} had no client for ${Math.round(detachedFor / 1000)}s; stopping`);
      stopTerminalSession(session.id);
      return;
    }
    scheduleTerminalCleanup(session, Math.min(60000, Math.max(5000, grace - detachedFor + 1000)));
  }, delay);
  if (session.cleanupTimer.unref) session.cleanupTimer.unref();
}

function stopTerminalSession(id) {
  const session = terminalSessions.get(id);
  if (!session) return false;
  terminalSessions.delete(id);
  clearTimeout(session.cleanupTimer);
  try { session.pty.kill(); } catch {}
  const force = setTimeout(() => {
    try { session.pty.kill('SIGKILL'); } catch {}
  }, 1500);
  if (force.unref) force.unref();
  for (const ws of session.clients) {
    try { ws.close(1000, 'session stopped'); } catch {}
  }
  session.clients.clear();
  appendServerLog('INFO', `terminal session ${id} stopped (${session.mode} ${session.app})`);
  return true;
}

function stopAllTerminalSessions(filter = null) {
  let count = 0;
  for (const session of Array.from(terminalSessions.values())) {
    if (filter && !filter(session)) continue;
    if (stopTerminalSession(session.id)) count += 1;
  }
  return count;
}

function terminalSessionSummary(session) {
  return {
    id: session.id,
    mode: session.mode,
    app: session.app,
    agent: session.agent || '',
    title: session.title,
    cwd: session.cwd,
    pid: session.pty.pid,
    createdAt: session.createdAt,
    lastClientAt: session.lastClientAt || null,
    clients: session.clients.size,
    exited: session.exited,
    exitCode: session.exitCode
  };
}

function terminalOutputSince(session, after = 0) {
  const requested = Number(after);
  const cursor = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 0;
  const buffer = session.buffer || [];
  const chunks = cursor > 0 ? buffer.filter(chunk => chunk.seq > cursor) : buffer.slice();
  const oldest = buffer.length ? buffer[0].seq : session.sequence + 1;
  return {
    chunks: chunks.map(chunk => chunk.data),
    cursor: session.sequence,
    oldest,
    truncated: cursor > 0 && cursor < oldest - 1
  };
}

function terminalBufferText(session, max = 2000) {
  const raw = (session.buffer || []).map(chunk => typeof chunk === 'string' ? chunk : chunk.data).join('');
  const clean = raw
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return clean.slice(-max);
}

async function createTerminalSession({ mode = 'admin', app = 'shell', agent = '', prompt = '', title = '', startupCheck = false } = {}) {
  if (!TERMINAL_MODES[mode]) throw httpError(400, 'Unknown terminal mode');
  if (!['shell', 'opencode'].includes(app)) throw httpError(400, 'Unknown terminal application');
  if (app === 'opencode' && mode === 'admin') {
    throw httpError(409,
      'Admin OpenCode runs only inside the Dok Maintenance container. Start Maintenance from Settings → Maintenance, then launch OpenCode there.');
  }
  if (terminalSessions.size >= OPENCODE_MAX_SESSIONS) {
    // Prefer reclaiming an abandoned, clientless session over refusing to start
    // a new one. This is what accumulates after a failed chat attach. Sessions
    // using the HTTP polling fallback have no WebSocket in `clients`, so a
    // recent poll counts as an attached client.
    const now = Date.now();
    const abandoned = Array.from(terminalSessions.values())
      .filter(session => !session.clients.size && now - (session.lastClientAt || session.createdAtMs || 0) > 10000)
      .sort((a, b) => (a.lastClientAt || 0) - (b.lastClientAt || 0))[0];
    if (abandoned) {
      appendServerLog('INFO', `evicting abandoned terminal session ${abandoned.id} to make room`);
      stopTerminalSession(abandoned.id);
    } else {
      throw httpError(429, `Too many terminal sessions are open (max ${OPENCODE_MAX_SESSIONS}). Stop one first.`);
    }
  }

  const settings = readSettings();
  let binary = '';
  let args = ['-i'];
  let cwd = mode === 'user' ? appsDir : root;
  let version = '';
  const selectedAgent = String(agent || mode).trim();
  if (app === 'opencode' && !/^[A-Za-z0-9._-]+$/.test(selectedAgent)) {
    throw httpError(400, 'Unknown OpenCode agent');
  }

  if (app === 'opencode') {
    const info = await getOpencodeInfo();
    if (!info.installed) {
      throw httpError(503, 'OpenCode is not installed in this container. Rebuild the WickedAFDok image with the bundled OpenCode runtime, then try again.');
    }
    writeOpencodeConfigs(settings);
    binary = info.path;
    args = ['--agent', selectedAgent];
    if (prompt) args.push('--prompt', String(prompt));
    version = info.version;
  } else {
    // The Docker image bundles bash, but direct development runs on Alpine or
    // other minimal hosts may only have sh. Use the user's shell when it exists
    // and fall back to a POSIX shell instead of failing every terminal launch.
    binary = [process.env.SHELL, '/bin/bash', '/bin/sh']
      .map(candidate => findExecutable(candidate))
      .find(Boolean) || '';
    if (!binary) {
      throw httpError(503, 'No interactive shell was found in this container. Rebuild the WickedAFDok image or install bash or sh.');
    }
  }

  fs.mkdirSync(cwd, { recursive: true });
  const id = `term_${crypto.randomBytes(12).toString('hex')}`;
  const sessionTitle = title || (app === 'opencode' ? `OpenCode · ${TERMINAL_MODES[mode].label}` : `Terminal · ${TERMINAL_MODES[mode].label}`);
  const session = {
    id,
    mode,
    app,
    agent: app === 'opencode' ? selectedAgent : '',
    title: sessionTitle,
    cwd,
    version,
    createdAt: new Date().toISOString(),
    createdAtMs: Date.now(),
    lastActivity: Date.now(),
    lastClientAt: Date.now(),
    buffer: [],
    bufferBytes: 0,
    sequence: 0,
    clients: new Set(),
    exited: false,
    exitCode: null,
    cleanupTimer: null
  };

  let child;
  try {
    child = pty.spawn(binary, args, {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd,
      env: terminalEnv(mode, app, settings)
    });
  } catch (e) {
    throw httpError(500, `Unable to start ${app === 'opencode' ? 'OpenCode' : 'the terminal'}: ${e.message}`);
  }

  session.pty = child;
  terminalSessions.set(id, session);
  appendServerLog('INFO', `terminal session ${id} started (${mode} ${app}, pid ${child.pid})`);

  child.onData((data) => {
    session.lastActivity = Date.now();
    session.sequence += 1;
    session.buffer.push({ seq: session.sequence, data });
    session.bufferBytes += Buffer.byteLength(data);
    while (session.bufferBytes > TERMINAL_BUFFER_LIMIT && session.buffer.length > 1) {
      const removed = session.buffer.shift();
      session.bufferBytes -= Buffer.byteLength(removed.data);
    }
    if (session.clients.size) {
      const payload = JSON.stringify({ type: 'output', data });
      for (const ws of session.clients) {
        try { ws.send(payload); } catch {}
      }
    }
  });

  child.onExit(({ exitCode }) => {
    session.exited = true;
    session.exitCode = exitCode;
    session.lastActivity = Date.now();
    const payload = JSON.stringify({ type: 'exit', code: exitCode });
    for (const ws of session.clients) {
      try { ws.send(payload); } catch {}
    }
    appendServerLog('INFO', `terminal session ${id} exited with code ${exitCode}`);
    const timer = setTimeout(() => stopTerminalSession(id), 30000);
    if (timer.unref) timer.unref();
  });

  if (startupCheck) {
    // The TUI normally paints its first frame well under a second. If OpenCode
    // rejects the generated config or the selected agent, it exits immediately;
    // surface that output instead of returning a session that is already dead.
    await new Promise(resolve => setTimeout(resolve, 1200));
    if (session.exited) {
      const detail = terminalBufferText(session);
      stopTerminalSession(id);
      throw httpError(502,
        `OpenCode exited before the chat opened (code ${session.exitCode ?? 'unknown'})` +
        (detail ? `: ${detail}` : '. Check the OpenCode settings and try again.'));
    }
  }

  scheduleTerminalCleanup(session);
  return terminalSessionSummary(session);
}

app.get('/api/terminal', async (req, res) => {
  try {
    const info = await getOpencodeInfo();
    res.json({
      installed: info.installed,
      opencodeVersion: info.version,
      modes: TERMINAL_MODES,
      sessions: Array.from(terminalSessions.values()).map(terminalSessionSummary)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/terminal/sessions', async (req, res) => {
  try {
    const session = await createTerminalSession({
      mode: String(req.body?.mode || 'admin'),
      app: String(req.body?.app || 'shell')
    });
    res.json({ ok: true, session });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.post('/api/terminal/sessions/stop-all', (req, res) => {
  const app = req.body?.app ? String(req.body.app) : null;
  const stopped = stopAllTerminalSessions(app ? session => session.app === app : null);
  res.json({ ok: true, stopped });
});

app.post('/api/terminal/sessions/:id/stop', (req, res) => {
  const stopped = stopTerminalSession(req.params.id);
  res.json({ ok: true, stopped });
});

// HTTP transport used when a browser or reverse proxy cannot complete a
// WebSocket upgrade. Polling is slower than the WebSocket path, but it keeps
// the terminal and OC Assist usable behind proxies that strip `Upgrade`.
app.get('/api/terminal/sessions/:id/output', (req, res) => {
  const session = terminalSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Terminal session is no longer running' });
  session.lastActivity = Date.now();
  session.lastClientAt = Date.now();
  if (!session.httpAttached) {
    session.httpAttached = true;
    appendServerLog('INFO', `terminal session ${session.id} attached via HTTP compatibility transport`);
  }
  const output = terminalOutputSince(session, req.query.after);
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    session: terminalSessionSummary(session),
    ...output,
    exited: session.exited,
    exitCode: session.exitCode
  });
});

app.post('/api/terminal/sessions/:id/input', (req, res) => {
  const session = terminalSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Terminal session is no longer running' });
  session.lastActivity = Date.now();
  session.lastClientAt = Date.now();
  const data = typeof req.body?.data === 'string' ? req.body.data : '';
  if (data.length > 65536) {
    return res.status(413).json({ error: 'Terminal input is too large' });
  }
  if (data && !session.exited) {
    try { session.pty.write(data); } catch {}
  }
  if (!session.exited) {
    const cols = Math.max(20, Math.min(400, Number(req.body?.cols) || 0));
    const rows = Math.max(5, Math.min(200, Number(req.body?.rows) || 0));
    if (cols && rows) {
      try { session.pty.resize(cols, rows); } catch {}
    }
  }
  res.json({ ok: true, exited: session.exited, exitCode: session.exitCode });
});

app.get('/api/core/opencode', async (req, res) => {
  try {
    const settings = readSettings();
    const info = await getOpencodeInfo();
    const service = settings.services?.opencode || {};
    const sessions = Array.from(terminalSessions.values())
      .filter(session => session.app === 'opencode')
      .map(terminalSessionSummary);
    const chats = Array.from(assistChats.values()).map(assistChatSummary);
    res.json({
      installed: info.installed,
      version: info.version,
      running: sessions.length > 0 || chats.length > 0,
      sessions,
      chats,
      modes: TERMINAL_MODES,
      settings: {
        model: service.model || '',
        provider: service.provider || '',
        hasApiKey: !!service.apiKey
      },
      configs: {
        admin: opencodeConfigForMode('admin', settings),
        user: opencodeConfigForMode('user', settings)
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/core/opencode/settings', (req, res) => {
  try {
    const body = req.body || {};
    const settings = readSettings();
    const current = { ...(settings.services?.opencode || {}) };
    if (body.model !== undefined) {
      const model = String(body.model || '').trim();
      if (model && !/^[A-Za-z0-9._-]+\/\S+$/.test(model)) {
        return res.status(400).json({ error: 'Model must use the provider/model format' });
      }
      current.model = model;
    }
    if (body.provider !== undefined) {
      const provider = String(body.provider || '').trim();
      if (provider && !/^[A-Za-z0-9._-]+$/.test(provider)) {
        return res.status(400).json({ error: 'Invalid provider id' });
      }
      current.provider = provider;
    }
    if (body.clearApiKey) current.apiKey = '';
    else if (body.apiKey) current.apiKey = String(body.apiKey).trim().slice(0, 500);
    settings.services = settings.services || {};
    settings.services.opencode = current;
    writeSettings(settings);
    opencodeInfoCache = { at: 0, value: null };
    writeOpencodeConfigs(settings);
    res.json({
      ok: true,
      settings: {
        model: current.model || '',
        provider: current.provider || '',
        hasApiKey: !!current.apiKey
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/core/opencode/run', async (req, res) => {
  try {
    const mode = String(req.body?.mode || 'admin');
    const session = await createTerminalSession({ mode, app: 'opencode' });
    res.json({
      ok: true,
      session,
      message: `OpenCode ${TERMINAL_MODES[mode]?.label || mode} mode is starting in the terminal.`
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.post('/api/core/opencode/stop', async (req, res) => {
  try {
    const stoppedChats = await stopAllAssistChats();
    const stoppedSessions = stopAllTerminalSessions(session => session.app === 'opencode');
    res.json({ ok: true, stopped: stoppedChats + stoppedSessions, chats: stoppedChats, sessions: stoppedSessions });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.get('/api/assist/chats', (req, res) => {
  res.json({
    ok: true,
    chats: Array.from(assistChats.values())
      .map(assistChatSummary)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  });
});

app.get('/api/assist/chats/:id', async (req, res) => {
  try {
    const chat = requireAssistChat(req.params.id);
    res.json(await assistChatSnapshot(chat));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.post('/api/assist/chats/:id/prompt', async (req, res) => {
  try {
    const chat = requireAssistChat(req.params.id);
    const prompt = String(req.body?.prompt || '').trim();
    if (!prompt) throw httpError(400, 'Enter a message for OC Assist');
    if (prompt.length > 20000) throw httpError(400, 'The message is too long (max 20000 characters)');
    const server = await ensureOpencodeServer();
    await opencodeServerRequest(server, `/session/${encodeURIComponent(chat.id)}/prompt_async`, {
      method: 'POST',
      body: { agent: 'assist', parts: [{ type: 'text', text: prompt }] },
      timeout: 30000,
      label: 'prompt'
    });
    chat.lastStatus = 'busy';
    chat.lastError = '';
    chat.lastActivity = Date.now();
    scheduleOpencodeServerIdleStop(server);
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.post('/api/assist/chats/:id/abort', async (req, res) => {
  try {
    const chat = requireAssistChat(req.params.id);
    const server = await ensureOpencodeServer();
    await opencodeServerRequest(server, `/session/${encodeURIComponent(chat.id)}/abort`, {
      method: 'POST',
      timeout: 15000,
      label: 'abort'
    });
    chat.lastStatus = 'idle';
    chat.lastActivity = Date.now();
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.post('/api/assist/chats/:id/stop', async (req, res) => {
  try {
    const chat = requireAssistChat(req.params.id);
    assistChats.delete(chat.id);
    if (opencodeServer?.ready) {
      await opencodeServerRequest(opencodeServer, `/session/${encodeURIComponent(chat.id)}/abort`, {
        method: 'POST',
        timeout: 10000,
        label: 'abort'
      }).catch(() => {});
    }
    if (!assistChats.size) stopOpencodeServer('stopped with the last chat');
    res.json({ ok: true, stopped: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.post('/api/assist/chats/:id/question', async (req, res) => {
  try {
    requireAssistChat(req.params.id);
    const requestID = String(req.body?.requestID || '').trim();
    const answers = req.body?.answers;
    if (!/^que/.test(requestID)) throw httpError(400, 'A valid question request is required');
    if (!Array.isArray(answers) || !answers.length || answers.some(answer => !Array.isArray(answer))) {
      throw httpError(400, 'Answers must be an array of selected labels');
    }
    const clean = answers.map(answer => answer.map(value => String(value).slice(0, 2000)).slice(0, 30));
    const server = await ensureOpencodeServer();
    await opencodeServerRequest(server, `/question/${encodeURIComponent(requestID)}/reply`, {
      method: 'POST',
      body: { answers: clean },
      timeout: 15000,
      label: 'question reply'
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.post('/api/assist/chats/:id/question/reject', async (req, res) => {
  try {
    requireAssistChat(req.params.id);
    const requestID = String(req.body?.requestID || '').trim();
    if (!/^que/.test(requestID)) throw httpError(400, 'A valid question request is required');
    const server = await ensureOpencodeServer();
    await opencodeServerRequest(server, `/question/${encodeURIComponent(requestID)}/reject`, {
      method: 'POST',
      timeout: 15000,
      label: 'question reject'
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.post('/api/assist/chats/:id/permission', async (req, res) => {
  try {
    requireAssistChat(req.params.id);
    const requestID = String(req.body?.requestID || '').trim();
    const reply = String(req.body?.reply || '').trim();
    if (!/^per/.test(requestID)) throw httpError(400, 'A valid permission request is required');
    if (!['once', 'always', 'reject'].includes(reply)) throw httpError(400, 'Permission reply must be once, always, or reject');
    const server = await ensureOpencodeServer();
    await opencodeServerRequest(server, `/permission/${encodeURIComponent(requestID)}/reply`, {
      method: 'POST',
      body: { reply },
      timeout: 15000,
      label: 'permission reply'
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Core services - app integration hints
// The app compose builder asks for this before rendering so routing and
// certificate variables for installed core services are present automatically.
app.get('/api/core/app-hints', async (req, res) => {
  try {
    const settings = readSettings();
    const containers = await docker.listContainers({ all: true }).catch(() => []);
    const nameOf = container => String((container.Names || [])[0] || '').replace(/^\//, '');
    const isRunning = (project, names, service = '') => containers.some(container => {
      const labels = container.Labels || {};
      const projectMatch = labels['com.docker.compose.project'] === project;
      if (service) {
        return (projectMatch && labels['com.docker.compose.service'] === service) ||
          names.includes(nameOf(container));
      }
      return projectMatch || names.includes(nameOf(container));
    });
    // The installer writes managed composes for every selected core service.
    // Hints must survive a stopped service so a freshly installed stack still
    // configures the compose editor before anything is started.
    const installed = (project, names, enabled = false) => enabled ||
      fs.existsSync(path.join(coreServiceDir(project), 'docker-compose.yml')) ||
      isRunning(project, names);
    const nginxProxy = installed('nginx-proxy', ['nginx-proxy'], settings.services?.nginxProxy?.enabled === true);
    const acmeCompanion = nginxProxy && (settings.services?.nginxProxy?.acme?.enabled === true ||
      isRunning('nginx-proxy', ['acme-companion'], 'acme-companion'));
    const authelia = installed('authelia', ['authelia'], settings.services?.authelia?.enabled === true);
    const authentik = installed('auth', ['authentik-server'],
      settings.services?.authentik?.enabled === true || settings.services?.auth?.enabled === true);
    const mailpit = installed('mailpit', ['mailpit'], settings.services?.mailpit?.enabled === true);
    const stalwart = installed('stalwart', ['stalwart'], settings.services?.stalwart?.enabled === true);
    const defaults = defaultsDefaults(settings.defaults || {});
    const appName = String(req.query.app || '').trim();
    const suggestedHost = appName && defaults.primaryDomain
      ? `${projectName(appName, 'app')}.${defaults.primaryDomain}`
      : '';
    const fields = [];
    if (nginxProxy) {
      fields.push(
        { key: 'VIRTUAL_HOST', value: suggestedHost, label: 'Public hostname', help: 'Hostname nginx-proxy serves for this app.' },
        { key: 'VIRTUAL_PORT', value: '', label: 'Container port', help: 'Container port nginx-proxy forwards to. Required when the image exposes more than one port.' }
      );
    }
    if (authelia) {
      fields.push({ key: 'ENABLE_AUTH', value: 'true', label: 'Require login', help: 'Protect this app through the Authelia forward-auth portal.' });
    }
    if (acmeCompanion) {
      fields.push(
        { key: 'LETSENCRYPT_HOST', value: suggestedHost, label: 'Certificate hostname', help: 'Hostname acme-companion requests a certificate for. Usually the same as VIRTUAL_HOST.' },
        { key: 'LETSENCRYPT_EMAIL', value: defaults.adminEmail || '', label: 'Certificate email', help: 'Contact email used for Let\'s Encrypt registration and expiry notices.' }
      );
    }
    res.json({
      services: { nginxProxy, acmeCompanion, authelia, authentik, mailpit, stalwart },
      primaryDomain: defaults.primaryDomain || '',
      fields
    });
  } catch (e) {
    res.status(500).json({ error: e.message, services: {}, fields: [] });
  }
});

// Core services - dashboard console links
// The dashboard shows one button per installed service that has a web UI. The
// URL uses the configured hostname when one exists, otherwise the published
// localhost port, so the link works both behind nginx-proxy and on the host.
app.get('/api/core/dashboard', async (req, res) => {
  try {
    const settings = readSettings();
    const authentik = settings.services?.authentik || {};
    const authelia = autheliaDefaults(settings.services?.authelia || {});
    const autheliaDomain = normalizeDomain(authelia.domain);
    const technitium = settings.services?.technitium || {};
    const adguard = adguardDefaults(settings.services?.adguard || {});
    const mailpit = mailpitDefaults(settings.services?.mailpit || {});
    const stalwart = stalwartDefaults(settings.services?.stalwart || {});
    const entries = [
      {
        id: 'authentik', label: 'Authentik', project: 'authentik',
        status: { nameHint: 'authentik', primaryHint: 'authentik-server' },
        url: coreServiceUrl(authentik.domain, authentik.port || 9000)
      },
      {
        id: 'authelia', label: 'Authelia', project: 'authelia',
        status: { nameHint: 'authelia', primaryHint: 'authelia' },
        url: autheliaDomain ? `https://${autheliaDomain}` : `http://localhost:${authelia.port || 9091}`
      },
      {
        id: 'technitium', label: 'Technitium DNS', project: 'technitium',
        status: { nameHint: 'technitium-dns', primaryHint: 'technitium-dns' },
        url: coreServiceUrl(technitium.domain, technitium.webPort || 5380)
      },
      {
        id: 'adguard', label: 'AdGuard Home', project: 'adguard',
        status: { nameHint: 'adguard', primaryHint: 'adguard' },
        url: coreServiceUrl(adguard.domain, adguard.webPort || 3000)
      },
      {
        id: 'mailpit', label: 'Mailpit', project: 'mailpit',
        status: { nameHint: 'mailpit', primaryHint: 'mailpit' },
        url: coreServiceUrl(mailpit.domain, mailpit.webPort || 8025)
      },
      {
        id: 'stalwart', label: 'Stalwart', project: 'stalwart',
        status: { nameHint: 'stalwart', primaryHint: 'stalwart' },
        url: coreServiceUrl(stalwart.domain, stalwart.webPort || 8088)
      }
    ];
    const results = await Promise.all(entries.map(async entry => ({
      ...entry,
      ...(await coreServiceStatus(entry.project, entry.status))
    })));
    res.json({
      services: results
        .filter(item => item.exists)
        .map(({ id, label, url, running, state, lookupFailed }) => ({
          id, label, url, running: !!running, state: state || 'not created', lookupFailed: !!lookupFailed
        })),
      lookupFailed: results.some(item => item.lookupFailed)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Core services - shared actions
app.post('/api/core/all/:action(start|stop|restart)', async (req, res) => {
  try {
    const action = req.params.action === 'start' ? 'up' : req.params.action;
    const services = ['nginx-proxy', 'cloudflared', 'auth', 'authelia', 'dns', 'mailpit', 'stalwart', 'host-helper'];
    const results = [];
    for (const service of services) {
      const map = { 'nginx-proxy': 'nginx-proxy', cloudflared: 'cloudflared', auth: 'auth', authelia: 'authelia', dns: 'dns', mailpit: 'mailpit', stalwart: 'stalwart', 'host-helper': 'host-helper' };
      const dir = coreServiceDir(map[service]);
      if (!fs.existsSync(path.join(dir, 'docker-compose.yml'))) continue;
      try {
        await coreServiceAction(service, action);
        results.push({ service, ok: true });
      } catch (e) {
        results.push({ service, ok: false, error: e.message });
      }
    }
    res.json({ ok: results.every(item => item.ok), results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/core/:service/:action(start|stop|restart)', async (req, res) => {
  try {
    const { stdout, stderr } = await coreServiceAction(req.params.service, req.params.action === 'start' ? 'up' : req.params.action);
    res.json({ ok: true, stdout, stderr });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, stdout: e.stdout, stderr: e.stderr });
  }
});

// ---------- maintenance / installation state ----------
app.get('/api/installation', async (req, res) => {
  try {
    const state = writeInstallationState() || buildInstallationState();
    const saved = readJson(installationPath, {}) || {};
    res.json({ ok: true, installation: saved, state });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/installation/sync', (req, res) => {
  try {
    const state = writeInstallationState();
    res.json({ ok: !!state, state: state ? { updated: state.updated, summary: state.summary } : null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/maintenance', async (req, res) => {
  try {
    res.json({ ok: true, maintenance: await maintenanceStatus(req) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/maintenance/start', async (req, res) => {
  try {
    const result = await ensureMaintenanceService({ wait: true, recreate: req.body?.recreate === true });
    res.json({ ok: true, ...result, maintenance: await maintenanceStatus(req) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.post('/api/maintenance/stop', async (req, res) => {
  try {
    const info = await maintenanceContainerInfo();
    if (!info) return res.json({ ok: true, running: false, message: 'Maintenance is not created.' });
    if (info.State?.Running) await docker.getContainer(maintenanceContainer).stop({ t: 10 }).catch(() => {});
    res.json({ ok: true, running: false, message: 'Maintenance stopped.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/maintenance/mode', async (req, res) => {
  try {
    const active = req.body?.active !== false;
    if (active) {
      const result = await ensureMaintenanceService({ wait: true });
      return res.json({ ok: true, active: true, ...result, maintenance: await maintenanceStatus(req) });
    }
    const self = await selfContainerInfo();
    if (self?.State && !self.State.Running) {
      await docker.getContainer(self.Id).start().catch(() => {});
    }
    const info = await maintenanceContainerInfo();
    if (info?.State?.Running) await docker.getContainer(maintenanceContainer).stop({ t: 10 }).catch(() => {});
    res.json({ ok: true, active: false, running: false, message: 'Maintenance mode is off.' });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ---------- logs ----------
app.get('/api/logs/server', (req, res) => {
  const lines = readServerLog(req.query.tail);
  res.json({ ok: true, lines, text: lines.join('\n'), path: serverLogPath });
});

app.delete('/api/logs/server', (req, res) => {
  try {
    serverLogBuffer.length = 0;
    fs.writeFileSync(serverLogPath, '', { mode: 0o600 });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/logs/apps', (req, res) => {
  const apps = readRegistry().map(entry => ({
    id: entry.id, name: entry.name, appDir: appDirFor(entry)
  }));
  const core = ['nginx-proxy', 'cloudflared', 'auth', 'authelia', 'dns', 'mailpit', 'stalwart', 'host-helper'].filter(service => {
    const map = { 'nginx-proxy': 'nginx-proxy', cloudflared: 'cloudflared', auth: 'auth', authelia: 'authelia', dns: 'dns', mailpit: 'mailpit', stalwart: 'stalwart', 'host-helper': 'host-helper' };
    return fs.existsSync(path.join(coreServiceDir(map[service]), 'docker-compose.yml'));
  });
  res.json({ apps, core });
});

app.get('/api/logs/app/:id', async (req, res) => {
  try {
    const entry = readRegistry().find(item => item.id === req.params.id || item.name === req.params.id);
    if (!entry) return res.status(404).json({ error: 'App not found' });
    const dir = appDirFor(entry);
    const composeFile = findComposeFile(dir);
    if (!composeFile) return res.status(404).json({ error: 'This app has no compose file' });
    const args = ['compose', '-f', composeFile, '-p', projectName(entry.name, 'app')];
    const override = path.join(dir, 'docker-compose.wickedafdok.yml');
    if (fs.existsSync(override)) args.push('-f', override);
    const tail = String(Math.max(1, Math.min(5000, Number(req.query.tail) || 300)));
    args.push('logs', '--no-color', '--tail', tail);
    const { stdout, stderr } = await run('docker', args, { cwd: dir });
    res.json({ ok: true, text: stdout || stderr || '(no logs)' });
  } catch (e) {
    res.status(500).json({ error: e.message, stdout: e.stdout, stderr: e.stderr });
  }
});

app.get('/api/logs/core/:service', async (req, res) => {
  try {
    const map = {
      'nginx-proxy': { dir: 'nginx-proxy', project: 'nginx-proxy' },
      cloudflared: { dir: 'cloudflared', project: 'cloudflared' },
      auth: { dir: 'auth', project: 'authentik' },
      authelia: { dir: 'authelia', project: 'authelia' },
      dns: { dir: 'dns', project: dnsProviderName(readSettings()) === 'adguard' ? 'adguard' : 'technitium' },
      mailpit: { dir: 'mailpit', project: 'mailpit' },
      stalwart: { dir: 'stalwart', project: 'stalwart' },
      'host-helper': { dir: 'host-helper', project: 'wickedafdok-host-helper' }
    };
    const target = map[req.params.service];
    if (!target) return res.status(404).json({ error: 'Unknown core service' });
    const dir = coreServiceDir(target.dir);
    const composeFile = path.join(dir, 'docker-compose.yml');
    if (!fs.existsSync(composeFile)) return res.status(404).json({ error: 'Core service has not been created yet' });
    const tail = String(Math.max(1, Math.min(5000, Number(req.query.tail) || 300)));
    const { stdout, stderr } = await run('docker', ['compose', '-f', composeFile, '-p', target.project, 'logs', '--no-color', '--tail', tail], { cwd: dir });
    res.json({ ok: true, text: stdout || stderr || '(no logs)' });
  } catch (e) {
    res.status(500).json({ error: e.message, stdout: e.stdout, stderr: e.stderr });
  }
});

// ---------- backups ----------
app.get('/api/backups', (req, res) => {
  res.json({ backups: listBackups() });
});

app.get('/api/backups/options', (req, res) => {
  try {
    res.json(backupOptions());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/backups', async (req, res) => {
  try {
    const body = req.body || {};
    const scope = body.scope === 'app' ? 'app' : body.scope === 'custom' ? 'custom' : 'full';
    const meta = await createBackup({
      name: body.name,
      scope,
      app: body.app || body.appId || '',
      includeLogs: body.includeLogs === true,
      components: body.components && typeof body.components === 'object' ? body.components : {},
      selectedApps: Array.isArray(body.apps) ? body.apps : [],
      selectedCore: Array.isArray(body.core) ? body.core : []
    });
    res.json({ ok: true, backup: meta, backups: listBackups() });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, stdout: e.stdout, stderr: e.stderr });
  }
});

app.get('/api/backups/:id/download', (req, res) => {
  const id = String(req.params.id || '').replace(/[^A-Za-z0-9._-]/g, '');
  const archive = backupArchivePath(id);
  if (!id || !fs.existsSync(archive)) return res.status(404).json({ error: 'Backup not found' });
  res.download(archive, `${id}.tar.gz`);
});

app.delete('/api/backups/:id', (req, res) => {
  try {
    const id = String(req.params.id || '').replace(/[^A-Za-z0-9._-]/g, '');
    if (!id) return res.status(400).json({ error: 'Backup id required' });
    fs.rmSync(backupArchivePath(id), { force: true });
    fs.rmSync(backupMetaPath(id), { force: true });
    res.json({ ok: true, backups: listBackups() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/backups/:id/restore', async (req, res) => {
  try {
    const id = String(req.params.id || '').replace(/[^A-Za-z0-9._-]/g, '');
    const archive = backupArchivePath(id);
    if (!id || !fs.existsSync(archive)) return res.status(404).json({ error: 'Backup not found' });
    const result = await restoreBackupArchive(archive, { overwrite: req.body?.overwrite === true });
    res.json(result);
  } catch (e) {
    res.status(e.status || 500).json({
      error: e.message, needsOverwrite: !!e.needsOverwrite, appName: e.appName, scope: e.scope
    });
  }
});

app.post('/api/backups/import', upload.single('file'), async (req, res) => {
  const uploaded = req.file?.path || '';
  let stored = '';
  try {
    if (!uploaded) return res.status(400).json({ error: 'Choose a backup archive to import' });
    const overwrite = String(req.body?.overwrite || '') === 'true';
    const id = backupId();
    stored = backupArchivePath(id);
    fs.copyFileSync(uploaded, stored);
    try { fs.chmodSync(stored, 0o600); } catch {}
    fs.rmSync(uploaded, { force: true });
    const result = await restoreBackupArchive(stored, { overwrite });
    const meta = {
      ...result.manifest,
      id,
      name: safeBackupLabel(req.body?.name || result.manifest.name, `Imported backup ${id}`),
      archive: stored,
      size: fs.statSync(stored).size,
      imported: true
    };
    writeBackupMeta(meta);
    res.json({ ok: true, ...result, backup: meta, backups: listBackups() });
  } catch (e) {
    let storedId = '';
    if (e.needsOverwrite && stored) {
      storedId = path.basename(stored, '.tar.gz');
      try {
        const { manifest } = await extractBackup(stored).catch(() => ({ manifest: null }));
        if (manifest) {
          const meta = { ...manifest, archive: stored, size: fs.statSync(stored).size, imported: true };
          writeBackupMeta({ ...meta, id: storedId });
        }
      } catch {}
    } else if (stored) {
      try { fs.rmSync(stored, { force: true }); } catch {}
      try { fs.rmSync(backupMetaPath(path.basename(stored, '.tar.gz')), { force: true }); } catch {}
    }
    if (uploaded && fs.existsSync(uploaded)) { try { fs.rmSync(uploaded, { force: true }); } catch {} }
    res.status(e.status || 500).json({
      error: e.message, needsOverwrite: !!e.needsOverwrite, appName: e.appName, scope: e.scope, backupId: storedId || undefined
    });
  }
});

let updateJob = {
  running: false,
  phase: 'idle',
  repo: '',
  branch: '',
  previousCommit: '',
  commit: '',
  image: '',
  started: '',
  error: '',
  log: ''
};

function beginDockerUpdate({ sourceDir, repo, branch, previousCommit, commit }) {
  updateJob = {
    running: true,
    phase: 'building',
    repo,
    branch,
    previousCommit,
    commit,
    image: '',
    started: new Date().toISOString(),
    error: '',
    log: ''
  };
  const record = (text) => {
    if (!text) return;
    updateJob.log = tailText(updateJob.log + text);
    appendUpdateLog(text);
  };
  record(`\n--- ${updateJob.started} updating WickedAFDok to ${commit || 'latest'} ---\n`);
  record(`Repository: ${repo} (${branch})\nSource: ${sourceDir}\n`);

  (async () => {
    try {
      const info = await selfContainerInfo();
      const image = updateImageTag(info?.Config?.Image || info?.Image || process.env.WICKEDAFDOK_IMAGE || '');
      updateJob.image = image;
      record(`Rebuilding image ${image}...\n`);
      // Do not pass `--progress`: older Docker CLIs without buildx reject it
      // with "unknown flag", and the captured output is plain either way.
      const build = await run('docker', ['build', '-t', image, sourceDir], {
        cwd: sourceDir,
        env: dockerEnvironment()
      });
      record(build.stdout);
      record(build.stderr);
      record(`\nImage rebuilt. Scheduling container recreation...\n`);

      const settings = readSettings();
      const nginx = settings.services?.nginxProxy || {};
      const domain = nginx.enabled ? normalizeDomain(nginx.domain) : '';
      let network = '';
      if (domain) {
        network = nginx.network || 'wicked';
      } else {
        const networks = Object.keys(info?.NetworkSettings?.Networks || {});
        network = networks.find(name => !['bridge', 'host', 'none'].includes(name)) || networks[0] || '';
      }

      updateJob.phase = 'recreating';
      const restart = await scheduleSelfRecreate(domain, network);
      if (!restart.scheduled) {
        throw new Error(restart.reason || restart.error || 'Container recreation was not scheduled');
      }
      record('Container recreation scheduled. WickedAFDok will reconnect shortly.\n');
      updateJob.running = false;
      updateJob.phase = 'recreating';
    } catch (e) {
      const details = `${e.message || 'Update failed'}\n${e.stdout || ''}${e.stderr || ''}`;
      record(`\nUpdate failed: ${details}\n`);
      updateJob.running = false;
      updateJob.phase = 'error';
      updateJob.error = e.message || 'Update failed';
      updateJob.log = tailText(`${updateJob.log}\n${e.stdout || ''}${e.stderr || ''}`);
      appendServerLog('ERROR', `WickedAFDok update failed: ${e.message || e}`);
    }
  })();

  return updateJob;
}

app.get('/api/system/update-info', async (req, res) => {
  const sourceDir = updateSourceDir();
  const settings = readSettings();
  const saved = settings.updates || {};
  const info = {
    source: sourceDir === root ? 'image' : 'checkout',
    docker: fs.existsSync('/.dockerenv'),
    repo: saved.repo || '',
    branch: saved.branch || '',
    commit: '',
    subject: '',
    dirty: false,
    running: updateJob.running,
    phase: updateJob.phase
  };
  try {
    info.repo = info.repo || await gitText(['remote', 'get-url', 'origin'], sourceDir);
    info.branch = info.branch || await gitText(['rev-parse', '--abbrev-ref', 'HEAD'], sourceDir);
    info.commit = await gitText(['rev-parse', '--short', 'HEAD'], sourceDir);
    info.subject = await gitText(['log', '-1', '--pretty=%s'], sourceDir);
    info.dirty = !!await gitText(['status', '--porcelain'], sourceDir);
  } catch {}
  res.json(info);
});

app.get('/api/system/update-status', (req, res) => {
  res.json({
    running: updateJob.running,
    phase: updateJob.phase,
    repo: updateJob.repo,
    branch: updateJob.branch,
    previousCommit: updateJob.previousCommit,
    commit: updateJob.commit,
    image: updateJob.image,
    started: updateJob.started,
    error: updateJob.error,
    log: updateJob.log
  });
});

app.post('/api/system/update-from-git', async (req, res) => {
  try {
    if (updateJob.running) {
      return res.status(409).json({ error: 'An update is already running', phase: updateJob.phase });
    }
    const settings = readSettings();
    const saved = settings.updates || {};
    const sourceDir = updateSourceDir();
    const requestedRepo = String(req.body?.repo || '').trim();
    const requestedBranch = String(req.body?.branch || '').trim();
    const force = req.body?.force === true;

    let repo = requestedRepo || saved.repo || '';
    if (!repo) {
      try { repo = await gitText(['remote', 'get-url', 'origin'], sourceDir); } catch {}
    }
    if (!repo) return res.status(400).json({ error: 'repo required' });
    if (!/^(https?:\/\/|git:\/\/|ssh:\/\/|git@)[^\s]+$/.test(repo)) {
      return res.status(400).json({ error: 'Repo must be an http(s), git, ssh, or git@ URL' });
    }

    let branch = requestedBranch || saved.branch || '';
    if (!branch) {
      try { branch = await gitText(['rev-parse', '--abbrev-ref', 'HEAD'], sourceDir); } catch {}
      if (!branch || branch === 'HEAD') {
        try {
          const remote = await run('git', ['ls-remote', '--symref', repo, 'HEAD'], { env: gitEnvironment(repo) });
          branch = String(remote.stdout || '').match(/ref: refs\/heads\/([^\s]+)\s+HEAD/)?.[1] || '';
        } catch {}
      }
    }
    if (!branch) branch = 'main';
    if (!/^[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(branch)) {
      return res.status(400).json({ error: 'Invalid branch name' });
    }

    try {
      fs.accessSync(sourceDir, fs.constants.W_OK);
    } catch {
      throw httpError(403,
        `The application code directory ${sourceDir} is not writable by UID/GID ${processIdentity()}. ` +
        'Self-update requires a writable code checkout, for example when running as root or from a writable bind mount.'
      );
    }

    let previousCommit = '';
    try { previousCommit = await gitText(['rev-parse', '--short', 'HEAD'], sourceDir); } catch {}
    let dirty = '';
    try { dirty = await gitText(['status', '--porcelain'], sourceDir); } catch {}
    if (dirty && !force) {
      return res.status(409).json({
        error: 'The source checkout has local changes. Commit or discard them, or confirm the overwrite.',
        dirty: true
      });
    }

    // Ensure the checkout exists and points at the requested repo.
    try {
      await run('git', ['rev-parse', '--git-dir'], { cwd: sourceDir });
    } catch {
      try { await run('git', ['init'], { cwd: sourceDir }); } catch {}
    }
    try {
      await run('git', ['remote', 'set-url', 'origin', repo], { cwd: sourceDir });
    } catch {
      try { await run('git', ['remote', 'add', 'origin', repo], { cwd: sourceDir }); } catch {}
    }

    const gitEnv = gitEnvironment(repo);
    let stdout = '';
    let stderr = '';
    let method = 'reset';
    let fetched = false;
    try {
      const out = await run('git', ['fetch', 'origin', branch], { cwd: sourceDir, env: gitEnv });
      stdout += out.stdout;
      stderr += out.stderr;
      fetched = true;
    } catch (e) {
      stdout += e.stdout || '';
      stderr += e.stderr || '';
    }
    if (!fetched) {
      try {
        const out = await run('git', ['fetch', '--all', '--prune'], { cwd: sourceDir, env: gitEnv });
        stdout += out.stdout;
        stderr += out.stderr;
        method = 'fetch-all';
        fetched = true;
      } catch (e) {
        stdout += e.stdout || '';
        stderr += e.stderr || '';
      }
    }
    if (!fetched) {
      throw httpError(502, `Unable to fetch ${repo}: ${String(stderr || 'git fetch failed').trim()}`);
    }

    try {
      const out = await run('git', ['reset', '--hard', `origin/${branch}`], { cwd: sourceDir });
      stdout += out.stdout;
      stderr += out.stderr;
    } catch (e) {
      try {
        const out = await run('git', ['reset', '--hard', branch], { cwd: sourceDir });
        stdout += out.stdout;
        stderr += out.stderr;
        method = 'reset-local';
      } catch {
        throw httpError(502, `Fetched ${repo}, but could not check out ${branch}: ${String(e.stderr || e.message).trim()}`);
      }
    }

    const commit = await gitText(['rev-parse', '--short', 'HEAD'], sourceDir);
    const subject = await gitText(['log', '-1', '--pretty=%s'], sourceDir).catch(() => '');
    const nextSettings = readSettings();
    nextSettings.updates = { repo, branch };
    writeSettings(nextSettings);

    const changed = !previousCommit || previousCommit !== commit;
    const dockerRuntime = fs.existsSync('/.dockerenv');
    if (!changed) {
      return res.json({
        ok: true,
        upToDate: true,
        repo,
        branch,
        previousCommit,
        commit,
        subject,
        changed: false,
        method,
        stdout: tailText(stdout, 20000),
        stderr: tailText(stderr, 20000),
        message: `Already up to date at ${commit}.`
      });
    }

    if (dockerRuntime) {
      const job = beginDockerUpdate({ sourceDir, repo, branch, previousCommit, commit });
      return res.json({
        ok: true,
        running: true,
        repo,
        branch,
        previousCommit,
        commit,
        subject,
        changed,
        method,
        stdout: tailText(stdout, 20000),
        stderr: tailText(stderr, 20000),
        update: {
          running: job.running,
          phase: job.phase
        },
        message: `Pulled ${commit}. Rebuilding the image and recreating WickedAFDok.`
      });
    }

    return res.json({
      ok: true,
      repo,
      branch,
      previousCommit,
      commit,
      subject,
      changed,
      method,
      stdout: tailText(stdout, 20000),
      stderr: tailText(stderr, 20000),
      restartRequired: true,
      message: `Pulled ${commit}. Restart WickedAFDok to apply the new code.`
    });
  } catch (e) {
    res.status(e.status || 500).json({
      error: e.message,
      stdout: tailText(e.stdout, 20000),
      stderr: tailText(e.stderr, 20000)
    });
  }
});

app.use((err, req, res, next) => {
  console.error(err);
  const permissionFailure = ['EACCES', 'EPERM', 'EROFS'].includes(err.code);
  const alreadyHinted = String(err.message || '').includes('cannot access /var/run/docker.sock');
  const dockerHint = alreadyHinted ? '' : dockerSocketHint(err);
  const status = err.status || (permissionFailure ? 403 : 500);
  let message;
  if (err.status) {
    message = err.message || 'Internal server error';
  } else if (dockerHint) {
    message = `${String(err.message || 'Docker is unavailable').trim()}.${dockerHint}`;
  } else if (permissionFailure) {
    message = `${err.message}. The server is running as UID/GID ${processIdentity()}. Run "sudo ./setup.sh" on the host to fix runtime directory ownership.`;
  } else {
    message = err.message || 'Internal server error';
  }
  res.status(status).json({ error: message });
});

cleanupAppPreviews();
ensureAppAgentsFile();

const server = http.createServer(app);
const terminalWss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
terminalWss.on('error', (err) => {
  appendServerLog('ERROR', `terminal websocket server error: ${err?.message || err}`);
});

server.on('upgrade', (req, socket, head) => {
  try {
    let url;
    try {
      url = new URL(req.url || '/', 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== '/api/terminal/ws') {
      socket.destroy();
      return;
    }
    // Accept the origin when any host header the proxy may have forwarded
    // matches it. Some proxies rewrite `Host` to the backend address, which used
    // to make every chat attach fail with 403 while OpenCode kept running.
    const origin = req.headers.origin;
    if (origin) {
      try {
        const originUrl = new URL(origin);
        const hosts = [
          req.headers['x-forwarded-host'],
          req.headers['x-original-host'],
          req.headers.host
        ]
          .flatMap(value => String(value || '').split(','))
          .map(value => value.trim().toLowerCase())
          .filter(Boolean);
        const originHost = originUrl.host.toLowerCase();
        const originHostname = originUrl.hostname.toLowerCase();
        const allowed = hosts.some(host =>
          host === originHost ||
          host.split(':')[0] === originHostname);
        if (hosts.length && !allowed) {
          appendServerLog('WARN', `terminal websocket rejected: origin ${origin} does not match host ${hosts.join(', ')}`);
          socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
          socket.destroy();
          return;
        }
      } catch {
        appendServerLog('WARN', `terminal websocket rejected: invalid origin ${origin}`);
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
    }
    const id = url.searchParams.get('id') || '';
    const session = terminalSessions.get(id);
    if (!session) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    terminalWss.handleUpgrade(req, socket, head, (ws) => {
      terminalWss.emit('connection', ws, req, session);
    });
  } catch (err) {
    appendServerLog('ERROR', `terminal websocket upgrade failed: ${err?.message || err}`);
    try { socket.destroy(); } catch {}
  }
});

terminalWss.on('connection', (ws, req, session) => {
  if (!session || !terminalSessions.has(session.id)) {
    try { ws.close(4404, 'session not found'); } catch {}
    return;
  }
  session.lastActivity = Date.now();
  session.lastClientAt = Date.now();
  ws.isAlive = true;

  try {
    ws.send(JSON.stringify({
      type: 'ready',
      session: terminalSessionSummary(session),
      modes: TERMINAL_MODES
    }));
    for (const chunk of session.buffer) ws.send(JSON.stringify({ type: 'output', data: chunk.data }));
    if (session.exited) ws.send(JSON.stringify({ type: 'exit', code: session.exitCode }));
  } catch {}

  session.clients.add(ws);
  appendServerLog('INFO', `terminal client attached to ${session.id} (${session.mode} ${session.app})`);

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw, isBinary) => {
    session.lastActivity = Date.now();
    session.lastClientAt = Date.now();
    if (isBinary) {
      if (!session.exited) {
        try { session.pty.write(raw.toString('utf8')); } catch {}
      }
      return;
    }
    let message;
    try {
      message = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;
    if (message.type === 'input' && typeof message.data === 'string' && !session.exited) {
      try { session.pty.write(message.data); } catch {}
    } else if (message.type === 'resize') {
      const cols = Math.max(20, Math.min(400, Number(message.cols) || 0));
      const rows = Math.max(5, Math.min(200, Number(message.rows) || 0));
      if (cols && rows) {
        try { session.pty.resize(cols, rows); } catch {}
      }
    } else if (message.type === 'ping') {
      try { ws.send(JSON.stringify({ type: 'pong', at: Date.now() })); } catch {}
    }
  });

  ws.on('close', () => {
    session.clients.delete(ws);
    session.lastActivity = Date.now();
    session.lastClientAt = Date.now();
    appendServerLog('INFO', `terminal client detached from ${session.id} (${session.mode} ${session.app})`);
    scheduleTerminalCleanup(session);
  });

  ws.on('error', () => {
    session.clients.delete(ws);
    session.lastClientAt = Date.now();
  });
});

// Keep the socket alive through reverse proxies and reap clients that vanished
// without a close frame. Protocol-level pings are answered by every browser
// even when the page is running an older app.js.
const terminalHeartbeatTimer = setInterval(() => {
  for (const session of Array.from(terminalSessions.values())) {
    for (const ws of Array.from(session.clients)) {
      if (ws.readyState !== ws.OPEN) {
        session.clients.delete(ws);
        continue;
      }
      if (ws.isAlive === false) {
        try { ws.terminate(); } catch {}
        session.clients.delete(ws);
        continue;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch {}
    }
    if (!session.clients.size) scheduleTerminalCleanup(session, 1000);
  }
}, TERMINAL_HEARTBEAT_MS);
if (terminalHeartbeatTimer.unref) terminalHeartbeatTimer.unref();

// Encrypt legacy plaintext secrets on first start and keep settings normalized.
try {
  writeSettings(readSettings());
} catch (e) {
  appendServerLog('WARN', `settings secret migration failed: ${e.message}`);
}

// Record the complete installation state for the Maintenance container and
// refresh it on a timer so changes made outside Dok's settings routes (compose
// edits, core-service files, app folders) are still captured.
try {
  writeInstallationState();
} catch (e) {
  appendServerLog('WARN', `initial installation state failed: ${e.message}`);
}
const installationStateTimerInterval = setInterval(() => { writeInstallationState(); }, 30_000);
if (installationStateTimerInterval.unref) installationStateTimerInterval.unref();

// Ship editable error-page templates with every installation. Existing user
// edits are left untouched.
try {
  ensureNginxErrorPages();
} catch (e) {
  appendServerLog('WARN', `nginx error page preparation failed: ${e.message}`);
}

// A stray rejection from a background task (Docker, a PTY, or a websocket) must
// not take the whole UI offline. Log it so it is actionable instead of letting
// Node's default exit behaviour restart the container.
process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? (reason.stack || reason.message) : String(reason);
  appendServerLog('ERROR', `Unhandled promise rejection: ${message}`);
  console.error('Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  const message = err?.stack || err?.message || String(err);
  appendServerLog('ERROR', `Uncaught exception: ${message}`);
  console.error('Uncaught exception:', err);
});

server.on('clientError', (err, socket) => {
  try { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); } catch {}
});
server.on('error', (err) => {
  appendServerLog('ERROR', `HTTP server error: ${err?.message || err}`);
  console.error('HTTP server error:', err);
  // If another process grabbed the listen port, staying alive would leave the UI
  // permanently unreachable. Exit so Docker's restart policy recreates the
  // container cleanly instead.
  if (err?.code === 'EADDRINUSE') process.exit(1);
});

const port = process.env.PORT || 8080;
server.listen(port, () => {
  console.log(`WickedAFDok listening on http://0.0.0.0:${port}`);
});

async function logDockerAccess() {
  try {
    await docker.version();
  } catch (e) {
    const hint = dockerSocketHint(e);
    const lines = [`Docker is not reachable: ${e.message}`];
    try {
      const st = fs.statSync('/var/run/docker.sock');
      lines.push(`  /var/run/docker.sock owner ${st.uid}:${st.gid}, mode ${(st.mode & 0o777).toString(8)}`);
    } catch {
      lines.push('  /var/run/docker.sock is not present in this container');
    }
    let groups = 'unknown';
    try { groups = process.getgroups().join(', ') || 'none'; } catch {}
    lines.push(`  process UID/GID ${processIdentity()}, supplementary groups ${groups}`);
    if (hint) lines.push(` ${hint.trim()}`);
    for (const line of lines) console.error(line);
    appendServerLog('ERROR', lines.join('\n'));
  }
}
logDockerAccess().catch(() => {});

// Keep ENABLE_AUTH vhosts and Authelia cookie domains reconciled even when
// containers are started outside WickedAFDok.
syncAuthVhosts().catch(() => {});
const authVhostSyncTimer = setInterval(() => { syncAuthVhosts().catch(() => {}); }, 60_000);
if (authVhostSyncTimer.unref) authVhostSyncTimer.unref();

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    stopAllTerminalSessions();
    stopOpencodeServer('stopped during shutdown');
    server.close(() => process.exit(0));
    const timer = setTimeout(() => process.exit(0), 2500);
    if (timer.unref) timer.unref();
  });
}
