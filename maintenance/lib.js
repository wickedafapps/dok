import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import os from 'os';
import { execFile } from 'child_process';

export const DOK_ROOT = path.resolve(process.env.DOK_ROOT || '/dok');
export const HOST_ROOT = path.resolve(process.env.HOST_ROOT || '/host');
export const MAINT_DATA = path.resolve(process.env.MAINTENANCE_DATA || '/maintenance-data');
export const DOK_CONTAINER = String(process.env.DOK_CONTAINER || 'wickedafdok').trim();
export const DOK_PORT = Number(process.env.DOK_PORT) || 8080;
export const DOK_IMAGE = String(process.env.DOK_IMAGE || 'wickedafdok:latest').trim();
export const DOK_HOST_PATH = String(process.env.DOK_HOST_PATH || DOK_ROOT).trim();
export const DOK_COMPOSE_ROOT = (() => {
  try {
    if (path.isAbsolute(DOK_HOST_PATH) && fs.existsSync(path.join(DOK_HOST_PATH, 'docker-compose.yml'))) return DOK_HOST_PATH;
  } catch {}
  return DOK_ROOT;
})();
export const MAINTENANCE_URL = String(process.env.MAINTENANCE_URL || 'http://wickedafdok-maintenance:8090').trim();
export const DEFAULT_NETWORK = 'wicked';
export const STATE_SCHEMA = 'wickedafdok.installation/v1';
export const BACKUP_SCHEMA = 'wickedafdok.maintenance-backup/v1';

export const dataDir = path.join(DOK_ROOT, 'data');
export const appsDir = path.join(DOK_ROOT, 'apps');
export const coreDir = path.join(DOK_ROOT, 'core');
export const sourcesDir = path.join(DOK_ROOT, 'sources');
export const uploadsDir = path.join(DOK_ROOT, 'uploads');
export const backupsDir = path.join(MAINT_DATA, 'backups');
export const snapshotsDir = path.join(MAINT_DATA, 'snapshots');
export const logsDir = path.join(MAINT_DATA, 'logs');
export const opencodeDir = path.join(MAINT_DATA, 'opencode');
export const installationPath = path.join(MAINT_DATA, 'installation.json');
export const installationStatePath = path.join(MAINT_DATA, 'installation-state.json');
export const dokInstallationStatePath = path.join(dataDir, 'installation-state.json');
export const dokInstallationPath = path.join(dataDir, 'installation.json');
export const tokenPath = process.env.MAINTENANCE_TOKEN_FILE || path.join(dataDir, '.maintenance-token');

export function ensureDirs() {
  for (const dir of [MAINT_DATA, backupsDir, snapshotsDir, logsDir, opencodeDir,
    path.join(opencodeDir, 'home'), path.join(opencodeDir, 'config'),
    path.join(opencodeDir, 'state'), path.join(opencodeDir, 'data'), path.join(opencodeDir, 'cache')]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  try { fs.chmodSync(MAINT_DATA, 0o700); } catch {}
  for (const dir of [backupsDir, snapshotsDir, logsDir, opencodeDir]) {
    try { fs.chmodSync(dir, 0o700); } catch {}
  }
  for (const dir of [dataDir, appsDir, coreDir, sourcesDir, uploadsDir]) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  }
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value, { mode = 0o600 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, mode); } catch {}
  chownIfDokFile(file);
  return value;
}

export function writePrivateFile(file, content, { mode = 0o600 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode });
  try { fs.chmodSync(file, mode); } catch {}
  chownIfDokFile(file);
}

function chownIfDokFile(file) {
  const target = path.resolve(String(file || ''));
  if (target !== DOK_ROOT && !target.startsWith(DOK_ROOT + path.sep)) return;
  try { chownDokPath(target); } catch {}
}

export function run(command, args = [], { cwd = DOK_ROOT, env = {}, timeout = 0, input = '' } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, {
      cwd,
      timeout: timeout || 0,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, ...env }
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
    if (input && child.stdin) {
      child.stdin.end(input);
    }
  });
}

export async function runShell(script, options = {}) {
  return run('/bin/sh', ['-c', script], options);
}

export function tail(value, limit = 50000) {
  const text = String(value || '');
  return text.length > limit ? text.slice(-limit) : text;
}

export function randomSecret(bytes = 24) {
  return crypto.randomBytes(bytes).toString('hex').slice(0, bytes * 2);
}

export function yamlScalar(value) {
  const text = value === null || value === undefined ? '' : String(value);
  if (/^[A-Za-z0-9_./@%+=:, -]+$/.test(text) && !/^\s|\s$/.test(text) && !/^(true|false|yes|no|null|~|\d+(\.\d+)?)$/i.test(text)) {
    return text;
  }
  return JSON.stringify(text);
}

export function normalizeDomain(value) {
  return String(value || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

export function validDomain(value) {
  const domain = normalizeDomain(value);
  return !domain || /^[A-Za-z0-9*][A-Za-z0-9*._-]*$/.test(domain);
}

export function projectName(value, fallback = 'app') {
  const text = String(value || '').trim().toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return text || fallback;
}

// ---------- credential encryption ----------
const credentialsKeyPath = path.join(dataDir, '.credentials-key');

export function credentialsKey({ create = true } = {}) {
  try {
    if (fs.existsSync(credentialsKeyPath)) {
      const key = fs.readFileSync(credentialsKeyPath);
      if (key.length === 32) return key;
      if (!create) return null;
      const backup = `${credentialsKeyPath}.invalid-${Date.now()}`;
      fs.copyFileSync(credentialsKeyPath, backup);
      fs.chmodSync(backup, 0o600);
    }
  } catch {}
  if (!create) return null;
  const key = crypto.randomBytes(32);
  writePrivateFile(credentialsKeyPath, key);
  return key;
}

export function isStoredSecret(value) {
  if (typeof value !== 'string') return false;
  const parts = value.split(':');
  return parts.length === 4 && parts[0] === 'v1' &&
    parts.slice(1).every(part => /^[A-Za-z0-9+/=]+$/.test(part));
}

export function encryptSecret(plain) {
  const text = String(plain ?? '');
  if (!text) return '';
  if (isStoredSecret(text)) return text;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', credentialsKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${encrypted.toString('base64')}`;
}

export function decryptSecret(value) {
  const text = String(value ?? '');
  if (!text.startsWith('v1:')) return text;
  const [, iv, tag, payload] = text.split(':');
  if (!iv || !tag || !payload) throw new Error('Malformed stored credential');
  const decipher = crypto.createDecipheriv('aes-256-gcm', credentialsKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(payload, 'base64')), decipher.final()]).toString('utf8');
}

export const SETTINGS_SECRET_PATHS = [
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

export function mapSettingsSecrets(settings, transform) {
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

export function readSettings() {
  const raw = readJson(path.join(dataDir, 'settings.json'), {}) || {};
  return mapSettingsSecrets(JSON.parse(JSON.stringify(raw)), value => {
    if (!isStoredSecret(value)) return value;
    try { return decryptSecret(value); } catch { return ''; }
  });
}

export function encryptSettings(settings) {
  const clone = JSON.parse(JSON.stringify(settings || {}));
  return mapSettingsSecrets(clone, value => isStoredSecret(value) ? value : encryptSecret(value));
}

export function writeSettings(settings) {
  writeJson(path.join(dataDir, 'settings.json'), encryptSettings(settings));
  return settings;
}

export function readRegistries() {
  const data = readJson(path.join(dataDir, 'registries.json'), { connections: [] }) || {};
  if (!Array.isArray(data.connections)) data.connections = [];
  return data;
}

export function writeRegistries(data) {
  return writeJson(path.join(dataDir, 'registries.json'), data || { connections: [] });
}

export function readRegistry() {
  const data = readJson(path.join(dataDir, 'registry.json'), []);
  return Array.isArray(data) ? data : [];
}

export function readGroups() {
  const data = readJson(path.join(dataDir, 'groups.json'), { groups: [] }) || {};
  if (!Array.isArray(data.groups)) data.groups = [];
  return data;
}

export function readInstallation() {
  const saved = readJson(installationPath, null);
  if (saved && typeof saved === 'object') return saved;
  const dokState = readJson(dokInstallationPath, null);
  if (dokState && typeof dokState === 'object') return dokState;
  return null;
}

export function saveInstallation(value) {
  const current = readInstallation() || {};
  const next = {
    schema: STATE_SCHEMA,
    id: current.id || `dok-${Date.now().toString(36)}-${randomSecret(3)}`,
    created: current.created || new Date().toISOString(),
    ...current,
    ...value,
    updated: new Date().toISOString()
  };
  writeJson(installationPath, next);
  try { writeJson(dokInstallationPath, next); } catch {}
  return next;
}

export function installationExists() {
  return !!readInstallation();
}

export function installationState() {
  const state = readJson(dokInstallationStatePath, null) || readJson(installationStatePath, null);
  if (!state || typeof state !== 'object') return null;
  return state;
}

export function refreshInstallationState() {
  const state = readJson(dokInstallationStatePath, null);
  if (!state || typeof state !== 'object') return null;
  writeJson(installationStatePath, state);
  const current = readInstallation() || {};
  const restored = readJson(dokInstallationPath, null);
  const restoredRecord = restored && typeof restored === 'object' ? restored : {};
  const pick = (key) => restoredRecord[key] ?? current[key];
  saveInstallation({
    ...(pick('id') ? { id: pick('id') } : {}),
    ...(pick('created') ? { created: pick('created') } : {}),
    ...(pick('type') ? { type: pick('type') } : {}),
    ...(pick('plan') ? { plan: pick('plan') } : {}),
    ...(pick('completedAt') !== undefined ? { completedAt: pick('completedAt') } : {}),
    ...(pick('services') ? { services: pick('services') } : {}),
    ...(pick('reinstall') ? { reinstall: pick('reinstall') } : {}),
    dok: { ...(current.dok || {}), ...(restoredRecord.dok || {}), ...(state.dok || {}) },
    summary: state.summary || current.summary || {},
    lastStateSync: new Date().toISOString()
  });
  return state;
}

// ---------- identity helpers ----------
let dokOwnerCache = { at: 0, uid: 0, gid: 0 };

export function dokOwner() {
  if (Date.now() - dokOwnerCache.at < 15000) return dokOwnerCache;
  let uid = Number(process.env.DOK_UID);
  let gid = Number(process.env.DOK_GID);
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) {
    try {
      const stat = fs.statSync(DOK_ROOT);
      uid = stat.uid;
      gid = stat.gid;
    } catch {
      uid = 0;
      gid = 0;
    }
  }
  dokOwnerCache = { at: Date.now(), uid, gid };
  return dokOwnerCache;
}

export function chownDokPath(target) {
  const { uid, gid } = dokOwner();
  if (process.getuid && process.getuid() !== 0) return;
  try { fs.chownSync(target, uid, gid); } catch {}
}

export function chownTree(target) {
  const { uid, gid } = dokOwner();
  if (process.getuid && process.getuid() !== 0) return;
  const walk = (current) => {
    try { fs.chownSync(current, uid, gid); } catch {}
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      walk(path.join(current, entry.name));
    }
  };
  walk(target);
}

export function chmodPrivate(file) {
  try { fs.chmodSync(file, 0o600); } catch {}
}

// ---------- docker ----------
export async function docker(args, options = {}) {
  return run('docker', args, { cwd: DOK_ROOT, timeout: 120000, ...options });
}

export async function dockerInspect(container = DOK_CONTAINER) {
  try {
    const { stdout } = await docker(['container', 'inspect', container]);
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed) ? parsed[0] : parsed;
  } catch {
    return null;
  }
}

export async function dokStatus() {
  const info = await dockerInspect(DOK_CONTAINER);
  const maintenanceInfo = await dockerInspect('wickedafdok-maintenance');
  return {
    exists: !!info,
    running: info?.State?.Running === true,
    state: info?.State?.Status || (info ? 'stopped' : 'not created'),
    startedAt: info?.State?.StartedAt || '',
    image: info?.Config?.Image || '',
    id: info?.Id || '',
    maintenance: {
      exists: !!maintenanceInfo,
      running: maintenanceInfo?.State?.Running === true,
      state: maintenanceInfo?.State?.Status || (maintenanceInfo ? 'stopped' : 'not created'),
      id: maintenanceInfo?.Id || ''
    }
  };
}

export async function dockerJson(args) {
  const { stdout } = await docker(args);
  const text = String(stdout || '').trim();
  if (!text) return [];
  const lines = text.split('\n').filter(Boolean);
  try {
    return lines.map(line => JSON.parse(line));
  } catch {
    try { return JSON.parse(text); } catch { return []; }
  }
}

export async function containerList({ all = true } = {}) {
  const containers = await dockerJson(['ps', '--format', '{{json .}}'].concat(all ? ['-a'] : []));
  return containers.map(item => ({
    id: item.ID,
    name: String(item.Names || '').replace(/^\//, ''),
    image: item.Image || '',
    state: item.State || '',
    status: item.Status || '',
    labels: item.Labels ? Object.fromEntries(String(item.Labels).split(',').map(part => {
      const idx = part.indexOf('=');
      return idx === -1 ? [part, ''] : [part.slice(0, idx), part.slice(idx + 1)];
    }).filter(([key]) => key)) : {}
  }));
}

export async function ensureNetwork(name = DEFAULT_NETWORK) {
  try {
    await docker(['network', 'inspect', name]);
    return { created: false, name };
  } catch {
    await docker(['network', 'create', '--driver', 'bridge', name]);
    return { created: true, name };
  }
}

export async function dokApi(pathname, { method = 'GET', body, timeout = 120000 } = {}) {
  const url = `http://${DOK_CONTAINER}:${DOK_PORT}${pathname.startsWith('/') ? pathname : '/' + pathname}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    });
    let data = null;
    try { data = await response.json(); } catch {}
    if (!response.ok) {
      const message = data?.error || `Dok returned HTTP ${response.status}`;
      const err = new Error(message);
      err.status = response.status;
      err.data = data;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

export async function waitForDok(timeoutMs = 180000) {
  const started = Date.now();
  let lastError = '';
  while (Date.now() - started < timeoutMs) {
    try {
      await dokApi('/api/health', { timeout: 5000 });
      return true;
    } catch (e) {
      lastError = e.message;
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  throw new Error(`Dok did not become ready: ${lastError}`);
}

// ---------- maintenance auth token ----------
export function maintenanceToken({ create = false } = {}) {
  try {
    const token = fs.readFileSync(tokenPath, 'utf-8').trim();
    if (token) return token;
  } catch {}
  if (!create) return '';
  const token = randomSecret(24);
  try {
    writePrivateFile(tokenPath, token);
    chownDokPath(tokenPath);
  } catch {}
  return token;
}

// ---------- installation plan ----------
export const CORE_CATEGORIES = [
  {
    id: 'proxy',
    label: 'Reverse proxy and HTTPS',
    description: 'Routes your domains to Dok and your apps. Strongly recommended.',
    options: [
      {
        id: 'nginx-proxy',
        label: 'nginx-proxy',
        description: 'Virtual-host reverse proxy with optional Let\'s Encrypt certificates.',
        requiredFields: ['dokDomain'],
        fields: ['dokDomain', 'acmeEmail']
      }
    ]
  },
  {
    id: 'tunnel',
    label: 'Cloudflare Tunnel',
    description: 'Expose Dok and apps without opening host ports.',
    options: [
      {
        id: 'cloudflared',
        label: 'cloudflared',
        description: 'Cloudflare Tunnel connector using a tunnel token.',
        fields: ['cloudflareToken']
      }
    ]
  },
  {
    id: 'auth',
    label: 'Authentication',
    description: 'Add a login layer in front of protected apps and optionally the Dok UI.',
    options: [
      {
        id: 'authelia',
        label: 'Authelia',
        description: 'Forward-auth portal for apps with ENABLE_AUTH=true. Requires HTTPS certificates.',
        requiredFields: ['authDomain', 'adminPassword'],
        fields: ['authDomain', 'adminUser', 'adminEmail', 'adminPassword', 'protectDok']
      },
      {
        id: 'authentik',
        label: 'Authentik',
        description: 'Single sign-on and user management portal. Configure app providers in its admin UI.',
        requiredFields: ['authDomain'],
        fields: ['authDomain', 'adminEmail', 'adminPassword', 'authPort']
      }
    ]
  },
  {
    id: 'dns',
    label: 'DNS and ad blocking',
    description: 'Run DNS for your network with a web console.',
    options: [
      {
        id: 'technitium',
        label: 'Technitium DNS',
        description: 'Full DNS server with zones, records, blocklists, and a web console.',
        fields: ['dnsProvider', 'dnsDomain', 'dnsPort', 'adminPassword']
      },
      {
        id: 'adguard',
        label: 'AdGuard Home',
        description: 'Filtering DNS server with its own setup wizard.',
        fields: ['dnsProvider', 'dnsDomain', 'dnsWebPort', 'dnsPort']
      }
    ]
  },
  {
    id: 'mail',
    label: 'Email',
    description: 'Outgoing notifications and an optional test sink or full mail server.',
    options: [
      {
        id: 'mailpit',
        label: 'Mailpit (test sink)',
        description: 'Captures mail locally so you can inspect password resets and alerts.',
        fields: ['mailDomain', 'mailpitSmtpPort', 'mailpitWebPort', 'mailpitMaxMessages']
      },
      {
        id: 'stalwart',
        label: 'Stalwart Mail Server',
        description: 'Full IMAP/JMAP/SMTP mail server with a web admin.',
        fields: ['mailDomain', 'stalwartAdminUser', 'stalwartAdminPassword', 'stalwartWebPort', 'stalwartSmtpPort', 'stalwartSubmissionPort', 'stalwartImapsPort']
      },
      {
        id: 'smtp',
        label: 'External SMTP only',
        description: 'Use an existing SMTP provider for notifications.',
        requiredFields: ['smtpHost', 'smtpFrom'],
        fields: ['smtpHost', 'smtpPort', 'smtpTls', 'smtpUser', 'smtpPassword', 'smtpFrom']
      }
    ]
  }
];

export const SERVICE_OPTION_IDS = new Set(CORE_CATEGORIES.flatMap(category => category.options.map(option => option.id)));

export function selectedServiceIds(plan = {}) {
  const services = plan.services && typeof plan.services === 'object' ? plan.services : {};
  const selected = new Set();
  for (const category of CORE_CATEGORIES) {
    const choice = services[category.id];
    const value = String(choice || '').trim();
    if (value && SERVICE_OPTION_IDS.has(value)) selected.add(value);
  }
  // Backward/alternate shape: explicit array of service ids.
  if (Array.isArray(plan.selectedServices)) {
    for (const value of plan.selectedServices) {
      if (SERVICE_OPTION_IDS.has(String(value))) selected.add(String(value));
    }
  }
  return selected;
}

export function normalizeInstallPlan(body = {}) {
  const type = body.type === 'core' || body.type === 'dok-with-core' ? 'core' : 'standalone';
  const defaults = body.defaults && typeof body.defaults === 'object' ? body.defaults : {};
  const services = body.services && typeof body.services === 'object' ? body.services : {};
  const registries = Array.isArray(body.registries) ? body.registries : [];
  const plan = {
    type,
    defaults: {
      primaryDomain: normalizeDomain(defaults.primaryDomain || ''),
      dokDomain: normalizeDomain(defaults.dokDomain || ''),
      dataLocation: String(defaults.dataLocation || '').trim(),
      dataMode: String(defaults.dataMode || '0775').trim(),
      allowOutsideData: defaults.allowOutsideData !== false,
      autoAppData: defaults.autoAppData !== false,
      adminUser: String(defaults.adminUser || 'admin').trim() || 'admin',
      adminEmail: String(defaults.adminEmail || '').trim(),
      adminPassword: String(defaults.adminPassword || ''),
      defaultNetwork: String(defaults.defaultNetwork || DEFAULT_NETWORK).trim() || DEFAULT_NETWORK,
      protectDok: defaults.protectDok === true
    },
    services: {},
    registries: registries.map(item => ({
      kind: item.kind === 'git' ? 'git' : 'registry',
      provider: String(item.provider || 'custom').trim(),
      name: String(item.name || '').trim(),
      host: String(item.host || '').trim(),
      username: String(item.username || '').trim(),
      secret: String(item.secret || '')
    })).filter(item => item.host),
    metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : {}
  };
  for (const category of CORE_CATEGORIES) {
    const value = String(services[category.id] || '').trim();
    plan.services[category.id] = SERVICE_OPTION_IDS.has(value) ? value : '';
    for (const option of category.options) {
      if (option.id !== plan.services[category.id]) continue;
      for (const field of option.fields) {
        if (body[field] === undefined) continue;
        plan[field] = body[field];
      }
    }
  }
  // Copy raw service form fields used by the installer.
  for (const field of [
    'cloudflareToken', 'dokDomain', 'acmeEmail', 'authDomain', 'adminUser', 'adminEmail',
    'adminPassword', 'authPort', 'protectDok', 'dnsProvider', 'dnsDomain', 'dnsPort',
    'dnsWebPort', 'mailDomain', 'mailpitSmtpPort', 'mailpitWebPort', 'mailpitMaxMessages',
    'stalwartAdminUser', 'stalwartAdminPassword', 'stalwartWebPort', 'stalwartSmtpPort',
    'stalwartSubmissionPort', 'stalwartImapsPort', 'smtpHost', 'smtpPort', 'smtpTls',
    'smtpUser', 'smtpPassword', 'smtpFrom'
  ]) {
    if (body[field] === undefined) continue;
    plan[field] = body[field];
  }
  return plan;
}

export function validateInstallPlan(plan) {
  const issues = [];
  const defaults = plan.defaults || {};
  if (defaults.primaryDomain && !validDomain(defaults.primaryDomain)) issues.push('Primary domain is invalid.');
  if (defaults.dokDomain && !validDomain(defaults.dokDomain)) issues.push('Dok domain is invalid.');
  if (defaults.dataLocation) {
    if (!path.isAbsolute(defaults.dataLocation)) issues.push('Data location must be an absolute host path.');
    if (/[\r\n:\0]/.test(defaults.dataLocation)) issues.push('Data location contains unsupported characters.');
    if (defaults.dataLocation === '/') issues.push('Choose a dedicated data location, not the filesystem root.');
  }
  if (defaults.dataMode && !/^0?[0-7]{3,4}$/.test(defaults.dataMode)) issues.push('Data directory mode must be octal, for example 0775.');
  if (defaults.adminEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(defaults.adminEmail)) issues.push('Admin email is invalid.');
  if (plan.type === 'core') {
    const selected = selectedServiceIds(plan);
    const services = plan.services || {};
    if (!selected.size) issues.push('Select at least one core service, or use a standalone installation.');
    if (services.auth && !plan.authDomain) issues.push('The authentication portal domain is required.');
    if (services.auth === 'authelia' && !plan.adminPassword) issues.push('An Authelia admin password is required.');
    if (services.auth === 'authentik' && !plan.adminPassword) issues.push('An Authentik admin password is required.');
    if (services.proxy === 'nginx-proxy' && !plan.dokDomain && !defaults.dokDomain) {
      issues.push('A domain for Dok is required when nginx-proxy is selected.');
    }
    if (selected.has('smtp')) {
      if (!plan.smtpHost) issues.push('An SMTP host is required.');
      if (!plan.smtpFrom) issues.push('A sender address is required.');
    }
    if (services.tunnel === 'cloudflared' && !plan.cloudflareToken) issues.push('A Cloudflare tunnel token is required.');
  }
  return issues;
}

// ---------- installation writer ----------
export function baseSettings(plan) {
  const defaults = plan.defaults || {};
  const now = new Date().toISOString();
  const services = {
    nginxProxy: {
      enabled: false,
      network: defaults.defaultNetwork || DEFAULT_NETWORK,
      defaultVhostPort: 80,
      httpPort: 80,
      domain: normalizeDomain(defaults.dokDomain || ''),
      acme: { enabled: false, email: '', staging: false }
    },
    cloudflared: { enabled: false, token: '' },
    authentik: {
      enabled: false, adminEmail: '', adminPassword: '', secretKey: '', postgresPassword: '',
      port: 9000, httpsPort: 9443, domain: ''
    },
    authelia: {
      enabled: false, domain: '', port: 9091, adminUser: defaults.adminUser || 'admin',
      adminEmail: '', adminPassword: '', adminPasswordHash: '', sessionSecret: '',
      encryptionKey: '', jwtSecret: '', theme: 'auto', users: []
    },
    dns: { provider: 'technitium' },
    technitium: { enabled: false, adminPassword: '', webPort: 5380, dnsPort: 53, domain: '' },
    adguard: { enabled: false, webPort: 3000, dnsPort: 53, domain: '' },
    mail: { host: '', port: 587, tls: 'starttls', username: '', password: '', sender: '', identifier: '' },
    mailpit: { enabled: false, smtpPort: 1025, webPort: 8025, domain: '', maxMessages: 500 },
    stalwart: {
      enabled: false, domain: '', adminUser: 'admin', adminPassword: '',
      webPort: 8088, smtpPort: 25, submissionPort: 587, imapsPort: 993
    },
    hostHelper: { enabled: false, image: '' },
    opencode: { model: '', provider: '', apiKey: '' }
  };
  return {
    services,
    defaults: {
      primaryDomain: normalizeDomain(defaults.primaryDomain || ''),
      dokDomain: normalizeDomain(defaults.dokDomain || ''),
      dataLocation: defaults.dataLocation || '',
      dataMode: defaults.dataMode || '0775',
      allowOutsideData: defaults.allowOutsideData !== false,
      autoAppData: defaults.autoAppData !== false,
      adminUser: defaults.adminUser || 'admin',
      adminEmail: defaults.adminEmail || '',
      adminPassword: defaults.adminPassword || '',
      defaultNetwork: defaults.defaultNetwork || DEFAULT_NETWORK,
      protectDok: defaults.protectDok === true
    },
    backups: { includeLogs: false },
    logs: { tail: 500 },
    designer: { name: 'WickedAFDok', tagline: 'Server & Docker control room', css: '', logo: '' },
    installation: { installedAt: now, installedBy: 'dok-maintenance' },
    updates: {}
  };
}

export function writeRegistriesFromPlan(plan) {
  const existing = readRegistries();
  const byKey = new Map(existing.connections.map(item => [`${item.kind}:${item.host}:${item.username}`, item]));
  const connections = [];
  for (const item of plan.registries || []) {
    if (!item.host) continue;
    const host = item.host.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
    const key = `${item.kind}:${host}:${item.username}`;
    const previous = byKey.get(key);
    connections.push({
      id: previous?.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: item.kind,
      provider: item.provider || 'custom',
      name: item.name || host,
      host,
      username: item.username || '',
      secretEnc: item.secret ? encryptSecret(item.secret) : (previous?.secretEnc || ''),
      created: previous?.created || new Date().toISOString(),
      updated: new Date().toISOString()
    });
  }
  writeRegistries({ connections });
  return connections;
}

function hostVisiblePath(target) {
  const resolved = path.resolve(String(target || ''));
  const inside = root => resolved === root || resolved.startsWith(root + path.sep);
  if (inside(DOK_ROOT) || inside(MAINT_DATA) || inside(HOST_ROOT)) return resolved;
  // A data location is a host path. The Maintenance container sees the host
  // root at /host, so create it there instead of inside its own filesystem.
  return path.join(HOST_ROOT, resolved.replace(/^\/+/, ''));
}

export async function ensurePlanDirectories(plan) {
  const defaults = plan.defaults || {};
  const targets = [dataDir, appsDir, coreDir, sourcesDir, uploadsDir];
  if (defaults.dataLocation) {
    targets.push(defaults.dataLocation);
    targets.push(path.join(defaults.dataLocation, 'apps'));
  }
  const mode = parseInt(String(defaults.dataMode || '0775').replace(/^0o/i, ''), 8);
  for (const target of targets) {
    const resolved = hostVisiblePath(target);
    try {
      fs.mkdirSync(resolved, { recursive: true });
      try {
        if (Number.isInteger(mode)) fs.chmodSync(resolved, mode);
      } catch {}
      chownDokPath(resolved);
    } catch (e) {
      throw new Error(`Could not create ${resolved}: ${e.message}`);
    }
  }
}

// ---------- compose/snapshot helpers ----------
export function composeFilesFor(dir) {
  return ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']
    .map(name => path.join(dir, name))
    .filter(file => {
      try { return fs.statSync(file).isFile(); } catch { return false; }
    });
}

export function listCoreServices() {
  const names = [];
  try {
    for (const entry of fs.readdirSync(coreDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'host-helper') continue;
      if (composeFilesFor(path.join(coreDir, entry.name)).length) names.push(entry.name);
    }
  } catch {}
  return names.sort();
}

export function listApps() {
  return readRegistry().map(entry => ({
    id: entry.id || '',
    name: entry.name || projectName(entry.appDir || entry.path || '', 'app'),
    appDir: entry.appDir || entry.path || '',
    image: entry.image || '',
    managedBy: entry.managedBy || 'dok',
    library: entry.library || null,
    needsConfig: entry.needsConfig === true
  }));
}

export function installationSummary() {
  const settings = readSettings();
  return {
    apps: listApps().length,
    coreServices: listCoreServices(),
    registryConnections: readRegistries().connections.length,
    primaryDomain: settings.defaults?.primaryDomain || '',
    dokDomain: settings.defaults?.dokDomain || settings.services?.nginxProxy?.domain || '',
    dokHttpPort: Number(settings.services?.nginxProxy?.httpPort) || 80,
    dataLocation: settings.defaults?.dataLocation || '',
    defaultNetwork: settings.defaults?.defaultNetwork || DEFAULT_NETWORK
  };
}

export function writeInstallationCompose() {
  const target = path.join(dataDir, 'wickedafdok', 'installation-compose.yml');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const includes = ['../../docker-compose.yml'];
  if (fs.existsSync(path.join(DOK_ROOT, 'docker-compose.override.yml'))) includes.push('../../docker-compose.override.yml');
  if (fs.existsSync(path.join(dataDir, '.docker-socket-gid.yml'))) includes.push('../../data/.docker-socket-gid.yml');
  // Core services are separate compose projects. Including them here lets the
  // Maintenance container recreate the exact installed stack in one command.
  // The managed self-compose (data/wickedafdok/docker-compose.yml) is not
  // included: it defines the same wickedafdok service as the root compose and
  // would conflict with it.
  const coreIncludes = listCoreServices().map(name => `../../core/${name}/docker-compose.yml`);
  const body = `# managed-by: wickedafdok-maintenance
# Canonical installation stack: Dok plus every installed core service.
# Use this file for an exact reinstall from the checkout:
#   docker compose -f data/wickedafdok/installation-compose.yml up -d --build
name: wickedafdok-installation
include:
${[...new Set([...includes, ...coreIncludes])].map(item => `  - ${item}`).join('\n')}
`;
  writePrivateFile(target, body);
  chownDokPath(target);
  return target;
}

export async function captureSnapshot({ reason = 'manual', label = '' } = {}) {
  ensureDirs();
  const id = `${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${randomSecret(3)}`;
  const archive = path.join(snapshotsDir, `${id}.tar.gz`);
  const targets = ['data', 'apps', 'core', 'sources'].filter(name => fs.existsSync(path.join(DOK_ROOT, name)));
  if (!targets.length) throw new Error('The Dok installation directory is empty');
  const args = ['-czf', archive,
    '--exclude=data/backups', '--exclude=data/tmp', '--exclude=data/logs',
    '--exclude=data/docker-config', '--exclude=data/host-helper/agent.sock', '--exclude=data/.maintenance-token',
    '--exclude=apps/.preview-*', '--exclude=node_modules', '--exclude=.git', ...targets];
  await run('tar', args, { cwd: DOK_ROOT });
  try { fs.chmodSync(archive, 0o600); } catch {}
  const meta = {
    id,
    schema: BACKUP_SCHEMA,
    kind: 'snapshot',
    label: label || `Installation snapshot ${id}`,
    reason,
    created: new Date().toISOString(),
    size: fs.statSync(archive).size,
    archive,
    summary: installationSummary()
  };
  writeJson(path.join(snapshotsDir, `${id}.json`), meta);
  pruneSnapshots(30);
  return meta;
}

export function pruneSnapshots(keep = 30) {
  let items = [];
  try {
    items = fs.readdirSync(snapshotsDir)
      .filter(name => name.endsWith('.json'))
      .map(name => readJson(path.join(snapshotsDir, name), null))
      .filter(Boolean)
      .sort((a, b) => String(b.created).localeCompare(String(a.created)));
  } catch {}
  for (const item of items.slice(keep)) {
    try { fs.rmSync(path.join(snapshotsDir, `${item.id}.tar.gz`), { force: true }); } catch {}
    try { fs.rmSync(path.join(snapshotsDir, `${item.id}.json`), { force: true }); } catch {}
  }
}

export function listSnapshots() {
  try {
    return fs.readdirSync(snapshotsDir)
      .filter(name => name.endsWith('.json'))
      .map(name => {
        const meta = readJson(path.join(snapshotsDir, name), null);
        if (!meta || !meta.id) return null;
        const archive = path.join(snapshotsDir, `${meta.id}.tar.gz`);
        if (!fs.existsSync(archive)) return null;
        return { ...meta, archive, size: fs.statSync(archive).size };
      })
      .filter(Boolean)
      .sort((a, b) => String(b.created).localeCompare(String(a.created)));
  } catch {
    return [];
  }
}

export function listBackups() {
  try {
    return fs.readdirSync(backupsDir)
      .filter(name => name.endsWith('.json'))
      .map(name => {
        const meta = readJson(path.join(backupsDir, name), null);
        if (!meta || !meta.id) return null;
        const archive = path.join(backupsDir, `${meta.id}.tar.gz`);
        if (!fs.existsSync(archive)) return null;
        return { ...meta, archive, size: fs.statSync(archive).size };
      })
      .filter(Boolean)
      .sort((a, b) => String(b.created).localeCompare(String(a.created)));
  } catch {
    return [];
  }
}

export async function createBackup({ name = '', includeLogs = true, snapshot = true } = {}) {
  ensureDirs();
  const id = `${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${randomSecret(3)}`;
  const archive = path.join(backupsDir, `${id}.tar.gz`);
  const targets = ['data', 'apps', 'core', 'sources'].filter(item => fs.existsSync(path.join(DOK_ROOT, item)));
  if (!targets.length) throw new Error('No Dok installation files were found to back up');
  const args = ['-czf', archive,
    '--exclude=data/backups', '--exclude=data/tmp', '--exclude=data/docker-config',
    '--exclude=data/host-helper/agent.sock', '--exclude=data/.maintenance-token',
    '--exclude=apps/.preview-*', '--exclude=node_modules', '--exclude=.git'];
  if (!includeLogs) args.push('--exclude=data/logs');
  args.push(...targets);
  await run('tar', args, { cwd: DOK_ROOT });
  try { fs.chmodSync(archive, 0o600); } catch {}
  const meta = {
    id,
    schema: BACKUP_SCHEMA,
    kind: 'backup',
    name: String(name || `Dok backup ${id}`).slice(0, 100),
    created: new Date().toISOString(),
    includeLogs: includeLogs === true,
    size: fs.statSync(archive).size,
    archive,
    installationState: snapshot ? refreshInstallationState()?.summary || installationSummary() : installationSummary()
  };
  writeJson(path.join(backupsDir, `${id}.json`), meta);
  if (snapshot) await captureSnapshot({ reason: 'backup', label: meta.name }).catch(() => {});
  return meta;
}

export function safeArchiveEntries(entries) {
  for (const entry of entries) {
    const clean = String(entry).replace(/\\/g, '/');
    if (!clean || clean === '.') continue;
    if (clean.startsWith('/') || clean.split('/').includes('..')) {
      throw new Error('The archive contains an unsafe path');
    }
  }
}

export async function restoreArchive(archive, { overwrite = false, restart = true } = {}) {
  if (!overwrite) {
    const err = new Error('Restoring an archive overwrites the Dok installation files. Confirm to continue.');
    err.status = 409;
    err.needsOverwrite = true;
    throw err;
  }
  const list = await run('tar', ['-tzf', archive]);
  const entries = String(list.stdout || '').split('\n').filter(Boolean);
  safeArchiveEntries(entries);
  const topLevel = new Set(entries.map(entry => entry.replace(/^\.?\//, '').split('/')[0]).filter(Boolean));
  let preservedToken = '';
  try { preservedToken = fs.readFileSync(tokenPath, 'utf-8').trim(); } catch {}
  let preservedHelperToken = '';
  try { preservedHelperToken = fs.readFileSync(path.join(dataDir, 'host-helper', 'token'), 'utf-8').trim(); } catch {}
  const appProjects = new Set(readRegistry().flatMap(entry => {
    const name = projectName(entry.name || entry.appDir || entry.path || '', 'app');
    return [name, `app-${name}`, projectName(entry.id || '', '')].filter(Boolean);
  }));
  const stopped = [];
  const containers = await containerList().catch(() => []);
  for (const container of containers) {
    if (container.state !== 'running') continue;
    const project = container.labels?.['com.docker.compose.project'] || '';
    const managedApp = container.labels?.['dok.managed'] === 'true' &&
      container.labels?.['dok.maintenance'] !== 'true' && container.name !== 'wickedafdok-maintenance';
    if (container.name === DOK_CONTAINER || project === 'wickedafdok' ||
        project === 'wickedafdok-installation' ||
        appProjects.has(project) || managedApp ||
        ['nginx-proxy', 'cloudflared', 'authelia', 'technitium-dns', 'adguard', 'mailpit', 'stalwart',
          'authentik-server', 'authentik-worker', 'authentik-postgresql', 'authentik-redis'].includes(container.name)) {
      try {
        await docker(['stop', container.id]);
        stopped.push(container.id);
      } catch {}
    }
  }
  for (const target of ['apps', 'core', 'sources']) {
    if (!topLevel.has(target)) continue;
    const dir = path.join(DOK_ROOT, target);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  }
  if (topLevel.has('data')) {
    let names = [];
    try { names = fs.readdirSync(dataDir); } catch {}
    for (const name of names.filter(item => !['backups', 'tmp', 'logs', 'docker-config', 'host-helper'].includes(item))) {
      try { fs.rmSync(path.join(dataDir, name), { recursive: true, force: true }); } catch {}
    }
  }
  await run('tar', ['-xzf', archive, '-C', DOK_ROOT]);
  if (preservedToken) {
    try { writePrivateFile(tokenPath, preservedToken); } catch {}
  }
  if (preservedHelperToken) {
    try { writePrivateFile(path.join(dataDir, 'host-helper', 'token'), preservedHelperToken); } catch {}
  }
  chownTree(DOK_ROOT);
  for (const file of ['settings.json', 'registries.json', 'registry.json', 'groups.json', 'auth.json', 'dns.json', '.backup-manifest.json']) {
    try { fs.chmodSync(path.join(dataDir, file), 0o600); } catch {}
  }
  try { fs.chmodSync(path.join(dataDir, '.credentials-key'), 0o600); } catch {}
  if (restart) {
    try {
      const dokArgs = ['compose', '-p', 'wickedafdok', '-f', path.join(DOK_COMPOSE_ROOT, 'docker-compose.yml')];
      for (const name of ['docker-compose.override.yml', 'data/.docker-socket-gid.yml']) {
        const file = path.join(DOK_COMPOSE_ROOT, name);
        if (fs.existsSync(file)) dokArgs.push('-f', file);
      }
      await docker([...dokArgs, 'up', '-d', '--remove-orphans']);
      const coreErrors = [];
      for (const name of listCoreServices()) {
        const compose = composeFilesFor(path.join(coreDir, name))[0];
        if (!compose) continue;
        try {
          await docker(['compose', '-f', compose, 'up', '-d', '--remove-orphans']);
        } catch (e) {
          coreErrors.push(`${name}: ${e.message}`);
        }
      }
      if (coreErrors.length) {
        return { ok: true, restored: true, stopped, restarted: true, coreErrors };
      }
    } catch (e) {
      return { ok: true, restored: true, stopped, restartError: e.message };
    }
  }
  refreshInstallationState();
  return { ok: true, restored: true, stopped, restarted: restart };
}

export async function repairInstallation({ fix = false } = {}) {
  const checks = [];
  const add = (name, ok, detail = '', canFix = false) => checks.push({ name, ok, detail, canFix });
  let dok = { exists: false, running: false };
  try {
    const dockerVersion = await docker(['version', '--format', '{{.Server.Version}}']);
    add('Docker socket', true, `Docker ${dockerVersion.stdout.trim() || 'reachable'}`);
    dok = await dokStatus();
    add('Dok container', !!dok.exists, dok.exists ? `Dok container ${dok.state || 'present'}` : 'Dok container not found — run an installation');
  } catch (e) {
    add('Docker socket', false, e.message);
  }
  for (const [label, target] of [
    ['data directory', dataDir],
    ['apps directory', appsDir],
    ['core directory', coreDir],
    ['sources directory', sourcesDir]
  ]) {
    const exists = fs.existsSync(target);
    add(label, exists, exists ? target : `${target} is missing`, true);
  }
  const key = credentialsKey({ create: false });
  add('credential key', !!key, key ? 'Encryption key present' : 'data/.credentials-key is missing or invalid', true);
  const settingsOk = !!readJson(path.join(dataDir, 'settings.json'), null);
  add('settings', settingsOk, settingsOk ? 'data/settings.json is readable' : 'data/settings.json is missing or invalid', true);
  const state = installationState();
  add('installation snapshot', !!state, state ? `Updated ${state.updated || 'unknown'}` : 'No installation state has been recorded yet', true);
  try {
    await docker(['network', 'inspect', DEFAULT_NETWORK]);
    add('network', true, `Docker network ${DEFAULT_NETWORK} exists`);
  } catch {
    add('network', false, `Docker network ${DEFAULT_NETWORK} is missing`, true);
  }
  for (const name of listCoreServices()) {
    const files = composeFilesFor(path.join(coreDir, name));
    add(`compose: ${name}`, files.length > 0, files[0] || 'compose missing', false);
  }
  if (fix) {
    await ensurePlanDirectories({ defaults: { ...(readSettings().defaults || {}), dataLocation: '' } }).catch(() => {});
    credentialsKey({ create: true });
    try { await ensureNetwork(DEFAULT_NETWORK); } catch {}
    for (const target of [dataDir, appsDir, coreDir, sourcesDir, uploadsDir]) {
      try { fs.mkdirSync(target, { recursive: true }); } catch {}
    }
    for (const file of ['settings.json', 'registries.json', 'registry.json', 'groups.json', 'auth.json', 'dns.json']) {
      try { fs.chmodSync(path.join(dataDir, file), 0o600); } catch {}
    }
    try { fs.chmodSync(credentialsKeyPath, 0o600); } catch {}
    chownTree(DOK_ROOT);
    if (!settingsOk) writeSettings(baseSettings(normalizeInstallPlan({ type: 'standalone' })));
    if (!installationState()) {
      await dokApi('/api/installation/sync', { method: 'POST', body: {}, timeout: 30000 }).catch(() => {});
    }
    refreshInstallationState();
    add('repair', true, 'Directories, permissions, network, and encryption key repaired');
  }
  return { ok: checks.every(item => item.ok), fixed: fix, checks };
}

export function systemInfo() {
  const info = {
    hostname: os.hostname(),
    platform: `${os.platform()} ${os.release()}`,
    cpus: os.cpus().length,
    load: os.loadavg(),
    uptime: os.uptime(),
    totalmem: os.totalmem(),
    freemem: os.freemem(),
    node: process.version,
    maintenance: {
      uptime: process.uptime(),
      pid: process.pid,
      root: DOK_ROOT,
      hostRoot: HOST_ROOT,
      data: MAINT_DATA
    }
  };
  try {
    const stat = fs.statfsSync(MAINT_DATA);
    info.disk = { total: stat.blocks * stat.bsize, free: stat.bfree * stat.bsize };
  } catch {}
  return info;
}

export async function dockerInfo() {
  try {
    const { stdout } = await docker(['info', '--format', '{{json .}}']);
    return JSON.parse(stdout);
  } catch (e) {
    return { error: e.message };
  }
}

export function maintenanceVersion() {
  const pkg = readJson(path.join(DOK_ROOT, 'package.json'), {}) || readJson('/app/package.json', {}) || {};
  return pkg.version || '1.0.0';
}
