#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (name) => {
  const index = argv.indexOf(name);
  return index >= 0;
};
const option = (name, fallback = '') => {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  return argv[index + 1] ?? fallback;
};

const name = String(option('--name') || '').trim();
if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
  console.error('Usage: node /app/server/assist-register.mjs --name <app> [--dir /app/apps/<app>] [--compose <file>] [--launch] [--confirm-amend] [--vhost <host>] [--vhost-port <port>] [--network <name>]');
  process.exit(2);
}

const dir = path.resolve(option('--dir', path.join('/app/apps', name)));
const composePath = path.resolve(option('--compose', path.join(dir, 'docker-compose.yml')));
if (!fs.existsSync(composePath)) {
  console.error(`Compose file not found: ${composePath}`);
  process.exit(2);
}
const compose = fs.readFileSync(composePath, 'utf8');
if (!compose.trim()) {
  console.error(`Compose file is empty: ${composePath}`);
  process.exit(2);
}

const payload = {
  type: 'compose',
  appName: name,
  appDir: dir,
  compose,
  launchNow: flag('--launch') && !flag('--no-launch'),
  overwrite: true,
  force: flag('--force'),
  confirmAmend: flag('--confirm-amend'),
  network: option('--network'),
  vhost: option('--vhost'),
  vhostPort: option('--vhost-port'),
  ports: option('--ports'),
  vhostTouched: !!option('--vhost')
};

const port = process.env.WICKEDAFDOK_PORT || process.env.PORT || '8080';
const response = await fetch(`http://127.0.0.1:${port}/api/launch/finalize`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload)
});
const text = await response.text();
let body = null;
try { body = JSON.parse(text); } catch { body = { error: text }; }
if (!response.ok) {
  console.error(JSON.stringify(body, null, 2));
  process.exit(1);
}
console.log(JSON.stringify(body, null, 2));
