(() => {
  'use strict';

  const qs = (selector, root = document) => root.querySelector(selector);
  const qsa = (selector, root = document) => [...root.querySelectorAll(selector)];
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const bytes = (value) => {
    const n = Number(value) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  };
  const when = (value) => {
    if (!value) return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString();
  };
  const tokenKey = 'dok.maintenance.token';
  const state = {
    token: localStorage.getItem(tokenKey) || '',
    system: null,
    install: null,
    apps: [],
    containers: [],
    wizard: null,
    installPoll: null,
    updatePoll: null,
    terminal: null,
    terminalSession: null,
    terminalFit: null,
    confirmResolve: null
  };

  const fromUrl = new URLSearchParams(location.search).get('token');
  if (fromUrl) {
    state.token = fromUrl;
    localStorage.setItem(tokenKey, fromUrl);
    const url = new URL(location.href);
    url.searchParams.delete('token');
    history.replaceState({}, '', url.pathname + url.search + url.hash);
  }

  function withToken(url) {
    if (!state.token) return url;
    return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(state.token)}`;
  }

  function toast(message, kind = '') {
    const node = qs('#toast');
    node.textContent = message;
    node.className = `toast show ${kind}`.trim();
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { node.className = 'toast'; }, 4800);
  }

  function showTokenModal() {
    qs('#tokenModal').classList.remove('hidden');
    qs('#tokenInput').value = state.token || '';
    setTimeout(() => qs('#tokenInput').focus(), 50);
  }

  function hideTokenModal() {
    qs('#tokenModal').classList.add('hidden');
  }

  async function api(path, { method = 'GET', body, signal } = {}) {
    const headers = {};
    if (state.token) headers.authorization = `Bearer ${state.token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal
    });
    let data = null;
    try { data = await response.json(); } catch {}
    if (response.status === 401 && data?.needsToken) {
      showTokenModal();
      const error = new Error('Maintenance token required');
      error.needsToken = true;
      throw error;
    }
    if (!response.ok) {
      const error = new Error(data?.error || `Request failed (${response.status})`);
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  async function apiForm(path, formData) {
    const headers = {};
    if (state.token) headers.authorization = `Bearer ${state.token}`;
    const response = await fetch(path, { method: 'POST', headers, body: formData });
    let data = null;
    try { data = await response.json(); } catch {}
    if (response.status === 401 && data?.needsToken) {
      showTokenModal();
      throw new Error('Maintenance token required');
    }
    if (!response.ok) {
      const error = new Error(data?.error || `Request failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function confirmDialog(title, bodyHtml, okLabel = 'Continue') {
    return new Promise(resolve => {
      state.confirmResolve = resolve;
      qs('#confirmTitle').textContent = title;
      qs('#confirmBody').innerHTML = bodyHtml;
      qs('#confirmOk').textContent = okLabel;
      qs('#confirmModal').classList.remove('hidden');
      state.confirmResolve = resolve;
    });
  }

  function closeConfirm(value) {
    qs('#confirmModal').classList.add('hidden');
    const resolve = state.confirmResolve;
    state.confirmResolve = null;
    if (resolve) resolve(value);
  }

  qs('#confirmCancel').addEventListener('click', () => closeConfirm(false));
  qs('#confirmOk').addEventListener('click', () => closeConfirm(true));
  qs('#confirmModal').addEventListener('click', event => {
    if (event.target === qs('#confirmModal')) closeConfirm(false);
  });

  // ---------- tabs ----------
  const views = ['overview', 'install', 'backups', 'snapshots', 'updates', 'diagnostics', 'terminal'];
  function showView(name) {
    if (!views.includes(name)) name = 'overview';
    qsa('.tab-btn').forEach(button => button.classList.toggle('active', button.dataset.view === name));
    qsa('.view').forEach(view => view.classList.toggle('active', view.id === `view-${name}`));
    if (name === 'overview') loadOverview();
    if (name === 'install') loadInstall();
    if (name === 'backups') loadBackups();
    if (name === 'snapshots') loadSnapshots();
    if (name === 'updates') loadUpdates();
    if (name === 'diagnostics') { loadLogs(); if (!qs('#diagChecks').dataset.loaded) runDiagnostics(); }
    if (name === 'terminal') loadSessions();
  }

  qs('#tabs').addEventListener('click', event => {
    const button = event.target.closest('.tab-btn');
    if (button) showView(button.dataset.view);
  });

  // ---------- overview ----------
  function statusBadge(ok, textOk, textBad) {
    return `<span class="badge ${ok ? 'ok' : 'bad'}">${escapeHtml(ok ? textOk : textBad)}</span>`;
  }

  function renderOverview() {
    const data = state.system;
    if (!data) return;
    const dok = data.dok || {};
    const installation = data.installation || {};
    qs('#dokPill').innerHTML = `<span class="dot ${dok.running ? 'ok' : dok.exists ? 'warn' : 'bad'}"></span> Dok: ${dok.running ? 'running' : dok.exists ? dok.state || 'stopped' : 'not installed'}`;
    qs('#modePill').innerHTML = '<span class="dot warn"></span> Maintenance active';
    qs('#dokBadge').className = `badge ${dok.running ? 'ok' : 'warn'}`;
    qs('#dokBadge').textContent = dok.running ? 'running' : dok.exists ? (dok.state || 'stopped') : 'not installed';
    qs('#dokInfo').innerHTML = `
      <div><span class="sub">Container:</span> <span class="mono">${escapeHtml(dok.id ? dok.id.slice(0, 12) : '-')}</span></div>
      <div><span class="sub">Image:</span> <span class="mono">${escapeHtml(dok.image || '-')}</span></div>
      <div><span class="sub">Started:</span> ${escapeHtml(when(dok.startedAt))}</div>
      <div><span class="sub">Internal:</span> <a href="${withToken('http://' + location.hostname + ':8080')}" target="_blank" rel="noopener">http://${escapeHtml(location.hostname)}:8080</a></div>`;
    qs('#dokOpenBtn').disabled = !dok.running;
    qs('#dokStartBtn').disabled = !dok.exists || dok.running;
    qs('#dokRestartBtn').disabled = !dok.exists;

    const system = data.system || {};
    qs('#hostInfo').innerHTML = `
      <div><span class="sub">Host:</span> ${escapeHtml(system.hostname || '-')}</div>
      <div><span class="sub">Platform:</span> ${escapeHtml(system.platform || '-')}</div>
      <div><span class="sub">CPU / load:</span> ${escapeHtml(system.cpus || '-')} cores · ${escapeHtml((system.load || []).map(n => Number(n).toFixed(2)).join(' / '))}</div>
      <div><span class="sub">Memory:</span> ${bytes((system.totalmem || 0) - (system.freemem || 0))} / ${bytes(system.totalmem || 0)}</div>
      <div><span class="sub">Maintenance disk:</span> ${system.disk ? `${bytes(system.disk.total - system.disk.free)} / ${bytes(system.disk.total)}` : '-'}</div>`;
    qs('#maintInfo').innerHTML = `
      <div><span class="sub">Version:</span> ${escapeHtml(data.version || '-')}</div>
      <div><span class="sub">Checkout:</span> <span class="mono">${escapeHtml(installation.root || '/dok')}</span></div>
      <div><span class="sub">State:</span> <span class="mono">${escapeHtml(installation.dataRoot || '/maintenance-data')}</span></div>
      <div><span class="sub">Last saved:</span> ${escapeHtml(when(installation.state?.updated))}</div>
      <div><span class="sub">Token:</span> ${installation.tokenRequired ? 'required' : 'not required'}</div>`;

    const summary = installation.summary || {};
    qs('#summaryInfo').innerHTML = `
      <dt>Type saved</dt><dd>${escapeHtml(state.install?.installation?.saved?.type || '-')}</dd>
      <dt>Apps</dt><dd>${escapeHtml(summary.apps ?? '-')}</dd>
      <dt>Core services</dt><dd>${escapeHtml((summary.coreServices || []).join(', ') || '-')}</dd>
      <dt>Primary domain</dt><dd>${escapeHtml(summary.primaryDomain || '-')}</dd>
      <dt>Dok domain</dt><dd>${escapeHtml(summary.dokDomain || '-')}</dd>
      <dt>Default network</dt><dd>${escapeHtml(summary.defaultNetwork || '-')}</dd>
      <dt>Registry connections</dt><dd>${escapeHtml(summary.registryConnections ?? '-')}</dd>
      <dt>Snapshots</dt><dd>${escapeHtml((data.snapshots || []).length)}</dd>
      <dt>Backups</dt><dd>${escapeHtml((data.backups || []).length)}</dd>`;

    const banner = qs('#installBanner');
    if (!dok.exists) {
      banner.className = 'notice warn';
      banner.innerHTML = `Dok is not installed yet. <a href="#" data-goto="install">Open the installer</a> to create it,${installation.state ? ' or restore the saved installation.' : ' or use the maintenance terminal to investigate.'}`;
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }

    const containers = state.containers;
    qs('#containerCount').textContent = `${containers.length} container${containers.length === 1 ? '' : 's'}`;
    qs('#containersBody').innerHTML = containers.length ? containers.map(item => `
      <tr>
        <td><span class="mono">${escapeHtml(item.name)}</span>${item.maintenance ? ' <span class="badge warn">maintenance</span>' : ''}${item.dok ? ' <span class="badge ok">dok</span>' : ''}</td>
        <td class="mono small">${escapeHtml(item.image)}</td>
        <td>${statusBadge(item.state === 'running', 'running', item.state || 'stopped')}</td>
        <td class="small sub">${escapeHtml(item.status)}</td>
        <td><div class="actions">
          <button class="btn sm" data-container="${escapeHtml(item.id)}" data-action="restart">Restart</button>
          <button class="btn sm ${item.state === 'running' ? 'danger' : ''}" data-container="${escapeHtml(item.id)}" data-action="${item.state === 'running' ? 'stop' : 'start'}">${item.state === 'running' ? 'Stop' : 'Start'}</button>
        </div></td>
      </tr>`).join('') : '<tr><td colspan="5" class="empty">No containers.</td></tr>';

    const apps = state.apps || [];
    qs('#appsCount').textContent = `${apps.length} app${apps.length === 1 ? '' : 's'}`;
    qs('#appsList').innerHTML = apps.length ? apps.map(app => `
      <div class="list-row">
        <div style="min-width:0">
          <div class="name">${escapeHtml(app.name)}</div>
          <div class="meta">${escapeHtml(app.image || 'compose app')} · ${app.running ? 'running' : 'stopped'}${app.needsConfig ? ' · needs configuration' : ''}</div>
        </div>
        <div class="actions">
          <button class="btn sm" data-app="${escapeHtml(app.id)}" data-app-action="deploy">Deploy</button>
          <button class="btn sm ${app.running ? 'danger' : ''}" data-app="${escapeHtml(app.id)}" data-app-action="${app.running ? 'stop' : 'start'}">${app.running ? 'Stop' : 'Start'}</button>
        </div>
      </div>`).join('') : '<div class="empty">No apps in the Dok registry.</div>';
  }

  async function loadOverview() {
    try {
      const [system, containers, apps, install] = await Promise.all([
        api('/api/system'),
        api('/api/containers'),
        api('/api/apps'),
        api('/api/install')
      ]);
      state.system = system;
      state.containers = containers.containers || [];
      state.apps = apps.apps || [];
      state.install = install;
      renderOverview();
      renderLanding();
    } catch (e) {
      if (!e.needsToken) toast(e.message, 'error');
    }
  }

  qs('#refreshAll').addEventListener('click', () => { loadOverview(); toast('Refreshed'); });
  qs('#containersBody').addEventListener('click', async event => {
    const button = event.target.closest('[data-container]');
    if (!button) return;
    button.disabled = true;
    try {
      await api(`/api/containers/${encodeURIComponent(button.dataset.container)}/${button.dataset.action}`, { method: 'POST', body: {} });
      toast(`Container ${button.dataset.action} requested`);
      await loadOverview();
    } catch (e) { toast(e.message, 'error'); }
    finally { button.disabled = false; }
  });
  qs('#appsList').addEventListener('click', async event => {
    const button = event.target.closest('[data-app]');
    if (!button) return;
    button.disabled = true;
    try {
      await api(`/api/apps/${encodeURIComponent(button.dataset.app)}/${button.dataset.appAction}`, { method: 'POST', body: {} });
      toast(`App ${button.dataset.appAction} requested`);
      await loadOverview();
    } catch (e) { toast(e.message, 'error'); }
    finally { button.disabled = false; }
  });
  qs('#dokStartBtn').addEventListener('click', async () => {
    try { await api('/api/containers/wickedafdok/start', { method: 'POST', body: {} }); toast('Starting Dok'); await loadOverview(); }
    catch (e) { toast(e.message, 'error'); }
  });
  qs('#dokRestartBtn').addEventListener('click', async () => {
    try { await api('/api/containers/wickedafdok/restart', { method: 'POST', body: {} }); toast('Restarting Dok'); }
    catch (e) { toast(e.message, 'error'); }
  });
  qs('#dokOpenBtn').addEventListener('click', () => {
    const summary = state.system?.installation?.summary || {};
    const url = summary.dokDomain ? `http://${summary.dokDomain}` : `http://${location.hostname}:8080`;
    window.open(url, '_blank', 'noopener');
  });
  qs('#installBanner').addEventListener('click', event => {
    if (event.target.closest('[data-goto]')) { event.preventDefault(); showView(event.target.closest('[data-goto]').dataset.goto); }
  });
  qs('#syncStateBtn').addEventListener('click', () => syncInstallation(false));
  qs('#syncNowBtn').addEventListener('click', () => syncInstallation(false));
  qs('#snapshotNowBtn').addEventListener('click', async () => {
    try {
      await api('/api/snapshots', { method: 'POST', body: { label: 'Manual snapshot' } });
      toast('Snapshot captured', 'ok');
      await loadOverview();
      await loadSnapshots();
    } catch (e) { toast(e.message, 'error'); }
  });
  qs('#saveInstallBtn').addEventListener('click', () => syncInstallation(true));

  async function syncInstallation(snapshot) {
    try {
      await api('/api/maintenance/sync', { method: 'POST', body: { snapshot } });
      toast('Installation state saved', 'ok');
      await loadOverview();
      if (snapshot) window.open(withToken('/api/installation/export'), '_blank');
    } catch (e) { toast(e.message, 'error'); }
  }

  qs('#exitMaintenance').addEventListener('click', async () => {
    const ok = await confirmDialog('Exit maintenance?', '<p>Dok will be started if it is stopped, then this maintenance container will shut down. You can launch it again from Dok or by running <span class="mono">sudo ./setup.sh</span>.</p>', 'Exit maintenance');
    if (!ok) return;
    try {
      await api('/api/maintenance/mode', { method: 'POST', body: { active: false } });
      document.body.innerHTML = `<div style="display:grid;place-items:center;min-height:100vh;font-family:system-ui;color:#e8f0eb;background:#080a0c"><div style="text-align:center"><h2>Maintenance complete</h2><p>Dok is starting. This container is shutting down.</p><p><a style="color:#b6ff3b" href="http://${escapeHtml(location.hostname)}:8080">Open Dok</a></p></div></div>`;
    } catch (e) { toast(e.message, 'error'); }
  });

  // ---------- installer ----------
  const SERVICE_FIELDS = {
    dokDomain: { label: 'Dok domain', placeholder: 'dok.example.com', help: 'Domain served by nginx-proxy for the Dok UI.' },
    acmeEmail: { label: 'Let\'s Encrypt email', placeholder: 'admin@example.com', help: 'Enables the acme-companion certificate service.' },
    cloudflareToken: { label: 'Cloudflare Tunnel token', type: 'password', help: 'Token from the Cloudflare Zero Trust tunnel dashboard.' },
    authDomain: { label: 'Authentication portal domain', placeholder: 'auth.example.com', help: 'Authelia/Authentik web address. Must share a parent domain with protected apps.' },
    authPort: { label: 'Authentik HTTP port', placeholder: '9000', type: 'number' },
    protectDok: { label: 'Require login for the Dok UI', type: 'checkbox', help: 'Only for Authelia. Dok and the portal must share a cookie domain.' },
    dnsDomain: { label: 'DNS web console domain', placeholder: 'dns.example.com' },
    dnsPort: { label: 'DNS port', placeholder: '53', type: 'number' },
    dnsWebPort: { label: 'AdGuard web port', placeholder: '3000', type: 'number' },
    mailDomain: { label: 'Mail web domain', placeholder: 'mail.example.com' },
    mailpitSmtpPort: { label: 'Mailpit SMTP port', placeholder: '1025', type: 'number' },
    mailpitWebPort: { label: 'Mailpit web port', placeholder: '8025', type: 'number' },
    mailpitMaxMessages: { label: 'Mailpit max messages', placeholder: '500', type: 'number' },
    stalwartAdminUser: { label: 'Stalwart admin user', placeholder: 'admin' },
    stalwartAdminPassword: { label: 'Stalwart admin password', type: 'password', help: 'Blank uses the shared admin password.' },
    stalwartWebPort: { label: 'Stalwart web port', placeholder: '8088', type: 'number' },
    stalwartSmtpPort: { label: 'Stalwart SMTP port', placeholder: '25', type: 'number' },
    stalwartSubmissionPort: { label: 'Stalwart submission port', placeholder: '587', type: 'number' },
    stalwartImapsPort: { label: 'Stalwart IMAPS port', placeholder: '993', type: 'number' },
    smtpHost: { label: 'SMTP host', placeholder: 'smtp.example.com' },
    smtpPort: { label: 'SMTP port', placeholder: '587', type: 'number' },
    smtpTls: { label: 'SMTP security', type: 'select', options: [['none', 'None'], ['starttls', 'STARTTLS'], ['tls', 'Implicit TLS']] },
    smtpUser: { label: 'SMTP username' },
    smtpPassword: { label: 'SMTP password', type: 'password' },
    smtpFrom: { label: 'Sender address', placeholder: 'authelia@example.com' }
  };

  const DEFAULTS_FIELDS = [
    { key: 'primaryDomain', label: 'Primary domain', placeholder: 'example.com', help: 'Used to suggest auth., dns., and mail. subdomains.' },
    { key: 'dokDomain', label: 'Dok domain', placeholder: 'dok.example.com', help: 'Public address for the Dok UI when nginx-proxy is used.' },
    { key: 'dataLocation', label: 'App data location (host path)', placeholder: '/srv/dok-data', help: 'Created on the host. Blank keeps Dok defaults.' },
    { key: 'dataMode', label: 'Data directory mode', placeholder: '0775' },
    { key: 'adminUser', label: 'Admin username', placeholder: 'admin' },
    { key: 'adminEmail', label: 'Admin email', placeholder: 'admin@example.com' },
    { key: 'adminPassword', label: 'Admin password', type: 'password', help: 'Seeds Authelia, Authentik, and Technitium. Stored encrypted.' },
    { key: 'defaultNetwork', label: 'Default Docker network', placeholder: 'wicked' }
  ];

  function fieldInput(key, value, definition = {}, { checkbox = false } = {}) {
    const type = definition.type || 'text';
    const help = definition.help ? `<div class="help">${escapeHtml(definition.help)}</div>` : '';
    if (type === 'checkbox') {
      return `<label class="check"><input type="checkbox" data-field="${escapeHtml(key)}" ${value ? 'checked' : ''}> ${escapeHtml(definition.label || key)}</label>${help}`;
    }
    if (type === 'select') {
      const options = (definition.options || []).map(([optionValue, label]) => `<option value="${escapeHtml(optionValue)}" ${String(value || '') === optionValue ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('');
      return `<div class="field"><label>${escapeHtml(definition.label || key)}</label><select class="select" data-field="${escapeHtml(key)}">${options}</select>${help}</div>`;
    }
    return `<div class="field"><label>${escapeHtml(definition.label || key)}</label><input class="input" type="${escapeHtml(type)}" data-field="${escapeHtml(key)}" value="${escapeHtml(value ?? '')}" placeholder="${escapeHtml(definition.placeholder || '')}" ${checkbox ? '' : ''}>${help}</div>`;
  }

  function renderLanding() {
    const data = state.install;
    if (!data) return;
    const landing = qs('#installLanding');
    const wizard = qs('#installWizard');
    if (!wizard.classList.contains('hidden')) return;
    if (!qs('#installProgress').classList.contains('hidden')) {
      landing.classList.add('hidden');
      return;
    }
    landing.classList.remove('hidden');
    const saved = data.installation?.saved;
    const dok = data.dok || {};
    const notice = qs('#landingNotice');
    if (dok.exists) {
      notice.className = 'notice ok';
      notice.innerHTML = `Dok is installed${dok.running ? ' and running' : ` (${escapeHtml(dok.state || 'stopped')})`}. Use the Overview tab for controls. Reinstalling overwrites the current installation directories.`;
      notice.classList.remove('hidden');
    } else if (data.installation?.exists) {
      notice.className = 'notice warn';
      notice.innerHTML = `Saved installation data was found${saved?.completedAt ? ` from ${escapeHtml(when(saved.completedAt))}` : ''}. You can reinstall exactly from a snapshot, or start a fresh installation.`;
      notice.classList.remove('hidden');
    } else {
      notice.classList.add('hidden');
      notice.innerHTML = '';
    }
    const hasSnapshots = (data.installation?.snapshots || 0) > 0;
    qs('#reinstallBtn').classList.toggle('hidden', !hasSnapshots);
    qs('#openExistingDokBtn').classList.toggle('hidden', !dok.exists);
    qs('#startInstallBtn').textContent = dok.exists ? 'Start fresh installation (overwrites)' : 'Start installation';
  }

  async function loadInstall() {
    try {
      state.install = await api('/api/install');
      renderLanding();
    } catch (e) {
      if (!e.needsToken) toast(e.message, 'error');
    }
  }

  function startWizard(type = 'standalone') {
    const data = state.install || {};
    const discovered = data.discovered || {};
    const defaults = data.defaults || {};
    state.wizard = {
      step: 1,
      type: type === 'core' ? 'core' : 'standalone',
      services: {},
      fields: {
        primaryDomain: discovered.primaryDomain || '',
        dokDomain: discovered.dokDomain || '',
        dataLocation: discovered.dataLocation || '',
        dataMode: defaults.dataMode || '0775',
        adminUser: discovered.adminUser || 'admin',
        adminEmail: discovered.adminEmail || '',
        adminPassword: '',
        defaultNetwork: defaults.defaultNetwork || 'wicked',
        allowOutsideData: defaults.allowOutsideData !== false,
        autoAppData: defaults.autoAppData !== false,
        protectDok: false,
        dataModeAllow: true
      },
      registries: []
    };
    qs('#installLanding').classList.add('hidden');
    qs('#installProgress').classList.add('hidden');
    qs('#installResult').classList.add('hidden');
    qs('#installWizard').classList.remove('hidden');
    renderWizard();
  }

  function wizardSteps() {
    return state.wizard.type === 'core'
      ? ['Type', 'Core services', 'Dok settings', 'Connections', 'Review']
      : ['Type', 'Dok settings', 'Connections', 'Review'];
  }

  function wizardStepNumber(name) {
    const steps = wizardSteps();
    return steps.findIndex(step => step === name) + 1;
  }

  function renderWizard() {
    const wizard = state.wizard;
    if (!wizard) return;
    const steps = wizardSteps();
    qs('#wizardSteps').innerHTML = steps.map((label, index) => {
      const n = index + 1;
      const cls = n === wizard.step ? 'active' : n < wizard.step ? 'done' : '';
      return `<div class="step-chip ${cls}"><span class="n">${n < wizard.step ? '&check;' : n}</span>${escapeHtml(label)}</div>`;
    }).join('');

    const body = qs('#wizardBody');
    const stepName = steps[wizard.step - 1];
    if (stepName === 'Type') body.innerHTML = renderTypeStep();
    else if (stepName === 'Core services') body.innerHTML = renderServicesStep();
    else if (stepName === 'Dok settings') body.innerHTML = renderDefaultsStep();
    else if (stepName === 'Connections') body.innerHTML = renderRegistriesStep();
    else body.innerHTML = renderReviewStep();

    const back = qs('#wizardBack');
    const skip = qs('#wizardSkip');
    const next = qs('#wizardNext');
    back.disabled = wizard.step === 1;
    const canSkip = stepName !== 'Review' && (wizard.type === 'standalone' || stepName === 'Connections');
    skip.classList.toggle('hidden', !canSkip);
    next.textContent = stepName === 'Review' ? 'Install Dok' : 'Continue';
    next.classList.toggle('primary', true);

    qsa('[data-wizard-type]', body).forEach(node => {
      node.addEventListener('click', () => {
        wizard.type = node.dataset.wizardType === 'core' ? 'core' : 'standalone';
        if (wizard.type === 'standalone') wizard.services = {};
        renderWizard();
      });
    });
    qsa('[data-option]', body).forEach(node => {
      node.addEventListener('click', () => {
        const category = node.dataset.category;
        const option = node.dataset.option;
        wizard.services[category] = wizard.services[category] === option ? '' : option;
        renderWizard();
      });
    });
  }

  function renderTypeStep() {
    const wizard = state.wizard;
    return `
      <h3>Installation type</h3>
      <div class="option-grid" style="margin-top:12px">
        <div class="option ${wizard.type === 'standalone' ? 'selected' : ''}" data-wizard-type="standalone">
          <div class="title">Standalone Dok <span class="tag">flexible</span></div>
          <div class="desc">Run Dok on its own. Configure defaults and repository connections, or skip them now and later in Dok Settings.</div>
        </div>
        <div class="option ${wizard.type === 'core' ? 'selected' : ''}" data-wizard-type="core">
          <div class="title">Dok with Core Services <span class="tag">full stack</span></div>
          <div class="desc">Pick reverse proxy, tunnel, authentication, DNS, and mail. Dok configures and starts them together. Required information cannot be skipped.</div>
        </div>
      </div>
      <div class="notice" style="margin-top:14px">
        The installer writes the Dok configuration, builds <span class="mono">wickedafdok:latest</span> if needed, launches Dok, then applies the selected core services through Dok's own APIs. A snapshot of the finished installation is saved for an exact reinstall.
      </div>`;
  }

  function renderServicesStep() {
    const wizard = state.wizard;
    const categories = state.install?.services || [];
    return `
      <h3>Select core services</h3>
      <div class="sub small" style="margin-bottom:14px">Choose at most one option per category. Descriptions explain what each service does; required fields appear when selected.</div>
      ${categories.map(category => {
        const selected = wizard.services[category.id] || '';
        return `<div class="card" style="margin-bottom:12px;background:var(--bg-soft)">
          <div class="card-head"><div><h3>${escapeHtml(category.label)}</h3><div class="card-note">${escapeHtml(category.description || '')}</div></div><span class="badge">${selected ? 'selected' : 'optional'}</span></div>
          <div class="option-grid">
            <div class="option ${!selected ? 'selected' : ''}" data-category="${escapeHtml(category.id)}" data-option="">
              <div class="title">None</div>
              <div class="desc">Skip this category.</div>
            </div>
            ${category.options.map(option => `
              <div class="option ${selected === option.id ? 'selected' : ''}" data-category="${escapeHtml(category.id)}" data-option="${escapeHtml(option.id)}">
                <div class="title">${escapeHtml(option.label)}</div>
                <div class="desc">${escapeHtml(option.description || '')}</div>
              </div>`).join('')}
          </div>
          ${selected ? `<div class="service-config">${serviceFieldInputs(category, selected)}</div>` : ''}
        </div>`;
      }).join('')}`;
  }

  function serviceFieldInputs(category, selected) {
    const option = category.options.find(item => item.id === selected);
    if (!option) return '';
    const skip = new Set(['adminPassword', 'adminUser', 'adminEmail', 'dokDomain']);
    return (option.fields || []).filter(key => !skip.has(key)).map(key => {
      const definition = SERVICE_FIELDS[key] || { label: key };
      const value = state.wizard.fields[key] ?? '';
      return fieldInput(key, value, definition);
    }).join('') || '<div class="card-note">No extra fields are required for this option.</div>';
  }

  function renderDefaultsStep() {
    const wizard = state.wizard;
    return `
      <h3>Dok settings</h3>
      <div class="sub small" style="margin-bottom:14px">These values populate Dok Settings → Default settings. Secrets are encrypted before they are written.${wizard.type === 'core' ? ' Required fields for the selected core services must be filled.' : ' You can skip this step and configure these later in Dok.'}</div>
      <div class="grid two">
        <div>
          ${DEFAULTS_FIELDS.slice(0, 4).map(field => fieldInput(field.key, wizard.fields[field.key], field)).join('')}
        </div>
        <div>
          ${DEFAULTS_FIELDS.slice(4).map(field => fieldInput(field.key, wizard.fields[field.key], field)).join('')}
          <label class="check" style="margin:8px 0"><input type="checkbox" id="wizAllowOutside" ${wizard.fields.allowOutsideData ? 'checked' : ''}> Allow bind paths outside the data location</label>
          <label class="check" style="margin:8px 0"><input type="checkbox" id="wizAutoAppData" ${wizard.fields.autoAppData ? 'checked' : ''}> Automatically create app data folders</label>
        </div>
      </div>`;
  }

  function renderRegistriesStep() {
    const rows = state.wizard.registries;
    return `
      <h3>Repository connections</h3>
      <div class="sub small" style="margin-bottom:14px">Optional. Container registry and Git host credentials are encrypted with Dok's credential key. You can add these later in Dok Settings. ${state.wizard.type === 'core' ? 'This step may be skipped.' : ''}</div>
      <div class="stack" id="registryRows">
        ${rows.map((row, index) => `
          <div class="list-row" data-registry-row="${index}">
            <div class="grid" style="flex:1;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px">
              <select class="select" data-registry="${index}" data-key="kind">
                <option value="registry" ${row.kind !== 'git' ? 'selected' : ''}>Container registry</option>
                <option value="git" ${row.kind === 'git' ? 'selected' : ''}>Git host</option>
              </select>
              <input class="input" data-registry="${index}" data-key="host" value="${escapeHtml(row.host)}" placeholder="registry.example.com">
              <input class="input" data-registry="${index}" data-key="name" value="${escapeHtml(row.name)}" placeholder="Name">
              <input class="input" data-registry="${index}" data-key="username" value="${escapeHtml(row.username)}" placeholder="Username">
              <input class="input" type="password" data-registry="${index}" data-key="secret" value="${escapeHtml(row.secret)}" placeholder="Token / password">
            </div>
            <button class="btn sm danger" data-registry-remove="${index}">Remove</button>
          </div>`).join('')}
      </div>
      <div class="row" style="margin-top:10px"><button class="btn sm" id="registryAdd">Add connection</button></div>`;
  }

  function renderReviewStep() {
    const wizard = state.wizard;
    const selected = Object.entries(wizard.services).filter(([, value]) => value);
    const registries = wizard.registries.filter(row => row.host);
    return `
      <h3>Review</h3>
      <div class="grid two">
        <div class="card" style="background:var(--bg-soft)">
          <div class="stat-label">Installation type</div>
          <div class="stat" style="font-size:18px">${wizard.type === 'core' ? 'Dok with Core Services' : 'Standalone Dok'}</div>
          <div class="divider"></div>
          <div class="stat-label">Core services</div>
          <div>${selected.length ? selected.map(([, value]) => `<span class="badge ok" style="margin:2px 4px 2px 0">${escapeHtml(value)}</span>`).join('') : '<span class="sub">None</span>'}</div>
          <div class="divider"></div>
          <div class="stat-label">Registries</div>
          <div>${registries.length ? registries.map(row => `<div class="small">${escapeHtml(row.name || row.host)} <span class="sub">(${escapeHtml(row.kind)})</span></div>`).join('') : '<span class="sub">None</span>'}</div>
        </div>
        <div class="card" style="background:var(--bg-soft)">
          <div class="stat-label">Domains</div>
          <div class="kv small" style="grid-template-columns:110px 1fr;margin-top:6px">
            <dt>Primary</dt><dd>${escapeHtml(wizard.fields.primaryDomain || '-')}</dd>
            <dt>Dok</dt><dd>${escapeHtml(wizard.fields.dokDomain || '-')}</dd>
            <dt>Data path</dt><dd>${escapeHtml(wizard.fields.dataLocation || 'Dok default')}</dd>
            <dt>Admin</dt><dd>${escapeHtml(wizard.fields.adminUser || 'admin')} ${wizard.fields.adminEmail ? `· ${escapeHtml(wizard.fields.adminEmail)}` : ''}</dd>
            <dt>Network</dt><dd>${escapeHtml(wizard.fields.defaultNetwork || 'wicked')}</dd>
          </div>
        </div>
      </div>
      <div class="notice ${wizard.type === 'core' ? 'warn' : ''}" style="margin-top:14px">
        ${wizard.type === 'core'
          ? 'Core service installation cannot skip required configuration. If a service fails to start, the installer keeps Dok running and reports the failing service so you can repair it here or with OpenCode.'
          : 'Standalone installation skips core service configuration. You can install core services later from this Maintenance container.'}
      </div>`;
  }

  document.addEventListener('input', event => {
    const field = event.target.closest('[data-field]');
    if (field && state.wizard) {
      const key = field.dataset.field;
      state.wizard.fields[key] = field.type === 'checkbox' ? field.checked : field.value;
      return;
    }
    const registry = event.target.closest('[data-registry]');
    if (registry && state.wizard) {
      const index = Number(registry.dataset.registry);
      const key = registry.dataset.key;
      if (state.wizard.registries[index]) state.wizard.registries[index][key] = registry.value;
    }
  });
  document.addEventListener('change', event => {
    if (event.target.id === 'wizAllowOutside') state.wizard.fields.allowOutsideData = event.target.checked;
    if (event.target.id === 'wizAutoAppData') state.wizard.fields.autoAppData = event.target.checked;
    const registry = event.target.closest('[data-registry]');
    if (registry && state.wizard) {
      const index = Number(registry.dataset.registry);
      if (state.wizard.registries[index]) state.wizard.registries[index][registry.dataset.key] = registry.value;
    }
  });
  document.addEventListener('click', event => {
    if (event.target.id === 'registryAdd' && state.wizard) {
      state.wizard.registries.push({ kind: 'registry', provider: 'custom', name: '', host: '', username: '', secret: '' });
      qs('#wizardBody').innerHTML = renderRegistriesStep();
    }
    const remove = event.target.closest('[data-registry-remove]');
    if (remove && state.wizard) {
      state.wizard.registries.splice(Number(remove.dataset.registryRemove), 1);
      qs('#wizardBody').innerHTML = renderRegistriesStep();
    }
  });

  function validateWizardStep() {
    const wizard = state.wizard;
    const steps = wizardSteps();
    const stepName = steps[wizard.step - 1];
    if (stepName === 'Core services') {
      const count = Object.values(wizard.services).filter(Boolean).length;
      if (!count) return 'Select at least one core service, or switch to Standalone Dok.';
      if (wizard.services.proxy === 'nginx-proxy' && !wizard.fields.dokDomain) return 'nginx-proxy needs a Dok domain. Fill it in the next step.';
      if (wizard.services.auth && !wizard.fields.dokDomain && wizard.services.proxy === 'nginx-proxy') return 'Set the Dok domain for the reverse proxy.';
    }
    if (stepName === 'Dok settings') {
      if (wizard.type === 'core') {
        if (wizard.services.proxy === 'nginx-proxy' && !wizard.fields.dokDomain) return 'A Dok domain is required when nginx-proxy is selected.';
        if (wizard.services.auth && !wizard.fields.adminPassword) return 'The authentication service requires an admin password.';
        if (wizard.services.auth && !wizard.fields.authDomain) return 'The authentication portal domain is required.';
        if (wizard.services.tunnel === 'cloudflared' && !wizard.fields.cloudflareToken) return 'A Cloudflare Tunnel token is required.';
        if (wizard.services.mail === 'smtp' && (!wizard.fields.smtpHost || !wizard.fields.smtpFrom)) return 'SMTP host and sender address are required.';
        if (wizard.services.mail === 'smtp' && wizard.fields.smtpHost && !wizard.fields.smtpFrom) return 'A sender address is required for SMTP.';
      }
      if (wizard.fields.dataLocation && !wizard.fields.dataLocation.startsWith('/')) return 'The data location must be an absolute host path.';
      if (wizard.fields.dataMode && !/^0?[0-7]{3,4}$/.test(wizard.fields.dataMode)) return 'Data directory mode must be octal, for example 0775.';
      if (wizard.fields.adminEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(wizard.fields.adminEmail)) return 'Admin email is invalid.';
    }
    return '';
  }

  qs('#wizardBack').addEventListener('click', () => {
    if (!state.wizard || state.wizard.step <= 1) return;
    state.wizard.step -= 1;
    renderWizard();
  });
  qs('#wizardSkip').addEventListener('click', () => {
    if (!state.wizard) return;
    state.wizard.step += 1;
    renderWizard();
  });
  qs('#wizardNext').addEventListener('click', () => {
    if (!state.wizard) return;
    const issue = validateWizardStep();
    if (issue) { toast(issue, 'error'); return; }
    const steps = wizardSteps();
    if (state.wizard.step >= steps.length) { startInstall(); return; }
    state.wizard.step += 1;
    renderWizard();
  });
  qs('#startInstallBtn').addEventListener('click', () => startWizard('standalone'));

  qs('#reinstallBtn').addEventListener('click', async () => {
    const ok = await confirmDialog('Exact reinstall', '<p>Restore the newest installation snapshot over the current checkout, start Dok, and start the installed core services?</p><p class="sub">This overwrites data/, apps/, core/, and sources/ with the snapshot contents. Backups and maintenance storage stay untouched.</p>', 'Reinstall');
    if (!ok) return;
    qs('#installProgress').classList.remove('hidden');
    qs('#installLog').textContent = 'Restoring installation snapshot...\n';
    qs('#installPhase').textContent = 'Restoring installation';
    try {
      const result = await api('/api/install/reinstall', { method: 'POST', body: {} });
      qs('#installLog').textContent += `${result.message || 'Reinstall completed.'}\n`;
      const coreStart = result.coreStart || {};
      const coreErrors = result.coreErrors || [];
      const coreFailed = coreStart.ok === false || coreErrors.length > 0;
      const failedServices = (coreStart.results || []).filter(item => !item.ok);
      qs('#installBadge').textContent = coreFailed || result.restartError ? 'warning' : 'complete';
      qs('#installBadge').className = `badge ${coreFailed || result.restartError ? 'warn' : 'ok'}`;
      qs('#installResult').classList.remove('hidden');
      qs('#installResult').innerHTML = `
        <div class="notice ${coreFailed || result.restartError ? 'warn' : 'ok'}">${escapeHtml(result.message || 'Reinstall completed.')}</div>
        ${failedServices.length ? `<div class="small" style="margin-top:8px">${failedServices.map(item => `<div>${escapeHtml(item.service)}: ${escapeHtml(item.error || 'failed to start')}</div>`).join('')}</div>` : ''}
        ${coreErrors.length ? `<div class="small" style="margin-top:8px">${coreErrors.map(item => `<div>${escapeHtml(item)}</div>`).join('')}</div>` : ''}
        ${result.restartError ? `<div class="small" style="margin-top:8px">Restart error: ${escapeHtml(result.restartError)}</div>` : ''}
        <div class="row" style="margin-top:10px"><a class="btn primary" href="http://${escapeHtml(location.hostname)}:8080" target="_blank" rel="noopener">Open Dok</a></div>`;
      await loadOverview();
    } catch (e) {
      qs('#installLog').textContent += `ERROR: ${e.message}\n`;
      qs('#installBadge').textContent = 'error';
      qs('#installBadge').className = 'badge bad';
    }
  });

  qs('#openExistingDokBtn').addEventListener('click', () => {
    const summary = state.system?.installation?.summary || {};
    const url = summary.dokDomain ? `http://${summary.dokDomain}` : `http://${location.hostname}:8080`;
    window.open(url, '_blank', 'noopener');
  });

  qs('#maintenanceModeBtn').addEventListener('click', async () => {
    try {
      await api('/api/maintenance/mode', { method: 'POST', body: { active: true } });
      toast('Maintenance mode active. Use Diagnostics or Terminal to repair the installation.', 'ok');
      showView('terminal');
    } catch (e) { toast(e.message, 'error'); }
  });

  function installPayload() {
    const wizard = state.wizard;
    return {
      type: wizard.type,
      defaults: {
        primaryDomain: wizard.fields.primaryDomain || '',
        dokDomain: wizard.fields.dokDomain || '',
        dataLocation: wizard.fields.dataLocation || '',
        dataMode: wizard.fields.dataMode || '0775',
        allowOutsideData: wizard.fields.allowOutsideData !== false,
        autoAppData: wizard.fields.autoAppData !== false,
        adminUser: wizard.fields.adminUser || 'admin',
        adminEmail: wizard.fields.adminEmail || '',
        adminPassword: wizard.fields.adminPassword || '',
        defaultNetwork: wizard.fields.defaultNetwork || 'wicked',
        protectDok: !!wizard.fields.protectDok
      },
      services: { ...wizard.services },
      dokDomain: wizard.fields.dokDomain || '',
      acmeEmail: wizard.fields.acmeEmail || '',
      authDomain: wizard.fields.authDomain || '',
      adminUser: wizard.fields.adminUser || 'admin',
      adminEmail: wizard.fields.adminEmail || '',
      adminPassword: wizard.fields.adminPassword || '',
      authPort: wizard.fields.authPort || '',
      protectDok: !!wizard.fields.protectDok,
      dnsDomain: wizard.fields.dnsDomain || '',
      dnsPort: wizard.fields.dnsPort || '',
      dnsWebPort: wizard.fields.dnsWebPort || '',
      mailDomain: wizard.fields.mailDomain || '',
      mailpitSmtpPort: wizard.fields.mailpitSmtpPort || '',
      mailpitWebPort: wizard.fields.mailpitWebPort || '',
      mailpitMaxMessages: wizard.fields.mailpitMaxMessages || '',
      stalwartAdminUser: wizard.fields.stalwartAdminUser || '',
      stalwartAdminPassword: wizard.fields.stalwartAdminPassword || '',
      stalwartWebPort: wizard.fields.stalwartWebPort || '',
      stalwartSmtpPort: wizard.fields.stalwartSmtpPort || '',
      stalwartSubmissionPort: wizard.fields.stalwartSubmissionPort || '',
      stalwartImapsPort: wizard.fields.stalwartImapsPort || '',
      smtpHost: wizard.fields.smtpHost || '',
      smtpPort: wizard.fields.smtpPort || '',
      smtpTls: wizard.fields.smtpTls || 'starttls',
      smtpUser: wizard.fields.smtpUser || '',
      smtpPassword: wizard.fields.smtpPassword || '',
      smtpFrom: wizard.fields.smtpFrom || '',
      cloudflareToken: wizard.fields.cloudflareToken || '',
      registries: wizard.registries.filter(row => row.host).map(row => ({
        kind: row.kind === 'git' ? 'git' : 'registry',
        provider: row.kind === 'git' ? 'custom' : 'custom',
        name: row.name || '',
        host: row.host,
        username: row.username || '',
        secret: row.secret || ''
      }))
    };
  }

  async function startInstall() {
    const payload = installPayload();
    qs('#installWizard').classList.add('hidden');
    qs('#installProgress').classList.remove('hidden');
    qs('#installResult').classList.add('hidden');
    qs('#installLog').textContent = 'Starting installation...\n';
    qs('#installBar').style.width = '4%';
    qs('#installPhase').textContent = 'Preparing installation';
    qs('#installBadge').textContent = 'running';
    qs('#installBadge').className = 'badge warn';
    try {
      await api('/api/install/run', { method: 'POST', body: payload });
      pollInstall();
    } catch (e) {
      qs('#installLog').textContent += `ERROR: ${e.message}\n`;
      qs('#installBadge').textContent = 'error';
      qs('#installBadge').className = 'badge bad';
      if (e.data?.issues) qs('#installLog').textContent += e.data.issues.join('\n') + '\n';
    }
  }

  const PHASE_PERCENT = {
    starting: 4, prepare: 10, 'write-configuration': 22, 'launch-dok': 40,
    'wait-for-dok': 62, 'configure-core-services': 78, 'record-snapshot': 92, done: 100, error: 100
  };

  function pollInstall() {
    clearTimeout(state.installPoll);
    state.installPoll = setTimeout(async () => {
      try {
        const data = await api('/api/install/status');
        const job = data.job;
        if (job) {
          qs('#installPhase').textContent = job.phase || 'Installing';
          qs('#installBar').style.width = `${PHASE_PERCENT[job.phase] || 50}%`;
          if (job.log) qs('#installLog').textContent = job.log;
          if (job.running) { pollInstall(); return; }
          if (job.error) {
            qs('#installBadge').textContent = 'error';
            qs('#installBadge').className = 'badge bad';
            qs('#installResult').classList.remove('hidden');
            qs('#installResult').innerHTML = `<div class="notice danger">Installation failed: ${escapeHtml(job.error)}</div><div class="row" style="margin-top:10px"><button class="btn" id="retryInstall">Back to installer</button><button class="btn cyan" id="assistantRetry">Open OpenCode</button></div>`;
            qs('#retryInstall')?.addEventListener('click', () => { qs('#installProgress').classList.add('hidden'); qs('#installWizard').classList.remove('hidden'); renderWizard(); });
            qs('#assistantRetry')?.addEventListener('click', () => openMaintenanceOpenCode());
            await loadInstall();
            await loadOverview();
            return;
          }
          const result = job.result || {};
          qs('#installBadge').textContent = 'complete';
          qs('#installBadge').className = 'badge ok';
          qs('#installBar').style.width = '100%';
          const warnings = result.warnings || [];
          qs('#installResult').classList.remove('hidden');
          qs('#installResult').innerHTML = `
            <div class="notice ${warnings.length ? 'warn' : 'ok'}">${escapeHtml(result.message || 'Installation completed.')}</div>
            <div class="small" style="margin-top:8px">The installation record and a snapshot are saved in the separate maintenance store. Later, open <strong>Dok Settings → Maintenance</strong> or run <span class="mono">sudo ./setup.sh</span> to activate Maintenance mode again.</div>
            ${warnings.length ? `<div class="small" style="margin-top:8px">${warnings.map(item => `<div>${escapeHtml(item.name)}: ${escapeHtml(item.detail)}</div>`).join('')}</div>` : ''}
            <div class="row" style="margin-top:12px">
              <a class="btn primary" href="${escapeHtml(result.dokUrl || `http://${location.hostname}:8080`)}" target="_blank" rel="noopener">Open Dok</a>
              <button class="btn" id="saveInstallResult">Save installation files</button>
              <button class="btn cyan" id="assistantResult">Configure with OpenCode</button>
              <button class="btn danger" id="shutdownInstall">Shutdown installation container</button>
            </div>`;
          qs('#saveInstallResult')?.addEventListener('click', () => syncInstallation(true));
          qs('#assistantResult')?.addEventListener('click', () => openMaintenanceOpenCode());
          qs('#shutdownInstall')?.addEventListener('click', shutdownMaintenance);
          await loadInstall();
          await loadOverview();
          return;
        }
        pollInstall();
      } catch (e) {
        if (!e.needsToken) {
          qs('#installLog').textContent += `STATUS ERROR: ${e.message}\n`;
          pollInstall();
        }
      }
    }, 1300);
  }

  async function shutdownMaintenance() {
    const ok = await confirmDialog('Shut down maintenance?', '<p>The installation is complete. Shut down this privileged container now? You can relaunch it from Dok or with <span class="mono">sudo ./setup.sh</span>.</p>', 'Shut down');
    if (!ok) return;
    try {
      await api('/api/maintenance/stop', { method: 'POST', body: {} });
      toast('Maintenance container is shutting down', 'ok');
    } catch (e) { toast(e.message, 'error'); }
  }

  // ---------- backups ----------
  async function loadBackups() {
    try {
      const data = await api('/api/backups');
      const list = data.backups || [];
      qs('#backupsList').innerHTML = list.length ? list.map(item => `
        <div class="list-row">
          <div style="min-width:0">
            <div class="name">${escapeHtml(item.name || item.id)}</div>
            <div class="meta">${escapeHtml(when(item.created))} · ${bytes(item.size)} · ${escapeHtml(item.id)}</div>
          </div>
          <div class="actions">
            <a class="btn sm" href="${withToken(`/api/backups/${encodeURIComponent(item.id)}/download`)}">Download</a>
            <button class="btn sm" data-backup-restore="${escapeHtml(item.id)}">Restore</button>
            <button class="btn sm danger" data-backup-delete="${escapeHtml(item.id)}">Delete</button>
          </div>
        </div>`).join('') : '<div class="empty">No backups yet.</div>';
    } catch (e) { if (!e.needsToken) toast(e.message, 'error'); }
  }

  qs('#backupRefresh').addEventListener('click', loadBackups);
  qs('#backupCreate').addEventListener('click', async () => {
    const name = qs('#backupName').value.trim();
    const includeLogs = qs('#backupLogs').checked;
    const button = qs('#backupCreate');
    button.disabled = true;
    button.innerHTML = '<span class="spinner"></span> Creating';
    try {
      await api('/api/backups', { method: 'POST', body: { name, includeLogs } });
      qs('#backupName').value = '';
      toast('Backup created', 'ok');
      await loadBackups();
    } catch (e) { toast(e.message, 'error'); }
    finally { button.disabled = false; button.textContent = 'Create backup'; }
  });
  qs('#backupImportPick').addEventListener('click', () => qs('#backupImportFile').click());
  qs('#backupImportFile').addEventListener('change', async event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const form = new FormData();
    form.append('file', file);
    form.append('name', file.name.replace(/\.(tar\.gz|tgz)$/i, ''));
    try {
      await apiForm('/api/backups/import', form);
      toast('Backup imported', 'ok');
      await loadBackups();
    } catch (e) { toast(e.message, 'error'); }
  });
  qs('#backupsList').addEventListener('click', async event => {
    const restore = event.target.closest('[data-backup-restore]');
    const remove = event.target.closest('[data-backup-delete]');
    if (restore) {
      const id = restore.dataset.backupRestore;
      const ok = await confirmDialog('Restore backup', `<p>Restore backup <span class="mono">${escapeHtml(id)}</span> over the current installation?</p><p class="sub">Dok and core services will be stopped, files replaced, and Dok started again. This cannot be undone unless you have another backup.</p>`, 'Restore');
      if (!ok) return;
      restore.disabled = true;
      try {
        const result = await api(`/api/backups/${encodeURIComponent(id)}/restore`, { method: 'POST', body: { overwrite: true, restart: true } });
        const warning = result.restartError || result.coreErrors?.length;
        toast(warning ? `Backup restored, but Dok or core services need attention: ${result.restartError || result.coreErrors.join('; ')}` : 'Backup restored. Dok is starting.', warning ? 'warn' : 'ok');
        await loadOverview();
      } catch (e) { toast(e.message, 'error'); }
      finally { restore.disabled = false; }
    }
    if (remove) {
      const id = remove.dataset.backupDelete;
      const ok = await confirmDialog('Delete backup', `<p>Delete backup <span class="mono">${escapeHtml(id)}</span>? This removes the archive from maintenance storage.</p>`, 'Delete');
      if (!ok) return;
      try { await api(`/api/backups/${encodeURIComponent(id)}`, { method: 'DELETE' }); toast('Backup deleted', 'ok'); await loadBackups(); }
      catch (e) { toast(e.message, 'error'); }
    }
  });

  // ---------- snapshots ----------
  async function loadSnapshots() {
    try {
      const data = await api('/api/snapshots');
      const list = data.snapshots || [];
      qs('#snapshotsList').innerHTML = list.length ? list.map(item => `
        <div class="list-row">
          <div style="min-width:0">
            <div class="name">${escapeHtml(item.label || item.id)}</div>
            <div class="meta">${escapeHtml(when(item.created))} · ${bytes(item.size)} · ${escapeHtml(item.reason || 'snapshot')} · ${escapeHtml(item.summary?.apps ?? '-')} apps</div>
          </div>
          <div class="actions">
            <a class="btn sm" href="${withToken(`/api/snapshots/${encodeURIComponent(item.id)}/download`)}">Download</a>
            <button class="btn sm primary" data-snapshot-reinstall="${escapeHtml(item.id)}">Restore</button>
            <button class="btn sm danger" data-snapshot-delete="${escapeHtml(item.id)}">Delete</button>
          </div>
        </div>`).join('') : '<div class="empty">No snapshots yet. Install Dok or capture one from Overview.</div>';
    } catch (e) { if (!e.needsToken) toast(e.message, 'error'); }
  }

  qs('#snapRefresh').addEventListener('click', loadSnapshots);
  qs('#snapCreate').addEventListener('click', async () => {
    try {
      await api('/api/snapshots', { method: 'POST', body: { label: 'Manual snapshot' } });
      toast('Snapshot captured', 'ok');
      await loadSnapshots();
      await loadOverview();
    } catch (e) { toast(e.message, 'error'); }
  });
  qs('#snapReinstall').addEventListener('click', async () => {
    const ok = await confirmDialog('Exact reinstall', '<p>Restore the newest snapshot and start Dok plus its core services?</p><p class="sub">This overwrites data/, apps/, core/, and sources/ from the snapshot.</p>', 'Reinstall');
    if (!ok) return;
    try {
      const result = await api('/api/install/reinstall', { method: 'POST', body: {} });
      const warning = result.coreStart?.ok === false || result.restartError || result.coreErrors?.length;
      toast(result.message || 'Exact reinstall complete', warning ? 'warn' : 'ok');
      await loadOverview();
      await loadSnapshots();
    } catch (e) { toast(e.message, 'error'); }
  });
  qs('#snapshotsList').addEventListener('click', async event => {
    const restore = event.target.closest('[data-snapshot-reinstall]');
    const remove = event.target.closest('[data-snapshot-delete]');
    if (restore) {
      const id = restore.dataset.snapshotReinstall;
      const ok = await confirmDialog('Restore snapshot', `<p>Restore snapshot <span class="mono">${escapeHtml(id)}</span>?</p><p class="sub">Dok and core services are stopped, files are replaced, and Dok is started again.</p>`, 'Restore');
      if (!ok) return;
      restore.disabled = true;
      try {
        const result = await api(`/api/snapshots/${encodeURIComponent(id)}/restore`, { method: 'POST', body: { overwrite: true, restart: true } });
        const warning = result.restartError || result.coreErrors?.length;
        toast(warning ? `Snapshot restored, but Dok or core services need attention: ${result.restartError || result.coreErrors.join('; ')}` : 'Snapshot restored. Dok is starting.', warning ? 'warn' : 'ok');
        await loadOverview();
      } catch (e) { toast(e.message, 'error'); }
      finally { restore.disabled = false; }
    }
    if (remove) {
      const id = remove.dataset.snapshotDelete;
      const ok = await confirmDialog('Delete snapshot', `<p>Delete snapshot <span class="mono">${escapeHtml(id)}</span>?</p>`, 'Delete');
      if (!ok) return;
      try { await api(`/api/snapshots/${encodeURIComponent(id)}`, { method: 'DELETE' }); toast('Snapshot deleted', 'ok'); await loadSnapshots(); }
      catch (e) { toast(e.message, 'error'); }
    }
  });

  // ---------- updates ----------
  async function loadUpdates() {
    try {
      const data = await api('/api/updates');
      qs('#updateRepo').value = data.repo || qs('#updateRepo').value;
      qs('#updateBranch').value = data.branch || qs('#updateBranch').value;
      qs('#updateCheckout').textContent = data.repo || 'No origin configured';
      qs('#updateCommit').textContent = `${data.commit || '-'} ${data.subject ? `· ${data.subject}` : ''}`;
      qs('#updateDirty').classList.toggle('hidden', !data.dirty);
      if (data.job) renderUpdateJob(data.job);
    } catch (e) { if (!e.needsToken) toast(e.message, 'error'); }
  }

  function renderUpdateJob(job) {
    const badge = qs('#updateBadge');
    badge.textContent = job.running ? (job.phase || 'running') : job.error ? 'error' : job.result ? 'done' : 'idle';
    badge.className = `badge ${job.running ? 'warn' : job.error ? 'bad' : job.result ? 'ok' : ''}`;
    if (job.log) qs('#updateLog').textContent = job.log;
    qs('#updateRun').disabled = !!job.running;
    if (job.running) pollUpdate();
  }

  function pollUpdate() {
    clearTimeout(state.updatePoll);
    state.updatePoll = setTimeout(async () => {
      try {
        const data = await api('/api/updates/status');
        if (data.job) renderUpdateJob(data.job);
        if (data.job?.running) pollUpdate();
        else await loadOverview();
      } catch (e) { if (!e.needsToken) toast(e.message, 'error'); }
    }, 1400);
  }

  qs('#updateRefresh').addEventListener('click', loadUpdates);
  qs('#updateRun').addEventListener('click', async () => {
    const ok = await confirmDialog('Update Dok', '<p>Pull the selected branch, rebuild <span class="mono">wickedafdok:latest</span>, and recreate the Dok container?</p><p class="sub">Core services and apps are left running unless Compose needs to recreate Dok. A snapshot is captured after Dok becomes healthy.</p>', 'Update');
    if (!ok) return;
    try {
      await api('/api/updates/run', {
        method: 'POST',
        body: {
          repo: qs('#updateRepo').value.trim(),
          branch: qs('#updateBranch').value.trim(),
          force: qs('#updateForce').checked
        }
      });
      qs('#updateLog').textContent = 'Update started...';
      pollUpdate();
    } catch (e) {
      toast(e.message, 'error');
      if (e.data?.dirty) qs('#updateDirty').classList.remove('hidden');
    }
  });

  // ---------- diagnostics ----------
  async function runDiagnostics() {
    qs('#diagChecks').innerHTML = '<div class="empty">Running checks...</div>';
    try {
      const data = await api('/api/diagnostics');
      qs('#diagChecks').dataset.loaded = '1';
      qs('#diagChecks').innerHTML = (data.checks || []).map(check => `
        <div class="list-row">
          <div><span class="badge ${check.ok ? 'ok' : 'bad'}">${check.ok ? 'ok' : 'issue'}</span> <strong>${escapeHtml(check.name)}</strong><div class="meta">${escapeHtml(check.detail)}</div></div>
          ${!check.ok && check.canFix ? '<span class="small warn">repairable</span>' : ''}
        </div>`).join('') || '<div class="empty">No checks returned.</div>';
      await loadLogs();
    } catch (e) {
      qs('#diagChecks').innerHTML = `<div class="notice danger">${escapeHtml(e.message)}</div>`;
    }
  }

  qs('#diagRun').addEventListener('click', runDiagnostics);
  qs('#diagRepair').addEventListener('click', async () => {
    const ok = await confirmDialog('Repair installation', '<p>Recreate missing directories, fix permissions and ownership, ensure the <span class="mono">wicked</span> network, and restore the credential key if it is missing.</p>', 'Repair');
    if (!ok) return;
    try {
      const data = await api('/api/repair', { method: 'POST', body: {} });
      toast(data.ok ? 'Repair completed' : 'Repair finished with remaining issues', data.ok ? 'ok' : '');
      await runDiagnostics();
      await loadOverview();
    } catch (e) { toast(e.message, 'error'); }
  });

  async function loadLogs() {
    try {
      const data = await api('/api/logs?tail=400');
      qs('#maintenanceLog').textContent = data.maintenance || '-';
      qs('#dokLog').textContent = data.dok || '-';
    } catch (e) { if (!e.needsToken) toast(e.message, 'error'); }
  }
  qs('#logsRefresh').addEventListener('click', loadLogs);

  // ---------- terminal / OpenCode ----------
  async function loadSessions() {
    try {
      const data = await api('/api/terminal');
      const badge = qs('#opencodeBadge');
      badge.textContent = data.installed ? `OpenCode ${data.version || ''}`.trim() : 'not installed';
      badge.className = `badge ${data.installed ? 'ok' : 'bad'}`;
      const sessions = data.sessions || [];
      qs('#sessionsList').innerHTML = sessions.length ? sessions.map(session => `
        <div class="list-row">
          <div><div class="name">${escapeHtml(session.title || session.app)}</div><div class="meta">${escapeHtml(session.app)} · ${escapeHtml(session.createdAt)} · ${session.exited ? 'exited' : 'live'}</div></div>
          <div class="actions">
            <button class="btn sm" data-session-open="${escapeHtml(session.id)}">Attach</button>
            <button class="btn sm danger" data-session-stop="${escapeHtml(session.id)}">Stop</button>
          </div>
        </div>`).join('') : '<div class="empty">No sessions.</div>';
    } catch (e) { if (!e.needsToken) toast(e.message, 'error'); }
  }
  qs('#termRefresh').addEventListener('click', loadSessions);
  qs('#stopAllSessions').addEventListener('click', async () => {
    try { await api('/api/terminal/sessions/stop-all', { method: 'POST', body: {} }); closeTerminal(); await loadSessions(); }
    catch (e) { toast(e.message, 'error'); }
  });
  qs('#sessionsList').addEventListener('click', async event => {
    const open = event.target.closest('[data-session-open]');
    const stop = event.target.closest('[data-session-stop]');
    if (open) openExistingSession(open.dataset.sessionOpen);
    if (stop) {
      try { await api(`/api/terminal/sessions/${encodeURIComponent(stop.dataset.sessionStop)}/stop`, { method: 'POST', body: {} }); toast('Session stopped'); await loadSessions(); }
      catch (e) { toast(e.message, 'error'); }
    }
  });

  function ensureTerminal() {
    if (state.terminal) return state.terminal;
    if (!window.Terminal) { toast('Terminal assets failed to load', 'error'); return null; }
    const terminal = new window.Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      theme: { background: '#05080a', foreground: '#d7e5df', cursor: '#b6ff3b', selectionBackground: '#2c3b44' },
      scrollback: 5000,
      convertEol: true
    });
    terminal.open(qs('#terminalContainer'));
    state.terminal = terminal;
    if (window.FitAddon?.FitAddon) {
      state.terminalFit = new window.FitAddon.FitAddon();
      terminal.loadAddon(state.terminalFit);
      try { state.terminalFit.fit(); } catch {}
    }
    window.addEventListener('resize', () => { try { state.terminalFit?.fit(); } catch {} });
    terminal.onData(data => {
      if (state.terminalSession?.ws?.readyState === WebSocket.OPEN) {
        state.terminalSession.ws.send(JSON.stringify({ type: 'input', data }));
      }
    });
    return terminal;
  }

  async function openTerminal(appName, prompt = '') {
    const terminal = ensureTerminal();
    if (!terminal) return;
    qs('#terminalModal').classList.remove('hidden');
    qs('#terminalTitle').textContent = appName === 'opencode' ? 'Maintenance · OpenCode Admin' : 'Maintenance · Admin shell';
    qs('#terminalStatus').textContent = 'connecting';
    terminal.reset();
    try {
      const data = await api('/api/terminal/sessions', {
        method: 'POST',
        body: { app: appName, prompt, title: appName === 'opencode' ? 'Maintenance · OpenCode Admin' : 'Maintenance shell' }
      });
      attachSession(data.session);
      await loadSessions();
    } catch (e) {
      qs('#terminalStatus').textContent = 'failed';
      terminal.writeln(`\r\n\x1b[31m${e.message}\x1b[0m`);
    }
  }

  function attachSession(session) {
    detachTerminalSocket();
    const terminal = ensureTerminal();
    if (!terminal) return;
    qs('#terminalModal').classList.remove('hidden');
    qs('#terminalTitle').textContent = session.title || 'Maintenance session';
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${protocol}://${location.host}/api/terminal/ws?id=${encodeURIComponent(session.id)}&token=${encodeURIComponent(state.token || '')}`;
    const ws = new WebSocket(url);
    state.terminalSession = { ...session, ws };
    terminal.reset();
    qs('#terminalStatus').textContent = 'connecting';
    ws.addEventListener('open', () => { qs('#terminalStatus').textContent = 'connected'; });
    ws.addEventListener('message', event => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === 'output') terminal.write(message.data);
      if (message.type === 'ready') qs('#terminalStatus').textContent = 'connected';
      if (message.type === 'exit') { qs('#terminalStatus').textContent = `exited (${message.code})`; terminal.writeln(`\r\n\x1b[90m[session exited with code ${message.code}]\x1b[0m`); }
    });
    ws.addEventListener('close', () => { qs('#terminalStatus').textContent = 'disconnected'; });
    ws.addEventListener('error', () => { qs('#terminalStatus').textContent = 'connection error'; });
    ws.addEventListener('open', () => {
      try { state.terminalFit?.fit(); } catch {}
      const dims = terminal;
      ws.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }));
    });
  }

  async function openExistingSession(id) {
    try {
      const data = await api('/api/terminal');
      const session = (data.sessions || []).find(item => item.id === id);
      if (!session) { toast('Session no longer exists', 'error'); return; }
      attachSession(session);
    } catch (e) { toast(e.message, 'error'); }
  }

  function detachTerminalSocket() {
    if (state.terminalSession?.ws) {
      try { state.terminalSession.ws.close(); } catch {}
    }
    state.terminalSession = null;
  }

  async function closeTerminal() {
    const session = state.terminalSession;
    detachTerminalSocket();
    qs('#terminalModal').classList.add('hidden');
    if (session && !session.exited) {
      try { await api(`/api/terminal/sessions/${encodeURIComponent(session.id)}/stop`, { method: 'POST', body: {} }); } catch {}
    }
    await loadSessions();
  }

  qs('#terminalClose').addEventListener('click', closeTerminal);
  qs('#terminalStop').addEventListener('click', closeTerminal);
  qs('#openShellBtn').addEventListener('click', () => openTerminal('shell'));
  qs('#openOpencodeBtn').addEventListener('click', () => openTerminal('opencode'));
  qs('#openAssistBtn').addEventListener('click', () => openMaintenanceOpenCode());

  function openMaintenanceOpenCode() {
    const description = state.install?.installation?.saved?.plan
      ? `The saved installation plan is ${JSON.stringify(state.install.installation.saved.plan)}.`
      : 'Dok is being installed or maintained.';
    const prompt = [
      'You are the Dok Maintenance configuration assistant.',
      description,
      'Read /dok/AGENTS.md first. Inspect the current /dok/data/settings.json (values are decrypted only through the Dok API; do not print secrets), the generated core service composes under /dok/core, and the running containers.',
      'Verify that the selected core services work together: nginx-proxy domains and certificates, Authelia/Authentik portals and cookie domains, DNS ports, and mail delivery. Use the Dok API at http://wickedafdok:8080 where possible and verify with docker compose and curl.',
      'Make the smallest safe changes, preserve app data, and report what you changed and any remaining manual steps.'
    ].join('\n');
    openTerminal('opencode', prompt);
  }

  qs('#terminalModal').addEventListener('click', event => {
    if (event.target === qs('#terminalModal')) closeTerminal();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      if (!qs('#terminalModal').classList.contains('hidden')) closeTerminal();
      if (!qs('#confirmModal').classList.contains('hidden')) closeConfirm(false);
    }
  });

  // ---------- boot ----------
  qs('#tokenSave').addEventListener('click', async () => {
    const value = qs('#tokenInput').value.trim();
    if (!value) { toast('Enter the maintenance token', 'error'); return; }
    state.token = value;
    localStorage.setItem(tokenKey, value);
    hideTokenModal();
    await boot();
  });
  qs('#tokenInput').addEventListener('keydown', event => {
    if (event.key === 'Enter') qs('#tokenSave').click();
  });

  async function boot() {
    try {
      const health = await fetch('/api/health').then(response => response.json()).catch(() => null);
      if (health?.tokenRequired && !state.token) {
        showTokenModal();
        return;
      }
      hideTokenModal();
      await loadOverview();
      await loadInstall();
      await loadSessions();
      const installTab = new URLSearchParams(location.search).get('view');
      if (installTab) showView(installTab);
    } catch (e) {
      if (!e.needsToken) toast(e.message, 'error');
    }
  }

  setInterval(() => {
    if (document.hidden) return;
    if (qs('#view-overview').classList.contains('active')) loadOverview();
  }, 20000);

  boot();
})();
