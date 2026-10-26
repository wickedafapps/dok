import http from 'http';
import fs from 'fs';
import path from 'path';

const socketPath = process.env.HOST_AGENT_SOCKET || '/app/data/host-helper/agent.sock';
const hostRoot = path.resolve(process.env.HOST_ROOT || '/host');
const tokenEnv = String(process.env.HOST_AGENT_TOKEN || '').trim();

function readToken() {
  if (tokenEnv) return tokenEnv;
  try {
    return fs.readFileSync(process.env.HOST_AGENT_TOKEN_FILE || '/app/data/host-helper/token', 'utf-8').trim();
  } catch {
    return '';
  }
}

const token = readToken();

function log(message) {
  process.stdout.write(`${new Date().toISOString()} [host-helper] ${message}\n`);
}

function insideHostRoot(target) {
  const resolved = path.resolve(hostRoot, '.' + path.sep + target.replace(/^[/\\]+/, ''));
  return resolved === hostRoot || resolved.startsWith(hostRoot + path.sep);
}

function realPathInsideHostRoot(target) {
  const realHost = fs.realpathSync(hostRoot);
  let ancestor = path.dirname(target);
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) return false;
    ancestor = parent;
  }
  let realAncestor;
  try { realAncestor = fs.realpathSync(ancestor); } catch { return false; }
  if (realAncestor !== realHost && !realAncestor.startsWith(realHost + path.sep)) return false;
  if (fs.existsSync(target)) {
    const realTarget = fs.realpathSync(target);
    if (realTarget !== realHost && !realTarget.startsWith(realHost + path.sep)) return false;
  }
  return true;
}

function respond(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function readBody(req, limit = 1024 * 64) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf-8')) : {});
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function authorized(req) {
  if (!token) return false;
  const header = String(req.headers.authorization || '');
  return header === `Bearer ${token}`;
}

async function handle(req, res) {
  if (req.method === 'GET' && req.url === '/ping') {
    return respond(res, 200, { ok: true, hostRoot });
  }
  if (!authorized(req)) return respond(res, 401, { error: 'Unauthorized' });

  if (req.method === 'POST' && req.url === '/mkdir') {
    const body = await readBody(req);
    const requested = String(body.path || '').trim();
    if (!requested || !path.isAbsolute(requested)) {
      return respond(res, 400, { error: 'An absolute host path is required' });
    }
    if (!insideHostRoot(requested)) {
      return respond(res, 400, { error: 'Path escapes the host root' });
    }
    if (/[\0\r\n]/.test(requested)) {
      return respond(res, 400, { error: 'Invalid path' });
    }
    const target = path.resolve(hostRoot, '.' + path.sep + requested.replace(/^[/\\]+/, ''));
    try {
      if (!realPathInsideHostRoot(target)) {
        return respond(res, 400, { error: 'Resolved path escapes the host root' });
      }
      fs.mkdirSync(target, { recursive: true });
      const real = fs.realpathSync(target);
      const realHost = fs.realpathSync(hostRoot);
      if (real !== realHost && !real.startsWith(realHost + path.sep)) {
        return respond(res, 400, { error: 'Resolved path escapes the host root' });
      }
      if (Number.isInteger(body.uid) && Number.isInteger(body.gid)) {
        try { fs.chownSync(target, body.uid, body.gid); } catch {}
      }
      const mode = Number.isInteger(body.mode) ? body.mode : 0o775;
      try { fs.chmodSync(target, mode); } catch {}
      log(`created ${real}`);
      return respond(res, 200, { ok: true, path: requested });
    } catch (e) {
      return respond(res, 500, { error: e.message });
    }
  }

  if (req.method === 'POST' && req.url === '/stat') {
    const body = await readBody(req);
    const requested = String(body.path || '').trim();
    if (!requested || !path.isAbsolute(requested) || !insideHostRoot(requested)) {
      return respond(res, 400, { error: 'An absolute host path inside the host root is required' });
    }
    const target = path.resolve(hostRoot, '.' + path.sep + requested.replace(/^[/\\]+/, ''));
    if (!realPathInsideHostRoot(target)) {
      return respond(res, 400, { error: 'Resolved path escapes the host root' });
    }
    try {
      const stat = fs.statSync(target);
      return respond(res, 200, {
        ok: true,
        exists: true,
        isDirectory: stat.isDirectory(),
        uid: stat.uid,
        gid: stat.gid,
        mode: stat.mode
      });
    } catch {
      return respond(res, 200, { ok: true, exists: false });
    }
  }

  return respond(res, 404, { error: 'Not found' });
}

fs.mkdirSync(path.dirname(socketPath), { recursive: true });
try { fs.unlinkSync(socketPath); } catch {}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => respond(res, 500, { error: e.message }));
});

server.listen(socketPath, () => {
  try { fs.chmodSync(socketPath, 0o666); } catch {}
  try { fs.chmodSync(path.dirname(socketPath), 0o777); } catch {}
  log(`listening on ${socketPath} (host root ${hostRoot})`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
