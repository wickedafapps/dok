const qs = (sel) => document.querySelector(sel);
const qsa = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  containers: [],
  images: [],
  sourceRel: '.',
  lastProject: null,
  logsTimer: null,
  logsContainer: null,
  coreNginxRunning: false,
  coreNginxInstalled: null,
  groups: [],
  editingGroup: null,
  registries: [],
  editingRegistry: null
};

const ICONS = {
  cpu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/></svg>',
  ram: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 8h18v8H3z"/><path d="M7 16v2M12 16v2M17 16v2M7 8V6M12 8V6M17 8V6"/></svg>',
  disk: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 8h18v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z"/><path d="M3 8 5 3h14l2 5"/></svg>',
  layers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m12 2 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/></svg>',
  server: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v5h6"/></svg>'
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[ch]);
}

async function api(url, opts = {}) {
  let res;
  try {
    res = await fetch(url, opts);
  } catch {
    // Fetch rejects only for connection-level failures (server restart, DNS,
    // proxy drop). Say what the user can do instead of surfacing the browser's
    // opaque "network error".
    throw new Error('The server did not respond. Check that WickedAFDok is running, then reload the page.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || res.statusText || 'Request failed');
    err.stdout = data.stdout;
    err.stderr = data.stderr;
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function jsonBody(body) {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function fmtBytes(bytes, digits = 1) {
  if (bytes === null || bytes === undefined) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes);
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value.toFixed(i === 0 ? 0 : digits)} ${units[i]}`;
}

function fmtUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function toast(message, isError = false, duration = 3800) {
  const el = qs('#toast');
  el.textContent = message;
  el.className = 'toast' + (isError ? ' error' : '');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add('hidden'), duration);
}

async function waitForReconnect(maxMs = 90000, initialDelay = 10000) {
  await new Promise(r => setTimeout(r, initialDelay));
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    await new Promise(r => setTimeout(r, 3000));
    try {
      const res = await fetch('/api/health', { cache: 'no-store' });
      if (res.ok) {
        location.reload();
        return;
      }
    } catch {
      // keep waiting
    }
  }
}

function setLoading(btn, loading, label) {
  if (!btn) return;
  if (loading) {
    if (!btn.classList.contains('loading')) btn.dataset.label = btn.textContent.trim();
    btn.disabled = true;
    btn.classList.add('loading');
    btn.innerHTML = `<span class="spinner"></span>${escapeHtml(label || 'Working…')}`;
  } else {
    btn.disabled = false;
    btn.classList.remove('loading');
    btn.textContent = label || btn.dataset.label || 'Done';
  }
}

function showOutput(el, text, isError = false) {
  el.classList.remove('hidden');
  el.style.borderColor = isError ? 'rgba(255,95,86,0.4)' : '';
  el.textContent = text;
}

function openTab(name) {
  if (name === 'launch' || name === 'registry') name = name === 'launch' ? 'appcreation' : 'apps';
  qsa('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  qsa('.tab-pane').forEach(p => p.classList.toggle('active', p.id === `tab-${name}`));
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (name === 'containers') loadContainers();
  if (name === 'images') loadImages();
  if (name === 'dashboard') { loadStats(); loadDashboardCoreServices(); }
  if (name === 'sources') loadSources(state.sourceRel);
  if (name === 'apps') loadApps();
  if (name === 'appcreation') { checkAppCreationNginxNotice(); loadAssistSessions(); }
}

qsa('.tab-btn').forEach(btn => btn.addEventListener('click', () => {
  openTab(btn.dataset.tab);
  if (btn.dataset.tab === 'settings') { loadSettings(); checkAppCreationNginxNotice(); }
  if (btn.dataset.tab === 'appcreation') checkAppCreationNginxNotice();
}));

qsa('.subtab-btn[data-subtab]').forEach(btn => {
  btn.addEventListener('click', () => {
    qsa('.subtab-btn[data-subtab]').forEach(b => b.classList.toggle('active', b === btn));
    qsa('.subtab-pane').forEach(p => p.classList.toggle('active', p.id === `subtab-${btn.dataset.subtab}`));
  });
});

// ---------------- Dashboard ----------------
function statCard({ label, value, sub, icon, percent = null, color = '' }) {
  const bar = percent === null ? '' : `
    <div class="bar"><div class="bar-fill ${color}" style="width:${Math.max(0, Math.min(100, percent)).toFixed(1)}%"></div></div>`;
  return `
    <div class="stat-card">
      <div class="stat-head">
        <span class="stat-label">${escapeHtml(label)}</span>
        <span class="stat-icon">${icon}</span>
      </div>
      <div class="stat-value">${value}</div>
      <div class="stat-sub">${escapeHtml(sub || '')}</div>
      ${bar}
    </div>`;
}

function usageColor(percent) {
  if (percent >= 90) return 'danger';
  if (percent >= 75) return 'warn';
  return '';
}

async function loadStats() {
  try {
    const data = await api('/api/system/stats');
    const mem = data.memory;
    const disk = data.disk;
    const d = data.docker || {};

    qs('#statsGrid').innerHTML = [
      statCard({
        label: 'CPU Usage', icon: ICONS.cpu,
        value: data.cpuPercent === null ? `${data.cpus} cores` : `${data.cpuPercent.toFixed(0)}<small>%</small>`,
        sub: `${data.cpus} × ${data.cpuModel.split('@')[0].trim()}`,
        percent: data.cpuPercent,
        color: data.cpuPercent !== null ? usageColor(data.cpuPercent) : ''
      }),
      statCard({
        label: 'Memory', icon: ICONS.ram,
        value: `${fmtBytes(mem.used)} <small>/ ${fmtBytes(mem.total)}</small>`,
        sub: `${(mem.usedPercent).toFixed(1)}% used · ${fmtBytes(mem.free)} free`,
        percent: mem.usedPercent,
        color: usageColor(mem.usedPercent)
      }),
      statCard({
        label: 'Disk', icon: ICONS.disk,
        value: disk ? `${fmtBytes(disk.used)} <small>/ ${fmtBytes(disk.total)}</small>` : '—',
        sub: disk ? `${disk.usedPercent.toFixed(1)}% used on /data` : 'Disk info unavailable',
        percent: disk ? disk.usedPercent : null,
        color: disk ? usageColor(disk.usedPercent) : ''
      }),
      statCard({
        label: 'Containers', icon: ICONS.box,
        value: `${d.connected ? d.containersRunning : '—'} <small>running</small>`,
        sub: d.connected ? `${d.containersStopped} stopped · ${d.containersTotal} total` : 'Docker unavailable',
        percent: d.connected && d.containersTotal ? (d.containersRunning / d.containersTotal) * 100 : null,
        color: 'cyan'
      }),
      statCard({
        label: 'Images', icon: ICONS.layers,
        value: d.connected ? String(d.images) : '—',
        sub: 'Local Docker images'
      }),
      statCard({
        label: 'Uptime', icon: ICONS.clock,
        value: fmtUptime(data.uptime),
        sub: `Kernel ${data.release}`
      })
    ].join('');

    qs('#hostLine').textContent = `${data.hostname} · ${data.platform}/${data.arch} · load ${data.loadavg.map(n => n.toFixed(2)).join(' / ')}`;
    qs('#containerCount').textContent = d.connected ? d.containersRunning : '';
    qs('#imageCount').textContent = d.connected ? d.images : '';

    const conn = qs('#connStatus');
    conn.className = 'conn-status ' + (d.connected ? 'online' : 'offline');
    qs('.conn-text').textContent = d.connected ? `Docker ${d.version}` : 'Docker offline';

    qs('#dockerSummary').innerHTML = d.connected ? [
      ['Engine', d.version],
      ['Storage driver', d.storageDriver],
      ['Running', d.containersRunning],
      ['Stopped', d.containersStopped],
      ['Images', d.images],
      ['Host memory', fmtBytes(d.memoryLimit)]
    ].map(([k, v]) => `<div class="kv-row"><span class="kv-key">${k}</span><span class="kv-val">${escapeHtml(v)}</span></div>`).join('')
      : `<div class="kv-row"><span class="kv-key">Error</span><span class="kv-val">${escapeHtml(d.error || 'not connected')}</span></div>`;

    const nets = [];
    for (const [name, addrs] of Object.entries(data.networkInterfaces || {})) {
      for (const addr of addrs || []) {
        if (addr.family === 'IPv4' && !addr.internal) nets.push([name, addr.address]);
      }
    }
    qs('#networkSummary').innerHTML = nets.length
      ? nets.map(([k, v]) => `<div class="kv-row"><span class="kv-key">${escapeHtml(k)}</span><span class="kv-val">${escapeHtml(v)}</span></div>`).join('')
      : '<div class="kv-row"><span class="kv-key">Interfaces</span><span class="kv-val">none</span></div>';

    const { networkInterfaces, ...raw } = data;
    qs('#statsDetail').textContent = JSON.stringify(raw, null, 2);
    return data;
  } catch (e) {
    qs('#connStatus').className = 'conn-status offline';
    qs('.conn-text').textContent = 'Server offline';
    qs('#statsGrid').innerHTML = `<div class="empty">Unable to load stats: ${escapeHtml(e.message)}</div>`;
    return null;
  }
}

qs('#refreshStats').addEventListener('click', loadStats);

async function loadDashboardCoreServices() {
  const list = qs('#dashboardCoreLinks');
  if (!list) return;
  try {
    const data = await api('/api/core/dashboard');
    const services = Array.isArray(data.services) ? data.services : [];
    if (!services.length) {
      list.innerHTML = `<div class="empty">${data.lookupFailed
        ? 'Core service status is temporarily unavailable. Docker may still be starting.'
        : 'No core services with a web console are installed yet.'}</div>`;
      return;
    }
    list.innerHTML = services.map(service => `
      <div class="item">
        <div class="item-header">
          <div>
            <div class="item-title">${escapeHtml(service.label)} ${stateChip(service.state)}</div>
            <div class="item-sub mono">${escapeHtml(service.url)}</div>
          </div>
          <div class="item-actions">
            <button class="btn ${service.running ? 'btn-primary' : ''}" data-core-console="${escapeHtml(service.url)}"
              ${service.running ? '' : 'disabled title="Start this service first"'}>Open GUI</button>
          </div>
        </div>
      </div>`).join('');
    list.querySelectorAll('[data-core-console]').forEach(btn => {
      btn.addEventListener('click', () => window.open(btn.dataset.coreConsole, '_blank', 'noopener'));
    });
  } catch (e) {
    list.innerHTML = `<div class="empty">Unable to load core services: ${escapeHtml(e.message)}</div>`;
  }
}

qs('#dashboardCoreRefresh')?.addEventListener('click', loadDashboardCoreServices);

// ---------------- Containers ----------------
function containerPorts(ports) {
  return (ports || []).map(p => {
    const label = p.PublicPort ? `${p.PublicPort}→${p.PrivatePort}/${p.Type}` : `${p.PrivatePort}/${p.Type}`;
    return `<span class="port">${escapeHtml(label)}</span>`;
  }).join('');
}

function stateChip(state) {
  const map = { running: 'running', exited: 'exited', paused: 'paused', created: 'stopped', restarting: 'paused', dead: 'exited' };
  return `<span class="chip ${map[state] || 'stopped'}">${escapeHtml(state)}</span>`;
}

async function loadContainers() {
  const list = qs('#containersList');
  if (!state.containers.length) list.innerHTML = '<div class="empty">Loading containers…</div>';
  try {
    state.containers = await api('/api/containers');
    renderContainers();
  } catch (e) {
    list.innerHTML = `<div class="empty">Unable to load containers: ${escapeHtml(e.message)}</div>`;
  }
}

function containerItemHtml(c) {
  const paused = c.state === 'paused';
  const running = c.state === 'running' || paused;
  return `
    <div class="item" data-id="${escapeHtml(c.id)}">
      <div class="item-header">
        <div>
          <div class="item-title">${escapeHtml(c.name || c.shortId)} ${stateChip(c.state)}
            ${c.core ? badge('Core service', 'type') : ''}${c.protected && !c.core ? badge('Protected', 'type') : ''}
          </div>
          <div class="item-sub">${escapeHtml(c.image)} · ${escapeHtml(c.status)}</div>
          <div class="item-sub mono">${escapeHtml(c.shortId)}</div>
          ${containerPorts(c.ports) ? `<div class="ports">${containerPorts(c.ports)}</div>` : ''}
        </div>
        <div class="item-actions">
          ${running ? `<button class="btn" data-act="stop">Stop</button>` : `<button class="btn" data-act="start">Start</button>`}
          <button class="btn" data-act="restart">Restart</button>
          ${running ? `<button class="btn" data-act="${paused ? 'unpause' : 'pause'}">${paused ? 'Resume' : 'Pause'}</button>` : ''}
          <button class="btn" data-act="logs">Logs</button>
          <button class="btn" data-act="exec">Exec</button>
          ${c.core ? '' : `<button class="btn" data-act="update-check">Update</button>
          <button class="btn" data-act="save-reg">Save to Apps</button>`}
          ${c.protected
            ? `<button class="btn btn-danger" data-act="remove" title="Protected container">Remove…</button>`
            : `<button class="btn btn-danger" data-act="remove">Remove</button>`}
        </div>
      </div>
    </div>`;
}

function renderContainers() {
  const list = qs('#containersList');
  const query = (qs('#containerSearch').value || '').trim().toLowerCase();
  const items = state.containers.filter(c =>
    !query || c.name.toLowerCase().includes(query) || c.image.toLowerCase().includes(query) || c.state.includes(query)
  );
  if (!state.containers.length) {
    list.innerHTML = '<div class="empty">No containers found on this Docker engine.</div>';
    return;
  }
  if (!items.length) {
    list.innerHTML = '<div class="empty">No containers match that filter.</div>';
    return;
  }
  const coreItems = items.filter(c => c.core);
  const workloadItems = items.filter(c => !c.core);
  list.innerHTML = `
    ${coreItems.length ? `<div class="section-heading"><h3>Core Services</h3><span class="muted">Managed by WickedAFDok · protected</span></div>${coreItems.map(containerItemHtml).join('')}` : ''}
    ${workloadItems.length ? `<div class="section-heading"><h3>Workloads</h3><span class="muted">${workloadItems.length} container${workloadItems.length === 1 ? '' : 's'}</span></div>${workloadItems.map(containerItemHtml).join('')}` : ''}
  `;

  list.querySelectorAll('.item').forEach(item => {
    const id = item.dataset.id;
    const container = state.containers.find(c => c.id === id);
    item.querySelectorAll('button[data-act]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const act = btn.dataset.act;
        if (act === 'logs') return openLogs(container);
        let removeBody = null;
        if (act === 'remove') {
          if (container.protected) {
            const typed = prompt(`"${container.name}" is protected. Type the container name to confirm removal:`);
            if (typed !== container.name) {
              if (typed !== null) toast('Removal cancelled: the name did not match', true);
              return;
            }
            removeBody = {
              method: 'DELETE',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ confirmName: container.name })
            };
          } else if (!confirm(`Remove container "${container.name}"? This cannot be undone.`)) {
            return;
          }
        }
        if (act === 'stop' && !confirm(`Stop container "${container.name}"?`)) return;
        if (act === 'exec') {
          const c = prompt('Command to run inside container (e.g. sh, /bin/bash, ls -la /)', 'sh');
          if (!c) return;
          try {
            const res = await api(`/api/containers/${encodeURIComponent(id)}/exec`, jsonBody({ cmd: c }));
            alert((res.stdout || '') + (res.stderr || '') || 'Done');
          } catch (e) {
            alert(e.message);
          }
          return;
        }
        if (act === 'save-reg') {
          try {
            await api(`/api/containers/${encodeURIComponent(id)}/save-to-registry`, { method: 'POST' });
            toast('Saved to Apps');
            if (qs('#tab-apps').classList.contains('active')) loadApps();
          } catch (e) {
            toast(e.message, true);
          }
          return;
        }
        if (act === 'update-check') {
          setLoading(btn, true, 'Checking…');
          try {
            const info = await api(`/api/containers/${encodeURIComponent(id)}/inspect`);
            await api(`/api/containers/${encodeURIComponent(id)}/update-check`, { method: 'POST' });
            if (confirm(`Pulled latest ${container.image}. Redeploy with the same configuration?`)) {
              const currentEnv = info.Config?.Env || [];
              const env = prompt('Edit env (comma separated KEY=VAL, leave empty to keep)', currentEnv.join(','));
              await api(`/api/containers/${encodeURIComponent(id)}/redeploy`, jsonBody({
                image: container.image,
                env: env === null ? currentEnv : (env ? env.split(',').map(s => s.trim()).filter(Boolean) : currentEnv),
                ports: info.HostConfig?.PortBindings || {},
                restart: info.HostConfig?.RestartPolicy?.Name || 'unless-stopped',
                network: info.HostConfig?.NetworkMode || ''
              }));
              toast('Redeployed');
            }
            await loadContainers();
            loadStats();
          } catch (e) {
            toast(e.message, true);
          } finally {
            setLoading(btn, false, 'Update');
          }
          return;
        }
        setLoading(btn, true);
        try {
          if (act === 'remove') {
            await api(`/api/containers/${encodeURIComponent(id)}`, removeBody || { method: 'DELETE' });
            toast(`Removed ${container.name}`);
          } else {
            await api(`/api/containers/${encodeURIComponent(id)}/${act}`, { method: 'POST' });
            toast(`${container.name}: ${act} OK`);
          }
          await loadContainers();
          loadStats();
        } catch (e) {
          toast(e.message, true);
          setLoading(btn, false);
        }
      });
    });
  });
}

qs('#containerSearch').addEventListener('input', renderContainers);
qs('#refreshContainers').addEventListener('click', loadContainers);
if (qs('#containersOpenApps')) {
  qs('#containersOpenApps').addEventListener('click', () => openTab('apps'));
}

function openLogs(container) {
  state.logsContainer = container;
  qs('#logsTitle').textContent = `Logs · ${container.name}`;
  qs('#logsAuto').checked = false;
  qs('#logsModal').classList.remove('hidden');
  refreshLogs();
}

async function refreshLogs() {
  const container = state.logsContainer;
  if (!container) return;
  const out = qs('#logsOutput');
  try {
    const data = await api(`/api/containers/${encodeURIComponent(container.id)}/logs?tail=500`);
    if (state.logsContainer !== container) return;
    out.textContent = data.logs || '(no logs)';
    out.scrollTop = out.scrollHeight;
  } catch (e) {
    if (state.logsContainer !== container) return;
    out.textContent = e.message + '\n' + (e.stdout || '');
  }
}

qs('#logsRefreshBtn').addEventListener('click', refreshLogs);
qs('#logsAuto').addEventListener('change', (e) => {
  clearInterval(state.logsTimer);
  state.logsTimer = null;
  if (e.target.checked) state.logsTimer = setInterval(refreshLogs, 3000);
});

function closeModal(id) {
  qs(`#${id}`).classList.add('hidden');
  if (id === 'logsModal') {
    clearInterval(state.logsTimer);
    state.logsTimer = null;
    state.logsContainer = null;
  }
  if (id === 'terminalModal') {
    closeTerminalSession();
  }
  if (id === 'assistChatModal') {
    closeAssistChat();
  }
}

qsa('[data-close]').forEach(el => {
  if (!el._dataCloseBound) {
    el.addEventListener('click', () => closeModal(el.dataset.close));
    el._dataCloseBound = true;
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const open = qsa('.modal:not(.hidden)');
  if (!open.length) return;
  const top = open[open.length - 1];
  // Escape is part of the terminal UI (close a picker, cancel a prompt). Do not
  // let it close the terminal modal and kill the OpenCode session underneath.
  if (top.id === 'terminalModal' && e.target instanceof Element && e.target.closest('#terminalContainer')) return;
  closeModal(top.id);
});

// ---------------- Images ----------------
async function loadImages() {
  const list = qs('#imagesList');
  if (!state.images.length) list.innerHTML = '<div class="empty">Loading images…</div>';
  try {
    state.images = await api('/api/images');
    renderImages();
  } catch (e) {
    list.innerHTML = `<div class="empty">Unable to load images: ${escapeHtml(e.message)}</div>`;
  }
}

function renderImages() {
  const list = qs('#imagesList');
  const query = qs('#imageSearch').value.trim().toLowerCase();
  const items = state.images.filter(img => !query || img.repoTags.join(' ').toLowerCase().includes(query));
  if (!state.images.length) {
    list.innerHTML = '<div class="empty">No images found. Pull one above to get started.</div>';
    return;
  }
  if (!items.length) {
    list.innerHTML = '<div class="empty">No images match that filter.</div>';
    return;
  }
  list.innerHTML = items.map(img => {
    const tags = img.repoTags.filter(t => t !== '<none>:<none>');
    const title = tags.length ? tags.map(escapeHtml).join(' ') : '<span class="muted">untagged</span>';
    return `
      <div class="item" data-id="${escapeHtml(img.id)}">
        <div class="item-header">
          <div>
            <div class="item-title">${title}</div>
            <div class="item-sub mono">${escapeHtml(img.shortId)} · ${fmtBytes(img.size)} · ${new Date(img.created * 1000).toLocaleString()}</div>
          </div>
          <div class="item-actions">
            ${tags.length ? `<button class="btn" data-act="run">Run</button>` : ''}
            <button class="btn btn-danger" data-act="remove">Remove</button>
          </div>
        </div>
      </div>`;
  }).join('');

  list.querySelectorAll('.item').forEach(item => {
    const img = state.images.find(i => i.id === item.dataset.id);
    item.querySelectorAll('button[data-act]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (btn.dataset.act === 'run') {
          const tag = img.repoTags.find(t => t !== '<none>:<none>') || img.repoTags[0];
          const name = tag.split('/').pop().replace(/[:@].*$/, '').replace(/[^a-zA-Z0-9_.-]/g, '-');
          qs('#runCmd').value = `docker run -d --name ${name} ${tag}`;
          qs('#runName').value = name;
          openTab('appcreation');
          qsa('.subtab-btn').forEach(b => b.classList.toggle('active', b.dataset.subtab === 'run'));
          qsa('.subtab-pane').forEach(p => p.classList.toggle('active', p.id === 'subtab-run'));
          qs('#runCmd').focus();
          return;
        }
        if (!confirm('Remove this image? Containers using it must be removed first.')) return;
        setLoading(btn, true);
        try {
          await api('/api/images/remove', jsonBody({ id: img.id }));
          toast('Image removed');
          await loadImages();
          loadStats();
        } catch (e) {
          toast(e.message, true);
          setLoading(btn, false);
        }
      });
    });
  });
}

qs('#imageSearch').addEventListener('input', renderImages);
qs('#refreshImages').addEventListener('click', loadImages);

qs('#pullImageBtn').addEventListener('click', async () => {
  const input = qs('#pullImageInput');
  const image = input.value.trim();
  if (!image) return toast('Enter an image name', true);
  const btn = qs('#pullImageBtn');
  setLoading(btn, true, 'Pulling…');
  const out = qs('#pullOutput');
  showOutput(out, `Pulling ${image}…`);
  try {
    const data = await api('/api/images/pull', jsonBody({ image }));
    showOutput(out, (data.stdout || '') + (data.stderr || '') || `Pulled ${image}`);
    input.value = '';
    toast(`Pulled ${image}`);
    await loadImages();
    loadStats();
  } catch (e) {
    showOutput(out, e.message + '\n' + (e.stderr || e.stdout || ''), true);
    toast(e.message, true);
  } finally {
    setLoading(btn, false, 'Pull image');
  }
});

// ---------------- App Creation ----------------
let pendingAppConfig = null;
let pendingSaveAction = null;
let appCfgOverwritePending = null;
let appCfgNetworks = [];
let appCfgNetworksLoaded = false;
let appCfgBuilderModel = null;
let appCfgBuilderIssues = [];
let appCfgBuilderFieldIssues = [];
let appCfgBuilderLastBuild = null;
let appCfgBuilderLoadSeq = 0;
let appCfgBuilderBuildSeq = 0;
let appCfgBuilderTimer = null;
let appCfgBuilderManual = false;
let appCfgBuilderDirty = false;
let appCfgCompleting = false;

const APP_CFG_FIELD_TYPES = [
  { type: 'image', label: 'Image', input: 'text', placeholder: 'nginx:latest' },
  { type: 'build', label: 'Build context', input: 'text', placeholder: '. or {"context":"."}' },
  { type: 'container_name', label: 'Container name', input: 'text', placeholder: 'my-app' },
  { type: 'restart', label: 'Restart policy', input: 'select', options: ['unless-stopped', 'always', 'on-failure', 'no'] },
  { type: 'command', label: 'Command', input: 'textarea', placeholder: 'One argument per line, or a shell command' },
  { type: 'entrypoint', label: 'Entrypoint', input: 'textarea', placeholder: 'One argument per line' },
  { type: 'ports', label: 'Ports', input: 'textarea', placeholder: '8080:80' },
  { type: 'environment', label: 'Environment', input: 'textarea', placeholder: 'KEY=value' },
  { type: 'env_file', label: 'Env files', input: 'textarea', placeholder: '.env' },
  { type: 'volumes', label: 'Volumes', input: 'textarea', placeholder: './data:/data' },
  { type: 'networks', label: 'Networks', input: 'textarea', placeholder: 'wicked' },
  { type: 'depends_on', label: 'Depends on', input: 'textarea', placeholder: 'db' },
  { type: 'labels', label: 'Labels', input: 'textarea', placeholder: 'traefik.enable=true' },
  { type: 'expose', label: 'Expose', input: 'textarea', placeholder: '80' },
  { type: 'user', label: 'User', input: 'text', placeholder: '1000:1000' },
  { type: 'working_dir', label: 'Working directory', input: 'text', placeholder: '/app' },
  { type: 'hostname', label: 'Hostname', input: 'text', placeholder: 'app' },
  { type: 'domainname', label: 'Domain name', input: 'text', placeholder: 'example.com' },
  { type: 'network_mode', label: 'Network mode', input: 'text', placeholder: 'bridge, host, none, service:…' },
  { type: 'privileged', label: 'Privileged', input: 'boolean' },
  { type: 'init', label: 'Init process', input: 'boolean' },
  { type: 'read_only', label: 'Read-only filesystem', input: 'boolean' },
  { type: 'stdin_open', label: 'Keep stdin open', input: 'boolean' },
  { type: 'tty', label: 'Allocate TTY', input: 'boolean' },
  { type: 'devices', label: 'Devices', input: 'textarea', placeholder: '/dev/dri:/dev/dri' },
  { type: 'cap_add', label: 'Add capabilities', input: 'textarea', placeholder: 'NET_ADMIN' },
  { type: 'cap_drop', label: 'Drop capabilities', input: 'textarea', placeholder: 'ALL' },
  { type: 'security_opt', label: 'Security options', input: 'textarea', placeholder: 'no-new-privileges:true' },
  { type: 'sysctls', label: 'Sysctls', input: 'textarea', placeholder: 'net.ipv4.ip_forward=1' },
  { type: 'extra_hosts', label: 'Extra hosts', input: 'textarea', placeholder: 'host.docker.internal=host-gateway' },
  { type: 'dns', label: 'DNS servers', input: 'textarea', placeholder: '1.1.1.1' },
  { type: 'dns_search', label: 'DNS search domains', input: 'textarea' },
  { type: 'dns_opt', label: 'DNS options', input: 'textarea' },
  { type: 'tmpfs', label: 'Tmpfs mounts', input: 'textarea', placeholder: '/run' },
  { type: 'ulimits', label: 'Ulimits', input: 'json', placeholder: '{"nofile":{"soft":1024,"hard":2048}}' },
  { type: 'healthcheck', label: 'Healthcheck', input: 'json', placeholder: '{"test":["CMD","curl","-f","http://localhost"]}' },
  { type: 'logging', label: 'Logging', input: 'json', placeholder: '{"driver":"json-file","options":{"max-size":"10m"}}' },
  { type: 'deploy', label: 'Deploy', input: 'json', placeholder: '{"replicas":1}' },
  { type: 'mem_limit', label: 'Memory limit', input: 'text', placeholder: '512m' },
  { type: 'mem_reservation', label: 'Memory reservation', input: 'text', placeholder: '256m' },
  { type: 'memswap_limit', label: 'Memory swap limit', input: 'text' },
  { type: 'cpus', label: 'CPUs', input: 'text', placeholder: '1.5' },
  { type: 'cpu_shares', label: 'CPU shares', input: 'text', placeholder: '512' },
  { type: 'cpu_quota', label: 'CPU quota', input: 'text' },
  { type: 'cpu_percent', label: 'CPU percent', input: 'text' },
  { type: 'cpuset', label: 'CPU set', input: 'text', placeholder: '0-1' },
  { type: 'pids_limit', label: 'PIDs limit', input: 'text' },
  { type: 'shm_size', label: 'Shared memory size', input: 'text', placeholder: '64m' },
  { type: 'stop_signal', label: 'Stop signal', input: 'text', placeholder: 'SIGTERM' },
  { type: 'stop_grace_period', label: 'Stop grace period', input: 'text', placeholder: '10s' },
  { type: 'runtime', label: 'Runtime', input: 'text' },
  { type: 'pid', label: 'PID mode', input: 'text', placeholder: 'host' },
  { type: 'ipc', label: 'IPC mode', input: 'text', placeholder: 'host' },
  { type: 'isolation', label: 'Isolation', input: 'text' },
  { type: 'userns_mode', label: 'User namespace mode', input: 'text' },
  { type: 'uts', label: 'UTS mode', input: 'text' },
  { type: 'cgroup_parent', label: 'Cgroup parent', input: 'text' },
  { type: 'cgroup', label: 'Cgroup', input: 'text' },
  { type: 'cgroupns_mode', label: 'Cgroup namespace mode', input: 'text' },
  { type: 'mac_address', label: 'MAC address', input: 'text' },
  { type: 'scale', label: 'Scale', input: 'text' },
  { type: 'mem_swappiness', label: 'Memory swappiness', input: 'text' },
  { type: 'oom_score_adj', label: 'OOM score adjustment', input: 'text' },
  { type: 'oom_kill_disable', label: 'Disable OOM killer', input: 'boolean' },
  { type: 'platform', label: 'Platform', input: 'text', placeholder: 'linux/amd64' },
  { type: 'pull_policy', label: 'Pull policy', input: 'select', options: ['always', 'never', 'missing', 'build'] },
  { type: 'group_add', label: 'Additional groups', input: 'textarea' },
  { type: 'links', label: 'Links', input: 'textarea' },
  { type: 'external_links', label: 'External links', input: 'textarea' },
  { type: 'volumes_from', label: 'Volumes from', input: 'textarea' },
  { type: 'profiles', label: 'Profiles', input: 'textarea' },
  { type: 'annotations', label: 'Annotations', input: 'textarea' },
  { type: 'device_cgroup_rules', label: 'Device cgroup rules', input: 'textarea' },
  { type: 'gpus', label: 'GPUs', input: 'textarea', placeholder: 'all' },
  { type: 'configs', label: 'Configs', input: 'json' },
  { type: 'secrets', label: 'Secrets', input: 'json' },
  { type: 'credential_spec', label: 'Credential spec', input: 'json' },
  { type: 'scalar', label: 'Text (custom key)', input: 'text', keyEditable: true, placeholder: 'value' },
  { type: 'raw', label: 'Custom field (JSON)', input: 'json', keyEditable: true, placeholder: '{"key":"value"}' }
];
const APP_CFG_FIELD_TYPE_MAP = new Map(APP_CFG_FIELD_TYPES.map(item => [item.type, item]));

function setAppCfgBuilderStatus(text, isError = false) {
  const el = qs('#appCfgBuilderStatus');
  if (!el) return;
  el.textContent = text;
  el.style.color = isError ? 'var(--danger)' : '';
}

function normalizeClientBuilderModel(model) {
  const src = model && typeof model === 'object' ? model : {};
  const out = { services: [], networks: [], volumes: [] };
  const services = Array.isArray(src.services) ? src.services : [];
  for (const raw of services) {
    const svc = raw && typeof raw === 'object' ? raw : {};
    const fields = (Array.isArray(svc.fields) ? svc.fields : []).map(field => {
      const item = field && typeof field === 'object' ? field : {};
      const key = String(item.key ?? '').trim();
      const type = String(item.type || (APP_CFG_FIELD_TYPE_MAP.has(key) ? key : 'raw'));
      let value = item.value;
      if (value === undefined || value === null) value = type === 'boolean' ? false : '';
      if (typeof value === 'object') value = JSON.stringify(value, null, 2);
      return { key, type, value };
    });
    const hasBuild = fields.some(field => field.key === 'build' && String(field.value || '').trim());
    if (!fields.some(field => field.key === 'image') && !hasBuild) {
      fields.unshift({ key: 'image', type: 'image', value: '' });
    }
    out.services.push({ name: String(svc.name || ''), fields });
  }
  if (!out.services.length) {
    out.services.push({ name: 'app', fields: [{ key: 'image', type: 'image', value: '' }] });
  }
  out.networks = (Array.isArray(src.networks) ? src.networks : []).map(item => ({
    key: String(item?.key || item?.name || ''),
    external: item?.external === true || item?.external === 'true',
    name: String(item?.name || ''),
    driver: String(item?.driver || ''),
    extra: typeof item?.extra === 'string' ? item.extra : (item?.extra && typeof item.extra === 'object' ? JSON.stringify(item.extra) : '')
  })).filter(item => item.key);
  out.volumes = (Array.isArray(src.volumes) ? src.volumes : []).map(item => ({
    key: String(item?.key || item?.name || ''),
    external: item?.external === true || item?.external === 'true',
    name: String(item?.name || ''),
    driver: String(item?.driver || ''),
    extra: typeof item?.extra === 'string' ? item.extra : (item?.extra && typeof item.extra === 'object' ? JSON.stringify(item.extra) : '')
  })).filter(item => item.key);
  if (src.other !== undefined && src.other !== null) {
    out.other = typeof src.other === 'string' ? src.other : JSON.stringify(src.other, null, 2);
  } else {
    out.other = '';
  }
  return out;
}

const APP_CFG_STATIC_FIELDS = [
  { key: 'image', type: 'image', label: 'Image', input: 'text', placeholder: 'nginx:latest' },
  { key: 'container_name', type: 'container_name', label: 'Container Name', input: 'text', placeholder: 'my-app' },
  { key: 'restart', type: 'restart', label: 'Restart Policy', input: 'select', options: ['unless-stopped', 'always', 'on-failure', 'no'] },
  { key: 'command', type: 'command', label: 'Command', input: 'textarea', placeholder: 'One argument per line, or a shell command' },
  { key: 'entrypoint', type: 'entrypoint', label: 'Entrypoint', input: 'textarea', placeholder: 'One argument per line' }
];
const APP_CFG_LIST_FIELDS = [
  { key: 'ports', type: 'ports', label: 'Ports', placeholder: '8080:80' },
  { key: 'environment', type: 'environment', label: 'Environment', kv: true, placeholder: 'KEY=value' },
  { key: 'volumes', type: 'volumes', label: 'Volumes', placeholder: './data:/data' }
];
const APP_CFG_HIDDEN_FIELDS = new Set(['networks']);
const APP_CFG_STATIC_KEYS = new Set([...APP_CFG_STATIC_FIELDS, ...APP_CFG_LIST_FIELDS].map(def => def.key));

function appCfgRawLines(value) {
  return String(value ?? '').split(/\r?\n/);
}

function appCfgServiceField(service, key, type) {
  let field = service.fields.find(item => item.key === key);
  if (!field) {
    field = { key, type, value: '' };
    service.fields.push(field);
  } else if (field.type === 'raw' || field.type === 'scalar') {
    field.type = type;
  }
  return field;
}

function ensureAppCfgServiceShape(service) {
  for (const def of [...APP_CFG_STATIC_FIELDS, ...APP_CFG_LIST_FIELDS]) {
    const exists = service.fields.find(field => field.key === def.key);
    if (!exists) service.fields.push({ key: def.key, type: def.type, value: '' });
  }
  const rank = new Map([...APP_CFG_STATIC_FIELDS, ...APP_CFG_LIST_FIELDS].map((def, index) => [def.key, index]));
  service.fields.sort((a, b) => (rank.get(a.key) ?? 999) - (rank.get(b.key) ?? 999));
}

function ensureAppCfgBuilderRequired(service) {
  if (!service) return;
  ensureAppCfgServiceShape(service);
}

function appCfgBuilderFieldRequired(service, field) {
  if (field.key !== 'image') return false;
  const hasBuild = service.fields.some(item => item.key === 'build' && String(item.value || '').trim());
  return !hasBuild && !String(field.value ?? '').trim();
}

function refreshAppCfgBuilderRequiredBadges() {
  if (!appCfgBuilderModel) return;
  qsa('#appCfgBuilder .builder-service').forEach(card => {
    const service = appCfgBuilderModel.services[Number(card.dataset.serviceIndex)];
    const row = card.querySelector('[data-builder-key="image"]');
    if (!service || !row) return;
    const field = service.fields.find(item => item.key === 'image');
    const required = field ? appCfgBuilderFieldRequired(service, field) : true;
    const badge = row.querySelector('.builder-required');
    if (required && !badge) {
      row.querySelector('.builder-row-label')?.insertAdjacentHTML('beforeend', ' <span class="builder-required">required</span>');
    } else if (!required && badge) {
      badge.remove();
    }
  });
}

function appCfgBuilderFieldValue(field) {
  const def = APP_CFG_FIELD_TYPE_MAP.get(field.type) || APP_CFG_FIELD_TYPE_MAP.get('raw');
  const value = field.value;
  if (def.input === 'boolean') {
    return `<label class="checkbox"><input type="checkbox" class="builder-value" data-builder-value ${value === true || value === 'true' ? 'checked' : ''}> Enabled</label>`;
  }
  if (def.input === 'select') {
    const options = def.options || [];
    return `<select class="input builder-value" data-builder-value>
      <option value="">Default</option>
      ${options.map(option => `<option value="${escapeHtml(option)}"${String(value) === option ? ' selected' : ''}>${escapeHtml(option)}</option>`).join('')}
      ${value && !options.includes(String(value)) ? `<option value="${escapeHtml(value)}" selected>${escapeHtml(value)}</option>` : ''}
    </select>`;
  }
  if (def.input === 'textarea' || def.input === 'json') {
    return `<textarea class="textarea code builder-value" data-builder-value rows="${def.input === 'json' ? 4 : 3}" spellcheck="false" placeholder="${escapeHtml(def.placeholder || '')}">${escapeHtml(value)}</textarea>`;
  }
  return `<input class="input builder-value" data-builder-value value="${escapeHtml(value)}" placeholder="${escapeHtml(def.placeholder || '')}">`;
}

function appCfgBuilderFieldRow(service, field, serviceIndex, fieldIndex) {
  const def = APP_CFG_FIELD_TYPE_MAP.get(field.type) || APP_CFG_FIELD_TYPE_MAP.get('raw');
  const required = appCfgBuilderFieldRequired(service, field);
  const typeOptions = APP_CFG_FIELD_TYPES.map(item =>
    `<option value="${item.type}"${item.type === field.type ? ' selected' : ''}>${escapeHtml(item.label)}</option>`
  ).join('');
  return `<div class="builder-field" data-field-index="${fieldIndex}">
    <div class="builder-field-name">
      <select class="input builder-field-type" data-field-type aria-label="Field type">${typeOptions}</select>
      <input class="input builder-field-key ${def.keyEditable ? '' : 'hidden'}" data-field-key value="${escapeHtml(field.key)}" placeholder="Field key" aria-label="Field key">
      ${appCfgFieldHelp(field.key, field.key || 'Field')}
      ${required ? '<span class="builder-required">required</span>' : ''}
    </div>
    <div class="builder-field-value">${appCfgBuilderFieldValue(field)}</div>
    <button class="btn btn-danger builder-remove builder-remove-field" type="button" title="Remove field">−</button>
    <div class="builder-field-error hidden" data-field-error></div>
  </div>`;
}

function appCfgFieldHelp(key, label) {
  const help = String(window.DokManual?.helpFor?.(key) || '').trim() ||
    `Sets the ${String(label || key || 'field').toLowerCase()} value for this service.`;
  return `<span class="field-help" tabindex="0" role="img" aria-label="Help: ${escapeHtml(help)}" data-tip="${escapeHtml(help)}" title="${escapeHtml(help)}">?</span>`;
}

function appCfgSection(label, body, helpKey = '') {
  return `<div class="builder-section">
    <div class="builder-section-head"><strong>${escapeHtml(label)}${helpKey ? appCfgFieldHelp(helpKey, label) : ''}</strong></div>
    <div class="builder-section-body">${body}</div>
  </div>`;
}

function appCfgStaticRow(service, def) {
  const field = appCfgServiceField(service, def.key, def.type);
  const required = appCfgBuilderFieldRequired(service, field);
  const value = field.value ?? '';
  let control;
  if (def.input === 'select') {
    const options = def.options || [];
    control = `<select class="input builder-static-input" data-static-key="${def.key}" data-static-type="${def.type}">
      <option value="">Default</option>
      ${options.map(option => `<option value="${escapeHtml(option)}"${String(value) === option ? ' selected' : ''}>${escapeHtml(option)}</option>`).join('')}
      ${value && !options.includes(String(value)) ? `<option value="${escapeHtml(value)}" selected>${escapeHtml(value)}</option>` : ''}
    </select>`;
  } else if (def.input === 'textarea') {
    control = `<textarea class="textarea code builder-static-input" data-static-key="${def.key}" data-static-type="${def.type}" rows="3" spellcheck="false" placeholder="${escapeHtml(def.placeholder || '')}">${escapeHtml(value)}</textarea>`;
  } else {
    control = `<input class="input builder-static-input" data-static-key="${def.key}" data-static-type="${def.type}" value="${escapeHtml(value)}" placeholder="${escapeHtml(def.placeholder || '')}">`;
  }
  return `<div class="builder-row builder-static-row" data-builder-key="${def.key}">
    <label class="builder-row-label">${escapeHtml(def.label)}${required ? ' <span class="builder-required">required</span>' : ''}${appCfgFieldHelp(def.key, def.label)}</label>
    <div class="builder-row-control">${control}</div>
    <div class="builder-field-error hidden" data-field-error></div>
  </div>`;
}

function appCfgListEditor(service, def) {
  const field = appCfgServiceField(service, def.key, def.type);
  const raw = appCfgRawLines(field.value).filter((line, index, all) => line.trim() || all.length === 1);
  let rows;
  if (def.kv) {
    rows = raw.map(line => {
      const idx = line.indexOf('=');
      const key = idx < 0 ? line : line.slice(0, idx);
      const value = idx < 0 ? '' : line.slice(idx + 1);
      return `<div class="builder-kv-row" data-env-row>
        <input class="input" data-env-key value="${escapeHtml(key)}" placeholder="KEY">
        <input class="input" data-env-value value="${escapeHtml(value)}" placeholder="value">
        <button class="btn btn-danger builder-remove-list" data-list-kind="${def.key}" type="button" title="Remove">−</button>
      </div>`;
    }).join('');
  } else {
    rows = raw.map(line => `<div class="builder-list-row" data-list-row>
      <input class="input builder-list-input" data-list-entry value="${escapeHtml(line)}" placeholder="${escapeHtml(def.placeholder || '')}">
      <button class="btn btn-danger builder-remove-list" data-list-kind="${def.key}" type="button" title="Remove">−</button>
    </div>`).join('');
  }
  return `<div class="builder-section builder-list-section" data-builder-list="${def.key}">
    <div class="builder-section-head">
      <strong>${escapeHtml(def.label)}${appCfgFieldHelp(def.key, def.label)}</strong>
      <button class="btn builder-add-list" data-list-kind="${def.key}" data-list-kv="${def.kv ? '1' : ''}" type="button">+ Add ${escapeHtml(def.label.toLowerCase().replace(/s$/, ''))}</button>
    </div>
    <div class="builder-section-body builder-list-rows" data-list-rows="${def.key}">${rows}</div>
  </div>`;
}

function appCfgAdditionalSection(service) {
  const additional = service.fields
    .map((field, fieldIndex) => ({ field, fieldIndex }))
    .filter(({ field }) => !APP_CFG_STATIC_KEYS.has(field.key) && !APP_CFG_HIDDEN_FIELDS.has(field.key));
  const presentTypes = new Set(service.fields.map(field => field.key).filter(key => APP_CFG_FIELD_TYPE_MAP.has(key)));
  const addTypes = APP_CFG_FIELD_TYPES.filter(item =>
    (item.type === 'raw' || item.type === 'scalar' || !presentTypes.has(item.type)) &&
    !APP_CFG_STATIC_KEYS.has(item.type) && !APP_CFG_HIDDEN_FIELDS.has(item.type)
  );
  const rows = additional.length
    ? additional.map(({ field, fieldIndex }) => appCfgBuilderFieldRow(service, field, appCfgBuilderModel.services.indexOf(service), fieldIndex)).join('')
    : '<p class="muted">No additional fields.</p>';
  return appCfgSection('Additional settings', `${rows}
    <div class="row builder-add-row">
      <select class="input builder-add-type" aria-label="Field type to add">
        ${addTypes.map(item => `<option value="${item.type}">${escapeHtml(item.label)}</option>`).join('')}
      </select>
      <button class="btn builder-add-field" type="button">+ Add field</button>
    </div>`, 'Additional settings');
}

function appCfgBuilderServiceCard(service, serviceIndex) {
  ensureAppCfgServiceShape(service);
  const staticSections = APP_CFG_STATIC_FIELDS.map(def => appCfgSection(def.label, appCfgStaticRow(service, def))).join('');
  const listSections = APP_CFG_LIST_FIELDS.map(def => appCfgListEditor(service, def)).join('');
  return `<div class="builder-service" data-service-index="${serviceIndex}">
    <div class="builder-service-head">
      <span class="builder-service-number">Service ${serviceIndex + 1}${appCfgFieldHelp('service', 'Service name')}</span>
      <input class="input builder-service-name" data-service-name value="${escapeHtml(service.name)}" placeholder="Service name" aria-label="Service name">
      <button class="btn btn-danger builder-remove builder-remove-service" type="button">Remove service</button>
    </div>
    ${staticSections}
    ${listSections}
    ${appCfgAdditionalSection(service)}
  </div>`;
}

function appCfgBuilderMetaRow(kind, item, index) {
  const label = kind === 'network' ? 'Network' : 'Volume';
  return `<div class="builder-meta-row" data-${kind}-index="${index}">
    <input class="input builder-${kind}-key" data-${kind}-key value="${escapeHtml(item.key)}" placeholder="${label} name" aria-label="${label} name">
    <input class="input builder-${kind}-name" data-${kind}-name value="${escapeHtml(item.name)}" placeholder="External ${kind} name (optional)" aria-label="External ${kind} name">
    <input class="input builder-${kind}-driver" data-${kind}-driver value="${escapeHtml(item.driver)}" placeholder="Driver (optional)" aria-label="${label} driver">
    <input class="input builder-${kind}-extra" data-${kind}-extra value="${escapeHtml(item.extra || '')}" placeholder="Advanced JSON (optional)" aria-label="${label} advanced settings">
    <label class="checkbox"><input type="checkbox" data-${kind}-external ${item.external ? 'checked' : ''}> external</label>
    <button class="btn btn-danger builder-remove builder-remove-${kind}" type="button">−</button>
  </div>`;
}

function renderAppCfgBuilder() {
  const root = qs('#appCfgBuilder');
  if (!root) return;
  if (!appCfgBuilderModel) {
    root.innerHTML = '<p class="muted">The visual builder is unavailable. The compose file can still be edited manually.</p>';
    return;
  }
  const metaGroups = `<div class="builder-group">
    <div class="row" style="margin-top:0; justify-content:space-between">
      <strong>Named Volumes${appCfgFieldHelp('Named Volumes', 'Named Volumes')}</strong>
      <button class="btn builder-add-volume" type="button">+ Add volume</button>
    </div>
    <p class="muted">Top-level named volumes used by service volume mappings.</p>
    ${appCfgBuilderModel.volumes.length
      ? appCfgBuilderModel.volumes.map((item, index) => appCfgBuilderMetaRow('volume', item, index)).join('')
      : '<p class="muted">No named volumes.</p>'}
  </div>
  <div class="builder-group">
    <strong>Other top-level settings${appCfgFieldHelp('Other top-level settings', 'Other top-level settings')}</strong>
    <p class="muted">Optional JSON for configs, secrets, or x-* extensions.</p>
    <textarea class="textarea code" data-builder-other rows="4" spellcheck="false" placeholder="{}">${escapeHtml(appCfgBuilderModel.other || '')}</textarea>
  </div>`;
  root.innerHTML = appCfgBuilderModel.services.map((service, serviceIndex) => appCfgBuilderServiceCard(service, serviceIndex)).join('') + metaGroups;
  setAppCfgBuilderStatus(appCfgBuilderModel.services.length ? 'Ready' : 'Add a service');
  updateAppCfgBuilderIssueList(appCfgBuilderIssues);
}

function updateAppCfgBuilderIssueList(issues) {
  const container = qs('#appCfgBuilderIssues');
  if (!container) return;
  const list = (issues || []).filter(Boolean);
  if (!list.length) {
    container.classList.add('hidden');
    container.innerHTML = '';
    return;
  }
  container.innerHTML = `<strong>${list.length} issue${list.length === 1 ? '' : 's'} found</strong><ul>${list.map(issue => `<li>${escapeHtml(issue)}</li>`).join('')}</ul>`;
  container.classList.remove('hidden');
}

function clearAppCfgBuilderFieldErrors() {
  qsa('#appCfgBuilder .invalid').forEach(el => {
    el.classList.remove('invalid');
    el.removeAttribute('title');
  });
  qsa('#appCfgBuilder .builder-field-error').forEach(el => {
    el.textContent = '';
    el.classList.add('hidden');
  });
  qsa('#appCfgBuilder .builder-field').forEach(el => el.classList.remove('has-error'));
  qsa('#appCfgBuilder .builder-row').forEach(el => el.classList.remove('has-error'));
  qsa('#appCfgBuilder .builder-invalid').forEach(el => {
    el.classList.remove('builder-invalid');
    el.removeAttribute('title');
  });
}

function markAppCfgBuilderField(serviceIndex, fieldIndex, key, message) {
  const scope = qs(`#appCfgBuilder .builder-service[data-service-index="${serviceIndex}"]`);
  if (!scope) return;
  if (key === '__service__' || fieldIndex < 0) {
    const nameInput = scope.querySelector('[data-service-name]');
    if (nameInput) {
      nameInput.classList.add('invalid');
      nameInput.title = message;
    }
    return;
  }
  let row = scope.querySelector(`.builder-field[data-field-index="${fieldIndex}"]`);
  if (row && key && key !== '__field__') {
    const rowKey = String(row.querySelector('[data-field-key]')?.value || '').trim();
    if (rowKey && rowKey !== key) row = null;
  }
  if (!row && key && key !== '__field__') {
    row = Array.from(scope.querySelectorAll('.builder-field')).find(item =>
      String(item.querySelector('[data-field-key]')?.value || '').trim() === key
    );
  }
  if (!row) return;
  row.classList.add('has-error');
  const control = key === '__field__'
    ? row.querySelector('[data-field-key]')
    : (row.querySelector('.builder-value') || row.querySelector('[data-field-key]') || row.querySelector('[data-field-type]'));
  if (control) {
    control.classList.add('invalid');
    control.title = message;
  }
  const error = row.querySelector('[data-field-error]');
  if (error) {
    error.textContent = message;
    error.classList.remove('hidden');
  }
}

function applyAppCfgBuilderIssues(fieldIssues, issues) {
  clearAppCfgBuilderFieldErrors();
  appCfgBuilderFieldIssues = Array.isArray(fieldIssues) ? fieldIssues : [];
  const grouped = new Map();
  for (const issue of appCfgBuilderFieldIssues) {
    if (!issue) continue;
    if (issue.section === 'other') {
      const other = qs('#appCfgBuilder [data-builder-other]');
      if (other) {
        other.classList.add('invalid');
        other.title = issue.message;
      }
      continue;
    }
    if (issue.section === 'networks' || issue.section === 'volumes') {
      const kind = issue.section.slice(0, -1);
      const scope = qs(`#appCfgBuilder .builder-meta-row[data-${kind}-index="${issue[`${kind}Index`]}"]`);
      if (scope) {
        const input = issue.key === '__extra__'
          ? scope.querySelector(`[data-${kind}-extra]`)
          : scope.querySelector(`[data-${kind}-key]`);
        if (input) {
          input.classList.add('invalid');
          input.title = issue.message;
        }
      }
      continue;
    }
    const groupKey = `${issue.serviceIndex ?? 0}:${issue.fieldIndex ?? -1}:${issue.key || ''}`;
    if (!grouped.has(groupKey)) grouped.set(groupKey, { issue, messages: [] });
    grouped.get(groupKey).messages.push(issue.message);
  }
  for (const group of grouped.values()) {
    const message = group.messages.join(' ');
    const issue = group.issue;
    const serviceIndex = issue.serviceIndex ?? 0;
    const scope = qs(`#appCfgBuilder .builder-service[data-service-index="${serviceIndex}"]`);
    if (!scope) continue;
    if (issue.key === '__service__' || issue.fieldIndex < 0) {
      const nameInput = scope.querySelector('[data-service-name]');
      if (nameInput) {
        nameInput.classList.add('invalid');
        nameInput.title = message;
      }
      continue;
    }
    if (APP_CFG_STATIC_KEYS.has(issue.key)) {
      const list = scope.querySelector(`[data-builder-list="${issue.key}"]`);
      if (list) {
        list.classList.add('builder-invalid');
        list.title = message;
        list.querySelectorAll('input, textarea, select').forEach(el => el.classList.add('invalid'));
        continue;
      }
      const row = Array.from(scope.querySelectorAll('[data-builder-key]')).find(el => el.dataset.builderKey === issue.key);
      if (row) {
        row.classList.add('has-error');
        row.querySelectorAll('input, textarea, select').forEach(el => {
          el.classList.add('invalid');
          el.title = message;
        });
        const error = row.querySelector('[data-field-error]');
        if (error) {
          error.textContent = message;
          error.classList.remove('hidden');
        }
        continue;
      }
    }
    markAppCfgBuilderField(serviceIndex, issue.fieldIndex ?? -1, issue.key, message);
  }
  updateAppCfgBuilderIssueList(issues || []);
  setAppCfgBuilderStatus(issues && issues.length ? `${issues.length} issue${issues.length === 1 ? '' : 's'} — fix highlighted fields` : 'Ready', !!(issues && issues.length));
}

function appCfgBuilderEnvMap(field) {
  const map = {};
  for (const line of String(field?.value || '').split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    const idx = text.indexOf('=');
    if (idx < 0) map[text] = '';
    else map[text.slice(0, idx).trim()] = text.slice(idx + 1).trim();
  }
  return map;
}

function appCfgQuickService() {
  const services = appCfgBuilderModel?.services || [];
  if (!services.length) return null;
  const preferred = String(pendingAppConfig?.vhostService || pendingAppConfig?.appName || '').trim();
  return services.find(service => service.name === preferred) || services[0];
}

function appCfgBuilderQuickValues() {
  const service = appCfgQuickService();
  if (!service) return { ports: '', vhost: '', vhostPort: '' };
  const portsField = service.fields.find(field => field.key === 'ports');
  const env = appCfgBuilderEnvMap(service.fields.find(field => field.key === 'environment'));
  return {
    ports: appCfgRawLines(portsField?.value).map(line => line.trim()).filter(Boolean).join(','),
    vhost: env.VIRTUAL_HOST || '',
    vhostPort: env.VIRTUAL_PORT || ''
  };
}

function appCfgSyncListEditor(service, kind) {
  const field = appCfgServiceField(service, kind, (APP_CFG_LIST_FIELDS.find(def => def.key === kind) || {}).type || kind);
  const scope = qs(`#appCfgBuilder .builder-service[data-service-index="${appCfgBuilderModel.services.indexOf(service)}"] [data-builder-list="${kind}"]`);
  if (!scope) return;
  let lines;
  if (kind === 'environment') {
    lines = Array.from(scope.querySelectorAll('[data-env-row]')).map(row => {
      const key = String(row.querySelector('[data-env-key]')?.value || '').trim();
      if (!key) return '';
      return `${key}=${String(row.querySelector('[data-env-value]')?.value || '')}`;
    });
  } else {
    lines = Array.from(scope.querySelectorAll('[data-list-entry]')).map(input => String(input.value || '').trim());
  }
  field.value = lines.filter(Boolean).join('\n');
  scheduleAppCfgBuilderBuild();
}

function scheduleAppCfgBuilderBuild(immediate = false, markDirty = true) {
  if (!appCfgBuilderModel || appCfgBuilderManual) return;
  if (markDirty) appCfgBuilderDirty = true;
  if (appCfgBuilderTimer) clearTimeout(appCfgBuilderTimer);
  setAppCfgBuilderStatus('Updating compose…');
  appCfgBuilderTimer = setTimeout(() => {
    appCfgBuilderTimer = null;
    runAppCfgBuilderBuild();
  }, immediate ? 0 : 220);
}

async function runAppCfgBuilderBuild() {
  if (!appCfgBuilderModel || appCfgBuilderManual) return appCfgBuilderLastBuild;
  if (appCfgBuilderTimer) {
    clearTimeout(appCfgBuilderTimer);
    appCfgBuilderTimer = null;
  }
  const seq = ++appCfgBuilderBuildSeq;
  const appDir = pendingAppConfig?.appDir || '';
  const model = JSON.parse(JSON.stringify(appCfgBuilderModel));
  try {
    const result = await api('/api/compose/build', jsonBody({ model, appDir }));
    if (seq !== appCfgBuilderBuildSeq || appCfgBuilderManual) return appCfgBuilderLastBuild;
    if ((pendingAppConfig?.appDir || '') !== appDir) return appCfgBuilderLastBuild;
    if (typeof result.compose !== 'string') throw new Error('The compose builder did not return a compose file');
    appCfgBuilderLastBuild = result;
    const area = qs('#appCfgCompose');
    if (area) area.value = result.compose;
    appCfgBuilderIssues = Array.isArray(result.issues) ? result.issues : [];
    applyAppCfgBuilderIssues(result.fieldIssues || [], appCfgBuilderIssues);
    updateAppCfgRequired();
    return result;
  } catch (e) {
    if (seq !== appCfgBuilderBuildSeq || appCfgBuilderManual) return appCfgBuilderLastBuild;
    if ((pendingAppConfig?.appDir || '') !== appDir) return appCfgBuilderLastBuild;
    appCfgBuilderLastBuild = { ok: false, issues: [e.message] };
    appCfgBuilderIssues = [e.message];
    updateAppCfgBuilderIssueList(appCfgBuilderIssues);
    setAppCfgBuilderStatus(e.message, true);
    return appCfgBuilderLastBuild;
  }
}

async function flushAppCfgBuilderBuild() {
  if (!appCfgBuilderModel || appCfgBuilderManual) return appCfgBuilderLastBuild;
  if (appCfgBuilderTimer) {
    clearTimeout(appCfgBuilderTimer);
    appCfgBuilderTimer = null;
  }
  return runAppCfgBuilderBuild();
}

async function loadAppCfgBuilder(compose) {
  const seq = ++appCfgBuilderLoadSeq;
  appCfgBuilderBuildSeq++;
  if (appCfgBuilderTimer) clearTimeout(appCfgBuilderTimer);
  appCfgBuilderTimer = null;
  appCfgBuilderModel = null;
  appCfgBuilderIssues = [];
  appCfgBuilderFieldIssues = [];
  appCfgBuilderLastBuild = null;
  appCfgBuilderManual = false;
  appCfgBuilderDirty = false;
  const root = qs('#appCfgBuilder');
  if (root) root.innerHTML = '<p class="muted">Reading compose file…</p>';
  setAppCfgBuilderStatus('Loading…');
  updateAppCfgBuilderIssueList([]);
  try {
    const result = await api('/api/compose/parse', jsonBody({ compose, appDir: pendingAppConfig?.appDir }));
    if (seq !== appCfgBuilderLoadSeq || appCfgBuilderManual) return;
    if (!result.ok || !result.model) {
      const message = result.issues?.[0] || 'Could not read this compose file in the visual builder.';
      if (root) root.innerHTML = `<p class="muted">${escapeHtml(message)}</p>`;
      setAppCfgBuilderStatus('Builder unavailable', true);
      return;
    }
    appCfgBuilderModel = normalizeClientBuilderModel(result.model);
    await applyCoreServiceHints(appCfgBuilderModel);
    if (seq !== appCfgBuilderLoadSeq || appCfgBuilderManual) return;
    renderAppCfgBuilder();
    scheduleAppCfgBuilderBuild(true, false);
  } catch (e) {
    if (seq !== appCfgBuilderLoadSeq || appCfgBuilderManual) return;
    if (root) root.innerHTML = `<p class="muted">${escapeHtml(e.message)}</p>`;
    setAppCfgBuilderStatus('Builder unavailable', true);
  }
}


const coreAppHintsCache = new Map();
async function getCoreAppHints(appName = '') {
  const requestedApp = String(appName || '').trim();
  const key = requestedApp || '__default__';
  const cached = coreAppHintsCache.get(key);
  if (cached?.data && Date.now() - cached.at < 30000) return cached.data;
  if (cached?.promise) return cached.promise;
  const query = requestedApp ? `?app=${encodeURIComponent(requestedApp)}` : '';
  const promise = api('/api/core/app-hints' + query)
    .then(data => {
      coreAppHintsCache.set(key, { at: Date.now(), data, promise: null });
      return data;
    })
    .catch(() => {
      const data = { services: {}, fields: [] };
      coreAppHintsCache.set(key, { at: 0, data, promise: null });
      return data;
    });
  coreAppHintsCache.set(key, { at: 0, data: null, promise });
  return promise;
}

function appCfgPrimaryContainerPort(service) {
  const fields = service?.fields || [];
  const portsField = fields.find(field => field.key === 'ports');
  const portsRaw = String(portsField?.value || '').trim();
  // Long-syntax ports are stored as raw JSON; read their container target so
  // VIRTUAL_PORT matches what the container actually listens on.
  if (portsRaw.startsWith('[') || portsRaw.startsWith('{')) {
    try {
      const parsed = JSON.parse(portsRaw);
      for (const item of (Array.isArray(parsed) ? parsed : [parsed])) {
        const target = item && typeof item === 'object' ? (item.target ?? item.published) : item;
        const match = String(target ?? '').match(/^(\d+)(?:-\d+)?$/);
        if (match) return match[1];
      }
    } catch {}
  }
  for (const line of appCfgRawLines(portsField?.value)) {
    const text = line.trim().replace(/\/(?:tcp|udp|sctp)$/i, '');
    if (!text) continue;
    const target = text.split(':').pop();
    const match = String(target || '').match(/^(\d+)(?:-\d+)?$/);
    if (match) return match[1];
  }
  const exposeField = fields.find(field => field.key === 'expose');
  for (const line of appCfgRawLines(exposeField?.value)) {
    const match = String(line || '').trim().split(/[-\/]/)[0].match(/^(\d+)$/);
    if (match) return match[1];
  }
  const env = appCfgBuilderEnvMap(fields.find(field => field.key === 'environment'));
  const envPort = String(env.PORT || '').trim();
  if (/^\d+$/.test(envPort)) return envPort;
  return '80';
}

function applyCoreServiceHintsToModel(model, hints) {
  const fields = Array.isArray(hints?.fields) ? hints.fields : [];
  if (!model || !fields.length) return false;
  const services = model.services || [];
  if (!services.length) return false;
  const preferred = String(pendingAppConfig?.vhostService || pendingAppConfig?.appName || '').trim();
  const service = services.find(item => item.name === preferred) || services[0];
  if (!service) return false;
  let envField = (service.fields || []).find(field => field.key === 'environment');
  if (!envField) {
    envField = { key: 'environment', type: 'environment', value: '' };
    service.fields = service.fields || [];
    service.fields.push(envField);
  }
  const existingMap = appCfgBuilderEnvMap(envField);
  const existing = new Set(Object.entries(existingMap)
    .filter(([, value]) => String(value ?? '').trim())
    .map(([key]) => key));
  // A blank placeholder (for example VIRTUAL_PORT=) must not block the hint.
  // Drop blank values for hint keys so the filled entry is not duplicated.
  const hintKeys = new Set(fields.map(hint => String(hint?.key || '').trim()).filter(Boolean));
  const originalLines = appCfgRawLines(envField.value).map(line => line.trim()).filter(Boolean);
  const lines = originalLines.filter(line => {
    const idx = line.indexOf('=');
    const key = (idx < 0 ? line : line.slice(0, idx)).trim();
    return !(hintKeys.has(key) && !String(existingMap[key] ?? '').trim());
  });
  let changed = lines.length !== originalLines.length;
  for (const hint of fields) {
    const key = String(hint?.key || '').trim();
    if (!key || existing.has(key)) continue;
    let value = hint.value === undefined || hint.value === null ? '' : String(hint.value);
    if (!value && (key === 'VIRTUAL_HOST' || key === 'LETSENCRYPT_HOST')) {
      const appName = String(pendingAppConfig?.appName || '').trim();
      const primary = String(hints?.primaryDomain || installDefaults?.primaryDomain || '').trim();
      if (appName && primary) value = `${slugifyAppName(appName)}.${primary}`;
    }
    if (!value && key === 'VIRTUAL_PORT') value = appCfgPrimaryContainerPort(service);
    if (!value && key === 'LETSENCRYPT_EMAIL') value = String(installDefaults?.adminEmail || '').trim();
    if (!value) continue;
    lines.push(`${key}=${value}`);
    existing.add(key);
    changed = true;
  }
  if (changed) envField.value = lines.join('\n');
  // With nginx-proxy installed the app is reached through VIRTUAL_HOST on the
  // shared Docker network. Publishing a host port is unnecessary and would
  // prevent another app from using the same container port.
  const routedEnv = appCfgBuilderEnvMap(envField);
  if (hints?.services?.nginxProxy && routedEnv.VIRTUAL_HOST) {
    const portsField = (service.fields || []).find(field => field.key === 'ports');
    if (portsField && String(portsField.value || '').trim()) {
      portsField.value = '';
      changed = true;
    }
  }
  return changed;
}

async function applyCoreServiceHints(model) {
  try {
    const appName = String(pendingAppConfig?.appName || '').trim();
    const hints = await getCoreAppHints(appName);
    return applyCoreServiceHintsToModel(model, hints);
  } catch {
    return false;
  }
}

function appCfgBuilderServiceIndex(element) {
  const card = element.closest('.builder-service');
  return card ? Number(card.dataset.serviceIndex) : -1;
}

function appCfgBuilderFieldIndex(element) {
  const row = element.closest('.builder-field');
  return row ? Number(row.dataset.fieldIndex) : -1;
}

function addAppCfgBuilderField(serviceIndex, type) {
  const service = appCfgBuilderModel?.services?.[serviceIndex];
  if (!service) return;
  if (type !== 'raw' && type !== 'scalar' && service.fields.some(field => field.key === type)) {
    toast(`The ${type} field is already present`, true);
    return;
  }
  const custom = type === 'raw' || type === 'scalar';
  let key = custom ? 'custom' : type;
  let suffix = 2;
  while (service.fields.some(field => field.key === key)) key = `${custom ? 'custom' : type}_${suffix++}`;
  const def = APP_CFG_FIELD_TYPE_MAP.get(type) || APP_CFG_FIELD_TYPE_MAP.get('raw');
  service.fields.push({ key, type, value: def.input === 'boolean' ? false : '' });
  renderAppCfgBuilder();
  scheduleAppCfgBuilderBuild(true);
}

function addAppCfgBuilderMeta(kind) {
  if (!appCfgBuilderModel) return;
  const collection = kind === 'network' ? appCfgBuilderModel.networks : appCfgBuilderModel.volumes;
  const base = kind === 'network' ? 'network' : 'volume';
  let index = collection.length + 1;
  while (collection.some(item => item.key === `${base}${index}`)) index++;
  collection.push({ key: `${base}${index}`, external: false, name: '', driver: '', extra: '' });
  renderAppCfgBuilder();
  scheduleAppCfgBuilderBuild(true);
}

function appCfgNewEnvRow() {
  return `<div class="builder-kv-row" data-env-row>
    <input class="input" data-env-key placeholder="KEY">
    <input class="input" data-env-value placeholder="value">
    <button class="btn btn-danger builder-remove-list" data-list-kind="environment" type="button" title="Remove">−</button>
  </div>`;
}

function appCfgNewListRow(def) {
  return `<div class="builder-list-row" data-list-row>
    <input class="input builder-list-input" data-list-entry placeholder="${escapeHtml(def.placeholder || '')}">
    <button class="btn btn-danger builder-remove-list" data-list-kind="${def.key}" type="button" title="Remove">−</button>
  </div>`;
}

if (qs('#appCfgBuilder')) {
  qs('#appCfgBuilder').addEventListener('click', (event) => {
    const target = event.target.closest('button');
    if (!target || !appCfgBuilderModel) return;
    const serviceIndex = appCfgBuilderServiceIndex(target);
    if (target.classList.contains('builder-add-field')) {
      const type = target.closest('.builder-service')?.querySelector('.builder-add-type')?.value || 'image';
      addAppCfgBuilderField(serviceIndex, type);
      return;
    }
    if (target.classList.contains('builder-add-list')) {
      const kind = target.dataset.listKind;
      const def = APP_CFG_LIST_FIELDS.find(item => item.key === kind);
      const scope = qs(`#appCfgBuilder .builder-service[data-service-index="${serviceIndex}"] [data-list-rows="${kind}"]`);
      if (!def || !scope) return;
      scope.insertAdjacentHTML('beforeend', def.kv ? appCfgNewEnvRow() : appCfgNewListRow(def));
      const rows = scope.querySelectorAll(def.kv ? '[data-env-key]' : '[data-list-entry]');
      rows[rows.length - 1]?.focus();
      return;
    }
    if (target.classList.contains('builder-remove-list')) {
      const kind = target.dataset.listKind;
      const service = appCfgBuilderModel.services[serviceIndex];
      const row = target.closest('[data-env-row], [data-list-row]');
      if (!service || !row) return;
      row.remove();
      appCfgSyncListEditor(service, kind);
      return;
    }
    if (target.classList.contains('builder-remove-field')) {
      const fieldIndex = appCfgBuilderFieldIndex(target);
      const service = appCfgBuilderModel.services[serviceIndex];
      if (!service || fieldIndex < 0) return;
      service.fields.splice(fieldIndex, 1);
      ensureAppCfgBuilderRequired(service);
      renderAppCfgBuilder();
      scheduleAppCfgBuilderBuild(true);
      return;
    }
    if (target.classList.contains('builder-remove-service')) {
      if (appCfgBuilderModel.services.length <= 1) {
        toast('An app needs at least one service', true);
        return;
      }
      appCfgBuilderModel.services.splice(serviceIndex, 1);
      renderAppCfgBuilder();
      scheduleAppCfgBuilderBuild(true);
      return;
    }
    if (target.classList.contains('builder-add-network')) {
      addAppCfgBuilderMeta('network');
      return;
    }
    if (target.classList.contains('builder-add-volume')) {
      addAppCfgBuilderMeta('volume');
      return;
    }
    if (target.classList.contains('builder-remove-network')) {
      const row = target.closest('[data-network-index]');
      const index = row ? Number(row.dataset.networkIndex) : -1;
      if (index >= 0) {
        appCfgBuilderModel.networks.splice(index, 1);
        renderAppCfgBuilder();
        scheduleAppCfgBuilderBuild(true);
      }
      return;
    }
    if (target.classList.contains('builder-remove-volume')) {
      const row = target.closest('[data-volume-index]');
      const index = row ? Number(row.dataset.volumeIndex) : -1;
      if (index >= 0) {
        appCfgBuilderModel.volumes.splice(index, 1);
        renderAppCfgBuilder();
        scheduleAppCfgBuilderBuild(true);
      }
    }
  });

  qs('#appCfgBuilder').addEventListener('input', (event) => {
    if (!appCfgBuilderModel) return;
    const el = event.target;
    if (el.matches('[data-service-name]')) {
      const serviceIndex = appCfgBuilderServiceIndex(el);
      if (appCfgBuilderModel.services[serviceIndex]) {
        appCfgBuilderModel.services[serviceIndex].name = el.value;
        scheduleAppCfgBuilderBuild();
      }
      return;
    }
    if (el.matches('[data-static-key]')) {
      const serviceIndex = appCfgBuilderServiceIndex(el);
      const service = appCfgBuilderModel.services[serviceIndex];
      if (!service) return;
      const field = appCfgServiceField(service, el.dataset.staticKey, el.dataset.staticType || 'scalar');
      field.value = el.value;
      if (field.key === 'image') refreshAppCfgBuilderRequiredBadges();
      scheduleAppCfgBuilderBuild();
      return;
    }
    if (el.matches('[data-env-key], [data-env-value]')) {
      const serviceIndex = appCfgBuilderServiceIndex(el);
      const service = appCfgBuilderModel.services[serviceIndex];
      if (service) appCfgSyncListEditor(service, 'environment');
      return;
    }
    if (el.matches('[data-list-entry]')) {
      const serviceIndex = appCfgBuilderServiceIndex(el);
      const service = appCfgBuilderModel.services[serviceIndex];
      const kind = el.closest('[data-builder-list]')?.dataset.builderList;
      if (service && kind) appCfgSyncListEditor(service, kind);
      return;
    }
    if (el.matches('[data-field-key]')) {
      const serviceIndex = appCfgBuilderServiceIndex(el);
      const fieldIndex = appCfgBuilderFieldIndex(el);
      const field = appCfgBuilderModel.services[serviceIndex]?.fields?.[fieldIndex];
      if (field) {
        field.key = el.value;
        scheduleAppCfgBuilderBuild();
      }
      return;
    }
    if (el.matches('[data-builder-other]')) {
      appCfgBuilderModel.other = el.value;
      scheduleAppCfgBuilderBuild();
      return;
    }
    if (el.matches('[data-builder-value]')) {
      const serviceIndex = appCfgBuilderServiceIndex(el);
      const fieldIndex = appCfgBuilderFieldIndex(el);
      const service = appCfgBuilderModel.services[serviceIndex];
      const field = service?.fields?.[fieldIndex];
      if (!field) return;
      field.value = el.type === 'checkbox' ? el.checked : el.value;
      if (field.key === 'build') {
        const before = service.fields.length;
        ensureAppCfgBuilderRequired(service);
        if (service.fields.length !== before) {
          renderAppCfgBuilder();
          scheduleAppCfgBuilderBuild(true);
          return;
        }
        refreshAppCfgBuilderRequiredBadges();
      }
      if (field.key === 'image') refreshAppCfgBuilderRequiredBadges();
      scheduleAppCfgBuilderBuild();
      return;
    }
    if (el.matches('[data-network-key], [data-network-name], [data-network-driver], [data-network-extra]')) {
      const row = el.closest('[data-network-index]');
      const index = row ? Number(row.dataset.networkIndex) : -1;
      const network = appCfgBuilderModel.networks[index];
      if (!network) return;
      if (el.matches('[data-network-key]')) network.key = el.value;
      if (el.matches('[data-network-name]')) network.name = el.value;
      if (el.matches('[data-network-driver]')) network.driver = el.value;
      if (el.matches('[data-network-extra]')) network.extra = el.value;
      scheduleAppCfgBuilderBuild();
      return;
    }
    if (el.matches('[data-volume-key], [data-volume-name], [data-volume-driver], [data-volume-extra]')) {
      const row = el.closest('[data-volume-index]');
      const index = row ? Number(row.dataset.volumeIndex) : -1;
      const volume = appCfgBuilderModel.volumes[index];
      if (!volume) return;
      if (el.matches('[data-volume-key]')) volume.key = el.value;
      if (el.matches('[data-volume-name]')) volume.name = el.value;
      if (el.matches('[data-volume-driver]')) volume.driver = el.value;
      if (el.matches('[data-volume-extra]')) volume.extra = el.value;
      scheduleAppCfgBuilderBuild();
    }
  });

  qs('#appCfgBuilder').addEventListener('change', (event) => {
    if (!appCfgBuilderModel) return;
    const el = event.target;
    if (el.matches('[data-static-key]')) {
      const serviceIndex = appCfgBuilderServiceIndex(el);
      const service = appCfgBuilderModel.services[serviceIndex];
      if (service) {
        appCfgServiceField(service, el.dataset.staticKey, el.dataset.staticType || 'scalar').value = el.value;
        scheduleAppCfgBuilderBuild();
      }
      return;
    }
    if (el.matches('[data-network-external], [data-volume-external]')) {
      const kind = el.matches('[data-network-external]') ? 'network' : 'volume';
      const row = el.closest(`[data-${kind}-index]`);
      const index = row ? Number(row.dataset[`${kind}Index`]) : -1;
      const item = kind === 'network' ? appCfgBuilderModel.networks[index] : appCfgBuilderModel.volumes[index];
      if (item) {
        item.external = el.checked;
        scheduleAppCfgBuilderBuild();
      }
      return;
    }
    if (el.matches('[data-field-type]')) {
      const serviceIndex = appCfgBuilderServiceIndex(el);
      const fieldIndex = appCfgBuilderFieldIndex(el);
      const service = appCfgBuilderModel.services[serviceIndex];
      const field = service?.fields?.[fieldIndex];
      if (!field) return;
      const nextType = el.value;
      if (nextType === field.type) return;
      if (nextType === 'raw' && field.type !== 'raw') {
        field.key = APP_CFG_FIELD_TYPE_MAP.has(field.key) ? 'custom' : (field.key || 'custom');
        field.value = String(field.value || '').trim() ? JSON.stringify(field.value) : '';
      } else if (nextType === 'scalar') {
        field.key = APP_CFG_FIELD_TYPE_MAP.has(field.key) ? 'custom' : (field.key || 'custom');
      } else {
        field.key = (nextType === 'raw' || nextType === 'scalar') ? (field.key || 'custom') : nextType;
        field.value = '';
      }
      field.type = nextType;
      ensureAppCfgBuilderRequired(service);
      renderAppCfgBuilder();
      scheduleAppCfgBuilderBuild(true);
    }
  });
}

if (qs('#appCfgAddService')) {
  qs('#appCfgAddService').addEventListener('click', () => {
    if (!appCfgBuilderModel) return;
    let index = appCfgBuilderModel.services.length + 1;
    while (appCfgBuilderModel.services.some(service => service.name === `service${index}`)) index++;
    appCfgBuilderModel.services.push({ name: `service${index}`, fields: [{ key: 'image', type: 'image', value: '' }] });
    renderAppCfgBuilder();
    scheduleAppCfgBuilderBuild(true);
    const names = qsa('#appCfgBuilder [data-service-name]');
    names[names.length - 1]?.focus();
  });
}

function isSpecialNetworkName(name) {
  const text = String(name || '').trim();
  return ['host', 'none', 'bridge', 'default'].includes(text) ||
    text.startsWith('container:') || text.startsWith('service:');
}

function appCfgDefaultNetworkName() {
  return String(installDefaults?.defaultNetwork || 'wicked').trim() || 'wicked';
}

function appCfgNetworkChoices(selected = '') {
  const fallback = appCfgDefaultNetworkName();
  const names = [...new Set([
    'wicked',
    fallback,
    ...(appCfgNetworks || []).filter(name => !isSpecialNetworkName(name))
  ].filter(Boolean))];
  const wanted = String(selected || '').trim();
  if (wanted && !isSpecialNetworkName(wanted) && !names.includes(wanted)) names.push(wanted);
  names.sort((a, b) => {
    if (a === b) return 0;
    if (a === fallback) return -1;
    if (b === fallback) return 1;
    if (a === 'wicked') return -1;
    if (b === 'wicked') return 1;
    return a.localeCompare(b);
  });
  return names;
}

function renderAppCfgNetworkOptions(selected = '') {
  const select = qs('#appCfgNetwork');
  if (!select) return;
  const current = String(selected || select.value || pendingAppConfig?.network || '').trim();
  const fallback = appCfgDefaultNetworkName();
  const names = appCfgNetworkChoices(current || fallback);
  const value = names.includes(current) ? current : (names.includes(fallback) ? fallback : names[0] || '');
  const known = new Set(appCfgNetworks || []);
  select.innerHTML = names.map(name => {
    const missing = appCfgNetworksLoaded && !known.has(name) && name !== 'wicked' && name !== fallback;
    return `<option value="${escapeHtml(name)}">${escapeHtml(name)}${name === fallback ? ' (default)' : ''}${missing ? ' (not found)' : ''}</option>`;
  }).join('');
  select.value = value;
}

async function loadNetworksForModal() {
  const selected = qs('#appCfgNetwork')?.value || pendingAppConfig?.network || '';
  try {
    const nets = await api('/api/networks');
    appCfgNetworks = (nets || []).map(n => n.Name).filter(Boolean);
    appCfgNetworksLoaded = true;
  } catch {
    appCfgNetworksLoaded = false;
  }
  renderAppCfgNetworkOptions(selected);
  renderAppCfgNetworkNotice();
  renderAppCfgVolumeNotice();
}

function renderAppCfgNetworkNotice() {
  const notice = qs('#appCfgNetworkNotice');
  const rows = qs('#appCfgNetworkRows');
  if (!notice || !rows) return;
  const missing = pendingAppConfig?.missingNetworks || [];
  if (!missing.length) {
    notice.classList.add('hidden');
    rows.innerHTML = '';
    return;
  }
  const choices = pendingAppConfig.networkChoices || {};
  const available = appCfgNetworkChoices();
  rows.innerHTML = missing.map(ref => {
    const key = String(ref.key || ref.name || '');
    const name = String(ref.name || key);
    const label = key && key !== name ? `${key} (${name})` : name;
    const current = choices[key];
    const currentOption = current && current !== '__create__' && !available.includes(current)
      ? `<option value="${escapeHtml(current)}" selected>${escapeHtml(current)} (not found)</option>`
      : '';
    const options = available.map(net =>
      `<option value="${escapeHtml(net)}"${choices[key] === net ? ' selected' : ''}>${escapeHtml(net)}</option>`
    ).join('');
    const create = `<option value="__create__"${choices[key] === '__create__' ? ' selected' : ''}>Create "${escapeHtml(name)}"</option>`;
    return `<div class="app-cfg-issue" data-network-key="${escapeHtml(key)}" data-network-name="${escapeHtml(name)}">
      <div class="muted">Network <code>${escapeHtml(label)}</code> does not exist.</div>
      <select class="input app-cfg-network-choice" aria-label="Network for ${escapeHtml(label)}">
        <option value="">Choose an existing network…</option>
        ${currentOption}
        ${options}
        ${create}
      </select>
    </div>`;
  }).join('');
  notice.classList.remove('hidden');
  rows.querySelectorAll('.app-cfg-network-choice').forEach(select => {
    select.addEventListener('change', () => {
      const key = select.closest('[data-network-key]')?.dataset.networkKey;
      if (!key || !pendingAppConfig) return;
      pendingAppConfig.networkChoices = pendingAppConfig.networkChoices || {};
      pendingAppConfig.networkChoices[key] = select.value;
    });
  });
}

function renderAppCfgVolumeNotice() {
  const notice = qs('#appCfgVolumeNotice');
  const rows = qs('#appCfgVolumeRows');
  if (!notice || !rows) return;
  const missing = pendingAppConfig?.missingVolumes || [];
  if (!missing.length) {
    notice.classList.add('hidden');
    rows.innerHTML = '';
    return;
  }
  const choices = pendingAppConfig.volumeChoices || {};
  rows.innerHTML = missing.map(volume => {
    const key = volume.key || `${volume.service || ''}::${volume.target || ''}`;
    const choice = choices[key] || {};
    return `<div class="app-cfg-issue" data-volume-key="${escapeHtml(key)}">
      <div class="muted">Host path <code>${escapeHtml(volume.source)}</code> for <code>${escapeHtml(volume.target)}</code> in service <code>${escapeHtml(volume.service)}</code> ${volume.reason ? 'is not usable.' : 'does not exist.'}</div>
      ${volume.reason ? `<div class="muted">${escapeHtml(volume.reason)}</div>` : ''}
      <div class="row">
        <input class="input app-cfg-volume-path" value="${escapeHtml(choice.source !== undefined ? choice.source : volume.source)}" placeholder="Existing host path" aria-label="Existing host path">
        <label class="checkbox"><input type="checkbox" class="app-cfg-volume-create" ${choice.create ? 'checked' : ''}> Create directory</label>
      </div>
    </div>`;
  }).join('');
  notice.classList.remove('hidden');
  rows.querySelectorAll('.app-cfg-issue').forEach(row => {
    const update = () => {
      const key = row.dataset.volumeKey;
      if (!key || !pendingAppConfig) return;
      pendingAppConfig.volumeChoices = pendingAppConfig.volumeChoices || {};
      pendingAppConfig.volumeChoices[key] = {
        source: row.querySelector('.app-cfg-volume-path')?.value.trim() || '',
        create: !!row.querySelector('.app-cfg-volume-create')?.checked
      };
    };
    row.querySelectorAll('input').forEach(input => {
      input.addEventListener('input', update);
      input.addEventListener('change', update);
    });
  });
}

function setComposeEditable(editable) {
  const area = qs('#appCfgCompose');
  if (!area) return;
  area.readOnly = !editable;
  const label = qs('#appCfgComposeState');
  if (label) label.textContent = editable ? '(editing)' : '(read-only)';
  appCfgBuilderManual = !!editable;
  if (editable) {
    if (appCfgBuilderTimer) clearTimeout(appCfgBuilderTimer);
    appCfgBuilderTimer = null;
    qs('#appCfgBuilderCard')?.classList.add('hidden');
  } else {
    appCfgBuilderManual = false;
    qs('#appCfgBuilderCard')?.classList.remove('hidden');
  }
}

function updateAppCfgRequired() {
  const name = qs('#appCfgName');
  if (!name) return;
  name.classList.toggle('invalid', !name.value.trim());
  if (!name.value.trim()) name.title = 'App title is required';
  else name.removeAttribute('title');
}

function syncAppCfgReferenceLink() {
  const input = qs('#appCfgReferenceUrl');
  const link = qs('#appCfgReferenceLink');
  if (!input || !link) return;
  let href = '';
  try {
    const url = new URL(input.value.trim());
    if (['http:', 'https:'].includes(url.protocol)) href = url.href;
  } catch {}
  link.classList.toggle('hidden', !href);
  if (href) link.href = href;
  else link.removeAttribute('href');
}

if (qs('#appCfgReferenceUrl')) {
  qs('#appCfgReferenceUrl').addEventListener('input', syncAppCfgReferenceLink);
}

function openAppConfig(data) {
  const initialCompose = data.compose || data.yaml || data.generatedCompose || '';
  pendingAppConfig = {
    ...data,
    initialCompose,
    initialVhost: String(data.vhost || '').trim(),
    networkChoices: data.networkChoices || {},
    volumeChoices: data.volumeChoices || {},
    missingNetworks: Array.isArray(data.missingNetworks) ? data.missingNetworks : [],
    missingVolumes: Array.isArray(data.missingVolumes) ? data.missingVolumes : []
  };
  pendingSaveAction = null;
  qs('#appCfgName').value = data.appName || '';
  if (qs('#appCfgReferenceUrl')) qs('#appCfgReferenceUrl').value = data.referenceUrl || '';
  syncAppCfgReferenceLink();
  pendingAppConfig.network = data.network || installDefaults.defaultNetwork || 'wicked';
  renderAppCfgNetworkOptions(pendingAppConfig.network);
  const notices = [];
  if (Array.isArray(data.unsupported) && data.unsupported.length) {
    notices.push(`These docker run options were not converted and may need to be added manually: ${data.unsupported.join(', ')}`);
  }
  if (Array.isArray(data.issues) && data.issues.length) {
    notices.push(data.issues.join(' '));
  }
  const replacedNetworks = Array.isArray(data.replacedNetworks)
    ? data.replacedNetworks.map(net => String(net?.name || net?.key || '').trim()).filter(Boolean)
    : [];
  if (replacedNetworks.length) {
    notices.push(`Nonexistent network${replacedNetworks.length > 1 ? 's' : ''} ${[...new Set(replacedNetworks)].join(', ')} replaced with wicked.`);
  }
  qs('#appCfgMsg').textContent = notices.join(' ');
  qs('#appCfgCompose').value = initialCompose;
  setComposeEditable(false);
  updateAppCfgRequired();
  qs('#appCfgBuilderCard')?.classList.remove('hidden');
  loadAppCfgBuilder(initialCompose);
  const summary = qs('#appCfgSummary');
  if (data.command) {
    summary.textContent = data.command;
    summary.classList.remove('hidden');
  } else {
    summary.classList.add('hidden');
    summary.textContent = '';
  }
  const editing = !!data.editAppId;
  if (qs('#appCfgName')) qs('#appCfgName').disabled = editing;
  qs('#appConfigTitle').textContent = editing
    ? (data.needsConfiguration ? `Configure imported app: ${data.appName || 'app'}` : `Deploy: ${data.appName || 'app'}`)
    : `Configure ${data.appName || 'app'}`;
  if (qs('#appCfgComplete')) qs('#appCfgComplete').textContent = editing ? 'Save configuration' : 'Save to library';
  if (qs('#appCfgCompleteRun')) qs('#appCfgCompleteRun').textContent = editing ? 'Save and deploy' : 'Test launch (stops after test)';
  hideAppCfgProgress();
  qs('#appConfigModal').classList.remove('hidden');
  renderAppCfgNetworkNotice();
  renderAppCfgVolumeNotice();
  loadNetworksForModal();
  checkAppCreationNginxNotice();
}

function showComposeIssues(issues, onSaveAnyway) {
  const out = qs('#composeSaveIssues');
  out.textContent = Array.isArray(issues) ? issues.join('\n') : String(issues || '');
  pendingSaveAction = typeof onSaveAnyway === 'function' ? onSaveAnyway : null;
  const prompt = qs('#composeSavePrompt');
  if (prompt) {
    prompt.textContent = pendingSaveAction
      ? 'Some errors or incompatibilities were found. Do you still want to save?'
      : 'Fix the issues above, then validate again.';
  }
  const saveBtn = qs('#composeSaveAnyway');
  if (saveBtn) saveBtn.textContent = pendingSaveAction ? 'Save anyway' : 'Close';
  const editBtn = qs('#composeContinueEdit');
  if (editBtn) editBtn.classList.toggle('hidden', !pendingSaveAction);
  qs('#composeSaveConfirmModal').classList.remove('hidden');
}

let appCfgProgressTimer = null;
let appCfgProgressValue = 0;
let appCfgProgressLabel = 'Preparing…';

function renderAppCfgProgress() {
  const wrap = qs('#appCfgProgress');
  if (!wrap) return;
  wrap.classList.remove('hidden');
  const fill = qs('#appCfgProgressFill');
  if (fill) fill.style.width = `${appCfgProgressValue}%`;
  if (qs('#appCfgProgressText')) qs('#appCfgProgressText').textContent = appCfgProgressLabel;
  if (qs('#appCfgProgressPct')) qs('#appCfgProgressPct').textContent = `${Math.round(appCfgProgressValue)}%`;
}

function setAppCfgProgress(percent, label) {
  appCfgProgressValue = Math.max(0, Math.min(100, Number(percent) || 0));
  if (label) appCfgProgressLabel = label;
  renderAppCfgProgress();
}

function stopAppCfgProgressTimer() {
  if (appCfgProgressTimer) clearInterval(appCfgProgressTimer);
  appCfgProgressTimer = null;
}

// Moves quickly at first, then eases towards 90% so the bar keeps moving while
// the server validates, writes the app, and optionally runs a test launch.
function startAppCfgProgress(label = 'Preparing…') {
  stopAppCfgProgressTimer();
  appCfgProgressValue = 4;
  appCfgProgressLabel = label;
  renderAppCfgProgress();
  appCfgProgressTimer = setInterval(() => {
    if (appCfgProgressValue >= 90) return;
    appCfgProgressValue += Math.max(0.5, (90 - appCfgProgressValue) * 0.07);
    renderAppCfgProgress();
  }, 220);
}

function finishAppCfgProgress(label = 'Saved') {
  stopAppCfgProgressTimer();
  appCfgProgressValue = 100;
  appCfgProgressLabel = label;
  renderAppCfgProgress();
}

function hideAppCfgProgress() {
  stopAppCfgProgressTimer();
  appCfgProgressValue = 0;
  qs('#appCfgProgress')?.classList.add('hidden');
}

function slugifyAppName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 60);
}

async function recentlyCreatedApp(name) {
  // A proxy timeout or dropped connection can hide a successful finalize. The
  // registry is written before the test/deploy step, so use a fresh entry as proof
  // that the app exists instead of leaving the modal open for a retry.
  try {
    const list = await api('/api/registry');
    const wanted = slugifyAppName(name);
    const match = (Array.isArray(list) ? list : []).find(item => item.name === wanted);
    if (!match) return null;
    const created = Date.parse(match.created || '');
    if (Number.isFinite(created) && Date.now() - created < 10 * 60 * 1000) return match;
  } catch {}
  return null;
}

async function doAppComplete(deployNow = false, force = false, overwrite = false, confirmAmend = false) {
  if (!pendingAppConfig || appCfgCompleting) return;
  appCfgCompleting = true;
  const data = pendingAppConfig;
  const editing = !!data.editAppId;
  const btn = deployNow ? qs('#appCfgCompleteRun') : qs('#appCfgComplete');
  const otherBtn = deployNow ? qs('#appCfgComplete') : qs('#appCfgCompleteRun');
  const labels = editing
    ? { save: 'Save configuration', deploy: 'Save and deploy' }
    : { save: 'Save to library', deploy: 'Test launch (stops after test)' };
  const msg = qs('#appCfgMsg');
  const release = () => {
    appCfgCompleting = false;
    setLoading(btn, false, deployNow ? labels.deploy : labels.save);
    if (otherBtn) otherBtn.disabled = false;
  };
  const fail = () => {
    hideAppCfgProgress();
    release();
  };
  startAppCfgProgress('Preparing…');
  if (!editing && !qs('#appCfgName').value.trim()) {
    updateAppCfgRequired();
    msg.textContent = 'App title is required.';
    toast('App title is required', true);
    qs('#appCfgName').focus();
    fail();
    return;
  }
  if (appCfgBuilderModel && !appCfgBuilderManual) {
    const built = await flushAppCfgBuilderBuild();
    if (built && built.ok === false) {
      msg.textContent = 'Fix the highlighted compose builder fields before continuing.';
      toast(msg.textContent, true);
      fail();
      return;
    }
  }
  setAppCfgProgress(18, 'Building compose…');
  const compose = qs('#appCfgCompose').value;
  if (editing) {
    if (!compose.trim()) {
      msg.textContent = 'The compose file is empty.';
      fail();
      return;
    }
    if (!force) {
      setAppCfgProgress(30, 'Validating compose…');
      try {
        const check = await api('/api/compose/validate', jsonBody({ compose, appDir: data.appDir }));
        if (!check.ok) {
          showComposeIssues(check.issues, () => doAppComplete(deployNow, true));
          fail();
          return;
        }
      } catch (e) {
        toast(e.message, true);
        fail();
        return;
      }
    }
    setAppCfgProgress(62, deployNow ? 'Saving and deploying…' : 'Saving base configuration…');
    const editQuick = appCfgBuilderManual ? { vhost: '' } : appCfgBuilderQuickValues();
    const editInitialVhost = String(data.initialVhost ?? data.vhost ?? '').trim();
    setLoading(btn, true, deployNow ? 'Deploying…' : 'Saving…');
    if (otherBtn) otherBtn.disabled = true;
    msg.textContent = '';
    try {
      const res = await api(`/api/apps/${encodeURIComponent(data.editAppId)}/compose`, jsonBody({
        compose,
        network: qs('#appCfgNetwork')?.value.trim() || '',
        referenceUrl: qs('#appCfgReferenceUrl')?.value.trim() || '',
        deploy: deployNow,
        force,
        confirmAmend,
        vhostTouched: editQuick.vhost !== editInitialVhost
      }));
      finishAppCfgProgress(deployNow ? (res.pending ? 'Starting' : 'Deployed') : 'Saved');
      await new Promise(resolve => setTimeout(resolve, 600));
      qs('#appConfigModal').classList.add('hidden');
      hideAppCfgProgress();
      pendingAppConfig = null;
      pendingSaveAction = null;
      if (res.pending) toast(res.message || `${data.appName} is still starting`);
      else if (deployNow) toast(`${data.appName} deployed`);
      else toast(`${data.appName} base configuration saved`);
      if (Array.isArray(res.issues) && res.issues.length) console.log(res.issues.join('\n'));
      refreshAll();
      loadApps();
    } catch (e) {
      hideAppCfgProgress();
      if (e.data?.needsAmendApproval) {
        msg.textContent = e.message;
        showAmendApproval(
          e.data.amendments,
          () => doAppComplete(deployNow, force, overwrite, true),
          `${data.appName} would amend existing containers. Review the other instances and changes below before approving.`
        );
      } else if (e.data?.saved) {
        // The new compose is already on disk; only the deploy step failed.
        // Say so explicitly instead of making it look like the edit was lost.
        msg.textContent = `${e.message} The compose file was saved.`;
        toast(`${data.appName} compose saved, but deploy failed: ${e.message}`, true, 12000);
        refreshAll();
        loadApps();
        return;
      } else if (e.data && Array.isArray(e.data.issues) && e.data.issues.length) {
        msg.textContent = e.message;
        showComposeIssues(e.data.issues, () => doAppComplete(deployNow, true));
      } else {
        msg.textContent = e.message;
        toast(e.message, true);
      }
    } finally {
      release();
    }
    return;
  }
  const network = qs('#appCfgNetwork').value.trim() || installDefaults.defaultNetwork || 'wicked';
  const quick = appCfgBuilderManual
    ? { ports: '', vhost: '', vhostPort: '' }
    : appCfgBuilderQuickValues();
  const vhost = quick.vhost;
  const initialVhost = String(data.initialVhost ?? data.vhost ?? '').trim();

  await loadNetworksForModal();
  if (appCfgNetworksLoaded && network && !isSpecialNetworkName(network) && network !== 'wicked' &&
      network !== installDefaults.defaultNetwork &&
      !appCfgNetworks.includes(network)) {
    msg.textContent = `Network "${network}" does not exist. Create it in the "Create a network" field or choose an existing network.`;
    fail();
    return;
  }

  const payload = {
    ...data,
    appName: qs('#appCfgName').value.trim() || data.appName,
    referenceUrl: qs('#appCfgReferenceUrl')?.value.trim() || '',
    network,
    ports: quick.ports,
    vhost,
    vhostPort: quick.vhostPort,
    compose,
    composeEdited: appCfgBuilderManual || appCfgBuilderDirty || compose !== (data.initialCompose || ''),
    networkChoices: data.networkChoices || {},
    volumeChoices: data.volumeChoices || {},
    vhostTouched: vhost !== initialVhost,
    vhostService: data.vhostService || '',
    testLaunch: deployNow,
    force,
    overwrite,
    confirmAmend
  };

  if (!force) {
    setAppCfgProgress(30, 'Validating compose…');
    try {
      const check = await api('/api/compose/validate', jsonBody({ compose, appDir: data.appDir }));
      if (!check.ok) {
        showComposeIssues(check.issues, () => doAppComplete(deployNow, true));
        fail();
        return;
      }
    } catch (e) {
      toast(e.message, true);
      fail();
      return;
    }
  }
  setAppCfgProgress(48, 'Saving app…');

  setLoading(btn, true, deployNow ? 'Testing…' : 'Saving…');
  if (otherBtn) otherBtn.disabled = true;
  msg.textContent = '';
  setAppCfgProgress(62, deployNow ? 'Saving and test launching…' : 'Saving to library…');
  try {
    const res = await api('/api/launch/finalize', jsonBody(payload));
    finishAppCfgProgress(res.launchError ? 'Saved (test failed)' : res.tested ? 'Tested and stopped' : 'Saved');
    await new Promise(resolve => setTimeout(resolve, 700));
    qs('#appConfigModal').classList.add('hidden');
    hideAppCfgProgress();
    pendingAppConfig = null;
    pendingSaveAction = null;
    const dataNotice = res.dataNotice ? ` ${res.dataNotice}` : '';
    if (res.testStopError) {
      toast(`${payload.appName} was saved, but the test launch could not be stopped: ${res.testStopError}. Stop it from Apps before configuring it.${dataNotice}`, true, 15000);
    } else if (res.launchError) {
      toast(`${payload.appName} was saved, but the test launch failed: ${res.launchError}${dataNotice}`, true, 12000);
    } else if (res.launchPending) {
      toast(`${res.message || `${payload.appName} test launch did not finish`}${dataNotice}`, true, 12000);
    } else if (res.tested) {
      const states = (res.testContainers || []).map(item => `${item.name}: ${item.state}`).join(', ');
      if (res.testHealthy) {
        toast(`${payload.appName} test launch succeeded and the app was stopped. Open Apps → Deploy to configure and deploy it.${dataNotice}`, false, 12000);
      } else {
        toast(`${payload.appName} was saved, but the test launch did not stay running${states ? ` (${states})` : ''}. Open Apps → Deploy to review and fix it.${dataNotice}`, true, 15000);
      }
    } else {
      toast(`${payload.appName} was saved to the library. Open Apps → Deploy to configure and deploy it.${dataNotice}`, false, res.dataNotice ? 12000 : undefined);
    }
    if (res.stdout) console.log(res.stdout, res.stderr || '');
    refreshAll();
    loadApps();
  } catch (e) {
    hideAppCfgProgress();
    if (e.data?.created) {
      // The registry entry is the source of truth: the app was saved even if
      // the test/deploy step timed out or the connection dropped. Close instead of
      // prompting the user to install the same app again.
      finishAppCfgProgress('Saved');
      await new Promise(resolve => setTimeout(resolve, 500));
      qs('#appConfigModal').classList.add('hidden');
      hideAppCfgProgress();
      pendingAppConfig = null;
      pendingSaveAction = null;
      msg.textContent = '';
      toast(`${e.data.appName || payload.appName} was saved. Check the Apps tab before retrying.`, false, 8000);
      refreshAll();
      loadApps();
      return;
    }
    if (!e.data || Object.keys(e.data).length === 0) {
      // No structured server response (proxy timeout, dropped socket, or an
      // HTML error page). Check the registry before asking the user to retry.
      const existing = await recentlyCreatedApp(payload.appName);
      if (existing) {
        finishAppCfgProgress('Saved');
        await new Promise(resolve => setTimeout(resolve, 500));
        qs('#appConfigModal').classList.add('hidden');
        hideAppCfgProgress();
        pendingAppConfig = null;
        pendingSaveAction = null;
        msg.textContent = '';
        toast(`${existing.name} was saved. Check the Apps tab before retrying.`, false, 8000);
        refreshAll();
        loadApps();
        return;
      }
    }
    if (e.data?.alreadyFinalizing) {
      msg.textContent = e.message;
      toast('This app is already being created. Wait for it to finish.', true);
      return;
    }
    if (e.data?.needsAmendApproval) {
      msg.textContent = e.message;
      showAmendApproval(
        e.data.amendments,
        () => doAppComplete(deployNow, force, overwrite, true),
        `${payload.appName} would amend existing containers. Review the other instances and changes below before approving.`
      );
      return;
    }
    if (e.status === 409 && e.data?.needsOverwrite) {
      appCfgOverwritePending = { deployNow, force };
      qs('#appOverwriteName').textContent = e.data.appName || payload.appName;
      const dataEl = qs('#appOverwriteData');
      const existingData = Array.isArray(e.data.existingData) ? e.data.existingData : [];
      if (dataEl) {
        dataEl.textContent = existingData.length
          ? `Existing app data at ${existingData.join(', ')} will be preserved and reused. Choose a different app name or data location for fresh data, or delete the existing data manually first.`
          : '';
        dataEl.classList.toggle('hidden', !existingData.length);
      }
      qs('#appOverwriteModal').classList.remove('hidden');
      msg.textContent = e.message;
      return;
    }
    const missingNetworks = Array.isArray(e.data?.missingNetworks) ? e.data.missingNetworks : [];
    const missingVolumes = Array.isArray(e.data?.missingVolumes) ? e.data.missingVolumes : [];
    if (missingNetworks.length || missingVolumes.length) {
      pendingAppConfig = {
        ...data,
        missingNetworks,
        missingVolumes,
        networkChoices: data.networkChoices || {},
        volumeChoices: data.volumeChoices || {}
      };
      renderAppCfgNetworkNotice();
      renderAppCfgVolumeNotice();
      msg.textContent = e.message;
      toast(e.message, true);
    } else if (e.data && Array.isArray(e.data.issues) && e.data.issues.length) {
      msg.textContent = e.message;
      showComposeIssues(e.data.issues, () => doAppComplete(deployNow, true));
    } else {
      msg.textContent = e.message;
      toast(e.message, true);
    }
  } finally {
    release();
  }
}

if (qs('#appCfgComplete')) {
  qs('#appCfgComplete').addEventListener('click', () => doAppComplete(false));
}
if (qs('#appCfgCompleteRun')) {
  qs('#appCfgCompleteRun').addEventListener('click', () => doAppComplete(true));
}
if (qs('#appOverwriteConfirm')) {
  qs('#appOverwriteConfirm').addEventListener('click', () => {
    const pending = appCfgOverwritePending;
    appCfgOverwritePending = null;
    qs('#appOverwriteModal').classList.add('hidden');
    if (pending) doAppComplete(pending.deployNow, pending.force, true);
  });
}

qs('#runCreateBtn').addEventListener('click', async () => {
  const command = qs('#runCmd').value.trim();
  if (!command) return toast('Paste a docker run command first', true);
  if (!qs('#runName').value.trim()) {
    toast('App title is required', true);
    qs('#runName').focus();
    return;
  }
  const btn = qs('#runCreateBtn');
  setLoading(btn, true, 'Preparing…');
  try {
    const data = await api('/api/launch/run', jsonBody({
      command,
      name: qs('#runName').value.trim()
    }));
    openAppConfig(data);
  } catch (e) {
    toast(e.message, true);
  } finally {
    setLoading(btn, false, 'Create App');
  }
});
qs('#composeCreateBtn').addEventListener('click', async () => {
  const yaml = qs('#composeYaml').value.trim();
  if (!yaml) return toast('Paste a compose file first', true);
  if (!/services\s*:/m.test(yaml)) return toast('That does not look like a compose file (missing services:)', true);
  if (!qs('#composeName').value.trim()) {
    toast('App title is required', true);
    qs('#composeName').focus();
    return;
  }
  const btn = qs('#composeCreateBtn');
  setLoading(btn, true, 'Preparing…');
  try {
    const data = await api('/api/launch/compose', jsonBody({
      yaml,
      name: qs('#composeName').value.trim()
    }));
    openAppConfig({ ...data, compose: data.compose || data.yaml || data.generatedCompose || yaml });
  } catch (e) {
    toast(e.message, true);
  } finally {
    setLoading(btn, false, 'Create App');
  }
});

qs('#gitCloneBtn').addEventListener('click', async () => {
  const repo = qs('#gitRepo').value.trim();
  if (!repo) return toast('Enter a repository URL', true);
  if (!qs('#gitName').value.trim()) {
    toast('App title is required', true);
    qs('#gitName').focus();
    return;
  }
  const btn = qs('#gitCloneBtn');
  setLoading(btn, true, 'Cloning…');
  const out = qs('#gitOutput');
  showOutput(out, 'Cloning repository…');
  try {
    const data = await api('/api/launch/git', jsonBody({
      repo,
      name: qs('#gitName').value.trim(),
      branch: qs('#gitBranch').value.trim()
    }));
    state.lastProject = data.appName;
    if (data.toProjects || data.needsConfig === false) {
      showOutput(out, `Cloned into sources/${data.appName} (sent to Projects). No compose/Dockerfile found.`);
      const openBtn = qs('#gitOpenBtn');
      openBtn.classList.remove('hidden');
      openBtn.onclick = () => {
        state.sourceRel = data.appName;
        openTab('sources');
      };
      toast('Cloned to Projects');
      openTab('sources');
      loadSources(data.appName);
      return;
    }
    showOutput(out, `Cloned into sources/${data.appName}. Configure and create the app.`);
    const openBtn = qs('#gitOpenBtn');
    openBtn.classList.remove('hidden');
    openBtn.onclick = () => {
      state.sourceRel = data.appName;
      openTab('sources');
    };
    openAppConfig({ ...data, type: 'git', sourcePath: data.path, sourceRel: data.appName, mode: 'auto', compose: data.compose || data.generatedCompose || '', appDir: data.appDir });
    toast('Repository cloned');
  } catch (e) {
    showOutput(out, e.message + '\n' + (e.stdout || '') + (e.stderr || ''), true);
    toast(e.message, true);
  } finally {
    setLoading(btn, false, 'Create App');
  }
});

qs('#uploadBtn').addEventListener('click', async () => {
  const folderInput = qs('#uploadFolder');
  const filesInput = qs('#uploadFiles');
  const files = [
    ...Array.from(folderInput.files || []),
    ...Array.from(filesInput.files || [])
  ];
  if (!files.length) return toast('Select a folder or files to upload', true);
  if (!qs('#uploadName').value.trim()) {
    toast('App title is required', true);
    qs('#uploadName').focus();
    return;
  }
  const btn = qs('#uploadBtn');
  setLoading(btn, true, 'Uploading…');
  const out = qs('#uploadOutput');
  showOutput(out, `Uploading ${files.length} file(s)…`);
  const form = new FormData();
  const paths = [];
  for (const f of files) {
    form.append('files', f, f.name);
    paths.push(f.webkitRelativePath || f.name);
  }
  form.append('name', qs('#uploadName').value.trim());
  form.append('paths', JSON.stringify(paths));
  try {
    const res = await fetch('/api/launch/upload', { method: 'POST', body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    if (data.toProjects || data.needsConfig === false) {
      showOutput(out, `Uploaded ${data.count} file(s) into sources/${data.appName} (sent to Projects). No compose/Dockerfile found.`);
      const openBtn = qs('#uploadOpenBtn');
      openBtn.classList.remove('hidden');
      openBtn.onclick = () => {
        state.sourceRel = data.appName;
        openTab('sources');
      };
      folderInput.value = '';
      filesInput.value = '';
      toast('Uploaded to Projects');
      openTab('sources');
      loadSources(data.appName);
      return;
    }
    showOutput(out, `Uploaded ${data.count} file(s) into sources/${data.appName}. Configure and create the app.`);
    const openBtn = qs('#uploadOpenBtn');
    openBtn.classList.remove('hidden');
    openBtn.onclick = () => {
      state.sourceRel = data.appName;
      openTab('sources');
    };
    folderInput.value = '';
    filesInput.value = '';
    openAppConfig({ ...data, type: 'upload', sourcePath: data.path, sourceRel: data.appName, mode: 'auto', compose: data.compose || data.generatedCompose || '', appDir: data.appDir });
    toast('Files uploaded');
  } catch (e) {
    showOutput(out, e.message, true);
    toast(e.message, true);
  } finally {
    setLoading(btn, false, 'Create App');
  }
});

// ---------------- Projects / sources ----------------
function badge(text, cls = 'muted-chip') {
  return `<span class="chip ${cls}">${escapeHtml(text)}</span>`;
}

async function loadSources(rel) {
  if (typeof rel === 'string') state.sourceRel = rel || '.';
  const list = qs('#sourcesFiles');
  try {
    const data = await api(`/api/sources/list?path=${encodeURIComponent(state.sourceRel === '.' ? '' : state.sourceRel)}`);
    state.sourceRel = data.rel === '.' ? '.' : data.rel;
    qs('#sourcesPath').value = data.rel === '.' ? '' : data.rel;
    state.sourceInfo = data;

    const projectName = data.rel === '.' ? '' : data.rel.split('/')[0];
    if (projectName) qs('#sourceName').value = projectName;
    if (data.isRoot) {
      qs('#sourceName').value = '';
      qs('#sourceBadges').innerHTML = badge('Select a project folder');
    } else {
      const badges = [];
      if (data.composeFile) badges.push(badge(`compose: ${data.composeFile}`, 'type'));
      if (data.hasDockerfile) badges.push(badge('Dockerfile', 'type'));
      if (!data.composeFile && !data.hasDockerfile) badges.push(badge('No compose/Dockerfile — use a docker run command', 'muted-chip'));
      qs('#sourceBadges').innerHTML = badges.join('');
    }
    qs('#sourceDeployBtn').disabled = !!data.isRoot;

    const root = data.items.map(item => {
      const icon = item.type === 'dir' ? `<span class="file-icon dir">${ICONS.folder}</span>` : `<span class="file-icon">${ICONS.file}</span>`;
      return `<button class="file-item ${item.type}" data-type="${item.type}" data-rel="${escapeHtml(item.rel)}">
        ${icon}<span>${escapeHtml(item.name)}</span>
        ${item.type === 'file' ? `<span class="size">${fmtBytes(item.size)}</span>` : ''}
      </button>`;
    });

    const crumbs = [];
    if (!data.isRoot) {
      const parts = data.rel.split('/');
      const backRel = parts.slice(0, -1).join('/');
      crumbs.push(`<button class="file-item" data-type="dir" data-rel="${escapeHtml(backRel)}"><span class="file-icon dir">${ICONS.folder}</span><span>..</span></button>`);
    }
    list.innerHTML = crumbs.concat(root).join('') || '<div class="empty">Empty folder</div>';

    list.querySelectorAll('.file-item').forEach(btn => {
      btn.addEventListener('click', () => {
        const target = btn.dataset.rel;
        if (btn.dataset.type === 'dir') {
          loadSources(target);
        } else {
          list.querySelectorAll('.file-item').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          qs('#editPath').value = target;
          loadFile(target);
        }
      });
    });
    return data;
  } catch (e) {
    list.innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`;
    qs('#sourceBadges').innerHTML = '';
    return null;
  }
}

async function loadFile(rel) {
  const msg = qs('#editMsg');
  try {
    msg.textContent = 'Loading…';
    const data = await api(`/api/sources/file?path=${encodeURIComponent(rel)}`);
    qs('#editContent').value = data.content;
    msg.textContent = '';
  } catch (e) {
    msg.textContent = e.message;
  }
}

qs('#sourcesListBtn').addEventListener('click', () => loadSources(qs('#sourcesPath').value.trim()));
qs('#sourcesRefresh').addEventListener('click', () => loadSources(state.sourceRel));
qs('#sourcesUp').addEventListener('click', () => {
  const parts = state.sourceRel.split('/').filter(Boolean);
  parts.pop();
  loadSources(parts.join('/') || '.');
});
qs('#sourcesPath').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') loadSources(qs('#sourcesPath').value.trim());
});

qs('#sourceMode').addEventListener('change', (e) => {
  qs('#sourceCommand').classList.toggle('hidden', e.target.value !== 'run');
});

qs('#sourceDeployBtn').addEventListener('click', async () => {
  if (!state.sourceRel || state.sourceRel === '.') return toast('Open a project folder first', true);
  if (!qs('#sourceName').value.trim()) {
    toast('App title is required', true);
    qs('#sourceName').focus();
    return;
  }
  const btn = qs('#sourceDeployBtn');
  const out = qs('#sourceOutput');
  setLoading(btn, true, 'Preparing…');
  showOutput(out, 'Preparing project…');
  try {
    const data = await api('/api/launch/source', jsonBody({
      path: state.sourceRel,
      mode: qs('#sourceMode').value,
      name: qs('#sourceName').value.trim(),
      ports: qs('#sourcePorts').value.trim(),
      command: qs('#sourceCommand').value.trim(),
      vhost: qs('#sourceVhost').value.trim(),
      vhostPort: qs('#sourceVport').value.trim()
    }));
    if (data.toProjects || data.needsConfig === false) {
      showOutput(out, `Sent to Projects. No compose/Dockerfile found.`);
      toast('Sent to Projects');
      openTab('sources');
      loadSources(state.sourceRel);
      return;
    }
    showOutput(out, `Ready to configure ${data.appName}.`);
    openAppConfig({
      ...data,
      type: 'source',
      sourcePath: data.path,
      sourceRel: state.sourceRel,
      mode: qs('#sourceMode').value,
      ports: qs('#sourcePorts').value.trim(),
      vhost: qs('#sourceVhost').value.trim(),
      vhostPort: qs('#sourceVport').value.trim(),
      compose: data.compose || data.generatedCompose || '',
      appDir: data.appDir
    });
  } catch (e) {
    showOutput(out, e.message + '\n' + (e.stdout || '') + (e.stderr || ''), true);
    toast(e.message, true);
  } finally {
    setLoading(btn, false, 'Deploy project');
  }
});

qs('#loadFileBtn').addEventListener('click', () => {
  const p = qs('#editPath').value.trim();
  if (p) loadFile(p);
});

qs('#saveFileBtn').addEventListener('click', async () => {
  const p = qs('#editPath').value.trim();
  if (!p) return toast('Choose a file path first', true);
  const msg = qs('#editMsg');
  try {
    await api('/api/sources/file', jsonBody({ path: p, content: qs('#editContent').value }));
    msg.textContent = 'Saved';
    toast(`Saved ${p}`);
    setTimeout(() => { msg.textContent = ''; }, 1600);
    loadSources(state.sourceRel);
  } catch (e) {
    msg.textContent = e.message;
    toast(e.message, true);
  }
});

qs('#newFileBtn').addEventListener('click', () => {
  const base = state.sourceRel === '.' ? '' : state.sourceRel + '/';
  const name = prompt('New file path (relative to sources root):', base + 'new-file.txt');
  if (!name) return;
  qs('#editPath').value = name;
  qs('#editContent').value = '';
  qs('#editPath').focus();
  toast('Enter contents, then press Save file');
});

// ---------------- Registry ----------------
const typeLabels = { run: 'docker run', compose: 'compose', source: 'project', git: 'git', upload: 'upload', container: 'container' };

let amendApprovalAction = null;

function renderAmendApproval(amendments, intro) {
  const body = qs('#amendApprovalBody');
  if (!body) return;
  const data = amendments || {};
  const instances = Array.isArray(data.instances) ? data.instances : [];
  const changes = Array.isArray(data.changes) ? data.changes : [];
  qs('#amendApprovalIntro').textContent = intro || 'Dok needs to amend existing containers before this app can start. Other instances of the app are listed below. Review the changes and approve them to continue.';
  const instanceRows = instances.length
    ? instances.map(item => `
      <div class="item">
        <div class="item-header">
          <div>
            <div class="item-title mono">${escapeHtml(item.name)} ${item.action === 'rename' ? badge('other instance', 'type') : badge('this app', 'type')}</div>
            <div class="item-sub">${escapeHtml(item.project || 'standalone')}${item.service ? ` · service ${escapeHtml(item.service)}` : ''}${item.state ? ` · ${escapeHtml(item.state)}` : ''}</div>
            <div class="item-sub mono">${escapeHtml(item.image || '')}${item.nextName ? ` → ${escapeHtml(item.nextName)}` : ''}</div>
          </div>
        </div>
      </div>`).join('')
    : '<p class="muted">No running containers were found for this app.</p>';
  body.innerHTML = `
    <div class="builder-group">
      <strong>Affected app instances</strong>
      ${instanceRows}
    </div>
    <div class="builder-group">
      <strong>Changes to apply</strong>
      ${changes.length ? `<ul>${changes.map(change => `<li>${escapeHtml(change)}</li>`).join('')}</ul>` : '<p class="muted">No container changes are needed.</p>'}
    </div>`;
  qs('#amendApprovalModal')?.classList.remove('hidden');
}

function showAmendApproval(amendments, action, intro) {
  amendApprovalAction = typeof action === 'function' ? action : null;
  renderAmendApproval(amendments, intro);
}

if (qs('#amendApprove')) {
  qs('#amendApprove').addEventListener('click', async () => {
    const action = amendApprovalAction;
    amendApprovalAction = null;
    qs('#amendApprovalModal')?.classList.add('hidden');
    if (action) await action();
  });
}

async function loadRegistry() {
  const list = qs('#appsList') || qs('#registryList');
  if (!list) return;
  try {
    const raw = await api('/api/registry');
    const data = Array.isArray(raw) ? raw : [];
    if (!data.length) {
      list.innerHTML = '<div class="empty">No apps yet. Create an app from App Creation.</div>';
      return;
    }
    list.innerHTML = data.map(entry => {
      const launch = entry.launch || {};
      const detail = entry.appDir || entry.path || '';
      const meta = [
        launch.network ? `network: ${launch.network}` : '',
        launch.ports && launch.ports.length ? `ports: ${Array.isArray(launch.ports) ? launch.ports.join(', ') : launch.ports}` : '',
        launch.vhost ? `domain: ${launch.vhost}` : '',
        entry.dataPath ? `data: ${entry.dataPath}` : ''
      ].filter(Boolean).join(' · ');
      return `
        <div class="item" data-id="${escapeHtml(entry.id)}">
          <div class="item-header">
            <div>
              <div class="item-title">${escapeHtml(entry.name)} ${badge(typeLabels[entry.type] || entry.type, 'type')} ${entry.needsConfig ? badge('needs setup', 'type') : (entry.library ? badge('library', 'type') : '')}</div>
              <div class="item-sub mono">${escapeHtml(detail)}</div>
              ${entry.referenceUrl ? `<div class="item-sub"><a href="${escapeHtml(entry.referenceUrl)}" target="_blank" rel="noopener noreferrer">Official repository / website ↗</a></div>` : ''}
              <div class="item-sub">${meta ? escapeHtml(meta) + ' · ' : ''}${entry.needsConfig ? 'Configure before deploying · ' : ''}Saved ${entry.created ? new Date(entry.created).toLocaleString() : 'unknown'}</div>
            </div>
            <div class="item-actions">
              <button class="btn btn-primary" data-act="deploy">${entry.needsConfig ? 'Configure & Deploy' : 'Deploy'}</button>
              <button class="btn" data-act="stop">Stop</button>
              ${entry.sourcePath && !String(entry.sourcePath).startsWith('/') ? '<button class="btn" data-act="browse">Browse</button>' : ''}
              <button class="btn btn-danger" data-act="delete">Remove</button>
            </div>
          </div>
        </div>`;
    }).join('');

    list.querySelectorAll('.item').forEach(item => {
      const entry = data.find(e => e.id === item.dataset.id);
      item.querySelectorAll('button[data-act]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const act = btn.dataset.act;
          if (act === 'delete') {
            if (!confirm(`Remove "${entry.name}" from Apps? The app directory is kept on disk.`)) return;
            try {
              await api(`/api/registry/${encodeURIComponent(entry.id)}`, { method: 'DELETE' });
              toast('App removed');
              loadApps();
            } catch (e) {
              toast(e.message, true);
            }
            return;
          }
          if (act === 'browse') {
            state.sourceRel = entry.sourcePath || '.';
            openTab('sources');
            return;
          }
          if (act === 'deploy') {
            setLoading(btn, true, 'Loading…');
            try {
              const res = await api(`/api/apps/${encodeURIComponent(entry.id)}/compose`);
              const issues = Array.isArray(res.issues) ? [...res.issues] : [];
              if (Array.isArray(res.missingNetworks) && res.missingNetworks.length) {
                issues.push(`Networks not found on this server: ${res.missingNetworks.map(net => net.name || net.key || net).join(', ')}. Update the network fields or create the networks before deploying.`);
              }
              if (Array.isArray(res.missingVolumes) && res.missingVolumes.length) {
                issues.push(`Host paths not found: ${res.missingVolumes.map(item => item.source || item).join(', ')}. Update the volume sources before deploying.`);
              }
              openAppConfig({
                appName: entry.name,
                appDir: res.appDir,
                compose: res.compose,
                editAppId: entry.id,
                referenceUrl: res.referenceUrl || entry.referenceUrl || '',
                network: res.network || entry.launch?.network || 'wicked',
                vhost: res.vhost || entry.launch?.vhost || '',
                vhostPort: res.vhostPort || entry.launch?.vhostPort || '',
                vhostService: res.vhostService || '',
                issues,
                needsConfiguration: !!entry.needsConfig
              });
            } catch (e) {
              toast(e.message, true);
            } finally {
              setLoading(btn, false);
            }
            return;
          }

          setLoading(btn, true, `${act[0].toUpperCase()}${act.slice(1)}…`);
          try {
            await api(`/api/registry/${encodeURIComponent(entry.id)}/${act}`, jsonBody({}));
            toast(`${entry.name}: ${act} requested`);
            loadApps();
            refreshAll();
          } catch (e) {
            toast(e.message, true);
          } finally {
            setLoading(btn, false);
          }
        });
      });
    });
  } catch (e) {
    list.innerHTML = `<div class="empty">Unable to load apps: ${escapeHtml(e.message)}</div>`;
  }
}

async function loadApps() {
  return loadRegistry();
}
if (qs('#registryRefresh')) qs('#registryRefresh').addEventListener('click', loadApps);
if (qs('#appsRefresh')) qs('#appsRefresh').addEventListener('click', loadApps);

// ---------------- App library export/import ----------------
async function openLibraryExport() {
  const modal = qs('#libraryExportModal');
  const list = qs('#libraryExportList');
  if (!modal || !list) return;
  modal.classList.remove('hidden');
  if (qs('#libraryExportName')) qs('#libraryExportName').value = `Dok app library ${new Date().toLocaleDateString()}`;
  if (qs('#libraryExportMsg')) qs('#libraryExportMsg').textContent = '';
  list.innerHTML = '<div class="empty">Loading apps…</div>';
  try {
    const data = await api('/api/registry');
    if (!Array.isArray(data) || !data.length) {
      list.innerHTML = '<div class="empty">No apps are available to export.</div>';
      return;
    }
    list.innerHTML = data.map(entry => `
      <label class="item" style="cursor:pointer">
        <div class="item-header">
          <div>
            <div class="item-title"><input type="checkbox" value="${escapeHtml(entry.id)}" checked> ${escapeHtml(entry.name)} ${badge(typeLabels[entry.type] || entry.type, 'type')}</div>
            <div class="item-sub mono">${escapeHtml(entry.appDir || entry.path || '')}</div>
            ${entry.library?.name ? `<div class="item-sub">Exported from ${escapeHtml(entry.library.name)}</div>` : ''}
          </div>
        </div>
      </label>`).join('');
  } catch (e) {
    list.innerHTML = `<div class="empty">Unable to load apps: ${escapeHtml(e.message)}</div>`;
  }
}

if (qs('#libraryExportBtn')) qs('#libraryExportBtn').addEventListener('click', openLibraryExport);
if (qs('#libraryExportDo')) {
  qs('#libraryExportDo').addEventListener('click', async () => {
    const btn = qs('#libraryExportDo');
    const msg = qs('#libraryExportMsg');
    const ids = qsa('#libraryExportList input[type="checkbox"]').filter(input => input.checked).map(input => input.value);
    if (!ids.length) {
      if (msg) msg.textContent = 'Select at least one app.';
      return;
    }
    setLoading(btn, true, 'Exporting…');
    if (msg) msg.textContent = '';
    try {
      const res = await fetch('/api/library/export', jsonBody({
        apps: ids,
        name: qs('#libraryExportName')?.value.trim() || 'Dok app library'
      }));
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || res.statusText || 'Export failed');
      }
      const blob = await res.blob();
      const disposition = res.headers.get('content-disposition') || '';
      const match = disposition.match(/filename="?([^";]+)"?/i);
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = match ? match[1] : 'dok-library.tar.gz';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 5000);
      qs('#libraryExportModal')?.classList.add('hidden');
      toast(`Exported ${ids.length} app${ids.length === 1 ? '' : 's'}`, false, 6000);
    } catch (e) {
      if (msg) msg.textContent = e.message;
      toast(e.message, true);
    } finally {
      setLoading(btn, false, 'Export selected apps');
    }
  });
}

async function importLibraryFile(file, overwrite = false) {
  const form = new FormData();
  form.append('file', file);
  form.append('overwrite', overwrite ? 'true' : 'false');
  const res = await fetch('/api/library/import', { method: 'POST', body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || res.statusText || 'Import failed');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

if (qs('#libraryImportFile')) {
  qs('#libraryImportFile').addEventListener('change', async (event) => {
    const input = event.target;
    const file = input.files?.[0];
    if (!file) return;
    try {
      let result;
      try {
        result = await importLibraryFile(file, false);
      } catch (e) {
        if (e.status === 409 && e.data?.needsOverwrite) {
          const names = Array.isArray(e.data.apps) ? e.data.apps.join(', ') : 'the selected apps';
          if (!confirm(`${names} already exist. Overwrite their app files? Existing app data is preserved and reused.`)) throw e;
          result = await importLibraryFile(file, true);
        } else {
          throw e;
        }
      }
      toast(result.message || `Imported ${result.imported?.length || 0} app${result.imported?.length === 1 ? '' : 's'}`, false, result.reuseData?.length ? 14000 : 9000);
      await loadApps();
      refreshAll();
    } catch (e) {
      toast(e.message, true, 8000);
    } finally {
      input.value = '';
    }
  });
}


async function importLibraryRepo(payload, overwrite = false) {
  const res = await fetch('/api/library/import-repo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, overwrite })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || res.statusText || 'Import failed');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

if (qs('#libraryImportRepoBtn')) {
  qs('#libraryImportRepoBtn').addEventListener('click', () => {
    const msg = qs('#libraryRepoMsg');
    if (msg) msg.textContent = '';
    qs('#libraryRepoModal')?.classList.remove('hidden');
  });
}

if (qs('#libraryRepoDo')) {
  qs('#libraryRepoDo').addEventListener('click', async () => {
    const btn = qs('#libraryRepoDo');
    const msg = qs('#libraryRepoMsg');
    const payload = {
      repo: qs('#libraryRepoUrl')?.value.trim() || '',
      branch: qs('#libraryRepoBranch')?.value.trim() || '',
      path: qs('#libraryRepoPath')?.value.trim() || '',
      name: qs('#libraryRepoName')?.value.trim() || ''
    };
    if (!payload.repo) {
      if (msg) msg.textContent = 'Repository URL is required';
      return;
    }
    const setBusy = (busy, text) => {
      if (btn) { btn.disabled = busy; btn.textContent = busy ? 'Cloning…' : 'Clone and import'; }
      if (msg) msg.textContent = text || '';
    };
    setBusy(true, 'Cloning repository and importing apps…');
    try {
      let result;
      try {
        result = await importLibraryRepo(payload, false);
      } catch (e) {
        if (e.status === 409 && e.data?.needsOverwrite) {
          const names = Array.isArray(e.data.apps) ? e.data.apps.join(', ') : 'the selected apps';
          if (!confirm(`${names} already exist. Overwrite their app files? Existing app data is preserved and reused.`)) throw e;
          result = await importLibraryRepo(payload, true);
        } else {
          throw e;
        }
      }
      setBusy(false, result.message || 'Import complete');
      toast(result.message || `Imported ${result.imported?.length || 0} app${result.imported?.length === 1 ? '' : 's'}`, false, result.reuseData?.length ? 14000 : 9000);
      closeModal('libraryRepoModal');
      await loadApps();
      refreshAll();
    } catch (e) {
      setBusy(false, e.message || 'Import failed');
      toast(e.message || 'Import failed', true, 8000);
    }
  });
}

// ---------------- Settings ----------------
let coreCfData = null;
let updateWatcher = null;

async function loadUpdateInfo() {
  try {
    const info = await api('/api/system/update-info');
    const repo = qs('#updateRepo');
    const branch = qs('#updateBranch');
    const meta = qs('#updateMeta');
    const btn = qs('#updateFromGitBtn');
    if (repo && !repo.value) repo.value = info.repo || '';
    if (branch && !branch.value) branch.value = info.branch || 'main';
    if (btn) {
      const label = info.docker ? 'Update & Restart' : 'Update from Git';
      btn.dataset.label = label;
      if (!btn.disabled) btn.textContent = label;
    }
    if (meta) {
      if (info.commit) {
        meta.textContent = `Current ${info.branch || 'HEAD'} ${info.commit}` +
          (info.subject ? ` · ${info.subject}` : '') +
          (info.dirty ? ' · local changes' : '');
      } else {
        meta.textContent = info.repo
          ? 'No local checkout yet; the first update initializes it.'
          : 'No repository configured.';
      }
    }
    if (info.running && !updateWatcher) watchUpdateJob();
  } catch {
    // Settings still work when git is not available.
  }
}

async function watchUpdateJob() {
  const btn = qs('#updateFromGitBtn');
  const out = qs('#updateOutput');
  if (!btn) return;
  if (updateWatcher) return updateWatcher;
  updateWatcher = true;
  setLoading(btn, true, 'Updating…');
  if (out) {
    out.classList.remove('hidden');
    if (!out.textContent.trim()) out.textContent = 'Starting update…';
  }
  const started = Date.now();
  try {
    while (Date.now() - started < 15 * 60 * 1000) {
      await new Promise(resolve => setTimeout(resolve, 3000));
      let status;
      try {
        status = await api('/api/system/update-status');
      } catch {
        if (out) out.textContent += '\n\nWickedAFDok is restarting. Waiting for it to come back…';
        await waitForReconnect(5 * 60 * 1000, 6000);
        setLoading(btn, false, btn.dataset.label || 'Update from Git');
        return;
      }
      if (out) {
        out.textContent = `Update ${status.commit || ''} · ${status.phase || 'working'}\n\n${status.log || ''}`;
        out.scrollTop = out.scrollHeight;
      }
      if (status.phase === 'error') {
        toast(`Update failed: ${status.error || 'see the log'}`, true, 9000);
        setLoading(btn, false, btn.dataset.label || 'Update from Git');
        return;
      }
      if (status.phase === 'recreating' && !status.running) {
        if (out) out.textContent += '\n\nContainer restarting. Waiting for WickedAFDok…';
        await waitForReconnect(5 * 60 * 1000, 6000);
        setLoading(btn, false, btn.dataset.label || 'Update from Git');
        return;
      }
      if (!status.running && status.phase === 'idle') {
        toast('Update finished');
        setLoading(btn, false, btn.dataset.label || 'Update from Git');
        return;
      }
    }
    toast('Update is taking longer than expected', true, 9000);
    setLoading(btn, false, btn.dataset.label || 'Update from Git');
  } finally {
    updateWatcher = null;
  }
}

async function runGitUpdate(force = false) {
  const btn = qs('#updateFromGitBtn');
  const out = qs('#updateOutput');
  setLoading(btn, true, 'Updating…');
  if (out) {
    out.textContent = 'Fetching from the repository…';
    out.classList.remove('hidden');
  }
  try {
    const res = await api('/api/system/update-from-git', jsonBody({
      repo: qs('#updateRepo') ? qs('#updateRepo').value.trim() : '',
      branch: qs('#updateBranch') ? qs('#updateBranch').value.trim() : '',
      force
    }));
    const lines = [
      res.upToDate
        ? `Already up to date at ${res.commit}`
        : `Updated ${res.previousCommit ? `${res.previousCommit} → ` : ''}${res.commit} (${res.branch})`,
      res.subject || '',
      '',
      res.stdout || '',
      res.stderr || '',
      res.message || ''
    ].filter(line => line !== '');
    if (out) {
      out.textContent = lines.join('\n');
      out.scrollTop = out.scrollHeight;
    }
    if (res.running) {
      watchUpdateJob();
      return;
    }
    setLoading(btn, false, btn.dataset.label || 'Update from Git');
    toast(res.message || 'Update complete', false, res.restartRequired ? 8000 : 3800);
    loadUpdateInfo();
  } catch (e) {
    if (e.status === 409 && e.data?.dirty && !force) {
      setLoading(btn, false, btn.dataset.label || 'Update from Git');
      if (confirm('The source checkout has local changes. Overwrite them and continue?')) {
        return runGitUpdate(true);
      }
      if (out) out.textContent = e.message;
      return;
    }
    setLoading(btn, false, btn.dataset.label || 'Update from Git');
    if (out) {
      out.textContent = e.message + '\n' + (e.stdout || '') + (e.stderr || '');
      out.classList.remove('hidden');
    }
    toast(e.message, true, 8000);
  }
}

let installDefaults = {
  primaryDomain: '', dokDomain: '', dataLocation: '', dataMode: '0775',
  allowOutsideData: true, autoAppData: true, adminUser: 'admin',
  adminEmail: '', defaultNetwork: 'wicked', protectDok: false
};

function suggestedServiceDomain(prefix) {
  return installDefaults.primaryDomain ? `${prefix}.${installDefaults.primaryDomain}` : '';
}

function applyDefaultsToServiceForms() {
  const defaults = installDefaults || {};
  const autheliaDomain = qs('#autheliaDomain');
  if (autheliaDomain && !autheliaDomain.value.trim()) autheliaDomain.placeholder = `Portal domain, e.g. ${suggestedServiceDomain('auth') || 'auth.example.com'}`;
  if (qs('#autheliaUser') && (!qs('#autheliaUser').value.trim() || qs('#autheliaUser').value === 'admin')) {
    qs('#autheliaUser').value = defaults.adminUser || 'admin';
  }
  if (qs('#autheliaEmail') && !qs('#autheliaEmail').value.trim()) qs('#autheliaEmail').value = defaults.adminEmail || '';
  if (qs('#autheliaDomain') && !qs('#autheliaDomain').value.trim() && suggestedServiceDomain('auth')) {
    qs('#autheliaDomain').value = suggestedServiceDomain('auth');
  }
  if (qs('#authDomain') && !qs('#authDomain').value.trim() && suggestedServiceDomain('sso')) {
    qs('#authDomain').value = suggestedServiceDomain('sso');
  }
  if (qs('#authEmail') && !qs('#authEmail').value.trim()) qs('#authEmail').value = defaults.adminEmail || '';
  if (qs('#dnsDomain') && !qs('#dnsDomain').value.trim() && suggestedServiceDomain('dns')) {
    qs('#dnsDomain').value = suggestedServiceDomain('dns');
  }
  if (qs('#mailpitDomain') && !qs('#mailpitDomain').value.trim() && suggestedServiceDomain('mail')) {
    qs('#mailpitDomain').value = suggestedServiceDomain('mail');
  }
  if (qs('#nginxDomain') && !qs('#nginxDomain').value.trim() && defaults.dokDomain) {
    qs('#nginxDomain').value = defaults.dokDomain;
  }
  if (qs('#appCfgNetwork') && (!qs('#appCfgNetwork').value.trim() || qs('#appCfgNetwork').value === 'wicked')) {
    renderAppCfgNetworkOptions(defaults.defaultNetwork || 'wicked');
  }
}

async function loadDefaults() {
  try {
    const res = await api('/api/settings/defaults');
    installDefaults = res.defaults || installDefaults;
    const d = installDefaults;
    if (qs('#defaultsPrimaryDomain')) qs('#defaultsPrimaryDomain').value = d.primaryDomain || '';
    if (qs('#defaultsDokDomain')) qs('#defaultsDokDomain').value = d.dokDomain || '';
    if (qs('#defaultsDataLocation')) qs('#defaultsDataLocation').value = d.dataLocation || '';
    if (qs('#defaultsDataMode')) qs('#defaultsDataMode').value = d.dataMode || '0775';
    if (qs('#defaultsAllowOutsideData')) qs('#defaultsAllowOutsideData').checked = d.allowOutsideData !== false;
    if (qs('#defaultsAutoAppData')) qs('#defaultsAutoAppData').checked = d.autoAppData !== false;
    if (qs('#defaultsAdminUser')) qs('#defaultsAdminUser').value = d.adminUser || 'admin';
    if (qs('#defaultsAdminEmail')) qs('#defaultsAdminEmail').value = d.adminEmail || '';
    if (qs('#defaultsAdminPassword')) qs('#defaultsAdminPassword').value = '';
    if (qs('#defaultsClearAdminPassword')) qs('#defaultsClearAdminPassword').checked = false;
    if (qs('#defaultsNetwork')) qs('#defaultsNetwork').value = d.defaultNetwork || 'wicked';
    if (qs('#defaultsProtectDok')) qs('#defaultsProtectDok').checked = !!d.protectDok;
    if (qs('#autheliaProtectDok')) qs('#autheliaProtectDok').checked = !!d.protectDok;
    if (qs('#defaultsPasswordState')) {
      qs('#defaultsPasswordState').textContent = d.adminPasswordSet
        ? 'A default admin password is stored. Leave the password field blank to keep it.'
        : 'No default admin password stored yet.';
    }
    applyDefaultsToServiceForms();
  } catch (e) {
    if (qs('#defaultsMsg')) qs('#defaultsMsg').textContent = e.message;
  }
}

function defaultsPayload() {
  const payload = {
    primaryDomain: qs('#defaultsPrimaryDomain')?.value.trim() || '',
    dokDomain: qs('#defaultsDokDomain')?.value.trim() || '',
    dataLocation: qs('#defaultsDataLocation')?.value.trim() || '',
    dataMode: qs('#defaultsDataMode')?.value.trim() || '0775',
    allowOutsideData: !!qs('#defaultsAllowOutsideData')?.checked,
    autoAppData: !!qs('#defaultsAutoAppData')?.checked,
    adminUser: qs('#defaultsAdminUser')?.value.trim() || 'admin',
    adminEmail: qs('#defaultsAdminEmail')?.value.trim() || '',
    defaultNetwork: qs('#defaultsNetwork')?.value.trim() || 'wicked',
    protectDok: !!qs('#defaultsProtectDok')?.checked,
    clearAdminPassword: !!qs('#defaultsClearAdminPassword')?.checked
  };
  const password = qs('#defaultsAdminPassword')?.value || '';
  if (password) payload.adminPassword = password;
  return payload;
}

async function saveDefaults() {
  const btn = qs('#saveDefaults');
  const msg = qs('#defaultsMsg');
  setLoading(btn, true, 'Saving…');
  if (msg) msg.textContent = '';
  try {
    const res = await api('/api/settings/defaults', jsonBody(defaultsPayload()));
    installDefaults = res.defaults || installDefaults;
    if (msg) msg.textContent = res.dataLocation ? `Saved. Data location is ready at ${res.dataLocation} (${res.dataMode}).` : 'Saved.';
    toast('Default settings saved');
    await loadDefaults();
    applyDefaultsToServiceForms();
    return res;
  } catch (e) {
    if (msg) msg.textContent = e.message;
    // The server may have reverted protectDok after a failed sync; use its
    // reported value instead of assuming the previous checkbox state.
    if (typeof e.data?.protectDok === 'boolean') installDefaults.protectDok = e.data.protectDok;
    if (qs('#defaultsProtectDok')) qs('#defaultsProtectDok').checked = !!installDefaults.protectDok;
    if (qs('#autheliaProtectDok')) qs('#autheliaProtectDok').checked = !!installDefaults.protectDok;
    toast(e.message, true);
    throw e;
  } finally {
    setLoading(btn, false, 'Save defaults');
  }
}

if (qs('#saveDefaults')) qs('#saveDefaults').addEventListener('click', () => saveDefaults().catch(() => {}));
if (qs('#defaultsRefresh')) qs('#defaultsRefresh').addEventListener('click', loadDefaults);
if (qs('#defaultsApplyData')) {
  qs('#defaultsApplyData').addEventListener('click', async () => {
    const btn = qs('#defaultsApplyData');
    const msg = qs('#defaultsMsg');
    setLoading(btn, true, 'Applying…');
    try {
      await saveDefaults();
      const res = await api('/api/settings/defaults/apply', jsonBody({}));
      if (msg) msg.textContent = res.dataLocation
        ? `Created ${res.dataLocation} with permissions ${res.dataMode}.`
        : 'Set a data location first.';
      toast(res.dataLocation ? 'Data location ready' : 'Set a data location first', !res.dataLocation);
    } catch (e) {
      if (msg) msg.textContent = e.message;
      toast(e.message, true);
    } finally {
      setLoading(btn, false, 'Create and apply');
    }
  });
}

async function loadSettings() {
  try {
    await loadDefaults();
    const s = await api('/api/settings');
    if (qs('#nginxNetwork')) qs('#nginxNetwork').value = s.services?.nginxProxy?.network || 'wicked';
    if (qs('#nginxPort')) {
      const v = s.services?.nginxProxy?.defaultVhostPort;
      qs('#nginxPort').value = v === undefined || v === null ? 80 : v;
    }
    if (qs('#nginxDomain')) qs('#nginxDomain').value = s.services?.nginxProxy?.domain || '';
    if (qs('#cfToken')) {
      qs('#cfToken').value = '';
      qs('#cfToken').placeholder = s.services?.cloudflared?.tokenSet
        ? 'Token saved (leave blank to keep)'
        : 'Cloudflare tunnel token';
    }
    if (qs('#authEmail')) qs('#authEmail').value = s.services?.authentik?.adminEmail || '';
    if (qs('#authPort')) qs('#authPort').value = s.services?.authentik?.port || 9000;
    if (qs('#authDomain')) qs('#authDomain').value = s.services?.authentik?.domain || '';
    if (qs('#autheliaDomain')) qs('#autheliaDomain').value = s.services?.authelia?.domain || '';
    if (qs('#autheliaPort')) qs('#autheliaPort').value = s.services?.authelia?.port || 9091;
    if (qs('#autheliaUser')) qs('#autheliaUser').value = s.services?.authelia?.adminUser || 'admin';
    if (qs('#autheliaEmail')) qs('#autheliaEmail').value = s.services?.authelia?.adminEmail || '';
    if (qs('#dnsWebPort')) qs('#dnsWebPort').value = s.services?.technitium?.webPort || 5380;
    if (qs('#dnsDnsPort')) qs('#dnsDnsPort').value = s.services?.technitium?.dnsPort || 53;
    if (qs('#dnsDomain')) qs('#dnsDomain').value = s.services?.technitium?.domain || '';
    loadCoreNginx();
    loadCoreCloudflared();
    loadCoreAuth();
    loadCoreAuthelia();
    loadCoreMail();
    loadCoreDns();
    loadCoreHelper();
    loadCoreOpencode();
    loadBackups();
    loadAppLogChoices();
    loadGroups();
    loadRegistries();
    loadUpdateInfo();
  } catch (e) {
    toast(e.message, true);
  }
}

qs('#settingsRefresh').addEventListener('click', loadSettings);

if (qs('#updateFromGitBtn')) {
  qs('#updateFromGitBtn').addEventListener('click', () => runGitUpdate(false));
}

let maintenanceData = null;

async function loadMaintenanceStatus() {
  try {
    const res = await api('/api/maintenance');
    maintenanceData = res.maintenance || null;
    const status = qs('#maintenanceStatus');
    if (status && maintenanceData) {
      status.textContent = maintenanceData.running
        ? `Maintenance is running (${maintenanceData.state}).`
        : maintenanceData.installed
          ? `Maintenance is ${maintenanceData.state}. Start it to open the installer or tools.`
          : 'Maintenance has not been created yet. Start it to run the installer.';
    }
    const stop = qs('#maintenanceStopBtn');
    if (stop) stop.disabled = !maintenanceData?.running;
  } catch (e) {
    const status = qs('#maintenanceStatus');
    if (status) status.textContent = `Maintenance status unavailable: ${e.message}`;
  }
}

async function openMaintenancePanel({ start = false } = {}) {
  const popup = window.open('about:blank', '_blank');
  if (popup) popup.document.write('<p style="font-family:sans-serif;padding:24px">Starting Dok Maintenance…</p>');
  try {
    let url = maintenanceData?.url || '';
    if (start || !maintenanceData?.running) {
      const res = await api('/api/maintenance/start', { method: 'POST' });
      maintenanceData = res.maintenance || maintenanceData;
      url = res.maintenance?.url || res.url || url;
    }
    if (!url) throw new Error('Maintenance did not return a URL.');
    await loadMaintenanceStatus();
    if (popup) popup.location.replace(url);
    else window.location.href = url;
  } catch (e) {
    if (popup) popup.close();
    const msg = qs('#maintenanceMsg');
    if (msg) {
      msg.classList.remove('hidden');
      msg.textContent = e.message;
    }
    toast(e.message, true);
  }
}

if (qs('#maintenanceOpenBtn')) {
  qs('#maintenanceOpenBtn').addEventListener('click', (e) => {
    setLoading(e.currentTarget, true);
    openMaintenancePanel({ start: true }).finally(() => setLoading(e.currentTarget, false));
  });
}
if (qs('#maintenanceStartBtn')) {
  qs('#maintenanceStartBtn').addEventListener('click', async (e) => {
    setLoading(e.currentTarget, true);
    try {
      await api('/api/maintenance/start', { method: 'POST' });
      toast('Maintenance started');
      await loadMaintenanceStatus();
    } catch (err) {
      toast(err.message, true);
    } finally {
      setLoading(e.currentTarget, false);
    }
  });
}
if (qs('#maintenanceStopBtn')) {
  qs('#maintenanceStopBtn').addEventListener('click', async (e) => {
    setLoading(e.currentTarget, true);
    try {
      await api('/api/maintenance/stop', { method: 'POST' });
      toast('Maintenance stopped');
      await loadMaintenanceStatus();
    } catch (err) {
      toast(err.message, true);
    } finally {
      setLoading(e.currentTarget, false);
    }
  });
}
if (qs('#maintenanceRefresh')) qs('#maintenanceRefresh').addEventListener('click', loadMaintenanceStatus);

let coreNginxData = null;

async function loadCoreNginx() {
  try {
    const res = await api('/api/core/nginx-proxy');
    coreNginxData = res;
    const create = qs('#nginxCreateSection');
    const manage = qs('#nginxManageSection');
    // The server owns "installed": a live or stopped container, plus a
    // compose-file fallback only when the Docker lookup itself failed. Never
    // treat a leftover compose file as an installed service here, or removing
    // the container leaves the card stuck in manage mode.
    const installed = res.lookupFailed
      ? (state.coreNginxInstalled === true || res.installed === true)
      : res.installed === true;
    if (create) create.classList.add('hidden');
    if (manage) manage.classList.toggle('hidden', !installed);
    if (installed) {
      const label = qs('#nginxManageSection .muted');
      const httpPort = Number(res.settings?.httpPort) || 80;
      if (label) label.textContent = `nginx-proxy status: ${res.state || 'created'}${httpPort !== 80 ? ` · HTTP host port ${httpPort}` : ''}`;
    }
    hideCoreCardUnless('coreNginxCard', installed);
    const hint = qs('#nginxCreateHint');
    if (hint) hint.classList.toggle('hidden', installed || !res.composeExists);
    if (qs('#nginxComposeEditor')) {
      qs('#nginxComposeEditor').value = res.compose || '';
    }
    if (qs('#nginxAcmeEnabled')) qs('#nginxAcmeEnabled').checked = !!res.acme?.enabled;
    if (qs('#nginxAcmeEmail')) qs('#nginxAcmeEmail').value = res.acme?.email || '';
    if (qs('#nginxAcmeStaging')) qs('#nginxAcmeStaging').checked = !!res.acme?.staging;
    state.coreNginxRunning = !!res.running;
    state.coreNginxInstalled = installed;
    const hasNginx = installed;
    if (qs('#appCreationNginxNotice')) qs('#appCreationNginxNotice').classList.toggle('hidden', hasNginx);
    if (qs('#appCreationNginxNoticeModal')) qs('#appCreationNginxNoticeModal').classList.toggle('hidden', hasNginx);
    updateAppCfgRequired();
  } catch (e) {
    // ignore
  }
  applyDefaultsToServiceForms();
}

if (qs('#editNginxCompose')) {
  qs('#editNginxCompose').addEventListener('click', () => {
    qs('#nginxComposeEditor').classList.remove('hidden');
    qs('#nginxEditorActions').classList.remove('hidden');
  });
}
if (qs('#editNginxComposeManage')) {
  qs('#editNginxComposeManage').addEventListener('click', () => {
    qs('#nginxComposeEditor').classList.remove('hidden');
    qs('#nginxEditorActions').classList.remove('hidden');
  });
}
if (qs('#cancelNginxCompose')) {
  qs('#cancelNginxCompose').addEventListener('click', () => {
    qs('#nginxComposeEditor').classList.add('hidden');
    qs('#nginxEditorActions').classList.add('hidden');
  });
}
if (qs('#saveNginxCompose')) {
  qs('#saveNginxCompose').addEventListener('click', async () => {
    const btn = qs('#saveNginxCompose');
    setLoading(btn, true);
    try {
      await api('/api/core/nginx-proxy/compose', jsonBody({ compose: qs('#nginxComposeEditor').value }));
      toast('Compose saved');
      qs('#nginxComposeEditor').classList.add('hidden');
      qs('#nginxEditorActions').classList.add('hidden');
    } catch (e) {
      toast(e.message, true);
    } finally {
      setLoading(btn, false, 'Save compose');
    }
  });
}
if (qs('#runNginxProxyCore')) {
  qs('#runNginxProxyCore').addEventListener('click', async () => {
    const btn = qs('#runNginxProxyCore');
    const portRaw = qs('#nginxPort') ? qs('#nginxPort').value.trim() : '';
    const ngPort = portRaw === '' ? 80 : Number(portRaw);
    if (!Number.isInteger(ngPort) || ngPort < 1 || ngPort > 65535) {
      return toast('Default VIRTUAL_PORT must be between 1 and 65535', true);
    }
    setLoading(btn, true);
    try {
      await api('/api/settings', jsonBody({
        services: {
          nginxProxy: {
            network: qs('#nginxNetwork') ? (qs('#nginxNetwork').value.trim() || 'wicked') : 'wicked',
            defaultVhostPort: ngPort,
            domain: (qs('#nginxDomain') && qs('#nginxDomain').value.trim()) || ''
          }
        }
      }));
      const res = await api('/api/core/nginx-proxy/run', { method: 'POST' });
      const message = res?.message || 'nginx-proxy launched';
      if (qs('#nginxMsg')) qs('#nginxMsg').textContent = message;
      toast(message, false, 15000);
      loadCoreNginx();
      if (res?.selfUpdate?.scheduled) waitForReconnect(90000, 12000);
      else refreshAll();
    } catch (e) {
      toast(e.message, true);
    } finally {
      setLoading(btn, false, 'Run nginx-proxy');
    }
  });
}
if (qs('#viewNginxStatus')) {
  qs('#viewNginxStatus').addEventListener('click', async () => {
    try {
      const res = await api('/api/core/nginx-proxy');
      coreNginxData = res;
      const out = qs('#nginxStatusOut');
      out.textContent = JSON.stringify(res, null, 2);
      out.classList.remove('hidden');
    } catch (e) {
      toast(e.message, true);
    }
  });
}

if (qs('#nginxAcmeSave')) {
  qs('#nginxAcmeSave').addEventListener('click', async () => {
    const btn = qs('#nginxAcmeSave');
    const msg = qs('#nginxAcmeMsg');
    const enabled = !!qs('#nginxAcmeEnabled')?.checked;
    const email = qs('#nginxAcmeEmail')?.value.trim() || '';
    if (enabled && !email) {
      if (msg) msg.textContent = 'Set a certificate email to enable acme-companion';
      return toast('Certificate email is required for acme-companion', true);
    }
    setLoading(btn, true, 'Saving…');
    try {
      const res = await api('/api/core/nginx-proxy/acme', jsonBody({
        enabled,
        email,
        staging: !!qs('#nginxAcmeStaging')?.checked
      }));
      if (msg) msg.textContent = res.message || 'Certificate settings saved';
      toast(res.message || 'Certificate settings saved', false, 12000);
      await loadCoreNginx();
    } catch (e) {
      if (msg) msg.textContent = e.message;
      toast(e.message, true);
    } finally {
      setLoading(btn, false, 'Save certificate settings');
    }
  });
}

async function nginxContainerAction(action, btn) {
  if (!coreNginxData?.containerId) return toast('nginx-proxy container not found', true);
  setLoading(btn, true);
  try {
    await api(`/api/containers/${encodeURIComponent(coreNginxData.containerId)}/${action}`, { method: 'POST' });
    toast(`nginx-proxy ${action} requested`);
    setTimeout(loadCoreNginx, 800);
  } catch (e) {
    toast(e.message, true);
  } finally {
    setLoading(btn, false);
  }
}

if (qs('#nginxStartBtn')) {
  qs('#nginxStartBtn').addEventListener('click', () => nginxContainerAction('start', qs('#nginxStartBtn')));
}
if (qs('#nginxStopBtn')) {
  qs('#nginxStopBtn').addEventListener('click', () => nginxContainerAction('stop', qs('#nginxStopBtn')));
}
if (qs('#nginxRestartBtn')) {
  qs('#nginxRestartBtn').addEventListener('click', () => nginxContainerAction('restart', qs('#nginxRestartBtn')));
}

async function loadCoreCloudflared() {
  try {
    const res = await api('/api/core/cloudflared');
    coreCfData = res;
    const cfInstalled = coreServiceInstalled('cf', res);
    setCoreSections('cf', cfInstalled);
    hideCoreCardUnless('coreCloudflaredCard', cfInstalled);
    if (cfInstalled) {
      const label = qs('#cfManageSection .muted');
      if (label) label.textContent = `cloudflared status: ${res.state}`;
    }
    if (qs('#cfComposeEditor') && res.compose) {
      qs('#cfComposeEditor').value = res.compose;
    }
    if (qs('#cfToken')) {
      qs('#cfToken').value = '';
      qs('#cfToken').placeholder = res.settings?.tokenSet
        ? 'Token saved (leave blank to keep)'
        : 'Cloudflare tunnel token';
    }
  } catch { /* ignore */ }
}

if (qs('#editCfCompose')) {
  qs('#editCfCompose').addEventListener('click', () => {
    qs('#cfComposeEditor').classList.remove('hidden');
    qs('#cfEditorActions').classList.remove('hidden');
  });
}
if (qs('#editCfComposeManage')) {
  qs('#editCfComposeManage').addEventListener('click', () => {
    qs('#cfComposeEditor').classList.remove('hidden');
    qs('#cfEditorActions').classList.remove('hidden');
  });
}
if (qs('#cancelCfCompose')) {
  qs('#cancelCfCompose').addEventListener('click', () => {
    qs('#cfComposeEditor').classList.add('hidden');
    qs('#cfEditorActions').classList.add('hidden');
  });
}
if (qs('#saveCfCompose')) {
  qs('#saveCfCompose').addEventListener('click', async () => {
    const btn = qs('#saveCfCompose');
    setLoading(btn, true);
    try {
      await api('/api/core/cloudflared/compose', jsonBody({ compose: qs('#cfComposeEditor').value }));
      toast('Compose saved');
      qs('#cfComposeEditor').classList.add('hidden');
      qs('#cfEditorActions').classList.add('hidden');
    } catch (e) {
      toast(e.message, true);
    } finally {
      setLoading(btn, false, 'Save compose');
    }
  });
}
if (qs('#runCfCore')) {
  qs('#runCfCore').addEventListener('click', async () => {
    const btn = qs('#runCfCore');
    setLoading(btn, true);
    try {
      const token = qs('#cfToken') ? qs('#cfToken').value.trim() : '';
      if (!token) {
        const current = await api('/api/settings').catch(() => null);
        if (!current?.services?.cloudflared?.tokenSet) {
          toast('Enter a Cloudflare tunnel token', true);
          return;
        }
      } else {
        await api('/api/settings', jsonBody({ services: { cloudflared: { token } } }));
      }
      const res = await api('/api/core/cloudflared/run', jsonBody({ token }));
      toast(res?.message || 'cloudflared launched');
      if (qs('#cfToken')) qs('#cfToken').value = '';
      loadCoreCloudflared();
      loadSettings();
      refreshAll();
    } catch (e) {
      toast(e.message, true);
    } finally {
      setLoading(btn, false, 'Run cloudflared');
    }
  });
}
if (qs('#viewCfStatus')) {
  qs('#viewCfStatus').addEventListener('click', async () => {
    try {
      const res = await api('/api/core/cloudflared');
      coreCfData = res;
      const out = qs('#cfStatusOut');
      out.textContent = JSON.stringify(res, null, 2);
      out.classList.remove('hidden');
    } catch (e) {
      toast(e.message, true);
    }
  });
}
async function cfContainerAction(action, btn) {
  if (!coreCfData?.containerId) return toast('cloudflared container not found', true);
  setLoading(btn, true);
  try {
    await api(`/api/containers/${encodeURIComponent(coreCfData.containerId)}/${action}`, { method: 'POST' });
    toast(`cloudflared ${action} requested`);
    setTimeout(loadCoreCloudflared, 800);
  } catch (e) {
    toast(e.message, true);
  } finally {
    setLoading(btn, false);
  }
}
if (qs('#cfStartBtn')) qs('#cfStartBtn').addEventListener('click', () => cfContainerAction('start', qs('#cfStartBtn')));
if (qs('#cfStopBtn')) qs('#cfStopBtn').addEventListener('click', () => cfContainerAction('stop', qs('#cfStopBtn')));
if (qs('#cfRestartBtn')) qs('#cfRestartBtn').addEventListener('click', () => cfContainerAction('restart', qs('#cfRestartBtn')));

// ---------------- boot ----------------
async function loadGroups() {
  try {
    const data = await api('/api/groups');
    state.groups = Array.isArray(data.groups) ? data.groups : [];
    const sel = qs('#groupContainers');
    sel.innerHTML = (state.containers || []).map(c => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`).join('');
    const list = qs('#groupsList');
    if (!data.groups || !data.groups.length) {
      list.innerHTML = '<div class="empty">No groups yet.</div>';
      return;
    }
    list.innerHTML = data.groups.map(g => `
      <div class="item" data-id="${escapeHtml(g.id)}" data-name="${escapeHtml(g.name)}">
        <div class="item-header">
          <div>
            <div class="item-title">${escapeHtml(g.name)} ${g.builtin ? badge('Built-in', 'type') : ''}</div>
            <div class="item-sub">${(g.containers||[]).length} container(s)${g.builtin ? ' · core services are added automatically' : ''}</div>
          </div>
          <div class="item-actions">
            ${g.builtin
              ? '<span class="muted">Protected group</span>'
              : '<button class="btn" data-act="edit-group">Edit</button><button class="btn btn-danger" data-act="del-group">Delete</button>'}
          </div>
        </div>
      </div>`).join('');
    list.querySelectorAll('.item').forEach(item => {
      item.querySelectorAll('button').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (btn.dataset.act === 'del-group') {
            if (!confirm('Delete group?')) return;
            await api(`/api/groups/${encodeURIComponent(item.dataset.id)}`, { method: 'DELETE' });
            loadGroups();
            return;
          }
          if (btn.dataset.act === 'edit-group') {
            const group = state.groups.find(g => g.id === item.dataset.id);
            qs('#groupName').value = group?.name || item.dataset.name;
            const ids = new Set(group?.containers || []);
            Array.from(qs('#groupContainers').options).forEach(o => { o.selected = ids.has(o.value); });
            state.editingGroup = group ? { id: group.id, name: group.name } : null;
          }
        });
      });
    });
  } catch (e) {
    toast(e.message, true);
  }
}

qs('#groupsRefresh').addEventListener('click', loadGroups);
qs('#saveGroup').addEventListener('click', async () => {
  const name = qs('#groupName').value.trim();
  if (!name) return toast('Enter group name', true);
  const sel = qs('#groupContainers');
  const containers = Array.from(sel.selectedOptions).map(o => o.value);
  try {
    await api('/api/groups', jsonBody({ name, containers }));
    if (state.editingGroup && state.editingGroup.name !== name) {
      await api(`/api/groups/${encodeURIComponent(state.editingGroup.id)}`, { method: 'DELETE' });
    }
    state.editingGroup = null;
    qs('#groupName').value = '';
    Array.from(sel.options).forEach(o => { o.selected = false; });
    toast('Group saved');
    loadGroups();
  } catch (e) {
    toast(e.message, true);
  }
});

// ---------------- registry connections ----------------
const REGISTRY_PROVIDERS = {
  dockerhub: { kind: 'registry', host: 'docker.io', name: 'Docker Hub', label: 'Docker Hub' },
  ghcr: { kind: 'registry', host: 'ghcr.io', name: 'GitHub Container Registry', label: 'GitHub Container Registry (ghcr.io)' },
  'gitlab-registry': { kind: 'registry', host: 'registry.gitlab.com', name: 'GitLab Container Registry', label: 'GitLab Container Registry' },
  quay: { kind: 'registry', host: 'quay.io', name: 'Quay.io', label: 'Quay.io' },
  'custom-registry': { kind: 'registry', host: '', name: '', label: 'Other container registry' },
  github: { kind: 'git', host: 'github.com', name: 'GitHub', label: 'GitHub' },
  gitlab: { kind: 'git', host: 'gitlab.com', name: 'GitLab', label: 'GitLab' },
  gitea: { kind: 'git', host: '', name: '', label: 'Gitea / Forgejo' },
  'custom-git': { kind: 'git', host: '', name: '', label: 'Other git host' }
};

function registryPreset(value) {
  return REGISTRY_PROVIDERS[value] || { kind: 'registry', host: '', name: '', label: '' };
}

function applyRegistryProvider(force = true) {
  const preset = registryPreset(qs('#registryProvider')?.value);
  if (!preset) return;
  if (force) {
    if (preset.host) qs('#registryHost').value = preset.host;
    if (preset.name) qs('#registryName').value = preset.name;
  }
  qs('#registryUsername').placeholder = preset.kind === 'git'
    ? 'Username (x-access-token for tokens)'
    : 'Username';
}

function renderRegistryProviderOptions(kind, force = true) {
  const select = qs('#registryProvider');
  if (!select) return;
  const current = select.value;
  const entries = Object.entries(REGISTRY_PROVIDERS).filter(([, preset]) => preset.kind === kind);
  select.innerHTML = entries.map(([value, preset]) => `<option value="${value}">${escapeHtml(preset.label)}</option>`).join('');
  select.value = entries.some(([value]) => value === current) ? current : (entries[0]?.[0] || '');
  applyRegistryProvider(force);
}

function setRegistryMsg(text) {
  const el = qs('#registryMsg');
  if (el) el.textContent = text || '';
}

function resetRegistryForm() {
  state.editingRegistry = null;
  if (!qs('#registryKind')) return;
  qs('#registryKind').value = 'registry';
  renderRegistryProviderOptions('registry');
  qs('#registryProvider').value = 'dockerhub';
  applyRegistryProvider(true);
  qs('#registryUsername').value = '';
  qs('#registrySecret').value = '';
  qs('#registrySecret').placeholder = 'Password or access token';
  qs('#saveRegistry').textContent = 'Save connection';
  qs('#cancelRegistryEdit').classList.add('hidden');
  setRegistryMsg('');
}

async function loadRegistries() {
  const list = qs('#registriesList');
  if (!list) return;
  try {
    const data = await api('/api/registries');
    state.registries = Array.isArray(data.connections) ? data.connections : [];
    if (!state.registries.length) {
      list.innerHTML = '<div class="empty">No registry connections yet.</div>';
      return;
    }
    list.innerHTML = state.registries.map(connection => {
      const kindLabel = connection.kind === 'git' ? 'Git' : 'Registry';
      return `
      <div class="item" data-id="${escapeHtml(connection.id)}">
        <div class="item-header">
          <div>
            <div class="item-title">${escapeHtml(connection.name || connection.host)} <span class="mode-pill${connection.kind === 'git' ? ' ok' : ''}">${kindLabel}</span></div>
            <div class="item-sub">${escapeHtml(connection.host)}${connection.username ? ` · ${escapeHtml(connection.username)}` : ''} · ${connection.hasSecret ? 'credential stored' : 'no credential'}</div>
          </div>
          <div class="item-actions">
            <button class="btn" data-act="edit-registry">Edit</button>
            <button class="btn" data-act="test-registry">Test</button>
            <button class="btn btn-danger" data-act="del-registry">Delete</button>
          </div>
        </div>
      </div>`;
    }).join('');

    list.querySelectorAll('.item').forEach(item => {
      item.querySelectorAll('button').forEach(btn => {
        btn.addEventListener('click', async () => {
          const connection = state.registries.find(c => c.id === item.dataset.id);
          if (!connection) return;

          if (btn.dataset.act === 'del-registry') {
            if (!confirm(`Delete the ${connection.name || connection.host} connection?`)) return;
            try {
              await api(`/api/registries/${encodeURIComponent(connection.id)}`, { method: 'DELETE' });
              if (state.editingRegistry?.id === connection.id) resetRegistryForm();
              toast('Registry connection deleted');
              loadRegistries();
            } catch (e) {
              toast(e.message, true);
            }
            return;
          }

          if (btn.dataset.act === 'test-registry') {
            setLoading(btn, true, 'Testing…');
            setRegistryMsg('');
            try {
              const result = await api(`/api/registries/${encodeURIComponent(connection.id)}/test`, { method: 'POST' });
              setRegistryMsg(result.message || 'Connection works');
              toast(result.message || 'Connection works');
            } catch (e) {
              setRegistryMsg(e.message);
              toast(e.message, true);
            } finally {
              setLoading(btn, false, 'Test');
            }
            return;
          }

          if (btn.dataset.act === 'edit-registry') {
            state.editingRegistry = connection;
            qs('#registryKind').value = connection.kind;
            renderRegistryProviderOptions(connection.kind, false);
            if (Array.from(qs('#registryProvider').options).some(option => option.value === connection.provider)) {
              qs('#registryProvider').value = connection.provider;
            }
            applyRegistryProvider(false);
            qs('#registryHost').value = connection.host || '';
            qs('#registryName').value = connection.name || connection.host || '';
            qs('#registryUsername').value = connection.username || '';
            qs('#registrySecret').value = '';
            qs('#registrySecret').placeholder = connection.hasSecret
              ? 'Leave blank to keep the stored credential'
              : 'Password or access token';
            qs('#saveRegistry').textContent = 'Update connection';
            qs('#cancelRegistryEdit').classList.remove('hidden');
            setRegistryMsg('');
          }
        });
      });
    });
  } catch (e) {
    list.innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`;
    toast(e.message, true);
  }
}

if (qs('#registryKind')) {
  resetRegistryForm();
  qs('#registryKind').addEventListener('change', () => renderRegistryProviderOptions(qs('#registryKind').value));
  qs('#registryProvider').addEventListener('change', () => applyRegistryProvider(true));
  qs('#registriesRefresh').addEventListener('click', loadRegistries);
  qs('#cancelRegistryEdit').addEventListener('click', resetRegistryForm);
  qs('#saveRegistry').addEventListener('click', async () => {
    const btn = qs('#saveRegistry');
    const body = {
      id: state.editingRegistry?.id,
      kind: qs('#registryKind').value,
      provider: qs('#registryProvider').value,
      name: qs('#registryName').value.trim(),
      host: qs('#registryHost').value.trim(),
      username: qs('#registryUsername').value.trim(),
      secret: qs('#registrySecret').value
    };
    if (!body.host) return toast('Enter a registry or git host', true);
    if (!body.id && !body.secret) return toast('Enter a password or access token', true);
    const editing = !!body.id;
    setLoading(btn, true, 'Saving…');
    setRegistryMsg('');
    try {
      await api('/api/registries', jsonBody(body));
      toast(editing ? 'Registry connection updated' : 'Registry connection saved');
      resetRegistryForm();
      await loadRegistries();
    } catch (e) {
      setRegistryMsg(e.message);
      toast(e.message, true);
    } finally {
      setLoading(btn, false, state.editingRegistry ? 'Update connection' : 'Save connection');
    }
  });
}

let coreAuthData = null;
let coreAutheliaData = null;
let coreDnsData = null;
let coreMailData = null;
let coreHelperData = null;
let serverLogsTimer = null;
let appLogsTimer = null;

function setCoreSections(prefix, exists) {
  const create = qs(`#${prefix}CreateSection`);
  const manage = qs(`#${prefix}ManageSection`);
  // Core services are installed by the Maintenance installer now; Dok only
  // shows and manages services that already exist.
  if (create) create.classList.add('hidden');
  if (manage) manage.classList.toggle('hidden', !exists);
}

function hideCoreCardUnless(id, installed) {
  const card = qs(`#${id}`);
  if (card) card.classList.toggle('hidden', !installed);
}

function coreServiceInstalled(prefix, res) {
  // A failed Docker lookup says nothing about whether a service exists. Keep
  // the currently displayed state instead of flipping an installed service
  // back to its create view on a transient error.
  if (res?.lookupFailed) {
    const manage = qs(`#${prefix}ManageSection`);
    if (manage) return !manage.classList.contains('hidden');
  }
  return !!res?.exists;
}

async function coreServiceAction(service, action, btn, reload) {
  if (btn) setLoading(btn, true);
  try {
    await api(`/api/core/${encodeURIComponent(service)}/${encodeURIComponent(action)}`, { method: 'POST' });
    toast(`${service} ${action} requested`);
    if (reload) await reload();
  } catch (e) {
    toast(e.message, true);
  } finally {
    if (btn) setLoading(btn, false);
  }
}

async function loadCoreAuth() {
  try {
    const res = await api('/api/core/auth');
    coreAuthData = res;
    const authInstalled = coreServiceInstalled('auth', res);
    setCoreSections('auth', authInstalled);
    hideCoreCardUnless('coreAuthCard', authInstalled);
    if (qs('#authStatus')) qs('#authStatus').textContent = `Authentik status: ${res.state || (res.running ? 'running' : 'stopped')}`;
    if (qs('#authDomain')) qs('#authDomain').value = res.settings?.domain || '';
    if (qs('#authDomainManage')) qs('#authDomainManage').value = res.settings?.domain || '';
    if (qs('#authComposeEditor') && res.compose) qs('#authComposeEditor').value = res.compose;
  } catch {}
  applyDefaultsToServiceForms();

}

async function loadCoreAuthelia() {
  try {
    const res = await api('/api/core/authelia');
    coreAutheliaData = res;
    const autheliaInstalled = coreServiceInstalled('authelia', res);
    setCoreSections('authelia', autheliaInstalled);
    hideCoreCardUnless('coreAutheliaCard', autheliaInstalled);
    if (qs('#autheliaStatus')) qs('#autheliaStatus').textContent = `Authelia status: ${res.state || (res.running ? 'running' : 'stopped')}`;
    if (qs('#autheliaDomain')) qs('#autheliaDomain').value = res.settings?.domain || '';
    if (qs('#autheliaDomainManage')) qs('#autheliaDomainManage').value = res.settings?.domain || '';
    if (qs('#autheliaUser')) qs('#autheliaUser').value = res.settings?.adminUser || 'admin';
    if (qs('#autheliaProtected')) {
      const hosts = Array.isArray(res.protectedHosts) ? res.protectedHosts : [];
      qs('#autheliaProtected').textContent = `Protected apps: ${hosts.length ? hosts.join(', ') : 'none'}`;
    }
    if (qs('#autheliaProtectDok')) qs('#autheliaProtectDok').checked = !!installDefaults.protectDok;
    if (qs('#autheliaComposeEditor') && res.compose) qs('#autheliaComposeEditor').value = res.compose;
  } catch {}
  applyDefaultsToServiceForms();

}

async function loadCoreMail() {
  try {
    const res = await api('/api/core/mail');
    coreMailData = res;
    const smtp = res.smtp || {};
    if (qs('#mailSmtpHost')) qs('#mailSmtpHost').value = smtp.host || '';
    if (qs('#mailSmtpPort')) qs('#mailSmtpPort').value = smtp.port || 587;
    if (qs('#mailSmtpTls')) qs('#mailSmtpTls').value = smtp.tls || 'starttls';
    if (qs('#mailSmtpUser')) qs('#mailSmtpUser').value = smtp.username || '';
    if (qs('#mailSmtpSender')) qs('#mailSmtpSender').value = smtp.sender || '';
    if (qs('#mailSmtpPassword')) {
      qs('#mailSmtpPassword').value = '';
      qs('#mailSmtpPassword').placeholder = smtp.passwordSet
        ? 'Password saved (leave blank to keep)'
        : 'Password (stored encrypted)';
    }
    if (qs('#mailStatus')) {
      const target = smtp.host
        ? `${smtp.host}:${smtp.port} (${smtp.tls === 'none' ? 'no TLS' : smtp.tls === 'tls' ? 'TLS' : 'STARTTLS'})`
        : '';
      const authelia = res.authelia?.installed ? 'Authelia notifications use it.' : 'Launch Authelia to use it.';
      qs('#mailStatus').textContent = smtp.host
        ? `SMTP: ${target}${smtp.passwordSet ? ' · password saved' : ''} · ${authelia}`
        : 'SMTP: not configured · Authelia writes notifications to /config/notifications.txt';
    }
    setCoreSections('mailpit', coreServiceInstalled('mailpit', res));
    if (qs('#mailpitStatus')) qs('#mailpitStatus').textContent = `Mailpit status: ${res.state || (res.running ? 'running' : 'stopped')}`;
    if (qs('#mailpitSmtpPort')) qs('#mailpitSmtpPort').value = res.settings?.smtpPort || 1025;
    if (qs('#mailpitWebPort')) qs('#mailpitWebPort').value = res.settings?.webPort || 8025;
    if (qs('#mailpitMaxMessages')) qs('#mailpitMaxMessages').value = res.settings?.maxMessages || 500;
    if (qs('#mailpitDomain')) qs('#mailpitDomain').value = res.settings?.domain || '';
    if (qs('#mailpitDomainManage')) qs('#mailpitDomainManage').value = res.settings?.domain || '';
    if (qs('#mailpitComposeEditor') && res.compose) qs('#mailpitComposeEditor').value = res.compose;
    const stalwart = await api('/api/core/stalwart').catch(() => null);
    if (stalwart) {
      coreMailData.stalwart = stalwart;
      setCoreSections('stalwart', coreServiceInstalled('stalwart', stalwart));
      if (qs('#stalwartStatus')) qs('#stalwartStatus').textContent = `Stalwart status: ${stalwart.state || (stalwart.running ? 'running' : 'stopped')}`;
      if (qs('#stalwartDomain')) qs('#stalwartDomain').value = stalwart.settings?.domain || '';
      if (qs('#stalwartDomainManage')) qs('#stalwartDomainManage').value = stalwart.settings?.domain || '';
      if (qs('#stalwartAdminUser')) qs('#stalwartAdminUser').value = stalwart.settings?.adminUser || 'admin';
      if (qs('#stalwartWebPort')) qs('#stalwartWebPort').value = stalwart.settings?.webPort || 8088;
      if (qs('#stalwartSmtpPort')) qs('#stalwartSmtpPort').value = stalwart.settings?.smtpPort || 25;
      if (qs('#stalwartSubmissionPort')) qs('#stalwartSubmissionPort').value = stalwart.settings?.submissionPort || 587;
      if (qs('#stalwartImapsPort')) qs('#stalwartImapsPort').value = stalwart.settings?.imapsPort || 993;
      if (qs('#stalwartComposeEditor')) qs('#stalwartComposeEditor').value = stalwart.compose || '';
      if (qs('#stalwartAdminPassword')) {
        qs('#stalwartAdminPassword').value = '';
        qs('#stalwartAdminPassword').placeholder = stalwart.settings?.adminPasswordSet
          ? 'Password saved (leave blank to keep)'
          : 'Admin password (generated if blank)';
      }
    }
  } catch {}
  applyDefaultsToServiceForms();

}

function updateDnsProviderForm() {
  const provider = qs('#dnsProvider')?.value === 'adguard' ? 'adguard' : 'technitium';
  const password = qs('#dnsAdminPassword');
  if (password) {
    password.classList.toggle('hidden', provider === 'adguard');
    const wrap = password.closest('.field-wrap');
    if (wrap) wrap.classList.toggle('hidden', provider === 'adguard');
  }
  const webPort = qs('#dnsWebPort');
  if (webPort && !webPort.dataset.touched) webPort.value = provider === 'adguard' ? '3000' : '5380';
  const runBtn = qs('#dnsRunBtn');
  if (runBtn && !runBtn.disabled) runBtn.textContent = provider === 'adguard' ? 'Launch AdGuard Home' : 'Launch Technitium';
  const openBtn = qs('#dnsOpenBtn');
  if (openBtn) openBtn.textContent = provider === 'adguard' ? 'Open AdGuard Home' : 'Open Technitium';
  const desc = qs('#dnsDesc');
  if (desc) desc.textContent = provider === 'adguard'
    ? 'AdGuard Home provides filtering DNS with a setup wizard and query dashboard. It can replace Technitium for local DNS and ad blocking.'
    : 'Optional local DNS and ad blocking. Technitium provides a web console for zones, records, and blocklists. AdGuard Home provides a simpler filtering DNS server with its own setup wizard.';
}

if (qs('#dnsProvider')) qs('#dnsProvider').addEventListener('change', () => {
  if (qs('#dnsWebPort')) delete qs('#dnsWebPort').dataset.touched;
  updateDnsProviderForm();
});
if (qs('#dnsWebPort')) qs('#dnsWebPort').addEventListener('input', (e) => { e.target.dataset.touched = '1'; });

async function loadCoreDns() {
  try {
    const res = await api('/api/core/dns');
    coreDnsData = res;
    const dnsInstalled = coreServiceInstalled('dns', res);
    setCoreSections('dns', dnsInstalled);
    hideCoreCardUnless('coreDnsCard', dnsInstalled);
    const provider = res.provider === 'adguard' ? 'adguard' : 'technitium';
    const label = provider === 'adguard' ? 'AdGuard Home' : 'Technitium DNS';
    if (qs('#dnsProvider')) qs('#dnsProvider').value = provider;
    if (qs('#dnsKindLabel')) qs('#dnsKindLabel').textContent = `(${label})`;
    if (qs('#dnsStatus')) qs('#dnsStatus').textContent = `${label} status: ${res.state || (res.running ? 'running' : 'stopped')}`;
    if (qs('#dnsDomain')) qs('#dnsDomain').value = res.settings?.domain || '';
    if (qs('#dnsDomainManage')) qs('#dnsDomainManage').value = res.settings?.domain || '';
    if (qs('#dnsComposeEditor') && res.compose) qs('#dnsComposeEditor').value = res.compose;
    if (qs('#dnsWebPort')) qs('#dnsWebPort').value = res.settings?.webPort || (provider === 'adguard' ? 3000 : 5380);
    if (qs('#dnsDnsPort')) qs('#dnsDnsPort').value = res.settings?.dnsPort || 53;
    updateDnsProviderForm();
  } catch {}
  applyDefaultsToServiceForms();

}

async function loadCoreHelper() {
  try {
    const res = await api('/api/core/host-helper');
    coreHelperData = res;
    const helperInstalled = coreServiceInstalled('helper', res);
    setCoreSections('helper', helperInstalled);
    hideCoreCardUnless('coreHostHelperCard', helperInstalled);
    if (qs('#helperStatus')) {
      qs('#helperStatus').textContent = `Host Helper status: ${res.state || (res.running ? 'running' : 'stopped')}${res.available ? ' · available' : ' · not responding'}`;
    }
    if (qs('#helperComposeEditor') && res.compose) qs('#helperComposeEditor').value = res.compose;
  } catch {}
}

// ---------------- OpenCode + web terminal ----------------
let coreOpencodeData = null;
let terminal = null;
let terminalFit = null;
let terminalSocket = null;
let terminalSessionId = null;
let terminalSessionApp = '';
let terminalResizeObserver = null;
let terminalConnectToken = 0;
let terminalOpenToken = 0;
let terminalReconnectTimer = null;
let terminalReconnectAttempt = 0;
let terminalHeartbeatTimer = null;
let terminalTransport = 'ws';
let terminalHttpTimer = null;
let terminalHttpCursor = 0;
let terminalHttpErrors = 0;
let terminalHttpReady = false;
let terminalHttpInputQueue = '';
let terminalHttpInputTimer = null;
let terminalHttpInputSending = false;
let terminalHttpFallbackNoticeShown = false;
let terminalHttpNoticePending = false;
let terminalHttpTruncatedShown = false;
let terminalHttpOutageNoticeShown = false;
let terminalReadyTimer = null;
let terminalStableTimer = null;
const TERMINAL_MAX_RECONNECT = 10;
const TERMINAL_WS_FALLBACK_ATTEMPTS = 2;
const TERMINAL_HTTP_IDLE_MS = 350;
const TERMINAL_CONNECT_TIMEOUT_MS = 8000;
const TERMINAL_READY_TIMEOUT_MS = 8000;
const TERMINAL_STABLE_MS = 10000;

function clearTerminalConnectionTimers() {
  if (terminalReconnectTimer) {
    clearTimeout(terminalReconnectTimer);
    terminalReconnectTimer = null;
  }
  if (terminalHeartbeatTimer) {
    clearInterval(terminalHeartbeatTimer);
    terminalHeartbeatTimer = null;
  }
  if (terminalHttpTimer) {
    clearTimeout(terminalHttpTimer);
    terminalHttpTimer = null;
  }
  if (terminalHttpInputTimer) {
    clearTimeout(terminalHttpInputTimer);
    terminalHttpInputTimer = null;
  }
  if (terminalReadyTimer) {
    clearTimeout(terminalReadyTimer);
    terminalReadyTimer = null;
  }
  if (terminalStableTimer) {
    clearTimeout(terminalStableTimer);
    terminalStableTimer = null;
  }
}

function resetTerminalHttpState() {
  terminalTransport = 'ws';
  terminalHttpCursor = 0;
  terminalHttpErrors = 0;
  terminalHttpReady = false;
  terminalHttpInputQueue = '';
  terminalHttpInputSending = false;
  terminalHttpFallbackNoticeShown = false;
  terminalHttpNoticePending = false;
  terminalHttpTruncatedShown = false;
  terminalHttpOutageNoticeShown = false;
}

function resetTerminalView() {
  clearTerminalConnectionTimers();
  if (terminalSocket) {
    try { terminalSocket.close(); } catch {}
    terminalSocket = null;
  }
  if (terminal) {
    try { terminal.dispose(); } catch {}
    terminal = null;
  }
  terminalFit = null;
  resetTerminalHttpState();
  const container = qs('#terminalContainer');
  if (container) container.innerHTML = '';
}

function terminalNotice(message) {
  if (terminal) {
    try {
      terminal.writeln('');
      terminal.writeln('\x1b[33m' + String(message).replace(/[\r\n]+/g, ' ') + '\x1b[0m');
    } catch {}
    return;
  }
  const container = qs('#terminalContainer');
  if (container) {
    const note = document.createElement('div');
    note.className = 'terminal-notice';
    note.textContent = message;
    container.appendChild(note);
  }
}

function ensureTerminal() {
  if (terminal) return true;
  const container = qs('#terminalContainer');
  if (!container || !window.Terminal) {
    if (container) {
      container.innerHTML = '<div class="terminal-notice">The terminal component failed to load. Reload the page and try again.</div>';
    }
    return false;
  }
  terminal = new window.Terminal({
    cursorBlink: true,
    cursorStyle: 'block',
    fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    fontSize: 13,
    lineHeight: 1.15,
    scrollback: 8000,
    allowTransparency: true,
    macOptionIsMeta: true,
    theme: {
      background: '#05080a',
      foreground: '#e8f0eb',
      cursor: '#b6ff3b',
      cursorAccent: '#05080a',
      selectionBackground: 'rgba(182, 255, 59, 0.25)',
      black: '#0d1114',
      red: '#ff5f56',
      green: '#34d399',
      yellow: '#ffbd2e',
      blue: '#4cd7e8',
      magenta: '#c084fc',
      cyan: '#4cd7e8',
      white: '#e8f0eb',
      brightBlack: '#5b6b70',
      brightRed: '#ff8a84',
      brightGreen: '#6ef0b8',
      brightYellow: '#ffd166',
      brightBlue: '#7be4f0',
      brightMagenta: '#d8b4fe',
      brightCyan: '#7be4f0',
      brightWhite: '#ffffff'
    }
  });
  if (window.FitAddon?.FitAddon) {
    terminalFit = new window.FitAddon.FitAddon();
    terminal.loadAddon(terminalFit);
  }
  terminal.open(container);
  terminal.onData((data) => {
    sendTerminalMessage({ type: 'input', data });
  });
  terminal.onResize(({ cols, rows }) => {
    if (cols && rows) sendTerminalMessage({ type: 'resize', cols, rows });
  });
  if (window.ResizeObserver && container) {
    if (!terminalResizeObserver) {
      terminalResizeObserver = new ResizeObserver(() => fitTerminal());
      terminalResizeObserver.observe(container);
    }
  }
  setTimeout(fitTerminal, 30);
  return true;
}

function sendTerminalMessage(message) {
  if (terminalSocket && terminalSocket.readyState === WebSocket.OPEN) {
    try { terminalSocket.send(JSON.stringify(message)); } catch {}
    return;
  }
  if (terminalTransport !== 'http' || !terminalSessionId) return;
  if (message.type === 'input' && typeof message.data === 'string') {
    terminalHttpInputQueue += message.data;
    if (terminalHttpInputQueue.length > 65536) {
      terminalHttpInputQueue = terminalHttpInputQueue.slice(-65536);
    }
    if (!terminalHttpInputTimer) {
      terminalHttpInputTimer = setTimeout(flushTerminalHttpInput, 25);
    }
  } else if (message.type === 'resize' && message.cols && message.rows) {
    postTerminalHttp({ cols: message.cols, rows: message.rows });
  }
}

function postTerminalHttp(payload) {
  const sessionId = terminalSessionId;
  if (!sessionId || terminalTransport !== 'http') return Promise.resolve();
  return fetch(`/api/terminal/sessions/${encodeURIComponent(sessionId)}/input`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    cache: 'no-store'
  }).then(async res => {
    if (res.status === 404 && sessionId === terminalSessionId) {
      handleLostTerminalSession(sessionId);
      return;
    }
    if (!res.ok) throw new Error(`Terminal input failed (${res.status})`);
    return res.json().catch(() => ({}));
  });
}

async function flushTerminalHttpInput() {
  terminalHttpInputTimer = null;
  if (!terminalHttpInputQueue || terminalHttpInputSending) return;
  const data = terminalHttpInputQueue;
  terminalHttpInputQueue = '';
  terminalHttpInputSending = true;
  try {
    await postTerminalHttp({ data });
  } catch {
    // The poll loop owns connection errors; dropping one batch is better than
    // replaying the same keystrokes twice after a partial write.
  } finally {
    terminalHttpInputSending = false;
    if (terminalHttpInputQueue) {
      terminalHttpInputTimer = setTimeout(flushTerminalHttpInput, 0);
    }
  }
}

function fitTerminal() {
  const container = qs('#terminalContainer');
  if (!terminal || !terminalFit || !container || !container.clientWidth || !container.clientHeight) return;
  try { terminalFit.fit(); } catch {}
  if (terminal.cols && terminal.rows) {
    sendTerminalMessage({ type: 'resize', cols: terminal.cols, rows: terminal.rows });
  }
}

function setTerminalStatus(text) {
  const el = qs('#terminalStatus');
  if (el) el.textContent = text;
}

function applyTerminalReady(session = {}) {
  if (terminal) {
    try { terminal.reset(); } catch {}
  }
  if (qs('#terminalTitle')) qs('#terminalTitle').textContent = session.title || 'Terminal';
  if (qs('#terminalSessionLabel')) {
    qs('#terminalSessionLabel').textContent = session.app === 'opencode'
      ? 'OC Assist can ask follow-up questions. The app appears in Apps when it is ready.'
      : `Shell · ${session.cwd || ''} · pid ${session.pid || '—'}`;
  }
  setTerminalStatus('Connected');
}

function startTerminalHeartbeat(ws, token) {
  if (terminalHeartbeatTimer) clearInterval(terminalHeartbeatTimer);
  terminalHeartbeatTimer = setInterval(() => {
    if (token !== terminalConnectToken || !ws || ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify({ type: 'ping', at: Date.now() })); } catch {}
  }, 25000);
}

function handleLostTerminalSession(sessionId) {
  if (sessionId !== terminalSessionId) return;
  const wasOpencode = terminalSessionApp === 'opencode';
  clearTerminalConnectionTimers();
  terminalTransport = 'ws';
  terminalSessionId = null;
  terminalSessionApp = '';
  terminalConnectToken += 1;
  if (terminalSocket) {
    try { terminalSocket.close(); } catch {}
    terminalSocket = null;
  }
  setTerminalStatus('Session ended');
  terminalNotice(wasOpencode
    ? 'This OpenCode session is no longer running. Close this window and start OC Assist again from the App Creation tab.'
    : 'This terminal session is no longer running. Close this window and open the terminal again.');
  toast(wasOpencode
    ? 'The OC Assist session ended. Start OC Assist again to continue.'
    : 'The terminal session ended. Open the terminal again to start a new session.', true, 8000);
  loadCoreOpencode();
  loadAssistSessions();
}

async function scheduleTerminalReconnect(sessionId) {
  if (!sessionId || sessionId !== terminalSessionId) return;
  if (terminalReconnectAttempt >= TERMINAL_MAX_RECONNECT) {
    // The HTTP transport retries indefinitely, so never give up here either.
    startTerminalHttp(sessionId, terminalConnectToken);
    return;
  }
  const attempt = terminalReconnectAttempt++;
  const delay = Math.min(1000 * (2 ** Math.min(attempt, 4)), 15000);
  setTerminalStatus(`Disconnected — reconnecting in ${Math.ceil(delay / 1000)}s…`);
  if (terminalReconnectTimer) clearTimeout(terminalReconnectTimer);
  terminalReconnectTimer = setTimeout(async () => {
    terminalReconnectTimer = null;
    if (sessionId !== terminalSessionId) return;
    let exists = true;
    try {
      const res = await fetch('/api/terminal', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        if (Array.isArray(data.sessions)) {
          exists = data.sessions.some(session => session && session.id === sessionId);
        }
      }
    } catch {
      // Server still unreachable; retry the socket below.
    }
    if (sessionId !== terminalSessionId) return;
    if (!exists) {
      handleLostTerminalSession(sessionId);
      return;
    }
    if (terminalReconnectAttempt >= TERMINAL_WS_FALLBACK_ATTEMPTS) {
      startTerminalHttp(sessionId, terminalConnectToken);
      return;
    }
    connectTerminal({ reconnect: true });
  }, delay);
}

function scheduleTerminalHttpPoll(sessionId, token, delay) {
  if (terminalHttpTimer) clearTimeout(terminalHttpTimer);
  terminalHttpTimer = setTimeout(() => {
    terminalHttpTimer = null;
    pollTerminalHttp(sessionId, token);
  }, Math.max(0, delay));
}

function failTerminalHttp(sessionId, token, message) {
  if (token !== terminalConnectToken || sessionId !== terminalSessionId || terminalTransport !== 'http') return;
  terminalHttpErrors += 1;
  if (terminalHttpErrors === TERMINAL_MAX_RECONNECT && !terminalHttpOutageNoticeShown) {
    terminalHttpOutageNoticeShown = true;
    terminalNotice('The connection to Dok was interrupted. Still retrying; the session resumes automatically when the server is reachable.');
  }
  if (terminalHttpErrors >= TERMINAL_MAX_RECONNECT) {
    setTerminalStatus('Disconnected — still retrying…');
  } else {
    setTerminalStatus(`Connection lost — retrying (${terminalHttpErrors}/${TERMINAL_MAX_RECONNECT})…`);
  }
  scheduleTerminalHttpPoll(sessionId, token, Math.min(500 * Math.min(terminalHttpErrors, 10), 5000));
}

async function pollTerminalHttp(sessionId, token) {
  if (token !== terminalConnectToken || sessionId !== terminalSessionId || terminalTransport !== 'http') return;
  let res;
  try {
    res = await fetch(
      `/api/terminal/sessions/${encodeURIComponent(sessionId)}/output?after=${terminalHttpCursor}`,
      { cache: 'no-store' }
    );
  } catch {
    failTerminalHttp(sessionId, token, 'The terminal connection was lost.');
    return;
  }
  if (token !== terminalConnectToken || sessionId !== terminalSessionId || terminalTransport !== 'http') return;
  if (res.status === 404) {
    handleLostTerminalSession(sessionId);
    return;
  }
  if (!res.ok) {
    failTerminalHttp(sessionId, token, `The terminal connection failed (HTTP ${res.status}).`);
    return;
  }
  let data;
  try {
    data = await res.json();
  } catch {
    failTerminalHttp(sessionId, token, 'The terminal returned an invalid response.');
    return;
  }
  if (token !== terminalConnectToken || sessionId !== terminalSessionId || terminalTransport !== 'http') return;
  const recoveredFromOutage = terminalHttpOutageNoticeShown;
  terminalHttpErrors = 0;
  terminalHttpOutageNoticeShown = false;
  if (recoveredFromOutage) {
    setTerminalStatus('Connected (compatibility mode)');
    terminalNotice('Connection restored.');
  }
  if (!terminalHttpReady) {
    applyTerminalReady(data.session || {});
    terminalHttpReady = true;
    setTimeout(fitTerminal, 30);
  }
  if (terminalHttpNoticePending) {
    terminalHttpNoticePending = false;
    setTerminalStatus('Connected (compatibility mode)');
    const message = 'WebSocket is unavailable here; using HTTP compatibility mode.';
    if (terminalSessionApp === 'opencode') toast(message, false, 6000);
    else terminalNotice(message);
  }
  if (data.truncated && !terminalHttpTruncatedShown) {
    terminalHttpTruncatedShown = true;
    const message = 'Some earlier terminal output is no longer in the replay buffer.';
    if (terminalSessionApp === 'opencode') toast(message, true, 6000);
    else terminalNotice(message);
  }
  const chunks = Array.isArray(data.chunks) ? data.chunks : [];
  for (const chunk of chunks) {
    if (terminal && typeof chunk === 'string') terminal.write(chunk);
  }
  const cursor = Number(data.cursor);
  if (Number.isFinite(cursor)) terminalHttpCursor = cursor;
  if (data.exited) {
    clearTerminalConnectionTimers();
    setTerminalStatus(`Exited (${data.exitCode})`);
    toast(`Terminal session ended${data.exitCode === 0 ? '' : ` with code ${data.exitCode}`}`, data.exitCode !== 0);
    loadCoreOpencode();
    loadAssistSessions();
    return;
  }
  scheduleTerminalHttpPoll(sessionId, token, chunks.length ? 25 : TERMINAL_HTTP_IDLE_MS);
}

function startTerminalHttp(sessionId, token) {
  if (token !== terminalConnectToken || sessionId !== terminalSessionId) return;
  clearTerminalConnectionTimers();
  terminalTransport = 'http';
  if (terminalSocket) {
    try { terminalSocket.close(); } catch {}
    terminalSocket = null;
  }
  terminalHttpCursor = 0;
  terminalHttpErrors = 0;
  terminalHttpReady = false;
  terminalHttpInputQueue = '';
  terminalHttpOutageNoticeShown = false;
  if (!terminalHttpFallbackNoticeShown) {
    terminalHttpFallbackNoticeShown = true;
    terminalHttpNoticePending = true;
  }
  setTerminalStatus('Connecting without WebSocket…');
  pollTerminalHttp(sessionId, token);
}

function connectTerminal({ reconnect = false } = {}) {
  if (!terminalSessionId) return;
  if (terminalReconnectTimer) {
    clearTimeout(terminalReconnectTimer);
    terminalReconnectTimer = null;
  }
  const sessionId = terminalSessionId;
  const token = ++terminalConnectToken;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${proto}//${location.host}/api/terminal/ws?id=${encodeURIComponent(sessionId)}`;
  let ws;
  try {
    ws = new WebSocket(url);
  } catch {
    startTerminalHttp(sessionId, token);
    return;
  }
  let opened = false;
  terminalTransport = 'ws';
  terminalSocket = ws;
  setTerminalStatus(reconnect ? 'Reconnecting…' : 'Connecting…');
  // Some proxies never answer the upgrade request. Do not leave the chat stuck
  // on "Connecting…"; give the handshake a deadline and use HTTP polling.
  if (terminalReadyTimer) clearTimeout(terminalReadyTimer);
  terminalReadyTimer = setTimeout(() => {
    terminalReadyTimer = null;
    if (token !== terminalConnectToken || terminalSessionId !== sessionId) return;
    if (terminalSocket !== ws || opened) return;
    try { ws.close(); } catch {}
    startTerminalHttp(sessionId, token);
  }, TERMINAL_CONNECT_TIMEOUT_MS);

  ws.onopen = () => {
    if (token !== terminalConnectToken || terminalSessionId !== sessionId) return;
    opened = true;
    terminalTransport = 'ws';
    setTerminalStatus('Attaching…');
    startTerminalHeartbeat(ws, token);
    fitTerminal();
    if (terminal) terminal.focus();
    // A proxy can accept the upgrade and then swallow the session frames. If
    // the server's ready message never arrives, switch to HTTP polling instead
    // of leaving the chat stuck on a silent socket.
    if (terminalReadyTimer) clearTimeout(terminalReadyTimer);
    terminalReadyTimer = setTimeout(() => {
      terminalReadyTimer = null;
      if (token !== terminalConnectToken || terminalSessionId !== sessionId) return;
      if (terminalSocket !== ws) return;
      try { ws.close(); } catch {}
      startTerminalHttp(sessionId, token);
    }, TERMINAL_READY_TIMEOUT_MS);
  };

  ws.onmessage = (event) => {
    if (token !== terminalConnectToken) return;
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (!message || typeof message !== 'object') return;
    if (message.type === 'output' && terminal) {
      terminal.write(message.data);
    } else if (message.type === 'ready') {
      if (terminalReadyTimer) {
        clearTimeout(terminalReadyTimer);
        terminalReadyTimer = null;
      }
      // Restore the reconnect budget only after the socket has stayed open for
      // a while, so a proxy that accepts and instantly drops every attempt
      // reaches the HTTP fallback instead of reconnecting in a loop forever.
      if (terminalStableTimer) clearTimeout(terminalStableTimer);
      terminalStableTimer = setTimeout(() => {
        terminalStableTimer = null;
        if (token === terminalConnectToken && terminalSessionId === sessionId) terminalReconnectAttempt = 0;
      }, TERMINAL_STABLE_MS);
      applyTerminalReady(message.session || {});
    } else if (message.type === 'ping') {
      try { ws.send(JSON.stringify({ type: 'pong', at: Date.now() })); } catch {}
    } else if (message.type === 'exit') {
      clearTerminalConnectionTimers();
      setTerminalStatus(`Exited (${message.code})`);
      toast(`Terminal session ended${message.code === 0 ? '' : ` with code ${message.code}`}`, message.code !== 0);
      loadCoreOpencode();
    }
  };

  ws.onclose = () => {
    if (token !== terminalConnectToken) return;
    if (terminalHeartbeatTimer) {
      clearInterval(terminalHeartbeatTimer);
      terminalHeartbeatTimer = null;
    }
    if (terminalReadyTimer) {
      clearTimeout(terminalReadyTimer);
      terminalReadyTimer = null;
    }
    if (terminalStableTimer) {
      clearTimeout(terminalStableTimer);
      terminalStableTimer = null;
    }
    if (terminalSocket === ws) terminalSocket = null;
    if (terminalTransport !== 'ws') return;
    const status = qs('#terminalStatus')?.textContent || '';
    if (status.startsWith('Exited')) return;
    if (!terminalSessionId || terminalSessionId !== sessionId) return;
    // A proxy that strips the upgrade header closes before `open`. Switch to
    // HTTP polling immediately instead of making the user wait through retries.
    if (!opened) {
      startTerminalHttp(sessionId, token);
      return;
    }
    scheduleTerminalReconnect(sessionId);
  };

  ws.onerror = () => {
    // onclose always follows and owns the reconnect state.
  };
}

async function stopCurrentTerminalSession({ quiet = false, exceptId = '', keepOpencode = false } = {}) {
  const id = terminalSessionId;
  const wasOpencode = terminalSessionApp === 'opencode';
  terminalSessionId = null;
  terminalSessionApp = '';
  terminalConnectToken += 1;
  clearTerminalConnectionTimers();
  if (terminalSocket) {
    try { terminalSocket.close(); } catch {}
    terminalSocket = null;
  }
  if (id && id !== exceptId && !(keepOpencode && wasOpencode)) {
    try {
      await api(`/api/terminal/sessions/${encodeURIComponent(id)}/stop`, { method: 'POST' });
    } catch (e) {
      if (!quiet) toast(e.message, true);
    }
  }
  if (!quiet) setTerminalStatus('Stopped');
  loadCoreOpencode();
  loadAssistSessions();
}

function closeTerminalSession() {
  terminalOpenToken += 1;
  const id = terminalSessionId;
  const wasOpencode = terminalSessionApp === 'opencode';
  terminalSessionId = null;
  terminalSessionApp = '';
  terminalConnectToken += 1;
  clearTerminalConnectionTimers();
  if (terminalSocket) {
    try { terminalSocket.close(); } catch {}
    terminalSocket = null;
  }
  // Closing the chat window must not cancel an OC Assist build. The explicit
  // Stop button still ends it; otherwise it keeps running so the app can be
  // finished and the chat reopened from App Creation later.
  if (id && !wasOpencode) {
    fetch(`/api/terminal/sessions/${encodeURIComponent(id)}/stop`, { method: 'POST' }).catch(() => {});
  } else if (id && wasOpencode) {
    toast('OC Assist keeps running in the background. Reopen the chat from App Creation.', false, 7000);
  }
  resetTerminalView();
  setTimeout(() => {
    loadCoreOpencode();
    loadAssistSessions();
  }, 200);
}

async function openTerminal({ mode = 'admin', app = 'shell' } = {}) {
  mode = mode === 'user' ? 'user' : 'admin';
  app = app === 'opencode' ? 'opencode' : 'shell';
  const modal = qs('#terminalModal');
  if (!modal) return;
  modal.classList.remove('hidden');
  if (qs('#terminalTitle')) qs('#terminalTitle').textContent = 'Terminal';
  if (qs('#terminalSessionLabel')) qs('#terminalSessionLabel').textContent = '';
  setTerminalStatus('Starting…');

  const openToken = ++terminalOpenToken;
  // Opening a shell should not cancel an OC Assist build that is still running.
  await stopCurrentTerminalSession({ quiet: true, keepOpencode: true });
  if (openToken !== terminalOpenToken || modal.classList.contains('hidden')) return;
  resetTerminalView();
  terminalReconnectAttempt = 0;
  if (!ensureTerminal()) {
    setTerminalStatus('Terminal unavailable');
    toast('The terminal component failed to load. Reload the page and try again.', true, 8000);
    return;
  }
  setTimeout(fitTerminal, 50);

  try {
    const res = await api('/api/terminal/sessions', jsonBody({ mode, app }));
    if (openToken !== terminalOpenToken || modal.classList.contains('hidden')) {
      if (res.session?.id) {
        fetch(`/api/terminal/sessions/${encodeURIComponent(res.session.id)}/stop`, { method: 'POST' }).catch(() => {});
      }
      return;
    }
    terminalSessionId = res.session?.id || null;
    terminalSessionApp = app;
    if (!terminalSessionId) throw new Error('The server did not return a terminal session');
    if (qs('#terminalTitle')) qs('#terminalTitle').textContent = 'Terminal';
    connectTerminal();
    setTimeout(fitTerminal, 120);
  } catch (e) {
    if (openToken !== terminalOpenToken) return;
    setTerminalStatus('Failed to start');
    toast(e.message, true, 7000);
  }
}

async function openExistingTerminal(session) {
  if (!session?.id) return;
  const modal = qs('#terminalModal');
  if (!modal) return;
  const app = session.app === 'opencode' ? 'opencode' : 'shell';
  modal.classList.remove('hidden');
  if (qs('#terminalTitle')) qs('#terminalTitle').textContent = session.title || 'Terminal';
  setTerminalStatus('Connecting…');
  const openToken = ++terminalOpenToken;
  // Never stop the session we are about to attach to. This can happen when the
  // server response is handled after a reconnect or a rapid double launch.
  // Other running OC Assist builds also keep going in the background.
  await stopCurrentTerminalSession({ quiet: true, exceptId: session.id, keepOpencode: true });
  if (openToken !== terminalOpenToken || modal.classList.contains('hidden')) return;
  resetTerminalView();
  terminalReconnectAttempt = 0;
  if (!ensureTerminal()) {
    setTerminalStatus('Terminal unavailable');
    toast('The terminal component failed to load. OC Assist keeps running; reopen it from App Creation after reloading.', true, 8000);
    loadAssistSessions();
    return;
  }
  terminalSessionId = session.id;
  terminalSessionApp = app;
  if (qs('#terminalSessionLabel')) {
    qs('#terminalSessionLabel').textContent = app === 'opencode'
      ? 'OC Assist can ask follow-up questions. The app appears in Apps when it is ready.'
      : session.title || session.id;
  }
  connectTerminal();
  setTimeout(fitTerminal, 120);
}

let assistChatId = null;
let assistChatPollTimer = null;
let assistChatToken = 0;
let assistChatRevision = '';
let assistChatPendingKey = '';
let assistChatData = null;

function assistChatBusy(data = assistChatData) {
  return data?.status?.type === 'busy' || data?.status?.type === 'retry';
}

function assistChatWaiting(data = assistChatData) {
  return ((data?.questions?.length || 0) + (data?.permissions?.length || 0)) > 0;
}

function setAssistChatStatus(text) {
  const el = qs('#assistChatStatus');
  if (el) el.textContent = text;
}

function assistChatStatusText(data) {
  if (!data) return 'Connecting…';
  if (assistChatWaiting(data)) return 'Waiting for your response';
  if (data.status?.type === 'retry') {
    return `Retrying${data.status.attempt ? ` (attempt ${data.status.attempt})` : ''}…`;
  }
  if (assistChatBusy(data)) return 'Working…';
  if (data.chat?.error) return data.chat.error;
  return 'Idle — ask a follow-up';
}

function clearAssistChatPoll() {
  if (assistChatPollTimer) {
    clearTimeout(assistChatPollTimer);
    assistChatPollTimer = null;
  }
}

function closeAssistChat() {
  assistChatToken += 1;
  clearAssistChatPoll();
  assistChatId = null;
  assistChatRevision = '';
  assistChatPendingKey = '';
  assistChatData = null;
  const box = qs('#assistChatMessages');
  if (box) box.innerHTML = '';
  const pending = qs('#assistChatPending');
  if (pending) {
    pending.innerHTML = '';
    pending.classList.add('hidden');
  }
  const input = qs('#assistChatInput');
  if (input) input.value = '';
}

function assistElement(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function appendAssistRichText(parent, value) {
  const text = String(value || '');
  const segments = text.split(/```/);
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    if (i % 2 === 1) {
      const code = segment.replace(/^[^\n]*\n/, '').replace(/\s+$/, '');
      if (!code) continue;
      parent.appendChild(assistElement('pre', '', code));
    } else {
      const clean = segment.replace(/^\n+|\n+$/g, '');
      if (!clean) continue;
      parent.appendChild(assistElement('div', '', clean));
    }
  }
}

function renderAssistMessages(data) {
  const box = qs('#assistChatMessages');
  if (!box) return;
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const openKeys = new Set(
    Array.from(box.querySelectorAll('details[data-key][open]')).map(el => el.dataset.key)
  );
  box.innerHTML = '';

  const messages = Array.isArray(data?.messages) ? data.messages : [];
  let userMessages = 0;
  let renderedAssistant = false;

  for (const record of messages) {
    const info = record?.info || {};
    const parts = Array.isArray(record?.parts) ? record.parts : [];
    const text = parts.filter(part => part.type === 'text').map(part => part.text || '').join('\n\n').trim();

    if (info.role === 'user') {
      userMessages += 1;
      if (!text) continue;
      if (userMessages === 1) {
        const details = assistElement('details', 'assist-request');
        details.dataset.key = `user-${info.id || userMessages}`;
        details.appendChild(assistElement('summary', '', 'Your request'));
        appendAssistRichText(details, text);
        box.appendChild(details);
      } else {
        const wrap = assistElement('div', 'assist-msg user');
        wrap.appendChild(assistElement('div', 'assist-msg-label', 'You'));
        const bubble = assistElement('div', 'assist-bubble');
        appendAssistRichText(bubble, text);
        wrap.appendChild(bubble);
        box.appendChild(wrap);
      }
      continue;
    }

    if (info.role !== 'assistant') continue;
    const wrap = assistElement('div', 'assist-msg assistant');
    wrap.appendChild(assistElement('div', 'assist-msg-label', 'OC Assist'));
    let hasContent = false;

    for (const part of parts) {
      if (part.type === 'text') {
        const value = String(part.text || '').trim();
        if (!value) continue;
        const bubble = assistElement('div', 'assist-bubble');
        appendAssistRichText(bubble, value);
        wrap.appendChild(bubble);
        hasContent = true;
      } else if (part.type === 'reasoning') {
        const value = String(part.text || '').trim();
        if (!value) continue;
        const details = assistElement('details', 'assist-reasoning');
        details.dataset.key = part.id || '';
        details.appendChild(assistElement('summary', '', 'Reasoning'));
        details.appendChild(assistElement('pre', '', value));
        wrap.appendChild(details);
        hasContent = true;
      } else if (part.type === 'tool') {
        const state = part.state || {};
        const details = assistElement('details', 'assist-tool');
        details.dataset.key = part.id || '';
        details.dataset.status = state.status || '';
        if (state.status === 'error') details.open = true;
        const summary = assistElement('summary');
        summary.appendChild(assistElement('strong', '', part.tool || 'tool'));
        if (state.title) summary.appendChild(document.createTextNode(` · ${state.title}`));
        if (state.status) summary.appendChild(assistElement('span', 'assist-tool-status', state.status));
        details.appendChild(summary);
        if (state.input && typeof state.input === 'object' && Object.keys(state.input).length) {
          let inputText = '';
          try { inputText = JSON.stringify(state.input, null, 2); } catch { inputText = String(state.input); }
          if (inputText) details.appendChild(assistElement('pre', '', inputText));
        }
        if (state.output) details.appendChild(assistElement('pre', '', state.output));
        if (state.error) details.appendChild(assistElement('pre', '', state.error));
        wrap.appendChild(details);
        hasContent = true;
      } else if (part.type === 'patch') {
        const files = Array.isArray(part.files) ? part.files : [];
        if (!files.length) continue;
        const details = assistElement('details', 'assist-tool');
        details.dataset.key = part.id || '';
        details.appendChild(assistElement('summary', '', `Changed ${files.length} file${files.length === 1 ? '' : 's'}`));
        details.appendChild(assistElement('pre', '', files.join('\n')));
        wrap.appendChild(details);
        hasContent = true;
      } else if (part.type === 'agent') {
        if (!part.name) continue;
        wrap.appendChild(assistElement('div', 'assist-tool', `Delegated to ${part.name}`));
        hasContent = true;
      } else if (part.type === 'file') {
        if (!part.filename) continue;
        wrap.appendChild(assistElement('div', 'assist-tool', `Attached ${part.filename}`));
        hasContent = true;
      }
    }

    if (info.error) {
      wrap.appendChild(assistElement('div', 'assist-bubble error', info.error));
      hasContent = true;
    }
    if (hasContent) {
      box.appendChild(wrap);
      renderedAssistant = true;
    }
  }

  if (assistChatBusy(data)) {
    const working = assistElement('div', 'assist-working');
    working.appendChild(assistElement('span', 'spinner'));
    working.appendChild(document.createTextNode(renderedAssistant ? 'OC Assist is still working…' : 'OC Assist is working…'));
    box.appendChild(working);
  } else if (!messages.length) {
    const empty = assistElement('div', 'assist-chat-empty');
    empty.appendChild(assistElement('span', 'spinner'));
    empty.appendChild(document.createTextNode('OC Assist is preparing your app. This can take a few minutes.'));
    box.appendChild(empty);
  }

  box.querySelectorAll('details[data-key]').forEach(el => {
    if (openKeys.has(el.dataset.key)) el.open = true;
  });
  if (nearBottom) box.scrollTop = box.scrollHeight;
}

function assistPendingKeyFor(data) {
  return JSON.stringify({
    questions: (data?.questions || []).map(question => question.id),
    permissions: (data?.permissions || []).map(permission => permission.id)
  });
}

function renderAssistPending(data) {
  const box = qs('#assistChatPending');
  if (!box) return;
  box.innerHTML = '';
  const questions = Array.isArray(data?.questions) ? data.questions : [];
  const permissions = Array.isArray(data?.permissions) ? data.permissions : [];
  if (!questions.length && !permissions.length) {
    box.classList.add('hidden');
    return;
  }
  box.classList.remove('hidden');

  for (const request of questions) {
    const card = assistElement('div', 'assist-pending-card');
    card.appendChild(assistElement('div', 'assist-pending-title', 'OC Assist needs an answer'));
    for (const [index, item] of (request.questions || []).entries()) {
      const block = assistElement('div', 'assist-pending-question-block');
      block.dataset.index = String(index);
      block.dataset.multiple = item.multiple ? 'true' : 'false';
      if (item.header) block.appendChild(assistElement('div', 'assist-pending-title', item.header));
      block.appendChild(assistElement('p', 'assist-pending-question', item.question || ''));
      for (const option of item.options || []) {
        const label = assistElement('label', 'assist-pending-option');
        const input = document.createElement('input');
        input.type = item.multiple ? 'checkbox' : 'radio';
        input.name = `assist-q-${request.id}-${index}`;
        input.value = option.label;
        label.appendChild(input);
        const text = assistElement('span', '', option.label);
        if (option.description) text.appendChild(assistElement('small', '', option.description));
        label.appendChild(text);
        block.appendChild(label);
      }
      if (item.custom) {
        const input = assistElement('input', 'input assist-pending-custom');
        input.type = 'text';
        input.placeholder = 'Type your own answer';
        block.appendChild(input);
      }
      card.appendChild(block);
    }
    const actions = assistElement('div', 'assist-pending-actions');
    const send = assistElement('button', 'btn btn-primary', 'Send answer');
    send.type = 'button';
    const reject = assistElement('button', 'btn', 'Skip question');
    reject.type = 'button';
    actions.appendChild(send);
    actions.appendChild(reject);
    card.appendChild(actions);

    send.addEventListener('click', async () => {
      const answers = [];
      for (const block of card.querySelectorAll('.assist-pending-question-block')) {
        const checked = Array.from(block.querySelectorAll('input[type="checkbox"]:checked, input[type="radio"]:checked'))
          .map(input => input.value);
        const custom = block.querySelector('.assist-pending-custom')?.value.trim() || '';
        const multiple = block.dataset.multiple === 'true';
        const values = multiple ? [...checked, ...(custom ? [custom] : [])] : (custom ? [custom] : checked);
        if (!values.length) {
          toast('Choose an answer for every question', true);
          return;
        }
        answers.push(values);
      }
      setLoading(send, true, 'Sending…');
      setLoading(reject, true);
      try {
        await api(`/api/assist/chats/${encodeURIComponent(assistChatId)}/question`, jsonBody({
          requestID: request.id,
          answers
        }));
        setAssistChatStatus('Answer sent — OC Assist is continuing…');
        scheduleAssistChatPoll(assistChatToken, 250);
      } catch (e) {
        toast(e.message, true);
      } finally {
        setLoading(send, false, 'Send answer');
        setLoading(reject, false, 'Skip question');
      }
    });

    reject.addEventListener('click', async () => {
      setLoading(send, true);
      setLoading(reject, true, 'Skipping…');
      try {
        await api(`/api/assist/chats/${encodeURIComponent(assistChatId)}/question/reject`, jsonBody({
          requestID: request.id
        }));
        setAssistChatStatus('Question skipped — OC Assist is continuing…');
        scheduleAssistChatPoll(assistChatToken, 250);
      } catch (e) {
        toast(e.message, true);
      } finally {
        setLoading(send, false, 'Send answer');
        setLoading(reject, false, 'Skip question');
      }
    });

    box.appendChild(card);
  }

  for (const permission of permissions) {
    const card = assistElement('div', 'assist-pending-card');
    card.appendChild(assistElement('div', 'assist-pending-title', `Approval needed: ${permission.permission}`));
    if (permission.patterns?.length) {
      card.appendChild(assistElement('p', 'assist-pending-question', permission.patterns.join('\n')));
    }
    const actions = assistElement('div', 'assist-pending-actions');
    const allow = assistElement('button', 'btn btn-primary', 'Allow once');
    const always = assistElement('button', 'btn', 'Always allow');
    const deny = assistElement('button', 'btn btn-danger', 'Deny');
    for (const button of [allow, always, deny]) {
      button.type = 'button';
      actions.appendChild(button);
    }
    card.appendChild(actions);

    const reply = async (value, button, label) => {
      setLoading(button, true, label);
      try {
        await api(`/api/assist/chats/${encodeURIComponent(assistChatId)}/permission`, jsonBody({
          requestID: permission.id,
          reply: value
        }));
        setAssistChatStatus('Response sent — OC Assist is continuing…');
        scheduleAssistChatPoll(assistChatToken, 250);
      } catch (e) {
        toast(e.message, true);
        setLoading(button, false, label.replace('…', ''));
      }
    };
    allow.addEventListener('click', () => reply('once', allow, 'Allowing…'));
    always.addEventListener('click', () => reply('always', always, 'Allowing…'));
    deny.addEventListener('click', () => reply('reject', deny, 'Denying…'));
    box.appendChild(card);
  }
}

function updateAssistChatComposer() {
  const input = qs('#assistChatInput');
  const send = qs('#assistChatSendBtn');
  const abort = qs('#assistChatAbortBtn');
  const stop = qs('#assistChatStopBtn');
  const hint = qs('#assistChatHint');
  const busy = assistChatBusy();
  const waiting = assistChatWaiting();
  const ready = !!assistChatId;
  if (input) {
    input.placeholder = waiting
      ? 'Answer the question above to continue…'
      : busy ? 'OC Assist is working…' : 'Ask a follow-up or add information…';
  }
  if (send) send.disabled = !ready || busy || waiting || !(input?.value.trim());
  if (abort) abort.disabled = !ready || !busy;
  if (stop) stop.disabled = !ready;
  if (hint) {
    hint.textContent = waiting
      ? 'Answer the question above, or skip it.'
      : busy ? 'OC Assist is working. Cancel run stops the current response.' : 'Enter to send · Shift+Enter for a new line';
  }
}

function scheduleAssistChatPoll(token, delay = 0) {
  clearAssistChatPoll();
  if (token !== assistChatToken || !assistChatId) return;
  assistChatPollTimer = setTimeout(() => {
    assistChatPollTimer = null;
    pollAssistChat(token);
  }, Math.max(0, delay));
}

function applyAssistChatSnapshot(data) {
  assistChatData = data;
  const title = data?.chat?.title || 'OC Assist';
  if (qs('#assistChatTitle')) qs('#assistChatTitle').textContent = title;
  if (qs('#assistChatApp')) {
    qs('#assistChatApp').textContent = data?.chat?.appName ? `App: ${data.chat.appName}` : '';
  }
  setAssistChatStatus(assistChatStatusText(data));

  const pendingKey = assistPendingKeyFor(data);
  if (pendingKey !== assistChatPendingKey) {
    assistChatPendingKey = pendingKey;
    renderAssistPending(data);
  }
  if (data?.revision !== assistChatRevision) {
    assistChatRevision = data?.revision || '';
    renderAssistMessages(data);
  }
  updateAssistChatComposer();
}

async function pollAssistChat(token) {
  if (token !== assistChatToken || !assistChatId) return;
  const id = assistChatId;
  let data;
  try {
    data = await api(`/api/assist/chats/${encodeURIComponent(id)}`);
  } catch (e) {
    if (token !== assistChatToken || id !== assistChatId) return;
    if (e.status === 404) {
      toast(e.message, true, 7000);
      closeAssistChat();
      qs('#assistChatModal')?.classList.add('hidden');
      loadAssistSessions();
      loadCoreOpencode();
      return;
    }
    setAssistChatStatus('Connection lost — retrying…');
    scheduleAssistChatPoll(token, 2000);
    return;
  }
  if (token !== assistChatToken || id !== assistChatId) return;
  applyAssistChatSnapshot(data);
  const delay = assistChatBusy(data) ? 1000 : 2500;
  scheduleAssistChatPoll(token, delay);
}

function openAssistChat(chat) {
  const modal = qs('#assistChatModal');
  if (!modal || !chat?.id) return;
  closeAssistChat();
  modal.classList.remove('hidden');
  assistChatId = chat.id;
  assistChatRevision = '';
  assistChatPendingKey = '';
  assistChatData = null;
  if (qs('#assistChatTitle')) qs('#assistChatTitle').textContent = chat.title || 'OC Assist';
  if (qs('#assistChatApp')) {
    qs('#assistChatApp').textContent = chat.appName ? `App: ${chat.appName}` : '';
  }
  const box = qs('#assistChatMessages');
  if (box) {
    box.innerHTML = '';
    const empty = assistElement('div', 'assist-chat-empty');
    empty.appendChild(assistElement('span', 'spinner'));
    empty.appendChild(document.createTextNode('Connecting to OC Assist…'));
    box.appendChild(empty);
  }
  const pending = qs('#assistChatPending');
  if (pending) {
    pending.innerHTML = '';
    pending.classList.add('hidden');
  }
  setAssistChatStatus('Connecting…');
  updateAssistChatComposer();
  const token = ++assistChatToken;
  scheduleAssistChatPoll(token, 0);
  setTimeout(() => qs('#assistChatInput')?.focus(), 100);
}

async function abortAssistChatRun() {
  if (!assistChatId) return;
  const btn = qs('#assistChatAbortBtn');
  setLoading(btn, true, 'Cancelling…');
  try {
    await api(`/api/assist/chats/${encodeURIComponent(assistChatId)}/abort`, { method: 'POST' });
    setAssistChatStatus('Run cancelled.');
    scheduleAssistChatPoll(assistChatToken, 400);
  } catch (e) {
    toast(e.message, true);
  } finally {
    setLoading(btn, false, 'Cancel run');
    updateAssistChatComposer();
  }
}

async function stopAssistChat() {
  if (!assistChatId) return;
  if (!confirm('Stop this OC Assist chat? Any work in progress will be cancelled.')) return;
  const btn = qs('#assistChatStopBtn');
  setLoading(btn, true, 'Stopping…');
  try {
    await api(`/api/assist/chats/${encodeURIComponent(assistChatId)}/stop`, { method: 'POST' });
    qs('#assistChatModal')?.classList.add('hidden');
    closeAssistChat();
    toast('OC Assist chat stopped');
    await loadAssistSessions();
    await loadCoreOpencode();
  } catch (e) {
    toast(e.message, true);
  } finally {
    setLoading(btn, false, 'Stop chat');
  }
}

if (qs('#assistStartBtn')) {
  qs('#assistStartBtn').addEventListener('click', async () => {
    const btn = qs('#assistStartBtn');
    const prompt = qs('#assistPrompt')?.value.trim() || '';
    const output = qs('#assistOutput');
    if (!prompt) {
      toast('Describe the app you want OC Assist to create', true);
      qs('#assistPrompt')?.focus();
      return;
    }
    if (!qs('#assistName')?.value.trim()) {
      toast('App title is required', true);
      qs('#assistName')?.focus();
      return;
    }
    const files = [
      ...Array.from(qs('#assistFiles')?.files || []),
      ...Array.from(qs('#assistFolder')?.files || [])
    ];
    const form = new FormData();
    form.append('prompt', prompt);
    form.append('data', qs('#assistData')?.value || '');
    form.append('name', qs('#assistName')?.value.trim() || '');
    const paths = [];
    for (const file of files) {
      form.append('files', file, file.name);
      paths.push(file.webkitRelativePath || file.name);
    }
    if (paths.length) form.append('paths', JSON.stringify(paths));
    setLoading(btn, true, 'Starting…');
    if (output) {
      output.textContent = 'Starting OC Assist…';
      output.classList.remove('hidden');
    }
    let startedChat = null;
    try {
      const res = await fetch('/api/assist/start', { method: 'POST', body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || res.statusText || 'OC Assist failed to start');
      startedChat = data.chat;
      if (output) output.textContent = `OC Assist is ready for ${data.appName}. The app is saved stopped in Apps when it is ready so you can configure and deploy it.`;
      toast(`OC Assist started for ${data.appName}`, false, 6000);
      openAssistChat(data.chat);
      loadAssistSessions();
      loadCoreOpencode();
    } catch (e) {
      if (output) output.textContent = e.message;
      toast(e.message, true);
      if (startedChat?.id) {
        fetch(`/api/assist/chats/${encodeURIComponent(startedChat.id)}/stop`, { method: 'POST' }).catch(() => {});
      }
    } finally {
      setLoading(btn, false, 'Create App with OC Assist');
    }
  });
}

if (qs('#assistChatStopBtn')) {
  qs('#assistChatStopBtn').addEventListener('click', stopAssistChat);
}
if (qs('#assistChatAbortBtn')) {
  qs('#assistChatAbortBtn').addEventListener('click', abortAssistChatRun);
}
if (qs('#assistChatForm')) {
  qs('#assistChatForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = qs('#assistChatInput');
    const prompt = input?.value.trim() || '';
    if (!assistChatId || !prompt) return;
    if (assistChatBusy() || assistChatWaiting()) {
      toast(assistChatWaiting() ? 'Answer the question above first' : 'OC Assist is still working', true);
      return;
    }
    const btn = qs('#assistChatSendBtn');
    setLoading(btn, true, 'Sending…');
    try {
      await api(`/api/assist/chats/${encodeURIComponent(assistChatId)}/prompt`, jsonBody({ prompt }));
      if (input) input.value = '';
      setAssistChatStatus('Message sent — waiting for OC Assist…');
      scheduleAssistChatPoll(assistChatToken, 250);
    } catch (e) {
      toast(e.message, true);
    } finally {
      setLoading(btn, false, 'Send');
      updateAssistChatComposer();
    }
  });
}
if (qs('#assistChatInput')) {
  qs('#assistChatInput').addEventListener('input', updateAssistChatComposer);
  qs('#assistChatInput').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    qs('#assistChatForm')?.requestSubmit();
  });
}

async function loadAssistSessions() {
  const wrap = qs('#assistSessions');
  const list = qs('#assistSessionsList');
  if (!wrap || !list) return;
  try {
    const res = await api('/api/assist/chats');
    const chats = Array.isArray(res.chats) ? res.chats : [];
    if (!chats.length) {
      wrap.classList.add('hidden');
      list.innerHTML = '';
      return;
    }
    list.innerHTML = chats.map(chat => {
      const started = chat.createdAt ? new Date(chat.createdAt).toLocaleTimeString() : '';
      const state = chat.waiting
        ? 'waiting for you'
        : chat.status === 'busy' || chat.status === 'retry' ? 'working' : 'idle';
      const meta = [chat.title || 'OC Assist', started, state].filter(Boolean).join(' · ');
      return `
        <div class="session-item">
          <div class="session-item-meta">
            <span class="session-item-title">${escapeHtml(chat.title || 'OC Assist')}</span>
            <span class="session-item-sub">${escapeHtml([chat.appName, started, state].filter(Boolean).join(' · '))}</span>
          </div>
          <button class="btn" data-open-chat="${escapeHtml(chat.id)}" title="${escapeHtml(meta)}">Open chat</button>
        </div>`;
    }).join('');
    list.querySelectorAll('[data-open-chat]').forEach(btn => {
      btn.addEventListener('click', () => {
        const chat = chats.find(item => item.id === btn.dataset.openChat);
        if (chat) openAssistChat(chat);
      });
    });
    wrap.classList.remove('hidden');
  } catch {
    wrap.classList.add('hidden');
  }
}

async function loadCoreOpencode() {
  try {
    const res = await api('/api/core/opencode');
    coreOpencodeData = res;
    const badge = qs('#opencodeStatus');
    if (badge) {
      badge.textContent = res.installed ? `Ready${res.version ? ` · v${res.version}` : ''}` : 'Not installed';
      badge.className = 'mode-pill ' + (res.installed ? 'ok' : 'danger');
    }
    const sessions = res.sessions || [];
    const chats = res.chats || [];
    const total = sessions.length + chats.length;
    if (qs('#opencodeSessions')) {
      qs('#opencodeSessions').textContent = total
        ? `${total} OC Assist session${total === 1 ? '' : 's'} running`
        : 'No OC Assist sessions running.';
    }
    if (qs('#opencodeStopBtn')) qs('#opencodeStopBtn').disabled = total === 0;
    if (qs('#opencodeModel')) qs('#opencodeModel').value = res.settings?.model || '';
    if (qs('#opencodeProvider')) qs('#opencodeProvider').value = res.settings?.provider || '';
    if (qs('#opencodeApiKey')) {
      qs('#opencodeApiKey').value = '';
      qs('#opencodeApiKey').placeholder = res.settings?.hasApiKey
        ? 'API key saved (leave blank to keep)'
        : 'API key (optional)';
    }
  } catch {}
}

if (qs('#dashboardTerminalBtn')) {
  qs('#dashboardTerminalBtn').addEventListener('click', () => openTerminal({ mode: 'admin', app: 'shell' }));
}
if (qs('#terminalStopBtn')) {
  qs('#terminalStopBtn').addEventListener('click', () => stopCurrentTerminalSession());
}
if (qs('#opencodeStopBtn')) {
  qs('#opencodeStopBtn').addEventListener('click', async () => {
    const btn = qs('#opencodeStopBtn');
    setLoading(btn, true);
    try {
      const res = await api('/api/core/opencode/stop', jsonBody({}));
      toast(res.stopped ? `Stopped ${res.stopped} OC Assist session${res.stopped === 1 ? '' : 's'}` : 'No OC Assist sessions were running');
      if (assistChatId) {
        qs('#assistChatModal')?.classList.add('hidden');
        closeAssistChat();
      }
      if (terminalSessionId && terminalSessionApp === 'opencode') {
        terminalSessionId = null;
        terminalSessionApp = '';
        terminalConnectToken += 1;
        clearTerminalConnectionTimers();
        if (terminalSocket) { try { terminalSocket.close(); } catch {} terminalSocket = null; }
        setTerminalStatus('Stopped');
      }
      await loadCoreOpencode();
      await loadAssistSessions();
    } catch (e) {
      toast(e.message, true);
    } finally {
      setLoading(btn, false, 'Stop OC Assist sessions');
    }
  });
}
if (qs('#opencodeSaveSettings')) {
  qs('#opencodeSaveSettings').addEventListener('click', async () => {
    const btn = qs('#opencodeSaveSettings');
    const msg = qs('#opencodeSettingsMsg');
    setLoading(btn, true);
    try {
      await api('/api/core/opencode/settings', jsonBody({
        model: qs('#opencodeModel')?.value.trim() || '',
        provider: qs('#opencodeProvider')?.value.trim() || '',
        apiKey: qs('#opencodeApiKey')?.value || '',
        clearApiKey: !!qs('#opencodeClearApiKey')?.checked
      }));
      if (qs('#opencodeApiKey')) qs('#opencodeApiKey').value = '';
      if (qs('#opencodeClearApiKey')) qs('#opencodeClearApiKey').checked = false;
      if (msg) msg.textContent = 'Saved. New sessions use this configuration.';
      toast('OpenCode settings saved');
      await loadCoreOpencode();
    } catch (e) {
      if (msg) msg.textContent = e.message;
      toast(e.message, true);
    } finally {
      setLoading(btn, false, 'Save');
    }
  });
}

if (qs('#coreAllStart')) qs('#coreAllStart').addEventListener('click', () => coreServiceAction('all', 'start', qs('#coreAllStart'), loadSettings));
if (qs('#coreAllStop')) qs('#coreAllStop').addEventListener('click', () => coreServiceAction('all', 'stop', qs('#coreAllStop'), loadSettings));
if (qs('#coreAllRestart')) qs('#coreAllRestart').addEventListener('click', () => coreServiceAction('all', 'restart', qs('#coreAllRestart'), loadSettings));

if (qs('#authRunBtn')) {
  qs('#authRunBtn').addEventListener('click', async () => {
    const btn = qs('#authRunBtn');
    setLoading(btn, true);
    try {
      const res = await api('/api/core/auth/run', jsonBody({
        adminEmail: qs('#authEmail')?.value.trim() || '',
        adminPassword: qs('#authPassword')?.value || '',
        port: Number(qs('#authPort')?.value || 9000),
        domain: qs('#authDomain')?.value.trim() || ''
      }));
      qs('#authPassword').value = '';
      if (qs('#authMsg')) qs('#authMsg').textContent = res.message || '';
      toast(res.message || 'Authentik launched', false, 12000);
      await loadCoreAuth();
      openAuthContainersPicker();
    } catch (e) {
      toast(e.message, true);
    } finally {
      setLoading(btn, false, 'Launch Authentik');
    }
  });
}
if (qs('#authEditCompose')) qs('#authEditCompose').addEventListener('click', () => { qs('#authComposeEditor').classList.remove('hidden'); qs('#authEditorActions').classList.remove('hidden'); });
if (qs('#authEditComposeManage')) qs('#authEditComposeManage').addEventListener('click', () => { qs('#authComposeEditor').classList.remove('hidden'); qs('#authEditorActions').classList.remove('hidden'); });
if (qs('#authCancelCompose')) qs('#authCancelCompose').addEventListener('click', () => { qs('#authComposeEditor').classList.add('hidden'); qs('#authEditorActions').classList.add('hidden'); });
if (qs('#authSaveCompose')) {
  qs('#authSaveCompose').addEventListener('click', async () => {
    try {
      await api('/api/core/auth/compose', jsonBody({ compose: qs('#authComposeEditor').value }));
      qs('#authComposeEditor').classList.add('hidden');
      qs('#authEditorActions').classList.add('hidden');
      toast('Authentik compose saved');
    } catch (e) { toast(e.message, true); }
  });
}
if (qs('#authStartBtn')) qs('#authStartBtn').addEventListener('click', () => coreServiceAction('auth', 'start', qs('#authStartBtn'), loadCoreAuth));
if (qs('#authStopBtn')) qs('#authStopBtn').addEventListener('click', () => coreServiceAction('auth', 'stop', qs('#authStopBtn'), loadCoreAuth));
if (qs('#authRestartBtn')) qs('#authRestartBtn').addEventListener('click', () => coreServiceAction('auth', 'restart', qs('#authRestartBtn'), loadCoreAuth));
if (qs('#authOpenBtn')) qs('#authOpenBtn').addEventListener('click', () => window.open(coreAuthData?.url || 'http://localhost:9000', '_blank'));
if (qs('#authApplyDomain')) {
  qs('#authApplyDomain').addEventListener('click', async () => {
    const btn = qs('#authApplyDomain');
    const msg = qs('#authDomainMsg');
    setLoading(btn, true, 'Applying…');
    try {
      const res = await api('/api/core/auth/domain', jsonBody({ domain: qs('#authDomainManage')?.value.trim() || '' }));
      if (msg) msg.textContent = res.domain ? `Applied ${res.domain}${res.restarted ? ' · container recreated' : ' · restart to apply'}` : 'Domain cleared';
      toast(res.domain ? `Authentik domain set to ${res.domain}` : 'Authentik domain cleared');
      await loadCoreAuth();
    } catch (e) {
      if (msg) msg.textContent = e.message;
      toast(e.message, true);
    } finally {
      setLoading(btn, false, 'Apply domain');
    }
  });
}

if (qs('#autheliaRunBtn')) {
  qs('#autheliaRunBtn').addEventListener('click', async () => {
    const btn = qs('#autheliaRunBtn');
    setLoading(btn, true);
    try {
      const res = await api('/api/core/authelia/run', jsonBody({
        domain: qs('#autheliaDomain')?.value.trim() || '',
        port: Number(qs('#autheliaPort')?.value || 9091),
        adminUser: qs('#autheliaUser')?.value.trim() || 'admin',
        adminPassword: qs('#autheliaPassword')?.value || '',
        adminEmail: qs('#autheliaEmail')?.value.trim() || ''
      }));
      if (qs('#autheliaPassword')) qs('#autheliaPassword').value = '';
      const creds = res.credentials
        ? ` Username: ${res.credentials.username} · password: ${res.credentials.password}`
        : '';
      if (qs('#autheliaMsg')) qs('#autheliaMsg').textContent = `${res.message || ''}${creds}`;
      toast(`${res.message || 'Authelia launched'}${creds}`, false, 20000);
      await loadCoreAuthelia();
      openAuthContainersPicker();
    } catch (e) {
      toast(e.message, true);
    } finally {
      setLoading(btn, false, 'Launch Authelia');
    }
  });
}
if (qs('#autheliaEditCompose')) qs('#autheliaEditCompose').addEventListener('click', () => { qs('#autheliaComposeEditor').classList.remove('hidden'); qs('#autheliaEditorActions').classList.remove('hidden'); });
if (qs('#autheliaEditComposeManage')) qs('#autheliaEditComposeManage').addEventListener('click', () => { qs('#autheliaComposeEditor').classList.remove('hidden'); qs('#autheliaEditorActions').classList.remove('hidden'); });
if (qs('#autheliaCancelCompose')) qs('#autheliaCancelCompose').addEventListener('click', () => { qs('#autheliaComposeEditor').classList.add('hidden'); qs('#autheliaEditorActions').classList.add('hidden'); });
if (qs('#autheliaSaveCompose')) {
  qs('#autheliaSaveCompose').addEventListener('click', async () => {
    try {
      await api('/api/core/authelia/compose', jsonBody({ compose: qs('#autheliaComposeEditor').value }));
      qs('#autheliaComposeEditor').classList.add('hidden');
      qs('#autheliaEditorActions').classList.add('hidden');
      toast('Authelia compose saved');
    } catch (e) { toast(e.message, true); }
  });
}
if (qs('#autheliaStartBtn')) qs('#autheliaStartBtn').addEventListener('click', () => coreServiceAction('authelia', 'start', qs('#autheliaStartBtn'), loadCoreAuthelia));
if (qs('#autheliaStopBtn')) qs('#autheliaStopBtn').addEventListener('click', () => coreServiceAction('authelia', 'stop', qs('#autheliaStopBtn'), loadCoreAuthelia));
if (qs('#autheliaRestartBtn')) qs('#autheliaRestartBtn').addEventListener('click', () => coreServiceAction('authelia', 'restart', qs('#autheliaRestartBtn'), loadCoreAuthelia));
if (qs('#autheliaOpenBtn')) qs('#autheliaOpenBtn').addEventListener('click', () => window.open(coreAutheliaData?.url || 'https://localhost:9091', '_blank'));
if (qs('#autheliaApplyDomain')) {
  qs('#autheliaApplyDomain').addEventListener('click', async () => {
    const btn = qs('#autheliaApplyDomain');
    const msg = qs('#autheliaDomainMsg');
    setLoading(btn, true);
    try {
      const res = await api('/api/core/authelia/domain', jsonBody({ domain: qs('#autheliaDomainManage')?.value.trim() || '' }));
      if (msg) msg.textContent = res.domain ? `Portal: ${res.url}` : 'Portal domain cleared';
      toast(res.domain ? `Authelia portal set to ${res.url}` : 'Authelia portal domain cleared');
      await loadCoreAuthelia();
    } catch (e) {
      toast(e.message, true);
    } finally {
      setLoading(btn, false, 'Apply domain');
    }
  });
}
if (qs('#autheliaSyncBtn')) {
  qs('#autheliaSyncBtn').addEventListener('click', async () => {
    const btn = qs('#autheliaSyncBtn');
    setLoading(btn, true);
    try {
      const res = await api('/api/core/authelia/sync', { method: 'POST' });
      const hosts = Array.isArray(res.hosts) ? res.hosts : [];
      const skipped = Array.isArray(res.skippedHosts) ? res.skippedHosts : [];
      let text = hosts.length ? `Protected: ${hosts.join(', ')}` : 'No apps currently set ENABLE_AUTH=true';
      if (skipped.length) text += ` · Skipped (different domain): ${skipped.join(', ')}`;
      if (qs('#autheliaSyncMsg')) qs('#autheliaSyncMsg').textContent = text;
      toast(text, false, 8000);
      await loadCoreAuthelia();
    } catch (e) {
      toast(e.message, true);
    } finally {
      setLoading(btn, false);
    }
  });
}

// ---------------- Authelia user management ----------------
let autheliaUsersEditing = '';
let autheliaUsersCache = [];

function renderAutheliaUsers(users) {
  const list = qs('#autheliaUsersList');
  if (!list) return;
  autheliaUsersCache = Array.isArray(users) ? users : [];
  if (!autheliaUsersCache.length) {
    list.innerHTML = '<div class="empty">No additional Authelia users yet.</div>';
    return;
  }
  list.innerHTML = autheliaUsersCache.map(user => `
    <div class="item">
      <div class="item-header">
        <div>
          <div class="item-title">${escapeHtml(user.displayname || user.username)} <span class="muted">(${escapeHtml(user.username)})</span>${user.disabled ? ' <span class="mode-pill">disabled</span>' : ''}</div>
          <div class="item-sub">${escapeHtml(user.email || 'no email')} · ${user.passwordSet ? 'password set' : 'no password'}</div>
        </div>
        <div class="inline">
          <button class="btn" data-authelia-user-edit="${escapeHtml(user.username)}">Edit</button>
          <button class="btn btn-danger" data-authelia-user-delete="${escapeHtml(user.username)}">Delete</button>
        </div>
      </div>
    </div>`).join('');
  list.querySelectorAll('[data-authelia-user-edit]').forEach(btn => {
    btn.addEventListener('click', () => editAutheliaUser(btn.dataset.autheliaUserEdit));
  });
  list.querySelectorAll('[data-authelia-user-delete]').forEach(btn => {
    btn.addEventListener('click', () => deleteAutheliaUser(btn.dataset.autheliaUserDelete));
  });
}

function resetAutheliaUserForm() {
  autheliaUsersEditing = '';
  if (qs('#autheliaUserName')) qs('#autheliaUserName').value = '';
  if (qs('#autheliaUserDisplay')) qs('#autheliaUserDisplay').value = '';
  if (qs('#autheliaUserEmail')) qs('#autheliaUserEmail').value = '';
  if (qs('#autheliaUserPassword')) qs('#autheliaUserPassword').value = '';
  if (qs('#autheliaUserDisabled')) qs('#autheliaUserDisabled').checked = false;
  if (qs('#autheliaUserSave')) qs('#autheliaUserSave').textContent = 'Add user';
  qs('#autheliaUserCancel')?.classList.add('hidden');
}

function editAutheliaUser(username) {
  const user = autheliaUsersCache.find(item => item.username === username);
  if (!user) return;
  autheliaUsersEditing = username;
  if (qs('#autheliaUserName')) qs('#autheliaUserName').value = user.username;
  if (qs('#autheliaUserDisplay')) qs('#autheliaUserDisplay').value = user.displayname || '';
  if (qs('#autheliaUserEmail')) qs('#autheliaUserEmail').value = user.email || '';
  if (qs('#autheliaUserPassword')) qs('#autheliaUserPassword').value = '';
  if (qs('#autheliaUserDisabled')) qs('#autheliaUserDisabled').checked = !!user.disabled;
  if (qs('#autheliaUserSave')) qs('#autheliaUserSave').textContent = 'Update user';
  qs('#autheliaUserCancel')?.classList.remove('hidden');
}

async function loadAutheliaUsers() {
  try {
    const res = await api('/api/core/authelia/users');
    renderAutheliaUsers(res.users || []);
    const admin = res.admin || {};
    if (qs('#autheliaAdminUser')) qs('#autheliaAdminUser').value = admin.username || 'admin';
    if (qs('#autheliaAdminEmail')) qs('#autheliaAdminEmail').value = admin.email || '';
    if (qs('#autheliaAdminState')) qs('#autheliaAdminState').textContent = admin.passwordSet ? 'password set' : 'password missing';
    if (qs('#autheliaUsersHint')) {
      const portal = coreAutheliaData?.url || '';
      qs('#autheliaUsersHint').textContent = portal
        ? `Manage the local Authelia user database. Portal: ${portal}. Provider and application policies are configured there.`
        : 'Manage the local Authelia user database. Provider and application policies are configured in the Authelia portal.';
    }
  } catch (e) {
    if (qs('#autheliaUsersMsg')) qs('#autheliaUsersMsg').textContent = e.message;
    toast(e.message, true);
  }
}

async function deleteAutheliaUser(username) {
  if (!confirm(`Delete Authelia user "${username}"?`)) return;
  try {
    const res = await api(`/api/core/authelia/users/${encodeURIComponent(username)}`, { method: 'DELETE' });
    if (autheliaUsersEditing === username) resetAutheliaUserForm();
    toast(res.message || 'Authelia user deleted');
    if (qs('#autheliaUsersMsg')) qs('#autheliaUsersMsg').textContent = res.message || '';
    await loadAutheliaUsers();
    loadCoreAuthelia();
  } catch (e) {
    toast(e.message, true);
  }
}

if (qs('#autheliaManageBtn')) {
  qs('#autheliaManageBtn').addEventListener('click', () => {
    resetAutheliaUserForm();
    qs('#autheliaUsersModal')?.classList.remove('hidden');
    loadAutheliaUsers();
  });
}
if (qs('#autheliaPickContainers')) {
  qs('#autheliaPickContainers').addEventListener('click', openAuthContainersPicker);
}
if (qs('#autheliaUsersRefresh')) qs('#autheliaUsersRefresh').addEventListener('click', loadAutheliaUsers);
if (qs('#autheliaUserCancel')) qs('#autheliaUserCancel').addEventListener('click', resetAutheliaUserForm);
if (qs('#autheliaUserSave')) {
  qs('#autheliaUserSave').addEventListener('click', async () => {
    const btn = qs('#autheliaUserSave');
    const msg = qs('#autheliaUsersMsg');
    const username = qs('#autheliaUserName')?.value.trim() || '';
    const password = qs('#autheliaUserPassword')?.value || '';
    if (!username) { if (msg) msg.textContent = 'Username is required.'; return; }
    setLoading(btn, true, autheliaUsersEditing ? 'Updating…' : 'Adding…');
    try {
      const payload = {
        username,
        originalUsername: autheliaUsersEditing || '',
        displayname: qs('#autheliaUserDisplay')?.value.trim() || '',
        email: qs('#autheliaUserEmail')?.value.trim() || '',
        disabled: !!qs('#autheliaUserDisabled')?.checked
      };
      if (password) payload.password = password;
      const res = await api('/api/core/authelia/users', jsonBody(payload));
      resetAutheliaUserForm();
      if (msg) msg.textContent = res.message || 'Saved.';
      toast(res.applied ? 'Authelia user saved' : 'Authelia user saved (not applied yet)');
      await loadAutheliaUsers();
    } catch (e) {
      if (msg) msg.textContent = e.message;
      toast(e.message, true);
    } finally {
      setLoading(btn, false, autheliaUsersEditing ? 'Update user' : 'Add user');
    }
  });
}
if (qs('#autheliaAdminSave')) {
  qs('#autheliaAdminSave').addEventListener('click', async () => {
    const btn = qs('#autheliaAdminSave');
    setLoading(btn, true, 'Saving…');
    try {
      const payload = {
        username: qs('#autheliaAdminUser')?.value.trim() || 'admin',
        email: qs('#autheliaAdminEmail')?.value.trim() || ''
      };
      const password = qs('#autheliaAdminPassword')?.value || '';
      if (password) payload.password = password;
      const res = await api('/api/core/authelia/admin', jsonBody(payload));
      if (qs('#autheliaAdminPassword')) qs('#autheliaAdminPassword').value = '';
      if (qs('#autheliaUsersMsg')) qs('#autheliaUsersMsg').textContent = res.message || 'Admin account saved.';
      toast(res.applied ? 'Authelia admin account saved' : 'Authelia admin account saved (not applied yet)');
      await loadAutheliaUsers();
      loadCoreAuthelia();
    } catch (e) {
      toast(e.message, true);
    } finally {
      setLoading(btn, false, 'Save admin');
    }
  });
}
if (qs('#autheliaProtectDok')) {
  qs('#autheliaProtectDok').addEventListener('change', async () => {
    const checkbox = qs('#autheliaProtectDok');
    const msg = qs('#autheliaProtectDokMsg');
    try {
      const res = await api('/api/core/authelia/dok-protection', jsonBody({ protect: checkbox.checked }));
      installDefaults.protectDok = res.protectDok;
      if (qs('#defaultsProtectDok')) qs('#defaultsProtectDok').checked = !!res.protectDok;
      if (msg) msg.textContent = res.protectDok
        ? `Dok UI protected at ${res.dokDomain}.`
        : 'Dok UI protection disabled.';
      toast(res.protectDok ? 'Dok UI now requires Authelia login' : 'Dok UI protection disabled', false, 8000);
      loadCoreAuthelia();
    } catch (e) {
      if (typeof e.data?.protectDok === 'boolean') {
        installDefaults.protectDok = e.data.protectDok;
        checkbox.checked = e.data.protectDok;
        if (qs('#defaultsProtectDok')) qs('#defaultsProtectDok').checked = e.data.protectDok;
      } else {
        checkbox.checked = !checkbox.checked;
      }
      if (msg) msg.textContent = e.message;
      toast(e.message, true);
    }
  });
}

if (qs('#mailSmtpTls')) {
  // Keep the port in step with the transport unless the user typed a custom one.
  qs('#mailSmtpTls').addEventListener('change', () => {
    const port = qs('#mailSmtpPort');
    if (!port || ![587, 465, 1025].includes(Number(port.value))) return;
    const mode = qs('#mailSmtpTls').value;
    port.value = mode === 'tls' ? 465 : mode === 'none' ? 1025 : 587;
  });
}

if (qs('#mailSaveSmtp')) {
  qs('#mailSaveSmtp').addEventListener('click', async () => {
    const btn = qs('#mailSaveSmtp');
    setLoading(btn, true);
    try {
      const res = await api('/api/core/mail/smtp', jsonBody({
        host: qs('#mailSmtpHost')?.value.trim() || '',
        port: Number(qs('#mailSmtpPort')?.value || 587),
        tls: qs('#mailSmtpTls')?.value || 'starttls',
        username: qs('#mailSmtpUser')?.value.trim() || '',
        password: qs('#mailSmtpPassword')?.value || '',
        sender: qs('#mailSmtpSender')?.value.trim() || ''
      }));
      if (qs('#mailMsg')) qs('#mailMsg').textContent = res.message || '';
      toast(res.message || 'SMTP settings saved', false, 12000);
      await loadCoreMail();
    } catch (e) {
      toast(e.message, true);
    } finally {
      setLoading(btn, false, 'Save SMTP');
    }
  });
}

if (qs('#mailUseMailpit')) {
  qs('#mailUseMailpit').addEventListener('click', async () => {
    const btn = qs('#mailUseMailpit');
    setLoading(btn, true);
    try {
      const res = await api('/api/core/mail/use-mailpit', { method: 'POST' });
      if (qs('#mailMsg')) qs('#mailMsg').textContent = res.message || '';
      toast(res.message || 'Mailpit started', false, 12000);
      await loadCoreMail();
    } catch (e) {
      toast(e.message, true);
    } finally {
      setLoading(btn, false, 'Use Mailpit');
    }
  });
}

if (qs('#mailpitRunBtn')) {
  qs('#mailpitRunBtn').addEventListener('click', async () => {
    const btn = qs('#mailpitRunBtn');
    setLoading(btn, true);
    try {
      const res = await api('/api/core/mailpit/run', jsonBody({
        smtpPort: Number(qs('#mailpitSmtpPort')?.value || 1025),
        webPort: Number(qs('#mailpitWebPort')?.value || 8025),
        maxMessages: Number(qs('#mailpitMaxMessages')?.value || 500),
        domain: qs('#mailpitDomain')?.value.trim() || ''
      }));
      if (qs('#mailpitMsg')) qs('#mailpitMsg').textContent = res.message || '';
      toast(res.message || 'Mailpit launched', false, 12000);
      await loadCoreMail();
    } catch (e) {
      toast(e.message, true);
    } finally {
      setLoading(btn, false, 'Launch Mailpit');
    }
  });
}
if (qs('#mailpitEditCompose')) qs('#mailpitEditCompose').addEventListener('click', () => { qs('#mailpitComposeEditor').classList.remove('hidden'); qs('#mailpitEditorActions').classList.remove('hidden'); });
if (qs('#mailpitEditComposeManage')) qs('#mailpitEditComposeManage').addEventListener('click', () => { qs('#mailpitComposeEditor').classList.remove('hidden'); qs('#mailpitEditorActions').classList.remove('hidden'); });
if (qs('#mailpitCancelCompose')) qs('#mailpitCancelCompose').addEventListener('click', () => { qs('#mailpitComposeEditor').classList.add('hidden'); qs('#mailpitEditorActions').classList.add('hidden'); });
if (qs('#mailpitSaveCompose')) {
  qs('#mailpitSaveCompose').addEventListener('click', async () => {
    try {
      await api('/api/core/mailpit/compose', jsonBody({ compose: qs('#mailpitComposeEditor').value }));
      qs('#mailpitComposeEditor').classList.add('hidden');
      qs('#mailpitEditorActions').classList.add('hidden');
      toast('Mailpit compose saved');
    } catch (e) { toast(e.message, true); }
  });
}
if (qs('#mailpitStartBtn')) qs('#mailpitStartBtn').addEventListener('click', () => coreServiceAction('mailpit', 'start', qs('#mailpitStartBtn'), loadCoreMail));
if (qs('#mailpitStopBtn')) qs('#mailpitStopBtn').addEventListener('click', () => coreServiceAction('mailpit', 'stop', qs('#mailpitStopBtn'), loadCoreMail));
if (qs('#mailpitRestartBtn')) qs('#mailpitRestartBtn').addEventListener('click', () => coreServiceAction('mailpit', 'restart', qs('#mailpitRestartBtn'), loadCoreMail));
if (qs('#mailpitOpenBtn')) qs('#mailpitOpenBtn').addEventListener('click', () => window.open(coreMailData?.url || 'http://localhost:8025', '_blank'));
if (qs('#mailpitApplyDomain')) {
  qs('#mailpitApplyDomain').addEventListener('click', async () => {
    const btn = qs('#mailpitApplyDomain');
    const msg = qs('#mailpitDomainMsg');
    setLoading(btn, true, 'Applying…');
    try {
      const res = await api('/api/core/mailpit/domain', jsonBody({ domain: qs('#mailpitDomainManage')?.value.trim() || '' }));
      if (msg) msg.textContent = res.domain ? `Applied ${res.domain}${res.restarted ? ' · container recreated' : ' · restart to apply'}` : 'Domain cleared';
      toast(res.domain ? `Mailpit domain set to ${res.domain}` : 'Mailpit domain cleared');
      await loadCoreMail();
    } catch (e) {
      if (msg) msg.textContent = e.message;
      toast(e.message, true);
    } finally {
      setLoading(btn, false, 'Apply domain');
    }
  });
}

async function deployDnsProvider(btn) {
  const provider = qs('#dnsProvider')?.value === 'adguard' ? 'adguard' : 'technitium';
  const current = coreDnsData?.provider === 'adguard' ? 'adguard' : 'technitium';
  if (coreDnsData?.exists && provider !== current && !confirm(`Replace the running ${current === 'adguard' ? 'AdGuard Home' : 'Technitium DNS'} service with ${provider === 'adguard' ? 'AdGuard Home' : 'Technitium DNS'}?`)) {
    return;
  }
  setLoading(btn, true);
  try {
    const res = await api('/api/core/dns/run', jsonBody({
      provider,
      adminPassword: qs('#dnsAdminPassword')?.value || '',
      webPort: Number(qs('#dnsWebPort')?.value || (provider === 'adguard' ? 3000 : 5380)),
      dnsPort: Number(qs('#dnsDnsPort')?.value || 53),
      domain: qs('#dnsDomain')?.value.trim() || ''
    }));
    if (qs('#dnsAdminPassword')) qs('#dnsAdminPassword').value = '';
    if (qs('#dnsMsg')) qs('#dnsMsg').textContent = res.message || '';
    toast(res.message || 'DNS service launched', false, 12000);
    await loadCoreDns();
  } catch (e) {
    toast(e.message, true);
  } finally {
    setLoading(btn, false, provider === 'adguard' ? 'Launch AdGuard Home' : 'Launch Technitium');
  }
}

if (qs('#dnsRunBtn')) qs('#dnsRunBtn').addEventListener('click', () => deployDnsProvider(qs('#dnsRunBtn')));
if (qs('#dnsDeployProvider')) qs('#dnsDeployProvider').addEventListener('click', () => deployDnsProvider(qs('#dnsDeployProvider')));
if (qs('#dnsEditCompose')) qs('#dnsEditCompose').addEventListener('click', () => { qs('#dnsComposeEditor').classList.remove('hidden'); qs('#dnsEditorActions').classList.remove('hidden'); });
if (qs('#dnsEditComposeManage')) qs('#dnsEditComposeManage').addEventListener('click', () => { qs('#dnsComposeEditor').classList.remove('hidden'); qs('#dnsEditorActions').classList.remove('hidden'); });
if (qs('#dnsCancelCompose')) qs('#dnsCancelCompose').addEventListener('click', () => { qs('#dnsComposeEditor').classList.add('hidden'); qs('#dnsEditorActions').classList.add('hidden'); });
if (qs('#dnsSaveCompose')) {
  qs('#dnsSaveCompose').addEventListener('click', async () => {
    try {
      await api('/api/core/dns/compose', jsonBody({ compose: qs('#dnsComposeEditor').value }));
      qs('#dnsComposeEditor').classList.add('hidden');
      qs('#dnsEditorActions').classList.add('hidden');
      toast('DNS compose saved');
    } catch (e) { toast(e.message, true); }
  });
}
if (qs('#dnsStartBtn')) qs('#dnsStartBtn').addEventListener('click', () => coreServiceAction('dns', 'start', qs('#dnsStartBtn'), loadCoreDns));
if (qs('#dnsStopBtn')) qs('#dnsStopBtn').addEventListener('click', () => coreServiceAction('dns', 'stop', qs('#dnsStopBtn'), loadCoreDns));
if (qs('#dnsRestartBtn')) qs('#dnsRestartBtn').addEventListener('click', () => coreServiceAction('dns', 'restart', qs('#dnsRestartBtn'), loadCoreDns));
if (qs('#dnsOpenBtn')) qs('#dnsOpenBtn').addEventListener('click', () => window.open(coreDnsData?.url || 'http://localhost:5380', '_blank'));
if (qs('#dnsApplyDomain')) {
  qs('#dnsApplyDomain').addEventListener('click', async () => {
    const btn = qs('#dnsApplyDomain');
    const msg = qs('#dnsDomainMsg');
    setLoading(btn, true, 'Applying…');
    try {
      const res = await api('/api/core/dns/domain', jsonBody({
        provider: qs('#dnsProvider')?.value === 'adguard' ? 'adguard' : 'technitium',
        domain: qs('#dnsDomainManage')?.value.trim() || ''
      }));
      if (msg) msg.textContent = res.domain ? `Applied ${res.domain}${res.restarted ? ' · container recreated' : ' · restart to apply'}` : 'Domain cleared';
      toast(res.domain ? `DNS domain set to ${res.domain}` : 'DNS domain cleared');
      await loadCoreDns();
    } catch (e) {
      if (msg) msg.textContent = e.message;
      toast(e.message, true);
    } finally {
      setLoading(btn, false, 'Apply domain');
    }
  });
}

if (qs('#stalwartRunBtn')) {
  qs('#stalwartRunBtn').addEventListener('click', async () => {
    const btn = qs('#stalwartRunBtn');
    setLoading(btn, true);
    try {
      const res = await api('/api/core/stalwart/run', jsonBody({
        domain: qs('#stalwartDomain')?.value.trim() || '',
        adminUser: qs('#stalwartAdminUser')?.value.trim() || 'admin',
        adminPassword: qs('#stalwartAdminPassword')?.value || '',
        webPort: Number(qs('#stalwartWebPort')?.value || 8088),
        smtpPort: Number(qs('#stalwartSmtpPort')?.value || 25),
        submissionPort: Number(qs('#stalwartSubmissionPort')?.value || 587),
        imapsPort: Number(qs('#stalwartImapsPort')?.value || 993)
      }));
      if (qs('#stalwartAdminPassword')) qs('#stalwartAdminPassword').value = '';
      if (qs('#stalwartMsg')) qs('#stalwartMsg').textContent = res.message || '';
      toast(res.message || 'Stalwart launched', false, 12000);
      await loadCoreMail();
    } catch (e) {
      toast(e.message, true);
    } finally {
      setLoading(btn, false, 'Launch Stalwart');
    }
  });
}
if (qs('#stalwartEditCompose')) qs('#stalwartEditCompose').addEventListener('click', () => { qs('#stalwartComposeEditor').classList.remove('hidden'); qs('#stalwartEditorActions').classList.remove('hidden'); });
if (qs('#stalwartEditComposeManage')) qs('#stalwartEditComposeManage').addEventListener('click', () => { qs('#stalwartComposeEditor').classList.remove('hidden'); qs('#stalwartEditorActions').classList.remove('hidden'); });
if (qs('#stalwartCancelCompose')) qs('#stalwartCancelCompose').addEventListener('click', () => { qs('#stalwartComposeEditor').classList.add('hidden'); qs('#stalwartEditorActions').classList.add('hidden'); });
if (qs('#stalwartSaveCompose')) {
  qs('#stalwartSaveCompose').addEventListener('click', async () => {
    try {
      await api('/api/core/stalwart/compose', jsonBody({ compose: qs('#stalwartComposeEditor').value }));
      qs('#stalwartComposeEditor').classList.add('hidden');
      qs('#stalwartEditorActions').classList.add('hidden');
      toast('Stalwart compose saved');
    } catch (e) { toast(e.message, true); }
  });
}
if (qs('#stalwartStartBtn')) qs('#stalwartStartBtn').addEventListener('click', () => coreServiceAction('stalwart', 'start', qs('#stalwartStartBtn'), loadCoreMail));
if (qs('#stalwartStopBtn')) qs('#stalwartStopBtn').addEventListener('click', () => coreServiceAction('stalwart', 'stop', qs('#stalwartStopBtn'), loadCoreMail));
if (qs('#stalwartRestartBtn')) qs('#stalwartRestartBtn').addEventListener('click', () => coreServiceAction('stalwart', 'restart', qs('#stalwartRestartBtn'), loadCoreMail));
if (qs('#stalwartOpenBtn')) qs('#stalwartOpenBtn').addEventListener('click', () => window.open(coreMailData?.stalwart?.url || 'http://localhost:8088', '_blank'));
if (qs('#stalwartApplyDomain')) {
  qs('#stalwartApplyDomain').addEventListener('click', async () => {
    const btn = qs('#stalwartApplyDomain');
    const msg = qs('#stalwartDomainMsg');
    setLoading(btn, true, 'Applying…');
    try {
      const res = await api('/api/core/stalwart/domain', jsonBody({ domain: qs('#stalwartDomainManage')?.value.trim() || '' }));
      if (msg) msg.textContent = res.domain ? `Applied ${res.domain}${res.restarted ? ' · container recreated' : ' · restart to apply'}` : 'Domain cleared';
      toast(res.domain ? `Stalwart domain set to ${res.domain}` : 'Stalwart domain cleared');
      await loadCoreMail();
    } catch (e) {
      if (msg) msg.textContent = e.message;
      toast(e.message, true);
    } finally {
      setLoading(btn, false, 'Apply domain');
    }
  });
}

if (qs('#helperRunBtn')) {
  qs('#helperRunBtn').addEventListener('click', async () => {
    const btn = qs('#helperRunBtn');
    setLoading(btn, true);
    try {
      const res = await api('/api/core/host-helper/run', jsonBody({ image: qs('#helperImage')?.value.trim() || '' }));
      if (qs('#helperMsg')) qs('#helperMsg').textContent = res.message || '';
      toast(res.message || 'Host Helper launched', false, 12000);
      await loadCoreHelper();
    } catch (e) {
      toast(e.message, true);
    } finally {
      setLoading(btn, false, 'Launch Host Helper');
    }
  });
}
if (qs('#helperEditCompose')) qs('#helperEditCompose').addEventListener('click', () => { qs('#helperComposeEditor').classList.remove('hidden'); qs('#helperEditorActions').classList.remove('hidden'); });
if (qs('#helperCancelCompose')) qs('#helperCancelCompose').addEventListener('click', () => { qs('#helperComposeEditor').classList.add('hidden'); qs('#helperEditorActions').classList.add('hidden'); });
if (qs('#helperSaveCompose')) {
  qs('#helperSaveCompose').addEventListener('click', async () => {
    try {
      await api('/api/core/host-helper/compose', jsonBody({ compose: qs('#helperComposeEditor').value }));
      qs('#helperComposeEditor').classList.add('hidden');
      qs('#helperEditorActions').classList.add('hidden');
      toast('Host Helper compose saved');
    } catch (e) { toast(e.message, true); }
  });
}
if (qs('#helperStartBtn')) qs('#helperStartBtn').addEventListener('click', () => coreServiceAction('host-helper', 'start', qs('#helperStartBtn'), loadCoreHelper));
if (qs('#helperStopBtn')) qs('#helperStopBtn').addEventListener('click', () => coreServiceAction('host-helper', 'stop', qs('#helperStopBtn'), loadCoreHelper));
if (qs('#helperRestartBtn')) qs('#helperRestartBtn').addEventListener('click', () => coreServiceAction('host-helper', 'restart', qs('#helperRestartBtn'), loadCoreHelper));

async function loadServerLogs() {
  const out = qs('#serverLogsOutput');
  if (!out) return;
  try {
    const res = await api('/api/logs/server?tail=800');
    out.textContent = res.text || '(no server logs)';
    out.scrollTop = out.scrollHeight;
  } catch (e) {
    out.textContent = e.message;
  }
}

async function loadAppLogChoices() {
  const select = qs('#appLogsSelect');
  if (!select) return;
  try {
    const res = await api('/api/logs/apps');
    const current = select.value;
    const options = [
      ...(res.core || []).map(service => `<option value="core:${escapeHtml(service)}">Core · ${escapeHtml(service)}</option>`),
      ...(res.apps || []).map(app => `<option value="app:${escapeHtml(app.id)}">App · ${escapeHtml(app.name)}</option>`)
    ];
    select.innerHTML = options.length ? options.join('') : '<option value="">No apps or core services</option>';
    if (current && Array.from(select.options).some(option => option.value === current)) select.value = current;
  } catch {}
}

async function loadSelectedAppLogs() {
  const select = qs('#appLogsSelect');
  const out = qs('#appLogsOutput');
  if (!select || !out) return;
  const value = select.value;
  if (!value) {
    out.textContent = 'No app or core service selected.';
    return;
  }
  const tail = String(Math.max(1, Math.min(5000, Number(qs('#appLogsTail')?.value) || 300)));
  try {
    const [kind, id] = value.split(':');
    const res = kind === 'core'
      ? await api(`/api/logs/core/${encodeURIComponent(id)}?tail=${tail}`)
      : await api(`/api/logs/app/${encodeURIComponent(id)}?tail=${tail}`);
    out.textContent = res.text || '(no logs)';
    out.scrollTop = out.scrollHeight;
  } catch (e) {
    out.textContent = e.message;
  }
}

if (qs('#serverLogsRefresh')) qs('#serverLogsRefresh').addEventListener('click', loadServerLogs);
if (qs('#serverLogsClear')) {
  qs('#serverLogsClear').addEventListener('click', async () => {
    if (!confirm('Clear the server log?')) return;
    try {
      await api('/api/logs/server', { method: 'DELETE' });
      await loadServerLogs();
      toast('Server log cleared');
    } catch (e) { toast(e.message, true); }
  });
}
if (qs('#appLogsRefresh')) qs('#appLogsRefresh').addEventListener('click', loadSelectedAppLogs);
if (qs('#appLogsSelect')) qs('#appLogsSelect').addEventListener('change', loadSelectedAppLogs);
if (qs('#serverLogsAuto')) {
  qs('#serverLogsAuto').addEventListener('change', () => {
    if (serverLogsTimer) clearInterval(serverLogsTimer);
    serverLogsTimer = null;
    if (qs('#serverLogsAuto').checked) {
      loadServerLogs();
      serverLogsTimer = setInterval(loadServerLogs, 4000);
    }
  });
}
if (qs('#appLogsAuto')) {
  qs('#appLogsAuto').addEventListener('change', () => {
    if (appLogsTimer) clearInterval(appLogsTimer);
    appLogsTimer = null;
    if (qs('#appLogsAuto').checked) {
      loadSelectedAppLogs();
      appLogsTimer = setInterval(loadSelectedAppLogs, 5000);
    }
  });
}

function fmtBackupSize(bytes) {
  return fmtBytes(bytes || 0);
}

function backupScopeLabel(item) {
  if (item.scope === 'app') return `App: ${item.appName || item.app || 'unknown'}`;
  if (item.scope === 'custom') {
    const components = item.components || {};
    const parts = [];
    if (components.data) parts.push(components.logs ? 'data + logs' : 'data');
    if (components.apps) parts.push(item.apps?.length ? `apps: ${item.apps.join(', ')}` : 'all apps');
    if (components.core) parts.push(item.core?.length ? `core: ${item.core.join(', ')}` : 'all core services');
    if (components.sources) parts.push('sources');
    return `Custom (${parts.join(' · ') || 'nothing selected'})`;
  }
  return 'Full installation';
}

let backupOptionsData = null;

async function loadBackupOptions() {
  try {
    const res = await api('/api/backups/options');
    backupOptionsData = res;
    const apps = Array.isArray(res.apps) ? res.apps : [];
    const core = Array.isArray(res.core) ? res.core : [];
    const appSelect = qs('#backupApp');
    if (appSelect) {
      const current = appSelect.value;
      appSelect.innerHTML = apps.length
        ? apps.map(app => `<option value="${escapeHtml(app.id || app.name)}">${escapeHtml(app.name || app.id)}</option>`).join('')
        : '<option value="">No apps</option>';
      if (current && apps.some(app => (app.id || app.name) === current)) appSelect.value = current;
    }
    const appsMulti = qs('#backupAppsSelect');
    if (appsMulti) {
      const current = new Set([...appsMulti.selectedOptions].map(option => option.value));
      appsMulti.innerHTML = apps.map(app => `<option value="${escapeHtml(app.id || app.name)}">${escapeHtml(app.name || app.id)}</option>`).join('');
      [...appsMulti.options].forEach(option => { option.selected = current.has(option.value); });
    }
    const coreSelect = qs('#backupCoreSelect');
    if (coreSelect) {
      const current = new Set([...coreSelect.selectedOptions].map(option => option.value));
      coreSelect.innerHTML = core.map(service => `<option value="${escapeHtml(service.name)}">${escapeHtml(service.label || service.name)}</option>`).join('');
      [...coreSelect.options].forEach(option => { option.selected = current.has(option.value); });
    }
  } catch {
    // The pickers are a convenience; keep whatever options are already shown.
  }
}

function syncBackupScopeUi() {
  const scope = qs('#backupScope')?.value || 'full';
  const isApp = scope === 'app';
  const isCustom = scope === 'custom';
  qs('#backupApp')?.classList.toggle('hidden', !isApp);
  qs('#backupCustomOptions')?.classList.toggle('hidden', !isCustom);
  const appsSelect = qs('#backupAppsSelect');
  const coreSelect = qs('#backupCoreSelect');
  if (appsSelect) appsSelect.disabled = !qs('#backupCompApps')?.checked;
  if (coreSelect) coreSelect.disabled = !qs('#backupCompCore')?.checked;
  const dataSelected = !!qs('#backupCompData')?.checked;
  const logsInput = qs('#backupCompLogs');
  if (logsInput) {
    logsInput.disabled = !dataSelected;
    if (!dataSelected) logsInput.checked = false;
  }
  if (qs('#backupLogsLabel')) qs('#backupLogsLabel').classList.toggle('hidden', isApp || isCustom);
}

function renderBackups(backups) {
  const list = qs('#backupsList');
  if (!list) return;
  if (!backups || !backups.length) {
    list.innerHTML = '<div class="empty">No backups yet.</div>';
    return;
  }
  list.innerHTML = backups.map(item => `
    <div class="item" data-backup-id="${escapeHtml(item.id)}">
      <div class="item-header">
        <div>
          <div class="item-title">${escapeHtml(item.name || item.id)}</div>
          <div class="item-sub">${escapeHtml(backupScopeLabel(item))} · ${fmtBackupSize(item.size)} · ${escapeHtml(item.created || item.createdAt ? new Date(item.created || item.createdAt).toLocaleString() : '')}${item.imported ? ' · imported' : ''}</div>
        </div>
        <div class="item-actions">
          <a class="btn" href="/api/backups/${encodeURIComponent(item.id)}/download">Download</a>
          <button class="btn" data-backup-act="restore">Restore</button>
          <button class="btn btn-danger" data-backup-act="delete">Delete</button>
        </div>
      </div>
    </div>`).join('');
  list.querySelectorAll('[data-backup-id]').forEach(row => {
    const id = row.dataset.backupId;
    row.querySelectorAll('button[data-backup-act]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (btn.dataset.backupAct === 'delete') {
          if (!confirm('Delete this backup archive?')) return;
          try {
            const res = await api(`/api/backups/${encodeURIComponent(id)}`, { method: 'DELETE' });
            renderBackups(res.backups || []);
            toast('Backup deleted');
          } catch (e) { toast(e.message, true); }
          return;
        }
        if (btn.dataset.backupAct === 'restore') {
          if (!confirm('Restore this backup? Existing files in the affected scope will be overwritten.')) return;
          setLoading(btn, true, 'Restoring…');
          try {
            const res = await api(`/api/backups/${encodeURIComponent(id)}/restore`, jsonBody({ overwrite: true }));
            toast(res.message || 'Backup restored', false, 8000);
            loadBackups();
            loadApps();
            loadSettings();
          } catch (e) {
            toast(e.message, true);
          } finally {
            setLoading(btn, false);
          }
        }
      });
    });
  });
}

async function loadBackups() {
  try {
    const [res] = await Promise.all([api('/api/backups'), loadBackupOptions()]);
    renderBackups(res.backups || []);
    syncBackupScopeUi();
  } catch (e) {
    const list = qs('#backupsList');
    if (list) list.innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`;
  }
}

if (qs('#backupRefresh')) qs('#backupRefresh').addEventListener('click', loadBackups);
if (qs('#backupScope')) {
  qs('#backupScope').addEventListener('change', async () => {
    await loadBackupOptions();
    syncBackupScopeUi();
  });
}
['#backupCompApps', '#backupCompCore', '#backupCompData'].forEach(selector => {
  if (qs(selector)) qs(selector).addEventListener('change', syncBackupScopeUi);
});
if (qs('#createBackupBtn')) {
  qs('#createBackupBtn').addEventListener('click', async () => {
    const btn = qs('#createBackupBtn');
    setLoading(btn, true, 'Creating…');
    const msg = qs('#backupMsg');
    if (msg) { msg.classList.add('hidden'); msg.textContent = ''; }
    try {
      const scope = qs('#backupScope')?.value || 'full';
      const payload = {
        name: qs('#backupName')?.value.trim() || '',
        scope,
        includeLogs: !!qs('#backupIncludeLogs')?.checked
      };
      if (scope === 'app') payload.app = qs('#backupApp')?.value || '';
      if (scope === 'custom') {
        payload.components = {
          data: !!qs('#backupCompData')?.checked,
          apps: !!qs('#backupCompApps')?.checked,
          core: !!qs('#backupCompCore')?.checked,
          sources: !!qs('#backupCompSources')?.checked,
          logs: !!qs('#backupCompLogs')?.checked
        };
        payload.apps = [...(qs('#backupAppsSelect')?.selectedOptions || [])].map(option => option.value);
        payload.core = [...(qs('#backupCoreSelect')?.selectedOptions || [])].map(option => option.value);
      }
      const res = await api('/api/backups', jsonBody(payload));
      if (msg) {
        msg.textContent = `Created ${res.backup?.name || res.backup?.id}`;
        msg.classList.remove('hidden');
      }
      renderBackups(res.backups || []);
      toast('Backup created');
    } catch (e) {
      if (msg) { msg.textContent = e.message; msg.classList.remove('hidden'); }
      toast(e.message, true);
    } finally {
      setLoading(btn, false, 'Create backup');
    }
  });
}
if (qs('#importBackupBtn')) {
  qs('#importBackupBtn').addEventListener('click', async () => {
    const file = qs('#importBackupFile')?.files?.[0];
    if (!file) return toast('Choose a backup archive first', true);
    const btn = qs('#importBackupBtn');
    const msg = qs('#importMsg');
    const submit = async (overwrite) => {
      const body = new FormData();
      body.append('file', file);
      body.append('name', qs('#importBackupName')?.value.trim() || '');
      body.append('overwrite', overwrite ? 'true' : 'false');
      return api('/api/backups/import', { method: 'POST', body });
    };
    setLoading(btn, true, 'Importing…');
    if (msg) msg.textContent = '';
    try {
      let res;
      try {
        res = await submit(false);
      } catch (e) {
        if (e.status !== 409 || !e.data?.needsOverwrite || !e.data?.backupId) throw e;
        if (!confirm(e.message + '\n\nContinue with the overwrite? Existing app data is preserved by app restores.')) throw e;
        res = await api(`/api/backups/${encodeURIComponent(e.data.backupId)}/restore`, jsonBody({ overwrite: true }));
        res.backups = null;
      }
      if (msg) msg.textContent = res.message || 'Backup imported and restored';
      qs('#importBackupFile').value = '';
      if (res.backups) renderBackups(res.backups);
      else await loadBackups();
      toast('Backup imported', false, 7000);
      loadApps();
      loadSettings();
    } catch (e) {
      if (msg) msg.textContent = e.message;
      toast(e.message, true);
    } finally {
      setLoading(btn, false, 'Import backup');
    }
  });
}

if (qs('#settingsSubtabs')) {
  qsa('#settingsSubtabs .subtab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      qsa('#settingsSubtabs .subtab-btn').forEach(item => item.classList.toggle('active', item === btn));
      qsa('.settings-pane').forEach(pane => pane.classList.toggle('active', pane.id === `settings-pane-${btn.dataset.settingsTab}`));
      if (btn.dataset.settingsTab === 'logs') {
        loadServerLogs();
        loadAppLogChoices();
      }
      if (btn.dataset.settingsTab === 'backups') loadBackups();
      if (btn.dataset.settingsTab === 'maintenance') loadMaintenanceStatus();
      if (btn.dataset.settingsTab === 'dok') {
        loadGroups();
        loadRegistries();
      }
    });
  });
}

async function checkAppCreationNginxNotice() {
  const applyNotice = (has) => {
    const notice1 = qs('#appCreationNginxNotice');
    if (notice1) notice1.classList.toggle('hidden', has);
    const notice2 = qs('#appCreationNginxNoticeModal');
    if (notice2) notice2.classList.toggle('hidden', has);
  };
  let res = null;
  try {
    res = await api('/api/core/nginx-proxy');
  } catch {
    // A transient API error says nothing about whether nginx-proxy is
    // installed, so keep the last known state instead of showing "not installed".
    updateAppCfgRequired();
    return;
  }
  // Same rule as the Core Services card: a leftover compose file is not an
  // installation. Only a failed Docker lookup may keep a previous "installed".
  const has = res.lookupFailed
    ? (state.coreNginxInstalled === true || res.installed === true)
    : res.installed === true;
  state.coreNginxRunning = !!res.running;
  state.coreNginxInstalled = has;
  applyNotice(has);
  updateAppCfgRequired();
}

async function createCoreNginxProxyQuick() {
  try {
    // try to get settings
    const settings = await api('/api/settings').catch(() => ({}));
    const net = settings.services?.nginxProxy?.network || 'wicked';
    const domain = settings.services?.nginxProxy?.domain || '';
    // create via run endpoint which uses compose
    const res = await api('/api/core/nginx-proxy/run', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ network: net, domain }) });
    toast(res?.message || 'nginx-proxy launched', false, 15000);
    await checkAppCreationNginxNotice();
    loadSettings();
    if (res?.selfUpdate?.scheduled) waitForReconnect(90000, 12000);
    else refreshAll();
  } catch (e) {
    toast(e.message, true);
  }
}

if (qs('#appCreationCreateNginx')) {
  qs('#appCreationCreateNginx').addEventListener('click', () => openMaintenancePanel({ start: true }));
}
if (qs('#appCreationCreateNginxModal')) {
  qs('#appCreationCreateNginxModal').addEventListener('click', () => openMaintenancePanel({ start: true }));
}

['#appCfgName', '#appCfgCompose'].forEach(sel => {
  const el = qs(sel);
  if (el) el.addEventListener('input', updateAppCfgRequired);
});

if (qs('#appCfgCreateNetwork')) {
  qs('#appCfgCreateNetwork').addEventListener('click', async () => {
    const input = qs('#appCfgNewNetwork');
    const name = String(input?.value || '').trim();
    if (!name) {
      toast('Enter a network name first', true);
      input?.focus();
      return;
    }
    if (isSpecialNetworkName(name)) {
      toast('Choose a named network, not host, none, bridge, or default', true);
      return;
    }
    const btn = qs('#appCfgCreateNetwork');
    setLoading(btn, true, 'Creating…');
    try {
      const res = await api('/api/networks/create', jsonBody({ name }));
      toast(res.existed ? `Network "${name}" already exists` : `Network "${name}" created`);
      if (input) input.value = '';
      await loadNetworksForModal();
      renderAppCfgNetworkOptions(name);
      if (pendingAppConfig) pendingAppConfig.network = name;
    } catch (e) {
      toast(e.message, true);
    } finally {
      setLoading(btn, false, 'Create');
    }
  });
}

if (qs('#appCfgEditCompose')) {
  qs('#appCfgEditCompose').addEventListener('click', () => {
    qs('#composeEditWarningModal').classList.remove('hidden');
  });
}
if (qs('#composeEditProceed')) {
  qs('#composeEditProceed').addEventListener('click', () => {
    qs('#composeEditWarningModal').classList.add('hidden');
    setComposeEditable(true);
    qs('#appCfgCompose').focus();
  });
}
if (qs('#appCfgValidate')) {
  qs('#appCfgValidate').addEventListener('click', async () => {
    if (appCfgBuilderModel && !appCfgBuilderManual) await flushAppCfgBuilderBuild();
    const compose = qs('#appCfgCompose').value;
    try {
      const res = await api('/api/compose/validate', jsonBody({ compose, appDir: pendingAppConfig?.appDir }));
      if (res.ok) {
        toast(res.issues?.length ? res.issues.join('; ') : 'Compose looks valid');
      } else {
        showComposeIssues(res.issues || ['Unknown validation error'], null);
      }
    } catch (e) {
      toast(e.message, true);
    }
  });
}
if (qs('#composeSaveAnyway')) {
  qs('#composeSaveAnyway').addEventListener('click', () => {
    qs('#composeSaveConfirmModal').classList.add('hidden');
    const action = pendingSaveAction;
    pendingSaveAction = null;
    if (action) action();
  });
}
if (qs('#composeContinueEdit')) {
  qs('#composeContinueEdit').addEventListener('click', () => {
    pendingSaveAction = null;
    qs('#composeSaveConfirmModal').classList.add('hidden');
    setComposeEditable(true);
    qs('#appCfgCompose').focus();
  });
}
// ensure modals with data-close work
qsa('[data-close]').forEach(el => {
  if (!el._dataCloseBound) {
    el.addEventListener('click', () => closeModal(el.dataset.close));
    el._dataCloseBound = true;
  }
});

// ---------------- Auth container picker ----------------
async function openAuthContainersPicker() {
  const modal = qs('#authContainersModal');
  const list = qs('#authContainersList');
  if (!modal || !list) return;
  if (qs('#authApplyMsg')) qs('#authApplyMsg').textContent = '';
  list.innerHTML = '<div class="empty">Loading containers…</div>';
  modal.classList.remove('hidden');
  try {
    const containers = await api('/api/containers');
    const candidates = (containers || []).filter(c => c.running);
    if (!candidates.length) {
      list.innerHTML = '<div class="empty">No running containers found. Start an app or core service first, then run this again.</div>';
      return;
    }
    list.innerHTML = candidates.map(c => {
      const locked = !!c.self || !!c.protected;
      const note = c.self
        ? ' · Dok itself: use "Require login for the Dok UI" in Dok Settings'
        : c.protected ? ' · protected core service (managed separately)' : '';
      return `
      <label class="item" style="cursor:pointer">
        <div class="item-header">
          <div>
            <div class="item-title"><input type="checkbox" value="${escapeHtml(c.id)}" ${locked ? 'disabled' : ''}> ${escapeHtml(c.name || c.shortId)} ${stateChip(c.state)}</div>
            <div class="item-sub">${escapeHtml(c.image)}${c.project ? ` · ${escapeHtml(c.project)}` : ''}${note}</div>
            ${containerPorts(c.ports) ? `<div class="ports">${containerPorts(c.ports)}</div>` : ''}
          </div>
        </div>
      </label>`;
    }).join('');
    if (!candidates.some(c => !c.self && !c.protected)) {
      list.insertAdjacentHTML('beforeend', '<div class="empty">No app containers are running. Start the apps you want to protect, then open this again.</div>');
    }
  } catch (e) {
    list.innerHTML = `<div class="empty">Unable to load containers: ${escapeHtml(e.message)}</div>`;
  }
}

function authPickerInputs() {
  return Array.from(qsa('#authContainersList input[type="checkbox"]')).filter(input => !input.disabled);
}

if (qs('#authSelectAll')) {
  qs('#authSelectAll').addEventListener('click', () => authPickerInputs().forEach(input => { input.checked = true; }));
}
if (qs('#authSelectNone')) {
  qs('#authSelectNone').addEventListener('click', () => authPickerInputs().forEach(input => { input.checked = false; }));
}
if (qs('#authApplySelected')) {
  qs('#authApplySelected').addEventListener('click', async () => {
    const ids = authPickerInputs().filter(input => input.checked).map(input => input.value);
    const msg = qs('#authApplyMsg');
    if (!ids.length) {
      if (msg) msg.textContent = 'Select at least one container.';
      return;
    }
    const btn = qs('#authApplySelected');
    setLoading(btn, true, 'Applying…');
    if (msg) msg.textContent = 'Recreating selected containers with auth…';
    try {
      const res = await api('/api/core/auth/apply', jsonBody({ ids }));
      const failed = Array.isArray(res.results) ? res.results.filter(item => !item.ok && !item.skipped) : [];
      const skipped = Array.isArray(res.results) ? res.results.filter(item => item.skipped) : [];
      if (msg) {
        const skippedNote = skipped.length
          ? ` Skipped ${skipped.length}: ${skipped.map(item => `${item.name}: ${item.reason || 'not eligible'}`).join('; ')}`
          : '';
        msg.textContent = failed.length
          ? `${res.message} ${failed.length} failed: ${failed.map(item => `${item.name}: ${item.error || item.reason}`).join('; ')}${skippedNote}`
          : `${res.message || 'Done.'}${skippedNote}`;
      }
      toast(skipped.length && !res.applied && !res.already
        ? 'No eligible containers were changed'
        : (res.message || 'Auth updated'), failed.length > 0 || (skipped.length > 0 && !res.applied && !res.already));
      // Keep the dialog open when nothing was applied, so a skipped-only
      // selection does not look like a successful change.
      if (!failed.length && (res.applied > 0 || res.already > 0)) {
        await new Promise(resolve => setTimeout(resolve, 800));
        qs('#authContainersModal')?.classList.add('hidden');
      }
      loadContainers();
      loadApps();
    } catch (e) {
      if (msg) msg.textContent = e.message;
      toast(e.message, true);
    } finally {
      setLoading(btn, false, 'Enable auth on selected');
    }
  });
}

// ---------------- Designer ----------------
function applyDesignerBranding(designer) {
  const data = designer || {};
  const name = String(data.name || 'WickedAFDok').trim() || 'WickedAFDok';
  const tagline = data.tagline === undefined ? 'Server & Docker control room' : String(data.tagline || '');
  const brandName = qs('#brandName');
  if (brandName) {
    if (name !== 'WickedAFDok' && name.length > 5 && name.slice(-5) === 'AFDok') {
      brandName.innerHTML = `${escapeHtml(name.slice(0, -5))}<span>AFDok</span>`;
    } else if (name === 'WickedAFDok') {
      brandName.innerHTML = 'Wicked<span>AFDok</span>';
    } else {
      brandName.textContent = name;
    }
  }
  if (qs('#brandTagline')) {
    qs('#brandTagline').textContent = tagline;
    qs('#brandTagline').classList.toggle('hidden', !tagline);
  }
  const logoUrl = data.logoUrl || '';
  if (qs('#brandLogo')) {
    if (logoUrl) {
      qs('#brandLogo').src = logoUrl;
      qs('#brandLogo').classList.remove('hidden');
      qs('#brandDefaultMark')?.classList.add('hidden');
    } else {
      qs('#brandLogo').classList.add('hidden');
      qs('#brandLogo').removeAttribute('src');
      qs('#brandDefaultMark')?.classList.remove('hidden');
    }
  }
  let style = qs('#designerCssStyle');
  if (!style) {
    style = document.createElement('style');
    style.id = 'designerCssStyle';
    document.head.appendChild(style);
  }
  style.textContent = String(data.css || '');
  document.title = name;
}

async function loadDesignerBranding() {
  try {
    const res = await api('/api/designer');
    applyDesignerBranding(res);
    return res;
  } catch {
    return null;
  }
}

let designerData = null;

async function loadDesignerFiles() {
  const select = qs('#designerFilePath');
  if (!select) return;
  try {
    const res = await api('/api/designer/files');
    const files = (res.items || []).filter(item => item.type === 'file');
    const current = select.value;
    select.innerHTML = files.length
      ? files.map(item => `<option value="${escapeHtml(item.rel)}">${escapeHtml(item.rel)}</option>`).join('')
      : '<option value="">No editable files found</option>';
    // Open a customizable error page by default instead of the compose file.
    const preferred = files.find(item => item.rel === 'html/404.html')?.rel ||
      files.find(item => item.rel.startsWith('html/'))?.rel ||
      files[0]?.rel || '';
    if (current && files.some(item => item.rel === current)) select.value = current;
    else if (preferred) select.value = preferred;
    if (select.value) await loadDesignerFile(select.value);
  } catch (e) {
    toast(e.message, true);
  }
}

async function loadDesignerFile(path) {
  const rel = path || qs('#designerFilePath')?.value || '';
  if (!rel) return;
  try {
    const res = await api(`/api/designer/file?path=${encodeURIComponent(rel)}`);
    qs('#designerFileContent').value = res.content || '';
    qs('#designerFileMsg').textContent = rel;
  } catch (e) {
    qs('#designerFileContent').value = '';
    qs('#designerFileMsg').textContent = e.message;
    toast(e.message, true);
  }
}

async function openDesigner() {
  const modal = qs('#designerModal');
  if (!modal) return;
  modal.classList.remove('hidden');
  const res = await loadDesignerBranding();
  designerData = res;
  if (qs('#designerName')) qs('#designerName').value = res?.name || 'WickedAFDok';
  if (qs('#designerTagline')) qs('#designerTagline').value = res?.tagline ?? 'Server & Docker control room';
  if (qs('#designerCss')) qs('#designerCss').value = res?.css || '';
  const preview = qs('#designerLogoPreview');
  if (preview) {
    if (res?.logoUrl) {
      preview.src = res.logoUrl;
      preview.classList.remove('hidden');
    } else {
      preview.classList.add('hidden');
      preview.removeAttribute('src');
    }
  }
  loadDesignerFiles();
}

if (qs('#openDesigner')) qs('#openDesigner').addEventListener('click', openDesigner);
if (qs('#settingsDesignerBtn')) qs('#settingsDesignerBtn').addEventListener('click', openDesigner);

if (qs('#designerSave')) {
  qs('#designerSave').addEventListener('click', async () => {
    const btn = qs('#designerSave');
    setLoading(btn, true, 'Saving…');
    try {
      const res = await api('/api/designer', jsonBody({
        name: qs('#designerName').value,
        tagline: qs('#designerTagline').value,
        css: qs('#designerCss').value
      }));
      applyDesignerBranding({ ...(res.designer || {}), css: qs('#designerCss').value });
      qs('#designerMsg').textContent = 'Design saved.';
      toast('Design saved');
    } catch (e) {
      qs('#designerMsg').textContent = e.message;
      toast(e.message, true);
    } finally {
      setLoading(btn, false, 'Save design');
    }
  });
}

if (qs('#designerLogoUpload')) {
  qs('#designerLogoUpload').addEventListener('click', async () => {
    const input = qs('#designerLogoFile');
    if (!input?.files?.length) return toast('Choose an image file first', true);
    const btn = qs('#designerLogoUpload');
    setLoading(btn, true, 'Uploading…');
    try {
      const form = new FormData();
      form.append('logo', input.files[0]);
      const res = await fetch('/api/designer/logo', { method: 'POST', body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      const preview = qs('#designerLogoPreview');
      if (preview) {
        preview.src = data.logoUrl;
        preview.classList.remove('hidden');
      }
      if (qs('#brandLogo')) {
        qs('#brandLogo').src = data.logoUrl;
        qs('#brandLogo').classList.remove('hidden');
        qs('#brandDefaultMark')?.classList.add('hidden');
      }
      input.value = '';
      toast('Logo updated');
    } catch (e) {
      toast(e.message, true);
    } finally {
      setLoading(btn, false, 'Upload logo');
    }
  });
}

if (qs('#designerLogoRemove')) {
  qs('#designerLogoRemove').addEventListener('click', async () => {
    if (!confirm('Remove the custom logo?')) return;
    try {
      const res = await api('/api/designer', jsonBody({ removeLogo: true }));
      applyDesignerBranding(res.designer || {});
      qs('#designerLogoPreview')?.classList.add('hidden');
      toast('Logo removed');
    } catch (e) {
      toast(e.message, true);
    }
  });
}

if (qs('#designerFileRefresh')) qs('#designerFileRefresh').addEventListener('click', loadDesignerFiles);
if (qs('#designerFilePath')) qs('#designerFilePath').addEventListener('change', () => loadDesignerFile());
if (qs('#designerFileSave')) {
  qs('#designerFileSave').addEventListener('click', async () => {
    const rel = qs('#designerFilePath')?.value || '';
    if (!rel) return toast('Select a file first', true);
    const btn = qs('#designerFileSave');
    setLoading(btn, true, 'Saving…');
    try {
      const res = await api('/api/designer/file', jsonBody({
        path: rel,
        content: qs('#designerFileContent').value
      }));
      qs('#designerFileMsg').textContent = res.message || 'Saved';
      toast('File saved');
    } catch (e) {
      qs('#designerFileMsg').textContent = e.message;
      toast(e.message, true);
    } finally {
      setLoading(btn, false, 'Save file');
    }
  });
}

function refreshAll() {
  loadStats();
  loadDashboardCoreServices();
  loadContainers();
  if (qs('#tab-images').classList.contains('active')) loadImages();
  if (qs('#tab-apps').classList.contains('active')) loadApps();
  if (qs('#tab-settings').classList.contains('active')) loadSettings();
  checkAppCreationNginxNotice();
}

loadStats();
loadDashboardCoreServices();
setInterval(() => {
  loadStats();
  if (qs('#tab-containers').classList.contains('active')) loadContainers();
}, 15000);

loadContainers();
loadSettings();
loadDesignerBranding();
checkAppCreationNginxNotice();
loadAssistSessions();
