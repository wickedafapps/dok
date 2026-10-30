import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import os from 'os';
import { execFile } from 'child_process';

// DOK_ROOT is the persistent data root. Before the installer relocates it, it
// is the checkout; afterwards it is <data location>/Dok. DOK_SOURCE_ROOT is
// always the code checkout and is kept separate so a relocated data root never
// hides the source tree.
export const DOK_ROOT = path.resolve(process.env.DOK_ROOT || '/dok');
export const HOST_ROOT = path.resolve(process.env.HOST_ROOT || '/host');
export const MAINT_DATA = path.resolve(process.env.MAINTENANCE_DATA || '/maintenance-data');
export const MAINT_DATA_HOST = String(process.env.MAINTENANCE_DATA_HOST_PATH || '').trim() || MAINT_DATA;

const SOURCE_MARKERS = ['Dockerfile', path.join('server', 'index.js')];
const SCAN_SKIP = new Set(['node_modules', '.cache', '.npm', 'proc', 'sys', 'dev', 'run']);
const SOURCE_SCAN_ROOTS = ['root', 'home', 'srv', 'opt', 'mnt', 'media', 'var/www', 'usr/local/src', 'data', 'tmp'];

export function looksLikeDokSource(dir) {
  try {
    return SOURCE_MARKERS.every(file => fs.statSync(path.join(dir, file)).isFile());
  } catch {
    return false;
  }
}

function sameDirectory(a, b) {
  try {
    const left = fs.statSync(a);
    const right = fs.statSync(b);
    return left.dev === right.dev && left.ino === right.ino;
  } catch {
    return false;
  }
}

function sameCheckout(a, b) {
  if (sameDirectory(a, b)) return true;
  const fingerprint = dir => {
    try {
      const stat = fs.statSync(path.join(dir, '.git', 'HEAD'));
      return `${stat.dev}:${stat.ino}`;
    } catch {
      return '';
    }
  };
  const left = fingerprint(a);
  return !!left && left === fingerprint(b);
}

function sourceLogHints() {
  let text = '';
  try {
    const file = path.join(MAINT_DATA, 'logs', 'maintenance.log');
    const stat = fs.statSync(file);
    const size = Math.min(stat.size, 512 * 1024);
    const buffer = Buffer.alloc(size);
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, buffer, 0, size, stat.size - size);
    } finally {
      fs.closeSync(fd);
    }
    text = buffer.toString('utf8');
  } catch {
    return [];
  }
  const hints = [];
  for (const line of text.split('\n').reverse()) {
    let match = line.match(/\bBuilding\s+\S+\s+from\s+(\/\S+)/);
    if (!match) match = line.match(/\bLaunching Dok with the (?:root|managed) compose\s+(\/\S+)/);
    if (!match) match = line.match(/\bDok root\s+(\/\S+?),\s+host root/);
    if (!match) continue;
    const value = match[1].replace(/\/docker-compose\.ya?ml$/, '');
    if (value) hints.push(value);
  }
  return hints;
}

function scanForDokSource() {
  const deadline = Date.now() + 2500;
  let inspected = 0;
  for (const relative of SOURCE_SCAN_ROOTS) {
    const start = path.join(HOST_ROOT, relative);
    const queue = [{ dir: start, depth: 0 }];
    while (queue.length && Date.now() < deadline && inspected < 8000) {
      const { dir, depth } = queue.shift();
      inspected++;
      if (looksLikeDokSource(dir) && fs.existsSync(path.join(dir, '.git'))) return dir;
      if (depth >= 5) continue;
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (!entry.isDirectory() || SCAN_SKIP.has(entry.name)) continue;
        queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
      }
    }
    if (Date.now() >= deadline) break;
  }
  return '';
}

function sourceHostPath(candidate, configuredRoot) {
  if (candidate === HOST_ROOT) return '';
  if (candidate === path.parse(candidate).root) return '';
  if (candidate.startsWith(HOST_ROOT + path.sep)) return candidate.slice(HOST_ROOT.length);
  if (candidate !== configuredRoot) return candidate;
  return '';
}

function resolveDokSource() {
  const configuredRoot = path.resolve(process.env.DOK_SOURCE_ROOT || process.env.DOK_ROOT || '/dok-source');
  const configuredHost = String(process.env.DOK_HOST_PATH || '').trim();
  const candidates = [];
  const add = value => {
    const raw = String(value || '').trim();
    if (!path.isAbsolute(raw)) return;
    const clean = path.resolve(raw.replace(/[/\\]+$/, '') || '/');
    candidates.push(clean);
    if (clean !== HOST_ROOT && !clean.startsWith(HOST_ROOT + path.sep)) {
      candidates.push(path.join(HOST_ROOT, clean.replace(/^\/+/, '')));
    }
  };
  add(configuredHost);
  for (const hint of sourceLogHints()) add(hint);
  const unique = [...new Set(candidates)];
  const configuredValid = looksLikeDokSource(configuredRoot);
  if (configuredValid) {
    for (const candidate of unique) {
      if (!sameCheckout(candidate, configuredRoot) || !looksLikeDokSource(candidate)) continue;
      const host = sourceHostPath(candidate, configuredRoot);
      if (host) return { root: configuredRoot, host, recovered: false };
    }
    return { root: configuredRoot, host: '', recovered: false };
  }
  let recovered = null;
  for (const candidate of unique) {
    if (!looksLikeDokSource(candidate)) continue;
    const host = sourceHostPath(candidate, configuredRoot);
    if (host) return { root: path.resolve(candidate), host, recovered: true };
    if (!recovered) recovered = { root: path.resolve(candidate), host: '', recovered: true };
  }
  if (recovered) return recovered;
  const scanned = scanForDokSource();
  if (scanned) return { root: path.resolve(scanned), host: sourceHostPath(scanned, configuredRoot), recovered: true };
  return { root: configuredRoot, host: '', recovered: false };
}

const sourceResolution = resolveDokSource();
export const DOK_SOURCE_ROOT = sourceResolution.root;
export const DOK_SOURCE_HOST_PATH = sourceResolution.host;
export const DOK_SOURCE_RECOVERED = sourceResolution.recovered;
export const DOK_CONTAINER = String(process.env.DOK_CONTAINER || 'wickedafdok').trim();
export const DOK_PORT = Number(process.env.DOK_PORT) || 8080;
export const DOK_IMAGE = String(process.env.DOK_IMAGE || 'wickedafdok:latest').trim();
export const DOK_HOST_PATH = DOK_SOURCE_HOST_PATH || String(process.env.DOK_HOST_PATH || DOK_SOURCE_ROOT).trim();
export const DOK_STORAGE_HOST = String(process.env.DOK_STORAGE_HOST_PATH || '').trim();
export const DOK_COMPOSE_ROOT = (() => {
  try {
    if (path.isAbsolute(DOK_SOURCE_ROOT) && fs.existsSync(path.join(DOK_SOURCE_ROOT, 'docker-compose.yml'))) return DOK_SOURCE_ROOT;
  } catch {}
  return DOK_SOURCE_ROOT;
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

// Older installs kept the store inside the checkout. Move it beside the
// checkout on first start so replacing the Dok checkout no longer risks the
// maintenance records. Conflicts are copied into a timestamped folder under
// the new store rather than overwritten.
function migrateLegacyMaintenanceData() {
  const legacy = path.join(DOK_SOURCE_ROOT, 'maintenance-data');
  if (path.resolve(legacy) === path.resolve(MAINT_DATA)) return;
  let stat;
  try { stat = fs.lstatSync(legacy); } catch { return; }
  if (!stat.isDirectory()) return;
  try {
    fs.mkdirSync(MAINT_DATA, { recursive: true });
    const empty = !fs.readdirSync(MAINT_DATA).length;
    if (empty) {
      try { fs.rmdirSync(MAINT_DATA); } catch {}
      try { fs.renameSync(legacy, MAINT_DATA); return; } catch {}
      fs.mkdirSync(MAINT_DATA, { recursive: true });
    }
    for (const entry of fs.readdirSync(legacy)) {
      const src = path.join(legacy, entry);
      const dest = path.join(MAINT_DATA, entry);
      if (fs.existsSync(dest)) continue;
      fs.cpSync(src, dest, { recursive: true, force: false, errorOnExist: false });
      fs.rmSync(src, { recursive: true, force: true });
    }
    if (!fs.readdirSync(legacy).length) fs.rmdirSync(legacy);
    else fs.renameSync(legacy, path.join(MAINT_DATA, `legacy-import-${Date.now()}`));
  } catch {}
}

export function ensureDirs() {
  migrateLegacyMaintenanceData();
  for (const dir of [MAINT_DATA, backupsDir, snapshotsDir, logsDir, opencodeDir,
    path.join(MAINT_DATA, 'tmp'),
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
  const inside = root => target === root || target.startsWith(root + path.sep);
  if (!inside(DOK_ROOT) && !inside(DOK_SOURCE_ROOT)) return;
  try { chownDokPath(target); } catch {}
}

// Git rejects a checkout owned by another user ("dubious ownership"). Dok's
// checkout is usually owned by the host user while Maintenance runs privileged,
// so trust exactly the directory each git command operates in.
function gitArgsWithSafeDirectory(args, cwd) {
  const dirs = new Set();
  for (const candidate of [cwd, path.resolve(cwd || DOK_SOURCE_ROOT)]) {
    if (!candidate) continue;
    const resolved = path.resolve(String(candidate));
    dirs.add(resolved);
    try { dirs.add(fs.realpathSync(resolved)); } catch {}
  }
  const prefix = [];
  for (const dir of dirs) prefix.push('-c', `safe.directory=${dir}`);
  return [...prefix, ...args];
}

export function run(command, args = [], { cwd = DOK_ROOT, env = {}, timeout = 0, input = '' } = {}) {
  return new Promise((resolve, reject) => {
    const execArgs = command === 'git' ? gitArgsWithSafeDirectory(args, cwd) : args;
    const child = execFile(command, execArgs, {
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
export const credentialsKeyPath = path.join(dataDir, '.credentials-key');

export function credentialsKey({ create = true, root = dataDir } = {}) {
  const keyPath = path.join(root, '.credentials-key');
  try {
    if (fs.existsSync(keyPath)) {
      const key = fs.readFileSync(keyPath);
      if (key.length === 32) return key;
      if (!create) return null;
      const backup = `${keyPath}.invalid-${Date.now()}`;
      fs.copyFileSync(keyPath, backup);
      fs.chmodSync(backup, 0o600);
    }
  } catch {}
  if (!create) return null;
  const key = crypto.randomBytes(32);
  writePrivateFile(keyPath, key);
  return key;
}

export function isStoredSecret(value) {
  if (typeof value !== 'string') return false;
  const parts = value.split(':');
  return parts.length === 4 && parts[0] === 'v1' &&
    parts.slice(1).every(part => /^[A-Za-z0-9+/=]+$/.test(part));
}

export function encryptSecret(plain, root = dataDir) {
  const text = String(plain ?? '');
  if (!text) return '';
  if (isStoredSecret(text)) return text;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', credentialsKey({ root }), iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${encrypted.toString('base64')}`;
}

export function decryptSecret(value, root = dataDir) {
  const text = String(value ?? '');
  if (!text.startsWith('v1:')) return text;
  const [, iv, tag, payload] = text.split(':');
  if (!iv || !tag || !payload) throw new Error('Malformed stored credential');
  const decipher = crypto.createDecipheriv('aes-256-gcm', credentialsKey({ root }), Buffer.from(iv, 'base64'));
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

export function readSettings(root = dataDir) {
  const raw = readJson(path.join(root, 'settings.json'), {}) || {};
  return mapSettingsSecrets(JSON.parse(JSON.stringify(raw)), value => {
    if (!isStoredSecret(value)) return value;
    try { return decryptSecret(value, root); } catch { return ''; }
  });
}

export function encryptSettings(settings, root = dataDir) {
  const clone = JSON.parse(JSON.stringify(settings || {}));
  return mapSettingsSecrets(clone, value => isStoredSecret(value) ? value : encryptSecret(value, root));
}

export function writeSettings(settings, root = dataDir) {
  writeJson(path.join(root, 'settings.json'), encryptSettings(settings, root));
  return settings;
}

export function readRegistries(root = dataDir) {
  const data = readJson(path.join(root, 'registries.json'), { connections: [] }) || {};
  if (!Array.isArray(data.connections)) data.connections = [];
  return data;
}

export function writeRegistries(data, root = dataDir) {
  return writeJson(path.join(root, 'registries.json'), data || { connections: [] });
}

export function readRegistry(root = dataDir) {
  const data = readJson(path.join(root, 'registry.json'), []);
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

export function refreshInstallationState(root = dataDir) {
  const state = readJson(path.join(root, 'installation-state.json'), null);
  if (!state || typeof state !== 'object') return null;
  writeJson(installationStatePath, state);
  const current = readInstallation() || {};
  const restored = readJson(path.join(root, 'installation.json'), null);
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

export async function verifyDokInstallation({ timeoutMs = 300000, dataRoot = dataDir } = {}) {
  await waitForDok(timeoutMs);
  const checks = [];
  const check = async (name, pathname, validate) => {
    try {
      const data = await dokApi(pathname, { timeout: 15000 });
      const ok = validate ? validate(data) : true;
      checks.push({ name, ok, detail: ok ? 'OK' : `Unexpected response from ${pathname}` });
      return ok;
    } catch (e) {
      checks.push({ name, ok: false, detail: e.message });
      return false;
    }
  };
  const checkPage = async (name, pathname, validate) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const url = `http://${DOK_CONTAINER}:${DOK_PORT}${pathname}`;
      const response = await fetch(url, { signal: controller.signal });
      const text = await response.text();
      const ok = response.ok && !!text && validate(text, response);
      checks.push({ name, ok, detail: ok ? 'OK' : `Unexpected response from ${pathname}` });
      return ok;
    } catch (e) {
      checks.push({ name, ok: false, detail: e.message });
      return false;
    } finally {
      clearTimeout(timer);
    }
  };
  let containerOk = false;
  try {
    const info = await dockerInspect();
    containerOk = info?.State?.Running === true;
    checks.push({ name: 'Dok container', ok: containerOk, detail: containerOk ? `Running ${info.Id?.slice(0, 12) || ''}`.trim() : 'Dok container is not running' });
  } catch (e) {
    checks.push({ name: 'Dok container', ok: false, detail: e.message });
  }
  const health = await check('Dok API health', '/api/health', data => data?.ok === true);
  const settings = await check('Settings API', '/api/settings', data => !!data && typeof data === 'object');
  const containers = await check('Docker API', '/api/containers', data => Array.isArray(data) || Array.isArray(data?.containers));
  const installation = await check('Installation API', '/api/installation', data => data?.ok === true);
  const registry = await check('App library API', '/api/registry', data => Array.isArray(data));
  // A healthy API is not enough: the user opens the HTML UI. Verify that the
  // static frontend is actually served so an install cannot finish with a
  // working API and a blank or error page.
  const ui = await checkPage('Dok web UI', '/', text => /<html[\s>]/i.test(text) && /<body[\s>]/i.test(text));
  let storageOk = true;
  if (dataRoot) {
    let settingsFileOk = false;
    let settingsDetail = `${path.join(dataRoot, 'settings.json')} is missing or invalid`;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dataRoot, 'settings.json'), 'utf-8'));
      settingsFileOk = !!raw && typeof raw === 'object' && !Array.isArray(raw);
      if (settingsFileOk) settingsDetail = 'settings.json is readable';
    } catch (e) { settingsDetail = e.message; }
    checks.push({ name: 'Stored settings', ok: settingsFileOk, detail: settingsDetail });
    storageOk = storageOk && settingsFileOk;
    let libraryOk = false;
    let libraryDetail = `${path.join(dataRoot, 'registry.json')} is missing or invalid`;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dataRoot, 'registry.json'), 'utf-8'));
      libraryOk = Array.isArray(raw);
      if (libraryOk) libraryDetail = `${raw.length} app record(s)`;
    } catch (e) { libraryDetail = e.message; }
    checks.push({ name: 'Stored app library', ok: libraryOk, detail: libraryDetail });
    storageOk = storageOk && libraryOk;
    const key = credentialsKey({ create: false, root: dataRoot });
    checks.push({ name: 'Credential key', ok: !!key, detail: key ? 'Encryption key present' : 'data/.credentials-key is missing' });
    storageOk = storageOk && !!key;
  }
  const ok = containerOk && health && settings && containers && installation && registry && ui && storageOk;
  const failures = checks.filter(item => !item.ok);
  return {
    ok,
    checks,
    error: ok ? '' : failures.map(item => `${item.name}: ${item.detail}`).join('; ')
  };
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
        fields: ['dokDomain', 'acmeEmail', 'acmeStaging']
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
        fields: ['mailDomain', 'mailFrom', 'mailpitSmtpPort', 'mailpitWebPort', 'mailpitMaxMessages']
      },
      {
        id: 'stalwart',
        label: 'Stalwart Mail Server',
        description: 'Full IMAP/JMAP/SMTP mail server with a web admin.',
        fields: ['mailDomain', 'mailFrom', 'stalwartAdminUser', 'stalwartAdminPassword', 'stalwartWebPort', 'stalwartSmtpPort', 'stalwartSubmissionPort', 'stalwartImapsPort']
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

export const REGISTRY_PRESETS = [
  { id: 'dockerhub', name: 'Docker Hub', kind: 'registry', provider: 'dockerhub', host: 'docker.io', aliases: ['docker', 'dockerhub', 'docker hub'] },
  { id: 'ghcr', name: 'GitHub Container Registry', kind: 'registry', provider: 'ghcr', host: 'ghcr.io', aliases: ['ghcr', 'github packages', 'github container registry'] },
  { id: 'gitlab-registry', name: 'GitLab Container Registry', kind: 'registry', provider: 'gitlab-registry', host: 'registry.gitlab.com', aliases: ['gitlab registry', 'gitlab container registry'] },
  { id: 'quay', name: 'Quay.io', kind: 'registry', provider: 'quay', host: 'quay.io', aliases: ['quay', 'quay.io'] },
  { id: 'github', name: 'GitHub', kind: 'git', provider: 'github', host: 'github.com', aliases: ['github.com'] },
  { id: 'gitlab', name: 'GitLab', kind: 'git', provider: 'gitlab', host: 'gitlab.com', aliases: ['gitlab.com'] },
  { id: 'gitea', name: 'Gitea / Forgejo', kind: 'git', provider: 'gitea', host: '', aliases: ['gitea', 'forgejo', 'gitea / forgejo'] }
];

export function normalizeRegistryHost(value) {
  return String(value || '').trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/\/.*$/, '')
    .toLowerCase();
}

export function registryPresetFor(value) {
  const query = String(value || '').trim().toLowerCase();
  if (!query) return null;
  return REGISTRY_PRESETS.find(preset =>
    preset.id === query ||
    preset.name.toLowerCase() === query ||
    preset.aliases.includes(query)
  ) || null;
}

export function registryHostForName(value) {
  const preset = registryPresetFor(value);
  if (preset?.host) return preset.host;
  const host = normalizeRegistryHost(value);
  return /^[a-z0-9][a-z0-9.-]*\.[a-z0-9.-]+(?::\d+)?$/i.test(host) ? host : '';
}


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
    existingData: body.existingData === 'overwrite' || body.existingData === 'reuse' ? body.existingData : '',
    defaults: {
      primaryDomain: normalizeDomain(defaults.primaryDomain || body.primaryDomain || '').toLowerCase(),
      dokDomain: normalizeDomain(defaults.dokDomain || '').toLowerCase(),
      dataLocation: normalizeDokDataLocation(defaults.dataLocation || ''),
      dataMode: String(defaults.dataMode || '0775').trim(),
      allowOutsideData: defaults.allowOutsideData !== false,
      autoAppData: defaults.autoAppData !== false,
      adminUser: String(defaults.adminUser || body.adminUser || 'admin').trim() || 'admin',
      adminEmail: String(defaults.adminEmail || body.adminEmail || '').trim(),
      adminPassword: String(defaults.adminPassword || ''),
      defaultNetwork: String(defaults.defaultNetwork || DEFAULT_NETWORK).trim() || DEFAULT_NETWORK,
      protectDok: defaults.protectDok === true
    },
    services: {},
    registries: registries.map(item => {
      const itemHost = normalizeRegistryHost(item.host);
      const hostPreset = REGISTRY_PRESETS.find(entry => entry.host && entry.host === itemHost);
      const namePreset = registryPresetFor(item.name || '');
      // A manually entered address wins over the name preset so changing the
      // host to GHCR does not keep Docker Hub's provider metadata.
      const preset = hostPreset || (itemHost ? null : namePreset);
      const kind = item.kind === 'git' || item.kind === 'registry'
        ? item.kind
        : (preset?.kind || namePreset?.kind || 'registry');
      const host = itemHost || normalizeRegistryHost(preset?.host || registryHostForName(item.name));
      return {
        kind,
        provider: String(hostPreset?.provider || item.provider || preset?.provider || 'custom').trim(),
        name: String(hostPreset && (!item.name || namePreset) ? hostPreset.name : item.name || preset?.name || host).trim(),
        host,
        username: String(item.username || '').trim(),
        secret: String(item.secret || '')
      };
    }).filter(item => item.host),
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
    'cloudflareToken', 'dokDomain', 'acmeEmail', 'acmeStaging', 'authDomain', 'adminUser',
    'adminEmail', 'adminPassword', 'authPort', 'protectDok', 'dnsProvider', 'dnsDomain',
    'dnsPort', 'dnsWebPort', 'mailDomain', 'mailFrom', 'mailpitSmtpPort', 'mailpitWebPort',
    'mailpitMaxMessages', 'stalwartAdminUser', 'stalwartAdminPassword', 'stalwartWebPort',
    'stalwartSmtpPort', 'stalwartSubmissionPort', 'stalwartImapsPort', 'smtpHost', 'smtpPort',
    'smtpTls', 'smtpUser', 'smtpPassword', 'smtpFrom'
  ]) {
    if (body[field] === undefined) continue;
    plan[field] = body[field];
  }
  const primary = plan.defaults.primaryDomain;
  if (!plan.defaults.adminUser && plan.adminUser) plan.defaults.adminUser = plan.adminUser;
  if (!plan.defaults.adminEmail && plan.adminEmail) plan.defaults.adminEmail = plan.adminEmail;
  if (!plan.dokDomain && plan.defaults.dokDomain) plan.dokDomain = plan.defaults.dokDomain;
  if (primary) {
    if (plan.services.proxy === 'nginx-proxy' && !plan.dokDomain) plan.dokDomain = `dok.${primary}`;
    if (plan.services.auth && !plan.authDomain) plan.authDomain = `auth.${primary}`;
    if (plan.services.dns && !plan.dnsDomain) plan.dnsDomain = `dns.${primary}`;
    if (plan.services.mail && !plan.mailDomain) plan.mailDomain = `mail.${primary}`;
    if (plan.services.mail && !plan.mailFrom) plan.mailFrom = `authelia@${primary}`;
    if (plan.services.mail === 'smtp' && !plan.smtpFrom) plan.smtpFrom = plan.mailFrom || `authelia@${primary}`;
  }
  if (plan.services.proxy === 'nginx-proxy' && !plan.acmeEmail && plan.defaults.adminEmail) {
    plan.acmeEmail = plan.defaults.adminEmail;
  }
  plan.acmeStaging = plan.acmeStaging === true || plan.acmeStaging === 'true';
  // Dok protection only works when Authelia and nginx-proxy are both part of
  // the stack; otherwise a saved checkbox could generate an auth vhost that
  // points at a container that does not exist.
  if (plan.services.auth !== 'authelia' || plan.services.proxy !== 'nginx-proxy') {
    plan.protectDok = false;
    plan.defaults.protectDok = false;
  } else if (plan.protectDok === true) {
    plan.defaults.protectDok = true;
  }
  if (plan.dokDomain) {
    plan.dokDomain = normalizeDomain(plan.dokDomain).toLowerCase();
    if (!plan.defaults.dokDomain) plan.defaults.dokDomain = plan.dokDomain;
  }
  for (const key of ['authDomain', 'dnsDomain', 'mailDomain']) {
    if (plan[key]) plan[key] = normalizeDomain(plan[key]).toLowerCase();
  }
  return plan;
}

export function validateInstallPlan(plan) {
  const issues = [];
  const defaults = plan.defaults || {};
  if (plan.type === 'core' && !defaults.primaryDomain) issues.push('A primary domain is required for a Dok with Core Services installation.');
  if (defaults.primaryDomain && !validDomain(defaults.primaryDomain)) issues.push('Primary domain is invalid.');
  if (defaults.dokDomain && !validDomain(defaults.dokDomain)) issues.push('Dok domain is invalid.');
  for (const [label, value] of [
    ['Dok domain', plan.dokDomain],
    ['Authentication portal domain', plan.authDomain],
    ['DNS console domain', plan.dnsDomain],
    ['Mail domain', plan.mailDomain]
  ]) {
    if (value && !validDomain(value)) issues.push(`${label} is invalid.`);
  }
  if (plan.acmeEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(plan.acmeEmail)) issues.push('Let\'s Encrypt email is invalid.');
  if (plan.mailFrom && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(plan.mailFrom)) issues.push('Notification sender address is invalid.');
  if (plan.smtpFrom && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(plan.smtpFrom)) issues.push('SMTP sender address is invalid.');
  if (!defaults.dataLocation) {
    issues.push('A data location is required. Dok stores all persistent data under a Dok directory in that location.');
  } else {
    if (!path.isAbsolute(defaults.dataLocation)) issues.push('Data location must be an absolute host path.');
    if (/[\r\n:\0]/.test(defaults.dataLocation)) issues.push('Data location contains unsupported characters.');
    if (defaults.dataLocation === '/') issues.push('Choose a dedicated data location, not the filesystem root.');
    const storage = dokStorageRoot(defaults.dataLocation);
    const checkout = path.resolve(DOK_HOST_PATH);
    if (storage === checkout || storage.startsWith(`${checkout}${path.sep}`)) {
      issues.push('Data location cannot place the Dok data directory inside the Dok checkout.');
    }
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

export function writeRegistriesFromPlan(plan, root = dataDir, { replace = false } = {}) {
  const existing = replace ? { connections: [] } : readRegistries(root);
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
      secretEnc: item.secret ? encryptSecret(item.secret, root) : (previous?.secretEnc || ''),
      created: previous?.created || new Date().toISOString(),
      updated: new Date().toISOString()
    });
  }
  writeRegistries({ connections }, root);
  return connections;
}

export function hostVisiblePath(target) {
  const resolved = path.resolve(String(target || ''));
  const inside = root => resolved === root || resolved.startsWith(root + path.sep);
  if (inside(DOK_ROOT) || inside(DOK_SOURCE_ROOT) || inside(MAINT_DATA) || inside(HOST_ROOT)) return resolved;
  // A data location is a host path. The Maintenance container sees the host
  // root at /host, so create it there instead of inside its own filesystem.
  return path.join(HOST_ROOT, resolved.replace(/^\/+/, ''));
}

// The installer keeps every Dok-owned persistent directory under a single
// "Dok" folder inside the user's data location. App runtime data stays at
// <data location>/apps/<app>/data; Dok's own state lives here. Older installs
// used the data location itself as the storage root, so detection must support
// both layouts and never assume the current one is the only possibility.
export function dokStorageRoot(dataLocation) {
  const location = String(dataLocation || '').trim();
  if (!path.isAbsolute(location)) return '';
  return path.join(path.resolve(location), 'Dok');
}

function childDirectoryNames(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
      .map(entry => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function samePath(a, b) {
  try { return path.resolve(a) === path.resolve(b); } catch { return false; }
}

// Bind mounts expose one host directory at several container paths. Path
// string comparison is not enough: a reinstall from an already-installed
// Maintenance container mounts the storage root at both /dok and /host/<path>,
// and copying it onto itself fails. Compare the underlying file identity too.
function sameFile(a, b) {
  if (samePath(a, b)) return true;
  try {
    const left = fs.statSync(a);
    const right = fs.statSync(b);
    return left.dev === right.dev && left.ino === right.ino;
  } catch {
    return false;
  }
}

// Dok state is split into three protection categories:
//   1. replaceable: generated compose files, temporary files, and logs
//   2. configurable: settings, credentials, secrets, and service configuration
//   3. user data: app library, app directories, app runtime data, sources,
//      uploads, groups, and maintenance backups/snapshots
// Only category 2 is ever replaced, and only after the user confirms it.
const STORAGE_CONFIG_FILES = ['settings.json', 'registries.json', 'auth.json', 'dns.json', '.credentials-key'];
const STORAGE_LIBRARY_FILES = ['registry.json'];
const STORAGE_STATE_FILES = ['installation.json', 'installation-state.json'];
const STORAGE_DATA_FILES = [...STORAGE_CONFIG_FILES, ...STORAGE_LIBRARY_FILES, ...STORAGE_STATE_FILES];

function parseProblem(file, validator = () => true) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return validator(value) ? '' : 'is not valid JSON for this file';
  } catch (e) {
    return e.code === 'ENOENT' ? '' : e.message;
  }
}

function inspectStorageRoot(root, dataLocation, { requireDataEvidence = false } = {}) {
  const containerRoot = hostVisiblePath(root);
  const directories = {
    data: path.join(containerRoot, 'data'),
    apps: path.join(containerRoot, 'apps'),
    core: path.join(containerRoot, 'core'),
    sources: path.join(containerRoot, 'sources'),
    uploads: path.join(containerRoot, 'uploads'),
    maintenance: path.join(containerRoot, 'maintenance')
  };
  const dataFiles = STORAGE_DATA_FILES.filter(name => fs.existsSync(path.join(directories.data, name)));
  const settingsFiles = STORAGE_CONFIG_FILES.filter(name => fs.existsSync(path.join(directories.data, name)));
  const appLibraryFiles = STORAGE_LIBRARY_FILES.filter(name => fs.existsSync(path.join(directories.data, name)));
  const appNames = childDirectoryNames(directories.apps);
  const coreServices = childDirectoryNames(directories.core);
  const sourceNames = childDirectoryNames(directories.sources);
  const uploadNames = childDirectoryNames(directories.uploads);
  const appRuntimeRoot = path.join(hostVisiblePath(dataLocation), 'apps');
  const appRuntimeNames = samePath(appRuntimeRoot, directories.apps)
    ? appNames
    : childDirectoryNames(appRuntimeRoot);
  let storagePresent = false;
  try { storagePresent = fs.statSync(containerRoot).isDirectory(); } catch {}
  const installation = readJson(path.join(directories.data, 'installation.json'), null) ||
    readJson(path.join(directories.maintenance, 'installation.json'), null);
  const state = readJson(path.join(directories.data, 'installation-state.json'), null) ||
    readJson(path.join(directories.maintenance, 'installation-state.json'), null);
  const invalidFiles = [];
  for (const [name, validator] of [
    ['settings.json', value => value && typeof value === 'object' && !Array.isArray(value)],
    ['registries.json', value => value && typeof value === 'object' && Array.isArray(value.connections)],
    ['registry.json', value => Array.isArray(value)],
    ['groups.json', value => value && typeof value === 'object' && Array.isArray(value.groups)],
    ['auth.json', value => value && typeof value === 'object'],
    ['dns.json', value => value && typeof value === 'object']
  ]) {
    const file = path.join(directories.data, name);
    const problem = parseProblem(file, validator);
    if (problem) invalidFiles.push(`${name} ${problem}`);
  }
  // A bare token or log directory is not an installation. Require evidence of
  // real Dok state so an unrelated directory is not mistaken for user data.
  // For a direct data-location layout, also require Dok's own data files: an
  // unrelated /srv/apps folder must not turn /srv into a previous install.
  const directoryEvidence = [appNames.length, coreServices.length, sourceNames.length, uploadNames.length].filter(Boolean).length;
  const exists = requireDataEvidence
    ? !!(dataFiles.length || installation || directoryEvidence >= 2 ||
      fs.existsSync(path.join(directories.maintenance, 'installation.json')))
    : !!(dataFiles.length || directoryEvidence || installation || fs.existsSync(path.join(directories.maintenance, 'installation.json')));
  return {
    root,
    containerRoot,
    storagePresent,
    dataRoot: directories.data,
    appsRoot: directories.apps,
    coreRoot: directories.core,
    sourcesRoot: directories.sources,
    uploadsRoot: directories.uploads,
    maintenanceRoot: directories.maintenance,
    appRuntimeRoot,
    dataFiles,
    settingsFiles,
    appLibraryFiles,
    apps: appNames.slice(0, 100),
    appCount: appNames.length,
    appRuntime: appRuntimeNames.slice(0, 100),
    appRuntimeCount: appRuntimeNames.length,
    coreServices: coreServices.slice(0, 100),
    coreServiceCount: coreServices.length,
    sources: sourceNames.slice(0, 100),
    sourceCount: sourceNames.length,
    uploads: uploadNames.slice(0, 100),
    uploadCount: uploadNames.length,
    installation: installation && typeof installation === 'object' ? {
      id: installation.id || '',
      type: installation.type || '',
      completedAt: installation.completedAt || '',
      created: installation.created || '',
      updated: installation.updated || ''
    } : null,
    summary: state?.summary || installation?.summary || null,
    invalidFiles,
    exists
  };
}

function installationTimestamp(inspection) {
  const candidates = [inspection?.installation?.completedAt, inspection?.installation?.updated, inspection?.summary?.updated];
  for (const value of candidates) {
    const time = Date.parse(String(value || ''));
    if (Number.isFinite(time)) return time;
  }
  return 0;
}

// Chooses the storage root to use. Existing data wins over creating a new
// empty folder: preferably the documented <location>/Dok layout, but a legacy
// installation that used <location> directly is adopted instead of being
// silently ignored and replaced with an empty directory.
function chooseStorageRoot(canonical, direct) {
  const candidates = [canonical, direct].filter(Boolean);
  const existing = candidates.filter(item => item.exists);
  if (!existing.length) return canonical;
  if (existing.length === 1) return existing[0];
  const canonicalTime = installationTimestamp(canonical);
  const directTime = installationTimestamp(direct);
  if (canonicalTime !== directTime) return canonicalTime > directTime ? canonical : direct;
  if (!!canonical.installation !== !!direct.installation) return canonical.installation ? canonical : direct;
  const rank = item => (item.settingsFiles.length * 100) + (item.appCount * 10) + item.coreServiceCount;
  return rank(direct) > rank(canonical) ? direct : canonical;
}

// The UI asks for the data location, but users often paste the actual storage
// folder (for example /srv/dok/Dok) shown by an earlier install. When that
// folder is itself a complete Dok storage root, its parent is the correct data
// location: the canonical root and the app runtime data root then line up again
// instead of creating a second "Dok/Dok" folder or orphaning app data.
export function normalizeDokDataLocation(dataLocation) {
  const location = String(dataLocation || '').trim();
  if (!path.isAbsolute(location)) return location;
  const resolved = path.resolve(location);
  if (path.basename(resolved) !== 'Dok') return location;
  const inspection = inspectStorageRoot(resolved, resolved);
  if (!inspection.exists) return location;
  const parent = path.dirname(resolved);

  // Prefer the location Dok itself recorded. This distinguishes an actual
  // canonical storage folder from a legacy installation that happens to use a
  // folder named "Dok" as its data location.
  const settings = readJson(path.join(inspection.dataRoot, 'settings.json'), null);
  const stored = settings?.defaults?.dataLocation;
  if (stored && path.isAbsolute(stored)) {
    if (stored === resolved || samePath(stored, resolved)) return location;
    if (stored === parent || samePath(stored, parent)) return parent;
  }

  // Canonical installs always create <dataLocation>/apps for app runtime data,
  // while the Dok storage folder has its own apps directory for the library.
  // Check the host-visible path: inside Maintenance the data location is not
  // mounted at its host path directly.
  const parentVisible = hostVisiblePath(parent);
  if (fs.existsSync(path.join(parentVisible, 'apps'))) return parent;
  if (fs.existsSync(inspection.appsRoot)) return location;
  return parent;
}

// Inspects the storage root the installer is about to use. This must never
// create anything: the UI uses it before the user has confirmed how an
// existing installation should be handled.
export function inspectDokStorage(dataLocation) {
  const location = String(dataLocation || '').trim();
  const canonicalRoot = dokStorageRoot(location);
  if (!canonicalRoot) return { valid: false, exists: false, dataLocation: location };
  const canonical = inspectStorageRoot(canonicalRoot, location);
  const directRoot = path.resolve(location);
  // Never treat the source checkout as a previous installation just because a
  // development run left data/apps directories in it.
  const directEligible = !samePath(directRoot, DOK_SOURCE_ROOT) &&
    !samePath(directRoot, hostVisiblePath(DOK_SOURCE_ROOT)) &&
    !samePath(directRoot, DOK_HOST_PATH);
  const direct = directEligible ? inspectStorageRoot(directRoot, location, { requireDataEvidence: true }) : null;
  const chosen = chooseStorageRoot(canonical, direct);
  const layout = samePath(chosen.root, directRoot) ? 'direct' : 'dok-subfolder';
  const bothLayouts = !!(canonical.exists && direct?.exists && !samePath(canonical.root, direct.root));
  return {
    valid: true,
    exists: !!chosen.exists,
    storagePresent: !!chosen.storagePresent,
    dataLocation: location,
    storageRoot: chosen.root,
    containerRoot: chosen.containerRoot,
    layout,
    legacyLayout: layout === 'direct',
    bothLayouts,
    canonical: {
      storageRoot: canonical.root,
      exists: canonical.exists,
      appCount: canonical.appCount,
      appRuntimeCount: canonical.appRuntimeCount,
      settingsFiles: canonical.settingsFiles
    },
    direct: direct ? {
      storageRoot: direct.root,
      exists: direct.exists,
      appCount: direct.appCount,
      appRuntimeCount: direct.appRuntimeCount,
      settingsFiles: direct.settingsFiles
    } : null,
    dataRoot: chosen.dataRoot,
    appsRoot: chosen.appsRoot,
    appRuntimeRoot: chosen.appRuntimeRoot,
    coreRoot: chosen.coreRoot,
    sourcesRoot: chosen.sourcesRoot,
    uploadsRoot: chosen.uploadsRoot,
    maintenanceRoot: chosen.maintenanceRoot,
    dataFiles: chosen.dataFiles,
    settingsFiles: chosen.settingsFiles,
    appLibraryFiles: chosen.appLibraryFiles,
    apps: chosen.apps,
    appCount: chosen.appCount,
    appRuntime: chosen.appRuntime,
    appRuntimeCount: chosen.appRuntimeCount,
    coreServices: chosen.coreServices,
    coreServiceCount: chosen.coreServiceCount,
    sources: chosen.sources,
    sourceCount: chosen.sourceCount,
    uploads: chosen.uploads,
    uploadCount: chosen.uploadCount,
    installation: chosen.installation,
    summary: chosen.summary,
    invalidFiles: chosen.invalidFiles,
    categories: {
      replaceable: ['Generated Dok compose files', 'Temporary files', 'Log files'],
      configurable: chosen.settingsFiles,
      appLibrary: chosen.apps,
      appLibraryIndex: chosen.appLibraryFiles,
      appData: chosen.appRuntime.slice(0, 100),
      appDataCount: chosen.appRuntimeCount,
      sources: chosen.sources,
      uploads: chosen.uploads.slice(0, 100),
      maintenance: chosen.exists ? path.join(chosen.root, 'maintenance') : ''
    }
  };
}

function writeEnvFile(file, values) {
  let existing = '';
  try { existing = fs.readFileSync(file, 'utf-8'); } catch {}
  const wanted = new Map(Object.entries(values).map(([key, value]) => [key, String(value)]));
  const seen = new Set();
  const lines = [];
  for (const line of existing.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (match && wanted.has(match[1])) {
      lines.push(`${match[1]}=${wanted.get(match[1])}`);
      seen.add(match[1]);
    } else if (line || lines.length) {
      lines.push(line);
    }
  }
  for (const [key, value] of wanted) {
    if (!seen.has(key)) lines.push(`${key}=${value}`);
  }
  const text = `${lines.join('\n').replace(/\n+$/, '')}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writePrivateFile(file, text, { mode: 0o600 });
}

function copyTree(source, target, { overwrite = true, excludeTopLevel = [] } = {}) {
  if (!fs.existsSync(source)) return;
  const resolvedSource = path.resolve(source);
  const resolvedTarget = path.resolve(target);
  if (resolvedSource === resolvedTarget) return;
  // Only compare existing paths. A missing target will be created below.
  if (fs.existsSync(target) && sameFile(resolvedSource, resolvedTarget)) return;
  const excluded = new Set(excludeTopLevel);
  fs.mkdirSync(resolvedTarget, { recursive: true });
  fs.cpSync(resolvedSource, resolvedTarget, {
    recursive: true,
    force: overwrite,
    errorOnExist: false,
    filter: entry => {
      const name = path.basename(entry);
      if (name === 'node_modules' || name === '.git') return false;
      if (name.startsWith('.preview-')) return false;
      const relative = path.relative(resolvedSource, entry);
      if (relative && excluded.has(relative.split(path.sep)[0])) return false;
      try {
        const stat = fs.lstatSync(entry);
        if (stat.isSocket() || stat.isFIFO() || stat.isBlockDevice() || stat.isCharacterDevice()) return false;
      } catch {}
      return true;
    }
  });
}

// Copy the live checkout data into the selected storage root, write the
// compose environment, and drop the generated managed compose so the root
// compose (which now points at the storage root) is used on the next launch.
export async function relocateDokStorage(plan, log = () => {}, { existingData = '' } = {}) {
  const defaults = plan.defaults || {};
  const inspected = inspectDokStorage(defaults.dataLocation);
  const hostRoot = inspected.storageRoot || dokStorageRoot(defaults.dataLocation);
  if (!hostRoot) throw new Error('A persistent data location is required before Dok can store its data.');
  const containerRoot = hostVisiblePath(hostRoot);
  const mode = parseInt(String(defaults.dataMode || '0775').replace(/^0o/i, ''), 8);
  for (const name of ['data', 'apps', 'core', 'sources', 'uploads', 'maintenance']) {
    const dir = path.join(containerRoot, name);
    fs.mkdirSync(dir, { recursive: true });
    try { if (Number.isInteger(mode)) fs.chmodSync(dir, mode); } catch {}
    chownDokPath(dir);
  }
  if (inspected.legacyLayout) {
    log(`Existing Dok data found directly in ${hostRoot}; continuing to use that folder (no data was moved).`);
  }
  const existingRoot = inspected.exists && existingData !== 'overwrite';
  // When the destination already has Dok state, its settings, encrypted
  // credentials, auth, and DNS configuration are authoritative. Copying the
  // checkout's matching files would mix encryption keys and could make the
  // existing secrets unreadable.
  const destinationConfig = inspected.exists
    ? ['settings.json', 'registries.json', 'auth.json', 'dns.json', '.credentials-key', 'installation.json', 'installation-state.json', '.maintenance-token']
    : [];
  for (const name of ['data', 'apps', 'core', 'sources', 'uploads']) {
    const source = path.join(DOK_ROOT, name);
    const target = path.join(containerRoot, name);
    // App code, app data, project sources, and existing settings are user data.
    // Core service files may be refreshed, and only when the user explicitly
    // chose to replace the configuration. Never delete files that the source
    // does not provide (certificates, app data, uploads, or local edits).
    const overwrite = name === 'core' && existingData === 'overwrite';
    copyTree(source, target, {
      overwrite,
      excludeTopLevel: name === 'data' ? destinationConfig : []
    });
    chownTree(target);
    const protection = existingRoot ? ' (existing files preserved)' : (existingData === 'overwrite' ? ' (replaceable files refreshed)' : '');
    log(`Prepared ${name} at ${path.join(hostRoot, name)}${protection}`);
  }
  const maintTarget = path.join(containerRoot, 'maintenance');
  if (path.resolve(MAINT_DATA) !== path.resolve(maintTarget)) {
    copyTree(MAINT_DATA, maintTarget, { overwrite: false });
    chownTree(maintTarget);
    log(`Merged maintenance data into ${path.join(hostRoot, 'maintenance')}`);
  }
  writeEnvFile(path.join(DOK_COMPOSE_ROOT, '.env'), {
    DOK_STORAGE_ROOT: hostRoot,
    MAINTENANCE_DATA_PATH: path.join(hostRoot, 'maintenance')
  });
  for (const dir of [path.join(containerRoot, 'data', 'wickedafdok'), path.join(DOK_ROOT, 'data', 'wickedafdok')]) {
    for (const name of ['docker-compose.yml', 'docker-compose.socket-gid.yml', 'installation-compose.yml']) {
      try { fs.rmSync(path.join(dir, name), { force: true }); } catch {}
    }
  }
  return { hostRoot, containerRoot, inspected };
}

export function mirrorMaintenanceData(hostRoot) {
  const containerRoot = hostVisiblePath(hostRoot);
  const target = path.join(containerRoot, 'maintenance');
  if (path.resolve(MAINT_DATA) === path.resolve(target)) return target;
  copyTree(MAINT_DATA, target);
  chownTree(target);
  return target;
}

export async function ensurePlanDirectories(plan) {
  const defaults = plan.defaults || {};
  const targets = [dataDir, appsDir, coreDir, sourcesDir, uploadsDir];
  if (defaults.dataLocation) {
    const inspected = inspectDokStorage(defaults.dataLocation);
    const storage = inspected.storageRoot || dokStorageRoot(defaults.dataLocation);
    targets.push(defaults.dataLocation);
    targets.push(storage);
    for (const name of ['data', 'apps', 'core', 'sources', 'uploads', 'maintenance']) {
      targets.push(path.join(storage, name));
    }
    // Keep the app runtime data root separate from the Dok storage root in the
    // documented layout, but avoid creating an unused Dok folder when an
    // existing installation uses the data location directly.
    if (!inspected.legacyLayout) targets.push(path.join(defaults.dataLocation, 'apps'));
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

export function managedDokCompose() {
  const dir = path.join(DOK_ROOT, 'data', 'wickedafdok');
  const file = path.join(dir, 'docker-compose.yml');
  try {
    if (!fs.statSync(file).isFile()) return null;
    const text = fs.readFileSync(file, 'utf8');
    if (/^[ \t]*-[ \t]*["']?\/app\/(?:data|sources|uploads|apps|core):\/app\/(?:data|sources|uploads|apps|core)["']?[ \t]*$/m.test(text)) {
      return null;
    }
    return { dir, file, managed: true };
  } catch {
    return null;
  }
}

export function dokComposeContext() {
  const managed = managedDokCompose();
  if (managed) return managed;
  const file = composeFilesFor(DOK_COMPOSE_ROOT)[0] || path.join(DOK_COMPOSE_ROOT, 'docker-compose.yml');
  return { dir: DOK_COMPOSE_ROOT, file, managed: false };
}

export function dokSocketOverridePath(ctx = dokComposeContext()) {
  return ctx.managed
    ? path.join(ctx.dir, 'docker-compose.socket-gid.yml')
    : path.join(DOK_SOURCE_ROOT, 'data', '.docker-socket-gid.yml');
}

export function dokComposeSupportFiles(ctx = dokComposeContext()) {
  const files = [];
  const override = path.join(ctx.dir, 'docker-compose.override.yml');
  try { if (fs.statSync(override).isFile()) files.push(override); } catch {}
  const socket = dokSocketOverridePath(ctx);
  try { if (fs.statSync(socket).isFile()) files.push(socket); } catch {}
  return files;
}

export function listCoreServices(root = coreDir) {
  const names = [];
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'host-helper') continue;
      if (composeFilesFor(path.join(root, entry.name)).length) names.push(entry.name);
    }
  } catch {}
  return names.sort();
}

export function listApps(root = dataDir) {
  return readRegistry(root).map(entry => ({
    id: entry.id || '',
    name: entry.name || projectName(entry.appDir || entry.path || '', 'app'),
    appDir: entry.appDir || entry.path || '',
    image: entry.image || '',
    managedBy: entry.managedBy || 'dok',
    library: entry.library || null,
    needsConfig: entry.needsConfig === true
  }));
}

export function installationSummary({ dataRoot = dataDir, coreRoot = coreDir } = {}) {
  const settings = readSettings(dataRoot);
  return {
    apps: listApps(dataRoot).length,
    coreServices: listCoreServices(coreRoot),
    registryConnections: readRegistries(dataRoot).connections.length,
    primaryDomain: settings.defaults?.primaryDomain || '',
    dokDomain: settings.defaults?.dokDomain || settings.services?.nginxProxy?.domain || '',
    dokHttpPort: Number(settings.services?.nginxProxy?.httpPort) || 80,
    dataLocation: settings.defaults?.dataLocation || '',
    defaultNetwork: settings.defaults?.defaultNetwork || DEFAULT_NETWORK
  };
}

export function writeInstallationCompose({ dataRoot = dataDir, sourceRoot = DOK_SOURCE_ROOT } = {}) {
  const target = path.join(dataRoot, 'wickedafdok', 'installation-compose.yml');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // Absolute container paths keep the file valid after the data root moves
  // away from the checkout and Maintenance mounts the source separately.
  const includes = [path.join(sourceRoot, 'docker-compose.yml')];
  const override = path.join(sourceRoot, 'docker-compose.override.yml');
  if (fs.existsSync(override)) includes.push(override);
  const socketOverride = path.join(dataRoot, '.docker-socket-gid.yml');
  if (fs.existsSync(socketOverride)) includes.push(socketOverride);
  // Core services are separate compose projects. Including them here lets the
  // Maintenance container recreate the exact installed stack in one command.
  // The managed self-compose (data/wickedafdok/docker-compose.yml) is not
  // included: it defines the same wickedafdok service as the root compose and
  // would conflict with it.
  const coreIncludes = listCoreServices(path.join(dataRoot, '..', 'core'))
    .map(name => path.join(dataRoot, '..', 'core', name, 'docker-compose.yml'));
  const body = `# managed-by: wickedafdok-maintenance
# Canonical installation stack: Dok plus every installed core service.
# Use this file from inside the Maintenance container for an exact reinstall:
#   docker compose -f ${target} up -d --build
name: wickedafdok-installation
include:
${[...new Set([...includes, ...coreIncludes])].map(item => `  - ${item}`).join('\n')}
`;
  writePrivateFile(target, body);
  chownDokPath(target);
  return target;
}

export async function captureSnapshot({ reason = 'manual', label = '', root = DOK_ROOT } = {}) {
  ensureDirs();
  const id = `${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${randomSecret(3)}`;
  const archive = path.join(snapshotsDir, `${id}.tar.gz`);
  const targets = ['data', 'apps', 'core', 'sources'].filter(name => fs.existsSync(path.join(root, name)));
  if (!targets.length) throw new Error('The Dok installation directory is empty');
  const args = ['-czf', archive,
    '--exclude=data/backups', '--exclude=data/tmp', '--exclude=data/logs',
    '--exclude=data/docker-config', '--exclude=data/host-helper/agent.sock', '--exclude=data/.maintenance-token',
    '--exclude=apps/.preview-*', '--exclude=node_modules', '--exclude=.git', ...targets];
  await run('tar', args, { cwd: root });
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
    summary: installationSummary({ dataRoot: path.join(root, 'data'), coreRoot: path.join(root, 'core') })
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

export async function restoreArchive(archive, { overwrite = false, restart = true, preserveApps = true } = {}) {
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
  const preservedRegistry = preserveApps ? readRegistry() : [];
  const preservedGroups = preserveApps ? readJson(path.join(dataDir, 'groups.json'), null) : null;
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
  if (preserveApps) {
    const tempRoot = path.join(MAINT_DATA, 'tmp', `restore-${Date.now()}-${randomSecret(3)}`);
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
      fs.mkdirSync(tempRoot, { recursive: true });
      await run('tar', ['-xzf', archive, '-C', tempRoot]);
      if (topLevel.has('data')) {
        let names = [];
        try { names = fs.readdirSync(dataDir); } catch {}
        for (const name of names.filter(item => !['backups', 'tmp', 'logs', 'docker-config', 'host-helper'].includes(item))) {
          try { fs.rmSync(path.join(dataDir, name), { recursive: true, force: true }); } catch {}
        }
        copyTree(path.join(tempRoot, 'data'), dataDir, { overwrite: true });
        const restoredRegistry = readJson(path.join(tempRoot, 'data', 'registry.json'), []);
        const merged = Array.isArray(preservedRegistry) ? [...preservedRegistry] : [];
        const seen = new Set(merged.map(entry => String(entry?.id || entry?.appDir || entry?.name || entry?.path || '')));
        for (const entry of Array.isArray(restoredRegistry) ? restoredRegistry : []) {
          const key = String(entry?.id || entry?.appDir || entry?.name || entry?.path || '');
          if (key && seen.has(key)) continue;
          if (key) seen.add(key);
          merged.push(entry);
        }
        writeJson(path.join(dataDir, 'registry.json'), merged);
        if (preservedGroups) writeJson(path.join(dataDir, 'groups.json'), preservedGroups);
      }
      // The app library and every apps/<app> directory are user data. Add apps
      // that are missing from the restored snapshot, but never overwrite or
      // delete an app that already exists here.
      copyTree(path.join(tempRoot, 'apps'), appsDir, { overwrite: false });
      if (topLevel.has('core')) {
        try { fs.rmSync(coreDir, { recursive: true, force: true }); } catch {}
        copyTree(path.join(tempRoot, 'core'), coreDir, { overwrite: true });
      }
      copyTree(path.join(tempRoot, 'sources'), sourcesDir, { overwrite: false });
    } finally {
      try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
    }
  } else {
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
  }
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
  const pkg = readJson(path.join(DOK_SOURCE_ROOT, 'package.json'), {}) || readJson('/app/package.json', {}) || {};
  return pkg.version || '1.0.0';
}

export function buildInstallerPrompt({ plan = {}, settings = {}, results = [], dok = {} } = {}) {
  const defaults = { ...(plan.defaults || {}), ...(settings.defaults || {}) };
  const nginx = settings.services?.nginxProxy || {};
  const authelia = settings.services?.authelia || {};
  const authentik = settings.services?.authentik || {};
  const dns = settings.services?.dns || {};
  const technitium = settings.services?.technitium || {};
  const adguard = settings.services?.adguard || {};
  const mail = settings.services?.mail || {};
  const mailpit = settings.services?.mailpit || {};
  const stalwart = settings.services?.stalwart || {};
  const cloudflared = settings.services?.cloudflared || {};
  const primary = normalizeDomain(defaults.primaryDomain || '');
  const dokDomain = normalizeDomain(defaults.dokDomain || nginx.domain || plan.dokDomain || '');
  const authDomain = normalizeDomain(authelia.domain || authentik.domain || plan.authDomain || (primary ? `auth.${primary}` : ''));
  const dnsDomain = normalizeDomain(technitium.domain || adguard.domain || plan.dnsDomain || (primary ? `dns.${primary}` : ''));
  const mailDomain = normalizeDomain(mailpit.domain || stalwart.domain || plan.mailDomain || (primary ? `mail.${primary}` : ''));
  const httpPort = Number(nginx.httpPort) || 80;
  const network = normalizeDomain(defaults.defaultNetwork || DEFAULT_NETWORK) || DEFAULT_NETWORK;
  const selected = new Set(Array.isArray(plan.selected) && plan.selected.length ? plan.selected : [...selectedServiceIds(plan)]);
  const has = id => selected.has(id) || settings.services?.[id === 'nginx-proxy' ? 'nginxProxy' : id]?.enabled === true;
  const proxySelected = has('nginx-proxy');
  const tlsReady = nginx.acme?.enabled === true;
  const httpUrl = (domain, port = httpPort) => normalizeDomain(domain) ? `http://${normalizeDomain(domain)}${Number(port) !== 80 ? `:${Number(port)}` : ''}` : '';
  const httpsUrl = domain => normalizeDomain(domain) ? `https://${normalizeDomain(domain)}` : '';
  const publicUrl = (domain, directPort) => {
    if (proxySelected) return domain ? (tlsReady ? httpsUrl(domain) : httpUrl(domain)) : `http://host:${httpPort}`;
    return `http://host:${Number(directPort) || 80}`;
  };
  const dokUrl = String(dok.url || '').trim() || (proxySelected && dokDomain ? publicUrl(dokDomain) : `http://localhost:${DOK_PORT}`);
  const adminUser = String(plan.adminUser || defaults.adminUser || authelia.adminUser || 'admin').trim() || 'admin';
  const adminEmail = String(plan.adminEmail || defaults.adminEmail || authelia.adminEmail || authentik.adminEmail || '').trim();
  const acmeEmail = String(plan.acmeEmail || nginx.acme?.email || defaults.adminEmail || '').trim();
  const acmeStaging = plan.acmeStaging === true || nginx.acme?.staging === true;
  const protectDok = plan.protectDok === true || defaults.protectDok === true;
  const mailSender = String(mail.sender || plan.mailFrom || plan.smtpFrom || (primary ? `authelia@${primary}` : '')).trim();
  const certHosts = [...new Set([dokDomain, authDomain, dnsDomain, mailDomain].filter(Boolean))];
  const statusLines = results.length
    ? results.map(item => {
      const parts = [`- ${item.name}: ${item.ok ? 'OK' : 'FAILED'}`];
      if (item.detail) parts.push(item.detail);
      if (item.url) parts.push(item.url);
      return parts.join(' — ');
    })
    : ['- No core service launch results were recorded.'];
  const registryLines = (plan.registries || []).length
    ? plan.registries.map(item => `- ${item.name || item.host} (${item.kind || 'registry'}, ${item.host}${item.username ? `, user ${item.username}` : ''})`)
    : ['- None configured.'];

  const wiring = [];
  wiring.push(`- Dok: container ${DOK_CONTAINER} on ${network}; internal http://${DOK_CONTAINER}:${DOK_PORT}; public ${dokUrl}`);
  if (proxySelected) wiring.push(`- nginx-proxy: container nginx-proxy on ${network}; public :${httpPort}${tlsReady ? ' and :443' : ''} -> container :80${tlsReady ? '/:443' : ''}; config /dok/core/nginx-proxy`);
  if (has('authelia')) wiring.push(`- Authelia: container authelia:9091 on ${network}; portal ${httpsUrl(authDomain) || 'not configured'}; config /dok/core/authelia; vhosts /dok/core/nginx-proxy/vhost.d`);
  if (has('authentik')) wiring.push(`- Authentik: containers authentik-server:9000, authentik-worker, authentik-postgresql, authentik-redis on ${network}; portal ${publicUrl(authDomain, 9000)}`);
  if (has('technitium')) wiring.push(`- Technitium DNS: container technitium-dns; web ${publicUrl(dnsDomain, Number(technitium.webPort) || 5380)}; DNS :53 TCP/UDP`);
  if (has('adguard')) wiring.push(`- AdGuard Home: container adguard; web ${publicUrl(dnsDomain, Number(adguard.webPort) || 3000)}; DNS :53 TCP/UDP`);
  if (has('mailpit')) wiring.push(`- Mailpit: container mailpit:1025 SMTP; web ${publicUrl(mailDomain, Number(mailpit.webPort) || 8025)}`);
  if (has('stalwart')) wiring.push(`- Stalwart: container stalwart:25 SMTP, :587 submission, :993 IMAPS; web ${publicUrl(mailDomain, Number(stalwart.webPort) || 8088)}`);
  if (has('cloudflared')) wiring.push(`- cloudflared: connector container on ${network}; public hostnames are configured in Cloudflare${proxySelected ? ' and should target http://nginx-proxy:80' : ' and must target the published host ports'}`);

  const routeLines = [];
  if (proxySelected) {
    if (dokDomain) routeLines.push(`Dok -> ${DOK_CONTAINER}:${DOK_PORT} (VIRTUAL_HOST=${dokDomain}, VIRTUAL_PORT=${DOK_PORT})`);
    if (has('authelia') && authDomain) routeLines.push(`Authelia -> authelia:9091 (VIRTUAL_HOST=${authDomain}, VIRTUAL_PORT=9091)`);
    if (has('authentik') && authDomain) routeLines.push(`Authentik -> authentik-server:${Number(authentik.port) || 9000} (VIRTUAL_HOST=${authDomain}, VIRTUAL_PORT=${Number(authentik.port) || 9000})`);
    if (has('technitium') && dnsDomain) routeLines.push(`Technitium -> technitium-dns:${Number(technitium.webPort) || 5380} (VIRTUAL_HOST=${dnsDomain}, VIRTUAL_PORT=${Number(technitium.webPort) || 5380})`);
    if (has('adguard') && dnsDomain) routeLines.push(`AdGuard -> adguard:${Number(adguard.webPort) || 3000} (VIRTUAL_HOST=${dnsDomain}, VIRTUAL_PORT=${Number(adguard.webPort) || 3000})`);
    if (has('mailpit') && mailDomain) routeLines.push(`Mailpit -> mailpit:${Number(mailpit.webPort) || 8025} (VIRTUAL_HOST=${mailDomain}, VIRTUAL_PORT=${Number(mailpit.webPort) || 8025})`);
    if (has('stalwart') && mailDomain) routeLines.push(`Stalwart -> stalwart:${Number(stalwart.webPort) || 8088} (VIRTUAL_HOST=${mailDomain}, VIRTUAL_PORT=${Number(stalwart.webPort) || 8088})`);
  }

  const portChecks = [`${DOK_PORT} (Dok)`];
  if (proxySelected) portChecks.push(`${httpPort} and 443 (nginx-proxy)`);
  if (has('technitium')) portChecks.push(`${Number(technitium.dnsPort) || 53} TCP/UDP and ${Number(technitium.webPort) || 5380} (Technitium)`);
  if (has('adguard')) portChecks.push(`${Number(adguard.dnsPort) || 53} TCP/UDP and ${Number(adguard.webPort) || 3000} (AdGuard)`);
  if (has('mailpit')) portChecks.push(`${Number(mailpit.smtpPort) || 1025} and ${Number(mailpit.webPort) || 8025} (Mailpit)`);
  if (has('stalwart')) portChecks.push(`${Number(stalwart.smtpPort) || 25}, ${Number(stalwart.submissionPort) || 587}, ${Number(stalwart.imapsPort) || 993}, ${Number(stalwart.webPort) || 8088} (Stalwart)`);
  if (has('cloudflared')) portChecks.push('no inbound ports (cloudflared)');

  const taskLines = [];
  if (proxySelected) {
    taskLines.push(`Reverse proxy: nginx-proxy is the public entry point. Keep it on the ${network} network and verify each expected route below. ${httpPort !== 80 ? `Host port 80 was unavailable, so plain-HTTP URLs must include :${httpPort}.` : ''}`);
    taskLines.push(`TLS: ${acmeEmail ? `acme-companion is configured for ${acmeEmail}${acmeStaging ? ' using the Let\'s Encrypt staging endpoint' : ''}; confirm issuance and renewal for ${certHosts.join(', ') || 'the configured hosts'}.${acmeStaging ? ' Staging certificates are not trusted by browsers; switch staging off only after the user confirms the domain is ready.' : ''}` : `ACME is not enabled. If HTTPS is required, place certificates under /dok/core/nginx-proxy/certs/<host>.crt and .key for ${certHosts.join(', ') || 'the configured hosts'}, or configure acme-companion with a valid email.`} Always verify the final nginx config with nginx -t before reloading.`);
  } else {
    taskLines.push('Reverse proxy: none selected. Reach Dok and the web UIs through their published host ports; do not add VIRTUAL_HOST-only configuration that assumes an nginx-proxy container exists. If the user later adds nginx-proxy, create the routes then.');
  }
  if (has('authelia')) {
    const notifierLine = has('mailpit')
      ? `Authelia's notifier must use mailpit:${Number(mailpit.smtpPort) || 1025} with TLS none and sender ${mailSender || 'authelia@the primary domain'}; send a test reset and confirm it appears in Mailpit.`
      : has('stalwart')
        ? `Create the sender mailbox ${mailSender || 'authelia@the primary domain'} in Stalwart, then point Authelia's notifier at stalwart:${Number(stalwart.submissionPort) || 587} with STARTTLS and the mailbox credentials. Keep Authelia's startup check disabled until the mailbox works.`
        : has('smtp')
          ? `Authelia's notifier uses ${mail.host || 'the saved SMTP host'}:${Number(mail.port) || 587} with sender ${mail.sender || mailSender || 'not set'}; verify authentication and send a test reset.`
          : 'No mail service was selected, so leave Authelia on the filesystem notifier. Do not invent SMTP credentials.';
    taskLines.push(`Authelia: portal ${httpsUrl(authDomain) || 'not configured'}. Confirm the portal is reachable${proxySelected ? ', the session cookie domain covers Dok and every protected host, and ENABLE_AUTH vhosts exist under /dok/core/nginx-proxy/vhost.d' : ' on its internal port'}. Dok protection is ${protectDok ? 'enabled; verify login is required and the portal is reachable' : 'disabled unless the user asks for it'}. ${notifierLine}`);
  } else if (has('authentik')) {
    taskLines.push(`Authentik: portal ${publicUrl(authDomain, Number(authentik.port) || 9000)}. Confirm the server, worker, PostgreSQL, and Redis are healthy. Configure providers/applications only when needed for the selected stack; do not weaken existing policies.`);
  } else {
    taskLines.push('Authentication: no Authelia or Authentik instance was selected. Do not enable ENABLE_AUTH on services unless the user asks.');
  }
  if (has('technitium') || has('adguard')) {
    const provider = dns.provider === 'adguard' || has('adguard') ? 'AdGuard Home' : 'Technitium DNS';
    const dnsPort = Number(dns.provider === 'adguard' || has('adguard') ? adguard.dnsPort : technitium.dnsPort) || 53;
    const webPort = dns.provider === 'adguard' || has('adguard') ? Number(adguard.webPort) || 3000 : Number(technitium.webPort) || 5380;
    taskLines.push(`DNS: ${provider} on port ${dnsPort} TCP/UDP at ${publicUrl(dnsDomain, webPort)}. Confirm the container is healthy, port ${dnsPort} is free, and the hostnames for Dok, authentication, mail, and apps resolve correctly for the intended clients. Do not overwrite existing zones or records without checking them first.`);
  }
  if (has('mailpit')) {
    taskLines.push(`Mail: Mailpit captures notifications at ${publicUrl(mailDomain, Number(mailpit.webPort) || 8025)}. Confirm Dok's notifier points at mailpit:${Number(mailpit.smtpPort) || 1025} with sender ${mailSender || 'not set'}, then trigger a password-reset or test notification and verify it appears in Mailpit.`);
  } else if (has('stalwart')) {
    taskLines.push(`Mail: Stalwart admin is at ${publicUrl(mailDomain, Number(stalwart.webPort) || 8088)} (SMTP ${Number(stalwart.smtpPort) || 25}, submission ${Number(stalwart.submissionPort) || 587}, IMAPS ${Number(stalwart.imapsPort) || 993}). Create the sender mailbox ${mailSender || 'authelia@the primary domain'} and the admin's mailbox, point Dok's notifier at the submission port with STARTTLS, and verify delivery with a test message. Stalwart does not automatically create mailboxes.`);
  } else if (has('smtp')) {
    taskLines.push(`Mail: external SMTP is configured at ${mail.host || 'the saved host'}:${Number(mail.port) || 587} (${mail.tls || 'starttls'}) with sender ${mail.sender || mailSender || 'not set'}. Verify authentication and send a test notification. Never print the SMTP password.`);
  } else {
    taskLines.push('Mail: no mail service was selected. Leave the notifier disabled or unchanged; do not invent SMTP credentials.');
  }
  if (has('cloudflared')) {
    taskLines.push(`Cloudflare Tunnel: the tunnel token is configured, but public hostnames are managed in Cloudflare. Verify the tunnel is connected and that routes exist for ${certHosts.join(', ') || 'the public hostnames'}${proxySelected ? ' targeting http://nginx-proxy:80' : ' targeting the published host ports'}. Report any route that still has to be added in the Cloudflare dashboard.`);
  }
  taskLines.push(`Network and ports: keep every selected service on the ${network} network and check these host ports: ${portChecks.join('; ')}. Check the host firewall only if it is accessible and report required openings.`);
  taskLines.push('Persistence: app and service data must not be reset, deleted, or overwritten. Use the existing /dok/data, /dok/apps, /dok/core, and configured data location. Do not run docker system prune, remove volumes, or recreate healthy containers without a reason.');
  if ((plan.registries || []).length) {
    taskLines.push('Registry access: verify each configured registry or git host with the saved credentials. Use a temporary DOCKER_CONFIG for docker login tests and never write tokens to compose files or logs.');
  }

  const commands = ["docker ps --format 'table {{.Names}}\\t{{.Status}}\\t{{.Ports}}'"];
  if (proxySelected) {
    commands.push('docker exec nginx-proxy nginx -t');
    commands.push('docker compose -f /dok/core/nginx-proxy/docker-compose.yml config -q');
  }
  if (has('authelia')) commands.push('docker compose -f /dok/core/authelia/docker-compose.yml config -q');
  if (has('authentik')) commands.push('docker compose -f /dok/core/auth/docker-compose.yml config -q');
  if (has('technitium') || has('adguard')) commands.push('docker compose -f /dok/core/dns/docker-compose.yml config -q');
  if (has('mailpit')) commands.push('docker compose -f /dok/core/mailpit/docker-compose.yml config -q');
  if (has('stalwart')) commands.push('docker compose -f /dok/core/stalwart/docker-compose.yml config -q');
  if (has('cloudflared')) commands.push('docker compose -f /dok/core/cloudflared/docker-compose.yml config -q');
  if (proxySelected && dokDomain) commands.push(`curl -sI -H 'Host: ${dokDomain}' http://127.0.0.1:${httpPort}/`);
  if (proxySelected && authDomain) {
    commands.push(tlsReady
      ? `curl -skI --resolve '${authDomain}:443:127.0.0.1' 'https://${authDomain}/'`
      : `curl -sI -H 'Host: ${authDomain}' http://127.0.0.1:${httpPort}/`);
  }
  if (proxySelected && dnsDomain) commands.push(`curl -sI -H 'Host: ${dnsDomain}' http://127.0.0.1:${httpPort}/`);
  if (proxySelected && mailDomain) commands.push(`curl -sI -H 'Host: ${mailDomain}' http://127.0.0.1:${httpPort}/`);
  if (!proxySelected && has('technitium')) commands.push(`curl -sI http://127.0.0.1:${Number(technitium.webPort) || 5380}/`);
  if (!proxySelected && has('adguard')) commands.push(`curl -sI http://127.0.0.1:${Number(adguard.webPort) || 3000}/`);
  if (!proxySelected && has('mailpit')) commands.push(`curl -sI http://127.0.0.1:${Number(mailpit.webPort) || 8025}/`);
  if (!proxySelected && has('stalwart')) commands.push(`curl -sI http://127.0.0.1:${Number(stalwart.webPort) || 8088}/`);
  if (has('cloudflared')) commands.push('docker logs --tail 50 cloudflared');
  if (has('technitium') || has('adguard')) {
    const firstHost = certHosts[0];
    if (firstHost) commands.push(`dig +short @127.0.0.1 ${firstHost} (if dig is available)`);
  }

  return [
    '# Dok installation integration brief',
    '',
    'You are OpenCode running inside the Dok Maintenance container. Configure the installed stack so the selected services work together as one stable server, then verify every public endpoint. The installer has already written the user\'s settings and launched the selected containers; prefer those working defaults and make only the smallest changes required for integration, security, or reliability.',
    '',
    '## Installation context',
    `- Installation type: ${plan.type === 'core' ? 'Dok with Core Services' : 'Standalone Dok'}`,
    `- Primary domain: ${primary || 'not set'}`,
    `- Dok URL: ${dokUrl}`,
    `- nginx-proxy HTTP host port: ${httpPort}${httpPort !== 80 ? ' (alternative port in use)' : ''}`,
    `- Default Docker network: ${network}`,
    `- Data location: ${defaults.dataLocation || 'Dok default'}`,
    `- Admin username: ${adminUser}`,
    `- Admin email: ${adminEmail || 'not set'}`,
    `- Let's Encrypt email: ${acmeEmail || 'not enabled'}${acmeStaging ? ' (staging)' : ''}`,
    `- Protect Dok with Authelia: ${protectDok ? 'yes' : 'no'}`,
    `- Domains: Dok ${dokDomain || '-'}, auth ${authDomain || '-'}, DNS ${dnsDomain || '-'}, mail ${mailDomain || '-'}`,
    `- Selected services: ${[...selected].join(', ') || 'none'}`,
    '',
    '### Service launch results',
    ...statusLines,
    '',
    '### Repository connections',
    ...registryLines,
    '',
    '### Expected container wiring',
    ...wiring,
    ...(routeLines.length ? ['', 'Expected nginx-proxy routes:', ...routeLines.map(line => `- ${line}`)] : []),
    '',
    '### Current non-secret service settings',
    `- nginx-proxy domain: ${nginx.domain || '-'}; ACME: ${nginx.acme?.enabled ? `enabled (${nginx.acme.email || 'no email'}${acmeStaging ? ', staging' : ''})` : 'disabled'}`,
    `- Authelia domain: ${authelia.domain || '-'}; admin: ${adminUser || '-'}`,
    `- Authentik domain: ${authentik.domain || '-'}; HTTP port: ${Number(authentik.port) || 9000}`,
    `- DNS provider: ${dns.provider || 'technitium'}; Technitium web/DNS: ${Number(technitium.webPort) || 5380}/${Number(technitium.dnsPort) || 53}; AdGuard web/DNS: ${Number(adguard.webPort) || 3000}/${Number(adguard.dnsPort) || 53}`,
    `- Notifier: ${mail.host ? `${mail.host}:${Number(mail.port) || 587} (${mail.tls || 'starttls'}), sender ${mail.sender || '-'}` : 'not configured'}`,
    `- Mailpit SMTP/web: ${Number(mailpit.smtpPort) || 1025}/${Number(mailpit.webPort) || 8025}`,
    `- Stalwart web/SMTP/submission/IMAPS: ${Number(stalwart.webPort) || 8088}/${Number(stalwart.smtpPort) || 25}/${Number(stalwart.submissionPort) || 587}/${Number(stalwart.imapsPort) || 993}`,
    `- Cloudflare Tunnel enabled: ${cloudflared.enabled ? 'yes' : 'no'}`,
    '',
    '## Secrets',
    'This brief intentionally contains no passwords or tokens. If a task needs one, read it from the running container environment (docker inspect) or the encrypted Dok settings only as needed. Never print, echo, commit, or write a secret into chat output, compose files, logs, or this brief.',
    '',
    '## Required integration work',
    ...taskLines.map((line, index) => `${index + 1}. ${line}`),
    '',
    '## Working rules',
    `- Read ${path.join(DOK_SOURCE_ROOT, 'AGENTS.md')} before changing Dok source or managed compose files.`,
    '- Prefer the Dok API at http://wickedafdok:8080 for settings, domains, auth sync, and service actions. Verify the result with Docker and HTTP afterward.',
    '- Make reversible changes. Do not delete app data, volumes, snapshots, or backups. Do not reset healthy services just to apply cosmetic settings.',
    '- If a required certificate, DNS record, tunnel route, or third-party credential is missing and cannot be created safely, report the exact remaining manual step instead of inventing a workaround.',
    '- After each change, inspect logs and health before moving to the next service.',
    '',
    '## Verification',
    'Run the relevant checks and report their actual results:',
    '```sh',
    ...commands,
    '```',
    'Also verify: the Dok UI responds, the auth portal responds (if selected), DNS answers resolve for the configured hostnames, mail notifications are delivered or captured, registry logins succeed, and every selected service is running with a restart policy and no unexpected port conflicts.',
    '',
    '## Report back',
    'Finish with a short table listing each service, whether it is running, its public URL, what you changed, and what still needs manual action. Mention any command that failed and the exact error.'
  ].join('\n');
}
