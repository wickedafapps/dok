import express from 'express';
import Docker from 'dockerode';
import os from 'os';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { execFile, spawn } from 'child_process';
import crypto from 'crypto';
import http from 'http';
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
          nginxProxy: { enabled: false, network: 'wicked', defaultVhostPort: 80, domain: '' },
          cloudflared: { enabled: false, token: '' },
          authentik: { enabled: false, adminEmail: '', adminPassword: '', secretKey: '', postgresPassword: '', port: 9000, httpsPort: 9443, domain: '' },
          authelia: { enabled: false, domain: '', port: 9091, adminUser: 'admin', adminEmail: '', adminPassword: '', adminPasswordHash: '', sessionSecret: '', encryptionKey: '', jwtSecret: '', theme: 'auto' },
          technitium: { enabled: false, adminPassword: '', webPort: 5380, dnsPort: 53, domain: '' },
          hostHelper: { enabled: false, image: '' },
          opencode: { model: '', provider: '', apiKey: '' }
        },
        backups: { includeLogs: false },
        logs: { tail: 500 },
        designer: { name: 'WickedAFDok', tagline: 'Server & Docker control room', css: '', logo: '' }
      };
      fs.writeFileSync(settingsPath, JSON.stringify(defaults, null, 2), { mode: 0o600 });
      return defaults;
    }
    const cur = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    cur.services = cur.services || {};
    cur.services.nginxProxy = { enabled: false, network: 'wicked', defaultVhostPort: 80, domain: '', ...(cur.services.nginxProxy || {}) };
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
    cur.services.technitium = {
      enabled: false, adminPassword: '', webPort: 5380, dnsPort: 53, domain: '',
      ...(cur.services.technitium || {})
    };
    cur.services.hostHelper = { enabled: false, image: '', ...(cur.services.hostHelper || {}) };
    cur.services.opencode = { model: '', provider: '', apiKey: '', ...(cur.services.opencode || {}) };
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
        nginxProxy: { enabled: false, network: 'wicked', defaultVhostPort: 80, domain: '' },
        cloudflared: { enabled: false, token: '' },
        authentik: { enabled: false, adminEmail: '', adminPassword: '', secretKey: '', postgresPassword: '', port: 9000, httpsPort: 9443, domain: '' },
        authelia: { enabled: false, domain: '', port: 9091, adminUser: 'admin', adminEmail: '', adminPassword: '', adminPasswordHash: '', sessionSecret: '', encryptionKey: '', jwtSecret: '', theme: 'auto' },
        technitium: { enabled: false, adminPassword: '', webPort: 5380, dnsPort: 53, domain: '' },
        hostHelper: { enabled: false, image: '' },
        opencode: { model: '', provider: '', apiKey: '' }
      },
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
  ['services', 'opencode', 'apiKey']
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
}

function writePrivateFile(file, content) {
  fs.writeFileSync(file, content, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
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

function addRegistryEntry(entry) {
  const reg = readRegistry();
  const existing = (entry.appDir ? reg.find(r => r.appDir === entry.appDir) : null)
    || (entry.name ? reg.find(r => r.name === entry.name) : null);
  if (existing) {
    Object.assign(existing, entry, { id: existing.id, created: existing.created });
    writeRegistry(reg);
    return existing;
  }
  const full = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, created: new Date().toISOString(), ...entry };
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

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const env = opts.env || (cmd === 'docker' ? dockerEnvironment() : process.env);
    execFile(cmd, args, { cwd: root, env, maxBuffer: 1024 * 1024 * 50, ...opts }, (err, stdout, stderr) => {
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
  const envInfo = normalizeVhostEnv(parsed.env, {
    vhost: opts.vhost,
    vhostPort: opts.vhostPort,
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
  if (parsed.devices.length) {
    compose += `    devices:\n${parsed.devices.map(v => `      - ${yamlScalar(v)}`).join('\n')}\n`;
  }
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

function copySourceTree(src, dest) {
  if (!src || !fs.existsSync(src) || path.resolve(src) === path.resolve(dest)) return;
  try {
    if (typeof fs.cpSync === 'function') {
      fs.cpSync(src, dest, {
        recursive: true,
        force: true,
        filter: (p) => {
          const base = path.basename(p);
          return base !== '.git' && base !== 'node_modules' && base !== 'docker-compose.wickedafdok.yml';
        }
      });
      return;
    }
  } catch {}
  // Fallback for older Node
  const srcResolved = fs.realpathSync(src);
  const destResolved = fs.existsSync(dest) ? fs.realpathSync(dest) : path.resolve(dest);
  if (srcResolved === destResolved) return;
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'docker-compose.wickedafdok.yml') continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copySourceTree(s, d);
    } else if (entry.isSymbolicLink()) {
      try {
        const link = fs.readlinkSync(s);
        fs.symlinkSync(link, d);
      } catch {
        // skip
      }
    } else {
      try { fs.copyFileSync(s, d); } catch {}
    }
  }
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
      fs.writeFileSync(file, String(text || ''));
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

  const missingVolumes = [];
  for (const [service, svc] of Object.entries(config.services || {})) {
    for (const volume of svc.volumes || []) {
      if (volume.type === 'bind' && volume.source && !fs.existsSync(volume.source)) {
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
      missingVolumes: [], vhost: '', vhostPort: '', vhostService: '', portIssues: []
    };
  }
  if (!model.ok) {
    return {
      ok: false, issues: model.issues, networks: [], missingNetworks: [],
      missingVolumes: [], vhost: '', vhostPort: '', vhostService: '', portIssues: []
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
  if (/\bversion\s*:/i.test(text)) issues.push('Warning: "version" is obsolete in Compose v2 and can be removed');
  if (issues.some(i => !i.startsWith('Warning'))) return { ok: false, issues };

  const workDir = projectDir && fs.existsSync(projectDir) ? projectDir : path.join(dataDir, 'tmp');
  try { fs.mkdirSync(workDir, { recursive: true }); } catch {}
  const tmpFile = path.join(workDir, `.wickedafdok-validate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.yml`);
  try {
    fs.writeFileSync(tmpFile, text);
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
  devices: 'list',
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

  const handled = new Set(['services', 'networks', 'volumes']);
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
    map[key] = text.slice(idx + 1).trim();
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

function nginxProxyCompose(network, domain, hostDir = '') {
  const host = normalizeDomain(domain);
  const base = String(hostDir || '').trim() ? String(hostDir).replace(/[/\\]+$/, '') + '/' : './';
  return `# managed-by: wickedafdok
services:
  nginx-proxy:
    image: nginxproxy/nginx-proxy
    container_name: nginx-proxy
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - /var/run/docker.sock:/tmp/docker.sock:ro
      - ${yamlScalar(`${base}vhost.d:/etc/nginx/vhost.d`)}
      - ${yamlScalar(`${base}certs:/etc/nginx/certs:ro`)}
      - ${yamlScalar(`${base}html:/usr/share/nginx/html:ro`)}
${host ? `    environment:
      - ${yamlScalar(`DEFAULT_HOST=${host}`)}
` : ''}    restart: unless-stopped
    networks:
      - proxy_net

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
  return hostHelperRequest('POST', '/mkdir', {
    path: target,
    uid: uid ?? (typeof process.getuid === 'function' ? process.getuid() : null),
    gid: gid ?? (typeof process.getgid === 'function' ? process.getgid() : null),
    mode: mode ?? 0o775
  }, 10000);
}

function permissionDenied(target, action = 'creating') {
  return httpError(403,
    `Permission denied while ${action} "${target}" as UID/GID ${processIdentity()}. ` +
    'Run "sudo ./setup.sh" on the host to fix ownership of the runtime directories, or create/chown this path with matching permissions. ' +
    'You can also launch the optional Host Helper core service to let WickedAFDok create host paths.'
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

async function ensureHostDirectory(target, { label = 'host path', action = 'creating' } = {}) {
  const dir = path.resolve(String(target || ''));
  if (!target) throw httpError(400, `${label} is empty`);
  if (fs.existsSync(dir)) {
    try {
      if (!fs.statSync(dir).isDirectory()) throw httpError(400, `${label} is not a directory: ${dir}`);
      return dir;
    } catch (e) {
      if (e.status) throw e;
      throw permissionDenied(dir, action);
    }
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch (e) {
    if (!['EACCES', 'EPERM', 'EROFS'].includes(e.code)) throw e;
  }
  try {
    await hostMkdir(dir);
    return dir;
  } catch {
    throw permissionDenied(dir, action);
  }
}

function buildWadCompose(info, { network, domain, port, serviceName = 'app', extraVolumes = [] }) {
  const name = info.Name.replace(/^\//, '');
  const image = info.Config?.Image && info.Config.Image !== '<none>' ? info.Config.Image : info.Image;
  if (!image) throw new Error('WickedAFDok container has no image');
  const envList = Array.isArray(info.Config?.Env) ? info.Config.Env.filter(e => !/^VIRTUAL_(HOST|PORT|PROTO)=/.test(String(e))) : [];
  if (domain) {
    envList.push(`VIRTUAL_HOST=${domain}`);
    envList.push(`VIRTUAL_PORT=${port}`);
  }
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
  for (const b of info.HostConfig?.Binds || []) {
    if (b && !seen.has(b)) { volumes.push(b); seen.add(b); }
  }
  for (const m of info.Mounts || []) {
    if (m.Type === 'bind' && m.Source && m.Destination) {
      const vol = `${m.Source}:${m.Destination}${m.RW === false ? ':ro' : ''}`;
      if (!seen.has(vol)) { volumes.push(vol); seen.add(vol); }
    } else if (m.Type === 'volume' && m.Name && m.Destination) {
      const vol = `${m.Name}:${m.Destination}${m.RW === false ? ':ro' : ''}`;
      if (!volumes.some(v => v.includes(m.Destination))) volumes.push(vol);
    }
  }
  for (const volume of Array.isArray(extraVolumes) ? extraVolumes : []) {
    if (volume && !volumes.includes(volume)) volumes.push(volume);
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

  let compose = `# managed-by: wickedafdok\nservices:\n  ${yamlScalar(serviceName)}:\n`;
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

async function scheduleSelfRecreate(domain, network) {
  const port = String(process.env.PORT || 8080);
  const containersAll = await docker.listContainers({ all: true });
  const wad = containersAll.find(c => (c.Names || []).some(n => {
    const nm = n.replace(/^\//, '');
    return /wickedafdok/i.test(nm) && !/updater/i.test(nm);
  }));
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

  const dataMount = (info.Mounts || []).find(m => m.Destination === '/app/data');
  const hostDataDir = dataMount?.Type === 'bind' && dataMount.Source ? dataMount.Source : null;
  const hostCheckout = hostDataDir && path.basename(hostDataDir) === 'data' ? path.dirname(hostDataDir) : '';
  const extraVolumes = hostCheckout && hostCheckout !== path.parse(hostCheckout).root
    ? [`${hostCheckout}:/app/host-source`]
    : [];
  writePrivateFile(composePath, buildWadCompose(info, {
    network,
    domain: normalizeDomain(domain),
    port,
    serviceName: 'wickedafdok',
    extraVolumes
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
    const ngx = containers.find(c => (c.Names || []).some(n => n.includes('nginx-proxy')));
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
    ...settings
  };
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

async function autheliaPasswordHash(password) {
  const { stdout } = await run('docker', [
    'run', '--rm', '--entrypoint', 'authelia', AUTHELIA_IMAGE,
    'crypto', 'hash', 'generate', 'argon2', '--password', String(password)
  ]);
  const match = /\$argon2id\$[^\s"']+/.exec(stdout || '');
  if (!match) throw new Error('Authelia did not return an Argon2id password hash');
  return match[0];
}

function autheliaConfiguration(raw = {}, cookieDomains = []) {
  const s = autheliaDefaults(raw);
  const portal = normalizeDomain(s.domain);
  const portalUrl = `https://${portal}`;
  const user = String(s.adminUser || 'admin').replace(/[^A-Za-z0-9._@-]/g, '') || 'admin';
  const hash = String(s.adminPasswordHash || '').trim();
  if (!portal) throw httpError(400, 'Authelia requires a portal domain');
  if (!hash) throw httpError(400, 'Authelia admin password hash is missing');
  const email = String(s.adminEmail || '').trim();
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
notifier:
  filesystem:
    filename: '/config/notifications.txt'
`;
  const users = `users:
  ${user}:
    displayname: ${JSON.stringify(user)}
    password: ${JSON.stringify(hash)}
${email ? `    email: ${JSON.stringify(email)}\n` : ''}`;
  return { config, users, cookieDomains: cookieSet };
}

async function writeAutheliaConfig(raw = {}, cookieDomains = []) {
  const s = autheliaDefaults(raw);
  const dir = path.join(coreServiceDir('authelia'), 'config');
  fs.mkdirSync(dir, { recursive: true });
  const files = autheliaConfiguration(s, cookieDomains);
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
  let containers = [];
  try {
    containers = await docker.listContainers({ all: false });
  } catch {
    return [];
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
  if (!next.includes('/etc/nginx/vhost.d') || !next.includes('/etc/nginx/certs') ||
      !next.includes('/usr/share/nginx/html')) {
    // Older managed composes have no vhost/certs/error-page volumes; regenerate
    // the whole file from the saved nginx-proxy settings.
    const configured = readSettings().services?.nginxProxy || {};
    next = nginxProxyCompose(configured.network || 'wicked', configured.domain || '', nginxHostDir);
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
  if (portal) {
    cookieDomains = [...new Set([authCookieDomain(portal), ...hosts.map(authCookieDomain)].filter(Boolean))];
    persistedCookieDomains = cookieDomains;
    const composePath = path.join(coreServiceDir('authelia'), 'docker-compose.yml');
    const configPath = path.join(coreServiceDir('authelia'), 'config', 'configuration.yml');
    const previousCookies = (Array.isArray(state.cookieDomains) ? state.cookieDomains : []).join(',');
    const nextCookies = cookieDomains.join(',');
    // Only rewrite the generated Authelia config when the cookie-domain set
    // changes (or the file is missing). This keeps manual additions such as
    // SMTP/notifier settings from being overwritten on every 60s sync.
    if (fs.existsSync(composePath) && authelia.adminPasswordHash &&
        (previousCookies !== nextCookies || !fs.existsSync(configPath))) {
      try {
        const written = await writeAutheliaConfig(authelia, cookieDomains);
        if (written.changed) {
          const containers = await docker.listContainers({ all: false }).catch(() => []);
          if (containers.some(c => (c.Names || []).some(n => n.replace(/^\//, '') === 'authelia'))) {
            await run('docker', ['restart', 'authelia']).catch(() => {});
          }
        }
      } catch (e) {
        // Keep the old cookie list in the state so the next sync retries.
        persistedCookieDomains = Array.isArray(state.cookieDomains) ? state.cookieDomains : [];
        appendServerLog('WARN', `Authelia config sync failed: ${e.message}`);
      }
    }
  }
  const ensured = await ensureNginxProxyCompose({ recreate: !!portal });
  if (nginxChanged && !ensured.recreated) await reloadNginxProxy();
  fs.writeFileSync(statePath, JSON.stringify({ hosts, skippedHosts: skipped, cookieDomains: persistedCookieDomains, at: Date.now() }, null, 2), { mode: 0o600 });
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

function coreServiceUrl(domain, port) {
  const clean = normalizeDomain(domain);
  return clean ? `http://${clean}` : `http://localhost:${port}`;
}

let selfInfoCache = { at: 0, info: null };

async function selfContainerInfo() {
  if (selfInfoCache.info && Date.now() - selfInfoCache.at < 5000) return selfInfoCache.info;
  try {
    const containers = await docker.listContainers({ all: true });
    const self = containers.find(c => (c.Names || []).some(n => {
      const name = n.replace(/^\//, '');
      return /wickedafdok/i.test(name) && !/updater|helper/i.test(name);
    }));
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
      return /wickedafdok/i.test(name) && !/updater|helper/i.test(name);
    }));
    if (self?.Image) return self.Image;
  } catch {}
  return process.env.WICKEDAFDOK_IMAGE || 'wickedafdok:latest';
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
  'wickedafdok-host-helper'
]);

const CORE_CONTAINER_NAMES = [
  'nginx-proxy',
  'cloudflared',
  'authelia',
  'technitium-dns',
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
  const selfName = /^wickedafdok(-|$)/.test(name) && !/updater|helper/.test(name);
  if (selfName || project === 'wickedafdok') {
    return { core: false, protected: true, self: true, role: 'WickedAFDok' };
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
  try {
    const containers = await docker.listContainers({ all: true });
    const matches = containers.filter(c => {
      const labels = c.Labels || {};
      if (labels['com.docker.compose.project'] === project) return true;
      return (c.Names || []).some(n => nameHint && n.includes(nameHint));
    });
    if (matches.length) {
      exists = true;
      const primary = matches.find(c => (c.Names || []).some(n => primaryHint && n.includes(primaryHint)))
        || matches.find(c => c.State === 'running')
        || matches[0];
      containerId = primary?.Id || null;
      state = primary?.State || matches[0].State;
      running = matches.some(c => c.State === 'running');
    }
  } catch {}
  return { exists, running, state, containerId, containers: [] };
}

async function coreServiceAction(service, action) {
  const map = {
    'nginx-proxy': { dir: 'nginx-proxy', project: 'nginx-proxy' },
    cloudflared: { dir: 'cloudflared', project: 'cloudflared' },
    auth: { dir: 'auth', project: 'authentik' },
    authelia: { dir: 'authelia', project: 'authelia' },
    dns: { dir: 'dns', project: 'technitium' },
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

function copyMerge(src, dest, { skip = [] } = {}) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip.includes(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyMerge(from, to);
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
      if (occupied && !overwrite) {
        const err = httpError(409, `An app named "${appName}" already exists. Confirm that you want to overwrite it.`);
        err.needsOverwrite = true;
        err.appName = appName;
        throw err;
      }
      fs.rmSync(target, { recursive: true, force: true });
      copyMerge(sourceDir, target);
      const registry = manifest.registry && typeof manifest.registry === 'object' ? manifest.registry : {};
      addRegistryEntry({
        ...registry,
        name: appName,
        path: target,
        appDir: target,
        composeFile: registry.composeFile || 'docker-compose.yml'
      });
      return { ok: true, scope, appName, manifest };
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
    { name: 'dns', label: 'Technitium DNS' },
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

function buildComposeOverride(services, {
  network = '', networks = [], networkMappings = [], vhost = '', vhostPort = '',
  clearVhost = false, vhostService = '', ports = [], volumeMappings = [], baseText = ''
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

  services.forEach((svc) => {
    lines.push(`  ${yamlScalar(svc)}:`);
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

function appDirFor(entry) {
  const name = projectName(entry?.name, 'app');
  if (entry?.appDir && isInsideApps(entry.appDir)) return entry.appDir;
  return path.join(appsDir, name);
}

function composeContainerNames(compose) {
  const names = {};
  let service = '';
  for (const line of String(compose || '').split('\n')) {
    const header = line.match(/^  ([A-Za-z0-9_.-]+):\s*$/);
    if (header) { service = header[1]; continue; }
    const value = line.match(/^\s+container_name:\s*['"]?([^'"#\s]+)/);
    if (value && service) names[service] = value[1];
  }
  return names;
}

// Compose refuses to start when a container_name already belongs to another
// container. Rename the stale container instead of deleting it, which keeps
// its data and makes Quick Deploy succeed on the first try.
async function resolveProjectNameConflicts(project, compose) {
  const desired = composeContainerNames(compose);
  if (!Object.keys(desired).length) return [];
  let containers = [];
  try { containers = await docker.listContainers({ all: true }); } catch { return []; }
  const renamed = [];
  for (const [service, containerName] of Object.entries(desired)) {
    const existing = containers.find(c => (c.Names || []).some(n => n.replace(/^\//, '') === containerName));
    if (!existing) continue;
    const labels = existing.Labels || {};
    if (labels['com.docker.compose.project'] === project) continue;
    const protection = coreContainerInfo({ name: containerName, Labels: labels });
    if (protection.protected) {
      throw httpError(409,
        `"${containerName}" belongs to a protected core service and cannot be reused by ${project}. ` +
        'Change container_name in the compose file or remove the conflicting service first.');
    }
    const shortId = existing.Id.slice(0, 8);
    let nextName = `${containerName}-previous-${shortId}`;
    let suffix = 1;
    while (containers.some(c => (c.Names || []).some(n => n.replace(/^\//, '') === nextName))) {
      nextName = `${containerName}-previous-${shortId}-${suffix++}`;
    }
    try {
      await docker.getContainer(existing.Id).rename({ name: nextName });
      renamed.push({ service, from: containerName, to: nextName });
      appendServerLog('INFO', `Quick Deploy renamed conflicting container ${containerName} to ${nextName}`);
    } catch (e) {
      throw httpError(409, `Unable to resolve the container name conflict for "${containerName}": ${e.message}`);
    }
  }
  return renamed;
}

async function composeAction(entry, action, { allowStartupGrace = false } = {}) {
  const name = projectName(entry?.name, 'app');
  let appDir = appDirFor(entry);
  if (isSymlink(appDir)) throw httpError(400, 'Invalid app directory');
  ensureWritableDirectory(appDir, { label: 'app directory' });
  if (!isInsideApps(appDir)) throw httpError(400, 'Invalid app directory');

  let composeFile = findComposeFile(appDir);
  if (!composeFile && entry?.appDir && fs.existsSync(entry.appDir)) {
    try { copySourceTree(entry.appDir, appDir); } catch {}
    composeFile = findComposeFile(appDir);
  }
  if (!composeFile) throw new Error('This app has no compose file in its app directory');

  let renamed = [];
  if (action === 'up' || action === 'start') {
    renamed = await resolveProjectNameConflicts(name, fs.readFileSync(composeFile, 'utf-8'));
  }

  const args = ['compose', '-f', composeFile, '-p', name];
  const overridePath = path.join(appDir, 'docker-compose.wickedafdok.yml');
  if (fs.existsSync(overridePath)) args.push('-f', overridePath);
  if (action === 'up' || action === 'start') args.push('up', '-d', '--remove-orphans');
  else args.push(action);

  try {
    const { stdout, stderr } = await run('docker', args, { cwd: appDir });
    return { stdout, stderr, appDir, composeFile, renamed };
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
          appDir, composeFile, renamed, pending: true,
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
  const target = path.join(appsDir, appName);
  if (isSymlink(target)) throw httpError(400, 'Invalid app directory');
  let occupied = false;
  try {
    occupied = fs.existsSync(target) && fs.readdirSync(target).length > 0;
  } catch {
    occupied = true;
  }
  if (!occupied) {
    ensureWritableDirectory(target, { label: 'app directory' });
    if (!isInsideApps(target)) throw httpError(400, 'Invalid app directory');
    return target;
  }
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
  try { copySourceTree(sourceDir, appDir); } catch {}

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
    res.json({
      ok: true,
      needsConfig: true,
      type: 'run',
      appName,
      appDir,
      command,
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
    const services = serviceNamesFromCompose(yamlText);
    const proj = projectName(name || services[0] || `app-${Date.now()}`, 'app');
    const appDir = launchAppDirectory(proj);
    const networkNames = await launchNetworkNames();
    const normalized = normalizeComposeNetworks(yamlText, networkNames);
    const launchCompose = normalized.text;
    fs.writeFileSync(path.join(appDir, 'docker-compose.yml'), launchCompose);
    const analysis = await analyzeCompose(launchCompose, {
      projectDir: appDir,
      networkNames: networkNamesForAnalysis(networkNames)
    });
    res.json({
      ok: true,
      needsConfig: true,
      type: 'compose',
      appName: proj,
      appDir,
      fileName: 'docker-compose.yml',
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
    const launchCompose = normalized.text;
    if (launchCompose.trim()) fs.writeFileSync(path.join(appDir, 'docker-compose.yml'), launchCompose);
    const analysis = await analyzeCompose(launchCompose, {
      projectDir: appDir,
      networkNames: networkNamesForAnalysis(networkNames)
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
    const launchCompose = normalized.text;
    if (launchCompose.trim()) fs.writeFileSync(path.join(appDir, 'docker-compose.yml'), launchCompose);
    const analysis = await analyzeCompose(launchCompose, {
      projectDir: appDir,
      networkNames: networkNamesForAnalysis(networkNames)
    });
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
    if (mode === 'run' && !String(command || '').trim()) {
      return res.status(400).json({ error: 'A docker run command is required for run mode' });
    }
    const dir = resolveSource(relPath);
    if (!fs.statSync(dir).isDirectory()) return res.status(400).json({ error: 'Not a directory' });
    if (dir === fs.realpathSync(sourcesDir)) {
      return res.status(400).json({ error: 'Choose a project folder, not the Projects root' });
    }
    const project = projectName(name || path.basename(dir), 'app');

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
      compose = normalized.text;
      replacedNetworks = normalized.replacedNetworks;
      fs.writeFileSync(path.join(appDir, 'docker-compose.yml'), compose);
    }
    const analysis = await analyzeCompose(compose, {
      projectDir: appDir,
      networkNames: networkNamesForAnalysis(networkNames)
    });

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

// Finalize creation: everything is written into apps/<name> and managed by compose from there.
app.post('/api/launch/finalize', async (req, res) => {
  try {
    const body = req.body || {};
    const {
      type = 'compose', appName, appDir: rawAppDir, path: sourcePath, command = '',
      compose: composeYaml, network = 'wicked', ports = '', vhost = '', vhostPort = '',
      mode = 'auto', sourceRel = '', launchNow = true, force = false, composeEdited = false,
      networkChoices = {}, volumeChoices = {}, vhostTouched = false,
      vhostService = '', createNetwork = false, overwrite = false
    } = body;
    const composeBody = String(composeYaml || body.yaml || body.generatedCompose || '');
    const composeProvided = body.compose !== undefined || body.yaml !== undefined || body.generatedCompose !== undefined;
    const runMode = type === 'run' && !!command && (!composeBody || !composeEdited);
    if (!runMode && composeProvided && !composeBody.trim()) {
      throw httpError(400, 'Compose file is empty');
    }

    const servicesFromBody = composeBody ? serviceNamesFromCompose(composeBody) : [];
    const fallbackName = sourcePath ? path.basename(sourcePath) : (servicesFromBody[0] || 'app');
    const name = projectName(appName || fallbackName, 'app');
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
    if (targetOccupied && overwrite !== true) {
      const err = httpError(409,
        `An app named "${name}" already exists. Confirm that you want to overwrite it, or choose another app name.`);
      err.needsOverwrite = true;
      err.appName = name;
      throw err;
    }

    const netName = String(network || '').trim();
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
    const cleanVhostPort = String(vhostPort || settingsVhostPort).trim() || '80';
    if (cleanVhost && (!/^\d+$/.test(cleanVhostPort) || Number(cleanVhostPort) < 1 || Number(cleanVhostPort) > 65535)) {
      throw httpError(400, 'VIRTUAL_PORT must be a port between 1 and 65535');
    }
    const clearVhost = vhostTouched === true && !cleanVhost;

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
      if (useNetwork === 'wicked' || createNetwork === true) {
        await createNetworkStrict(useNetwork);
        networkNames.push(useNetwork);
      } else {
        return res.status(400).json({
          error: `Network "${useNetwork}" does not exist. Choose an existing network or create it.`,
          missingNetworks: [{ key: useNetwork, name: useNetwork, form: true }]
        });
      }
    }

    const runConv = runMode ? runCommandToCompose(command, name) : null;
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
        copySourceTree(staged, targetDir);
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
      try { copySourceTree(sourceReal, targetDir); } catch {}
    }
    ensureWritableDirectory(targetDir, { label: 'app directory' });
    if (!isInsideApps(targetDir)) throw httpError(400, 'Invalid app directory');

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
      // network that does not exist with the setup-managed default network.
      finalCompose = normalizeComposeNetworks(finalCompose, networkNames).text;
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
      const create = choice.create === true;
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
        if (!create) {
          unresolvedVolumes.push({ ...volume, source });
          continue;
        }
        const safe = safeHostPath(source);
        try {
          await ensureHostDirectory(safe, { label: 'host path', action: 'creating' });
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
    const overrideNeeded = !!(overrideNetwork || cleanVhost || overrideClearVhost || overridePorts.length ||
      networkMappings.length || volumeMappings.length);
    const overrideText = overrideNeeded ? buildComposeOverride(orderedServices, {
      network: overrideNetwork,
      networkMappings,
      vhost: cleanVhost,
      vhostPort: cleanVhostPort,
      clearVhost: overrideClearVhost,
      vhostService: overrideVhostService,
      ports: overridePorts,
      volumeMappings,
      baseText: finalCompose
    }) : '';

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

    const composePath = path.join(targetDir, 'docker-compose.yml');
    writePrivateFile(composePath, finalCompose);
    const overridePath = path.join(targetDir, 'docker-compose.wickedafdok.yml');
    if (overrideText) fs.writeFileSync(overridePath, overrideText);
    else { try { fs.unlinkSync(overridePath); } catch {} }

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
      launch: {
        mode: type === 'run' ? 'compose' : mode,
        name,
        command: command || '',
        ports: portList,
        vhost: cleanVhost,
        vhostPort: cleanVhostPort,
        appDir: targetDir,
        network: useNetwork,
        type
      }
    });

    if (stagedToRemove) {
      try {
        fs.rmSync(stagedToRemove, { recursive: true, force: true });
        writeRegistry(readRegistry().filter(r => path.resolve(r.appDir || '') !== stagedToRemove));
      } catch {}
    }

    let result = { stdout: 'Created (not launched)', stderr: '' };
    let launchError = '';
    let launchPending = false;
    if (launchNow !== false) {
      const args = ['compose', '-f', composePath, '-p', name];
      if (fs.existsSync(overridePath)) args.push('-f', overridePath);
      args.push('up', '-d', '--remove-orphans');
      try {
        result = await run('docker', args, { cwd: targetDir });
      } catch (e) {
        // A first start often reports failure while the project containers are
        // still being created (image build, dependency startup). If they exist,
        // report a pending launch so the UI does not call it a failure.
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
    }

    res.json({
      ok: true, appDir: targetDir, appName: name, ...result,
      issues: [...new Set([...validationIssues, ...combinedIssues])], launchError,
      launchPending,
      message: launchPending ? `${name} is still starting.` : ''
    });
  } catch (e) {
    res.status(e.status || 500).json({
      error: e.message, stdout: e.stdout, stderr: e.stderr,
      needsOverwrite: !!e.needsOverwrite, appName: e.appName
    });
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

// ---------- registry ----------
app.get('/api/registry', (req, res) => {
  res.json(readRegistry());
});

async function registryAction(req, res, action) {
  try {
    const entry = readRegistry().find(r => r.id === req.params.id);
    if (!entry) return res.status(404).json({ error: 'App not found' });
    const result = await composeAction(entry, action, { allowStartupGrace: action === 'up' });
    try { await syncAuthVhosts(); } catch {}
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, stdout: e.stdout, stderr: e.stderr });
  }
}

app.post('/api/registry/:id/deploy', (req, res) => registryAction(req, res, 'up'));
app.post('/api/registry/:id/:action(start|stop|restart)', (req, res) => registryAction(req, res, req.params.action));

function appEntryForRequest(req) {
  const entry = readRegistry().find(r => r.id === req.params.id);
  if (!entry) throw httpError(404, 'App not found');
  return entry;
}

// Shared by Alter State (compose editor). The saved compose becomes the app's
// new base configuration, so subsequent Quick Deploys use exactly what the
// user sees. The generated override is removed to avoid stale volume, network,
// or environment values winning over the edited base file.
function normalizeEditedAppCompose(entry, compose) {
  let next = String(compose || '');
  if (!/^networks\s*:/m.test(next) && !/\bnetwork_mode\s*:/.test(next)) {
    next = next.replace(/\s*$/, '') +
      '\n\nnetworks:\n  default:\n    name: wicked\n    external: true\n';
  }
  const vhost = String(entry?.launch?.vhost || '').trim();
  if (vhost) {
    const services = serviceNamesFromCompose(next);
    const preferred = String(entry?.launch?.name || '').trim();
    const service = services.includes(preferred) ? preferred : services[0];
    if (service) {
      const vhostPort = String(entry?.launch?.vhostPort || '').trim();
      next = setComposeServiceEnv(next, service, {
        VIRTUAL_HOST: vhost,
        ...(vhostPort ? { VIRTUAL_PORT: vhostPort } : {})
      });
    }
  }
  return next;
}

app.get('/api/apps/:id/compose', (req, res) => {
  try {
    const entry = appEntryForRequest(req);
    const appDir = appDirFor(entry);
    const composeFile = findComposeFile(appDir);
    if (!composeFile) return res.status(404).json({ error: 'This app has no compose file' });
    res.json({
      entry,
      appDir,
      composeFile,
      compose: fs.readFileSync(composeFile, 'utf-8')
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.post('/api/apps/:id/compose', async (req, res) => {
  try {
    const entry = appEntryForRequest(req);
    const appDir = appDirFor(entry);
    if (isSymlink(appDir)) throw httpError(400, 'Invalid app directory');
    if (!isInsideApps(appDir)) throw httpError(400, 'Invalid app directory');
    ensureWritableDirectory(appDir, { label: 'app directory' });
    const deploy = req.body?.deploy === true;
    const force = req.body?.force === true;
    const compose = normalizeEditedAppCompose(entry, req.body?.compose || '');
    if (!compose.trim()) return res.status(400).json({ error: 'Compose file is empty' });
    const validation = await validateCompose(compose, { projectDir: appDir });
    if (!validation.ok && !force) {
      return res.status(400).json({
        error: 'Compose validation failed. Fix the issues or choose to save anyway.',
        issues: validation.issues || []
      });
    }
    const composePath = findComposeFile(appDir) || path.join(appDir, 'docker-compose.yml');
    writePrivateFile(composePath, compose);
    try { fs.unlinkSync(path.join(appDir, 'docker-compose.wickedafdok.yml')); } catch {}
    let result = { stdout: 'Base configuration saved', stderr: '', renamed: [] };
    if (deploy) {
      result = await composeAction(entry, 'up', { allowStartupGrace: true });
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
    res.status(e.status || 500).json({ error: e.message, stdout: e.stdout, stderr: e.stderr });
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
      if (body.services.nginxProxy) next.services.nginxProxy = { ...current.services.nginxProxy, ...body.services.nginxProxy };
      if (body.services.cloudflared) next.services.cloudflared = { ...current.services.cloudflared, ...body.services.cloudflared };
      if (body.services.authelia) next.services.authelia = { ...current.services.authelia, ...body.services.authelia };
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
    writeSettings(next);
    res.json(redactSettingsSecrets(next));
  } catch (e) {
    res.status(500).json({ error: e.message });
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
    // Keep "installed" tied to either the compose file or the live container.
    // A transient Docker lookup failure must not make a running nginx-proxy
    // look like it was never created.
    let status = { exists: false, running: false, state: 'not created', containerId: null };
    try {
      status = await coreServiceStatus('nginx-proxy', { nameHint: 'nginx-proxy', primaryHint: 'nginx-proxy' });
    } catch (e) {
      appendServerLog('WARN', `nginx-proxy status lookup failed: ${e.message}`);
    }
    res.json({
      ...status,
      installed: !!(status.exists || composeExists),
      composeExists,
      dir: nginxDir,
      composePath,
      compose: composeExists ? readComposeText(composePath) : '',
      settings: settings.services?.nginxProxy || {}
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

app.post('/api/core/nginx-proxy/run', async (req, res) => {
  try {
    const body = req.body || {};
    const settings = readSettings();
    const configured = settings.services?.nginxProxy || {};
    const network = String(body.network || configured.network || 'wicked').trim() || 'wicked';
    const domain = normalizeDomain(body.domain !== undefined ? body.domain : (configured.domain || ''));
    if (domain && !/^[A-Za-z0-9*][A-Za-z0-9*._-]*$/.test(domain)) {
      return res.status(400).json({ error: 'Invalid domain name' });
    }
    const port = process.env.PORT || 8080;
    await ensureNetwork(network);

    const nginxDir = path.join(coreDir, 'nginx-proxy');
    if (!fs.existsSync(nginxDir)) fs.mkdirSync(nginxDir, { recursive: true });
    fs.mkdirSync(path.join(nginxDir, 'vhost.d'), { recursive: true });
    fs.mkdirSync(path.join(nginxDir, 'certs'), { recursive: true });
    ensureNginxErrorPages();
    const composePath = path.join(nginxDir, 'docker-compose.yml');
    recoverOversizedManagedCompose(composePath);
    const existingCompose = readComposeText(composePath);
    const managedCompose = existingCompose.startsWith('# managed-by: wickedafdok');
    const networkLine = `name: ${network}`;
    const quotedNetworkLine = `name: ${yamlScalar(network)}`;
    const hostLine = `DEFAULT_HOST=${domain}`;
    const quotedHostLine = `DEFAULT_HOST=${yamlScalar(domain)}`;
    const staleCompose = managedCompose && (
      (!existingCompose.includes(networkLine) && !existingCompose.includes(quotedNetworkLine)) ||
      (domain
        ? !existingCompose.includes(hostLine) && !existingCompose.includes(quotedHostLine)
        : existingCompose.includes('DEFAULT_HOST=')) ||
      !existingCompose.includes('/etc/nginx/vhost.d') ||
      !existingCompose.includes('/etc/nginx/certs') ||
      !existingCompose.includes('/usr/share/nginx/html')
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
    if (!nextCompose || staleCompose) {
      nextCompose = nginxProxyCompose(network, domain, nginxHostDir);
    }
    if (nextCompose !== existingCompose) writePrivateFile(composePath, nextCompose);

    let resOut = { stdout: '', stderr: '' };
    try {
      const list = await docker.listContainers({ all: true });
      const stale = list.find(c => (c.Names || []).some(n => n.replace(/^\//, '') === 'nginx-proxy') &&
        c.State !== 'running' && c.Labels?.['com.docker.compose.project'] !== 'nginx-proxy');
      if (stale) await docker.getContainer(stale.Id).remove({ force: true });
    } catch {}
    try {
      resOut = await run('docker', ['compose', '-f', composePath, '-p', 'nginx-proxy', 'up', '-d', '--remove-orphans'], { cwd: nginxDir });
    } catch (e2) {
      resOut = await run('docker', ['compose', '-f', composePath, '-p', 'nginx-proxy', 'up', '-d'], { cwd: nginxDir });
    }
    try { await syncAuthVhosts(); } catch {}

    const nextSettings = readSettings();
    nextSettings.services = nextSettings.services || {};
    nextSettings.services.nginxProxy = {
      ...(nextSettings.services.nginxProxy || {}),
      enabled: true,
      network,
      domain
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
        const ngx = ngxList.find(c => (c.Names || []).some(n => n.includes('nginx-proxy')));
        if (ngx) await docker.getContainer(ngx.Id).restart().catch(() => {});
      } catch {}
      try {
        const wadList = await docker.listContainers({ all: true });
        const wad2 = wadList.find(c => (c.Names || []).some(n => /wickedafdok/i.test((n || '').replace(/^\//, '')) && !/updater/i.test(n)));
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
    let message = 'nginx-proxy launched';
    if (selfUpdate?.scheduled) {
      message = `WickedAFDok will be updated with the new domain and recreated. Access it at http://${domain} or http://${host}:${port} if the domain is not working yet.`;
    } else if (selfUpdate?.connected) {
      message = `nginx-proxy launched. WickedAFDok joined the ${network} network. Access it at http://${domain} or http://${host}:${port}.`;
    } else if (selfUpdate?.already) {
      message = `nginx-proxy launched. WickedAFDok is already configured for http://${domain}. It is also available at http://${host}:${port}.`;
    } else if (selfUpdate?.error) {
      message = `nginx-proxy launched, but WickedAFDok could not be reconfigured: ${selfUpdate.error}`;
    } else if (domain) {
      message = `nginx-proxy launched. Access WickedAFDok at http://${host}:${port}.`;
    }

    return res.json({
      ok: true,
      stdout: resOut.stdout,
      stderr: resOut.stderr,
      message,
      domain,
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
    const existingCompose = fs.existsSync(composePath) ? fs.readFileSync(composePath, 'utf-8') : '';
    if (!existingCompose) {
      writePrivateFile(composePath, cloudflaredCompose(settings.services?.cloudflared?.token || ''));
    }
    let running = false;
    let exists = false;
    let state = 'not created';
    let containerId = null;
    try {
      const containers = await docker.listContainers({ all: true });
      const found = containers.find(c => (c.Names || []).some(n => n.includes('cloudflared')));
      if (found) {
        exists = true;
        state = found.State;
        containerId = found.Id;
        running = found.State === 'running';
      }
    } catch {}
    res.json({
      exists,
      running,
      state,
      containerId,
      dir: cfDir,
      composePath,
      compose: fs.existsSync(composePath) ? fs.readFileSync(composePath, 'utf-8') : '',
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
    const existingCompose = fs.existsSync(composePath) ? fs.readFileSync(composePath, 'utf-8') : '';
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
    const existing = fs.existsSync(composePath) ? fs.readFileSync(composePath, 'utf-8') : '';
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
    const auth = { ...(settings.services?.authentik || {}) };
    if (body.adminEmail !== undefined) auth.adminEmail = String(body.adminEmail || '').trim();
    if (body.adminPassword) auth.adminPassword = String(body.adminPassword);
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
    if (fs.existsSync(composePath)) {
      const compose = fs.readFileSync(composePath, 'utf-8');
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
    const existing = fs.existsSync(composePath) ? fs.readFileSync(composePath, 'utf-8') : '';
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
    const domain = normalizeDomain(body.domain !== undefined ? body.domain : authelia.domain);
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
    const providedPassword = body.adminPassword ? String(body.adminPassword) : '';
    if (providedPassword) authelia.adminPassword = providedPassword;
    if (!authelia.adminPassword) authelia.adminPassword = randomSecret(12);
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
    if (fs.existsSync(composePath)) {
      let compose = fs.readFileSync(composePath, 'utf-8');
      const coreHostDir = await selfMountSource('/app/core');
      if (coreHostDir) {
        compose = setMountSource(compose, '/config', path.join(coreHostDir, 'authelia', 'config'));
      }
      compose = setComposeServiceEnv(compose, 'authelia', {
        VIRTUAL_HOST: domain,
        VIRTUAL_PORT: domain ? '9091' : ''
      });
      writePrivateFile(composePath, compose);
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
    try { await syncAuthVhosts(); } catch {}
    const applied = results.filter(item => item.ok && !item.already).length;
    const already = results.filter(item => item.already).length;
    const failed = results.filter(item => !item.ok && !item.skipped);
    // ENABLE_AUTH only produces nginx forward-auth configs once Authelia has a
    // portal domain. Tell the user instead of leaving them with a silent no-op.
    const authelia = autheliaDefaults(readSettings().services?.authelia || {});
    const portalReady = !!normalizeDomain(authelia.domain);
    const suffix = applied && !portalReady ? ' Set the Authelia portal domain in Core Services to activate the protection.' : '';
    res.json({
      ok: failed.length === 0,
      applied,
      already,
      failed: failed.length,
      results,
      message: applied
        ? `Enabled auth on ${applied} container${applied === 1 ? '' : 's'}.${suffix}`
        : already ? 'Those containers already have auth enabled.' : 'No containers were changed.'
    });
  } catch (e) {
    res.status(500).json({ error: e.message, stdout: e.stdout, stderr: e.stderr });
  }
});

// Core services - Technitium DNS
app.get('/api/core/dns', async (req, res) => {
  try {
    const settings = readSettings();
    const dir = path.join(coreDir, 'dns');
    const composePath = path.join(dir, 'docker-compose.yml');
    const dnsSettings = { ...(settings.services?.technitium || {}) };
    if (!dnsSettings.adminPassword) dnsSettings.adminPassword = randomSecret(12);
    const existing = fs.existsSync(composePath) ? fs.readFileSync(composePath, 'utf-8') : '';
    const coreHostDir = await selfMountSource('/app/core');
    const compose = existing.trim() ? existing : technitiumCompose(dnsSettings, coreHostDir ? path.join(coreHostDir, 'dns') : '');
    const status = await coreServiceStatus('technitium', { nameHint: 'technitium-dns', primaryHint: 'technitium-dns' });
    res.json({
      ...status,
      dir,
      composePath,
      compose,
      settings: redactServiceSecrets('technitium', settings.services?.technitium || {}),
      url: coreServiceUrl(settings.services?.technitium?.domain, settings.services?.technitium?.webPort || 5380)
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
    const dns = { ...(settings.services?.technitium || {}) };
    if (body.adminPassword) dns.adminPassword = String(body.adminPassword);
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
    if (!dns.adminPassword) dns.adminPassword = randomSecret(12);
    dns.enabled = true;
    await ensureNetwork('wicked');
    const composePath = coreServiceFile('dns');
    const coreHostDir = await selfMountSource('/app/core');
    const dnsHostDir = coreHostDir ? path.join(coreHostDir, 'dns') : '';
    prepareHostBindDirs(dnsHostDir, [['config', 0o775]]);
    writePrivateFile(composePath, technitiumCompose(dns, dnsHostDir));
    const { stdout, stderr } = await run('docker', ['compose', '-f', composePath, '-p', 'technitium', 'up', '-d', '--remove-orphans'], { cwd: coreServiceDir('dns') });
    settings.services = settings.services || {};
    settings.services.technitium = dns;
    writeSettings(settings);
    res.json({ ok: true, stdout, stderr, message: `Technitium DNS is starting. Open ${coreServiceUrl(dns.domain, dns.webPort)} to finish setup.`, url: coreServiceUrl(dns.domain, dns.webPort) });
  } catch (e) {
    res.status(500).json({ error: e.message, stdout: e.stdout, stderr: e.stderr });
  }
});

app.post('/api/core/dns/domain', async (req, res) => {
  try {
    const settings = readSettings();
    const dns = { ...(settings.services?.technitium || {}) };
    const domain = normalizeDomain(req.body?.domain);
    if (domain && !/^[A-Za-z0-9*][A-Za-z0-9*._-]*$/.test(domain)) {
      return res.status(400).json({ error: 'Invalid domain name' });
    }
    dns.domain = domain;
    settings.services = settings.services || {};
    settings.services.technitium = dns;
    writeSettings(settings);
    const dir = coreServiceDir('dns');
    const composePath = path.join(dir, 'docker-compose.yml');
    const status = await coreServiceStatus('technitium', { nameHint: 'technitium-dns', primaryHint: 'technitium-dns' });
    let stdout = '';
    let stderr = '';
    if (fs.existsSync(composePath)) {
      const compose = fs.readFileSync(composePath, 'utf-8');
      writePrivateFile(composePath, setComposeServiceEnv(compose, 'technitium-dns', {
        VIRTUAL_HOST: domain,
        VIRTUAL_PORT: domain ? '5380' : ''
      }));
      if (status.running) {
        ({ stdout, stderr } = await run('docker', ['compose', '-f', composePath, '-p', 'technitium', 'up', '-d', '--remove-orphans'], { cwd: dir }));
      }
    }
    res.json({ ok: true, domain, restarted: status.running, url: coreServiceUrl(domain, dns.webPort || 5380), stdout, stderr });
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
    const existing = fs.existsSync(composePath) ? fs.readFileSync(composePath, 'utf-8') : '';
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

function scheduleTerminalCleanup(session) {
  clearTimeout(session.cleanupTimer);
  session.cleanupTimer = setTimeout(() => {
    if (!terminalSessions.has(session.id)) return;
    if (session.clients.size) return;
    if (Date.now() - session.lastActivity < TERMINAL_IDLE_MS) return;
    stopTerminalSession(session.id);
  }, 60000);
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
    title: session.title,
    cwd: session.cwd,
    pid: session.pty.pid,
    createdAt: session.createdAt,
    clients: session.clients.size,
    exited: session.exited,
    exitCode: session.exitCode
  };
}

async function createTerminalSession({ mode = 'admin', app = 'shell' } = {}) {
  if (!TERMINAL_MODES[mode]) throw httpError(400, 'Unknown terminal mode');
  if (!['shell', 'opencode'].includes(app)) throw httpError(400, 'Unknown terminal application');
  if (terminalSessions.size >= OPENCODE_MAX_SESSIONS) {
    throw httpError(429, `Too many terminal sessions are open (max ${OPENCODE_MAX_SESSIONS}). Stop one first.`);
  }

  const settings = readSettings();
  let binary = '/bin/bash';
  let args = ['-i'];
  let cwd = mode === 'user' ? appsDir : root;
  let version = '';

  if (app === 'opencode') {
    const info = await getOpencodeInfo();
    if (!info.installed) {
      throw httpError(503, 'OpenCode is not installed in this container. Rebuild the WickedAFDok image with the bundled OpenCode runtime, then try again.');
    }
    writeOpencodeConfigs(settings);
    binary = info.path;
    args = ['--agent', mode];
    version = info.version;
  }

  fs.mkdirSync(cwd, { recursive: true });
  const id = `term_${crypto.randomBytes(12).toString('hex')}`;
  const title = app === 'opencode' ? `OpenCode · ${TERMINAL_MODES[mode].label}` : `Terminal · ${TERMINAL_MODES[mode].label}`;
  const session = {
    id,
    mode,
    app,
    title,
    cwd,
    version,
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
    session.buffer.push(data);
    session.bufferBytes += Buffer.byteLength(data);
    while (session.bufferBytes > TERMINAL_BUFFER_LIMIT && session.buffer.length > 1) {
      const removed = session.buffer.shift();
      session.bufferBytes -= Buffer.byteLength(removed);
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

app.get('/api/core/opencode', async (req, res) => {
  try {
    const settings = readSettings();
    const info = await getOpencodeInfo();
    const service = settings.services?.opencode || {};
    const sessions = Array.from(terminalSessions.values())
      .filter(session => session.app === 'opencode')
      .map(terminalSessionSummary);
    res.json({
      installed: info.installed,
      version: info.version,
      running: sessions.length > 0,
      sessions,
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

app.post('/api/core/opencode/stop', (req, res) => {
  const stopped = stopAllTerminalSessions(session => session.app === 'opencode');
  res.json({ ok: true, stopped });
});

// Core services - shared actions
app.post('/api/core/all/:action(start|stop|restart)', async (req, res) => {
  try {
    const action = req.params.action === 'start' ? 'up' : req.params.action;
    const services = ['nginx-proxy', 'cloudflared', 'auth', 'authelia', 'dns', 'host-helper'];
    const results = [];
    for (const service of services) {
      const map = { 'nginx-proxy': 'nginx-proxy', cloudflared: 'cloudflared', auth: 'auth', authelia: 'authelia', dns: 'dns', 'host-helper': 'host-helper' };
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
  const core = ['nginx-proxy', 'cloudflared', 'auth', 'authelia', 'dns', 'host-helper'].filter(service => {
    const map = { 'nginx-proxy': 'nginx-proxy', cloudflared: 'cloudflared', auth: 'auth', authelia: 'authelia', dns: 'dns', 'host-helper': 'host-helper' };
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
      dns: { dir: 'dns', project: 'technitium' },
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

const server = http.createServer(app);
const terminalWss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

server.on('upgrade', (req, socket, head) => {
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
  const origin = req.headers.origin;
  if (origin) {
    try {
      const originUrl = new URL(origin);
      const forwarded = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
      const host = forwarded || String(req.headers.host || '').trim();
      if (host && originUrl.host !== host) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
    } catch {
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
});

terminalWss.on('connection', (ws, req, session) => {
  if (!session || !terminalSessions.has(session.id)) {
    try { ws.close(4404, 'session not found'); } catch {}
    return;
  }
  session.lastActivity = Date.now();

  try {
    ws.send(JSON.stringify({
      type: 'ready',
      session: terminalSessionSummary(session),
      modes: TERMINAL_MODES
    }));
    for (const chunk of session.buffer) ws.send(JSON.stringify({ type: 'output', data: chunk }));
    if (session.exited) ws.send(JSON.stringify({ type: 'exit', code: session.exitCode }));
  } catch {}

  session.clients.add(ws);

  ws.on('message', (raw, isBinary) => {
    session.lastActivity = Date.now();
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
    scheduleTerminalCleanup(session);
  });

  ws.on('error', () => {
    session.clients.delete(ws);
  });
});

// Encrypt legacy plaintext secrets on first start and keep settings normalized.
try {
  writeSettings(readSettings());
} catch (e) {
  appendServerLog('WARN', `settings secret migration failed: ${e.message}`);
}

// Ship editable error-page templates with every installation. Existing user
// edits are left untouched.
try {
  ensureNginxErrorPages();
} catch (e) {
  appendServerLog('WARN', `nginx error page preparation failed: ${e.message}`);
}

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
    server.close(() => process.exit(0));
    const timer = setTimeout(() => process.exit(0), 2500);
    if (timer.unref) timer.unref();
  });
}
