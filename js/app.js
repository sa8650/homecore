/* =================================================================
 * app.js — Smart Home webapp (MQTT + HTTP dual-mode)
 * ================================================================= */

const ROOM_ICONS = {
  bedroom: '🛏️', kitchen: '🍳', bathroom: '🚿', garage: '🚗',
  balcony: '🌿', dining: '🍽️', living: '🛋️', custom: '🏠',
};

const $  = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const state = { info: null, rooms: [], switches: [], pins: [], poll: null, pollMs: 5000 };

const toast = (msg, kind = '') => {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), 2400);
};

const openModal  = (id) => { const m = document.getElementById(id); if (m) m.dataset.open = 'true'; };
const closeModal = (id) => { const m = document.getElementById(id); if (m) m.dataset.open = 'false'; };

// ---- Connection Flow ----
function showConnIfNeeded() {
  if (ESP.hasCreds()) {
    connectAndLoad().catch(() => openModal('connModal'));
  } else {
    openModal('connModal');
  }
}

async function connectAndLoad() {
  if (ESP.mode === 'mqtt') {
    await ESP.connectMqtt(ESP.mqttBroker, ESP.mqttUser, ESP.mqttPass, ESP.mqttBoardId);
    $('#connBadge').textContent = `MQTT · ${ESP.mqttBoardId || 'all'}`;
    $('#connBadge').classList.add('ok');
  } else {
    const info = await ESP.info();
    state.info = info;
    $('#connBadge').textContent = `HTTP · ${info.ip || ESP.httpHost}`;
    $('#connBadge').classList.add('ok');
  }
}

// MQTT Connect button
async function mqttConnectFlow() {
  const broker = $('#mqttBroker').value.trim();
  const user = $('#mqttUser').value.trim();
  const pass = $('#mqttPass').value;
  const boardId = $('#mqttBoardId').value.trim();
  if (!broker) { toast('MQTT broker URL required', 'bad'); return; }

  ESP.save('mqtt', { broker, user, pass, boardId });
  $('#mqttHint').textContent = 'Connecting...';

  try {
    await ESP.connectMqtt(broker, user, pass, boardId);
    closeModal('connModal');
    toast('Connected via MQTT', 'ok');
    startPolling();
    refreshAll();
  } catch (e) {
    $('#mqttHint').textContent = 'Failed: ' + e.message;
  }
}

// HTTP Connect button
async function httpConnectFlow() {
  const host = $('#espHost').value.trim();
  const pass = $('#espPass').value;
  if (!host || !pass) { toast('Host and password required', 'bad'); return; }

  ESP.save('http', { host, pass });
  $('#connHint').textContent = 'Connecting...';

  try {
    const info = await ESP.info();
    state.info = info;
    closeModal('connModal');
    toast('Connected', 'ok');
    startPolling();
    refreshAll();
  } catch (e) {
    $('#connHint').textContent = 'Failed: ' + e.message;
  }
}

async function discoverFlow() {
  $('#connHint').textContent = 'Scanning... (~10s)';
  try {
    const res = await ESP.discover();
    if (res) {
      $('#espHost').value = res.host;
      $('#connHint').textContent = `Found ${res.info.name} at ${res.host}`;
    } else {
      $('#connHint').textContent = 'No device found. Type the IP manually.';
    }
  } catch (e) { $('#connHint').textContent = 'Scan failed: ' + e.message; }
}

// ---- Tabs ----
function bindTabs() {
  $$('.tab').forEach((t) => {
    t.addEventListener('click', () => {
      const name = t.dataset.tab;
      const parent = t.closest('.modal-card') || document;
      parent.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
      parent.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === name));
    });
  });
}

// ---- Board Selector ----
function updateBoardSelector() {
  const sel = $('#boardSelect');
  sel.innerHTML = '';
  const boards = ESP.getAllBoards();
  if (boards.length === 0) {
    sel.style.display = 'none';
    return;
  }
  sel.style.display = '';
  boards.forEach(b => {
    const o = document.createElement('option');
    o.value = b.boardId;
    o.textContent = (b.state?.boardName || b.boardId) + (b.status === 'offline' ? ' (offline)' : '');
    o.selected = b.boardId === ESP.mqttBoardId;
    sel.appendChild(o);
  });
}

// ---- Data Refresh ----
async function refreshAll() {
  try {
    const [info, status, rooms, switches, pins] = await Promise.all([
      ESP.info().catch(() => null),
      ESP.status().catch(() => null),
      ESP.rooms().catch(() => ({ rooms: [] })),
      ESP.switches().catch(() => ({ switches: [] })),
      ESP.pins().catch(() => ({ pins: [] })),
    ]);

    if (info) state.info = info;
    state.rooms = (rooms && rooms.rooms) || [];
    state.switches = (switches && switches.switches) || [];
    state.pins = (pins && pins.pins) || [];

    if (info) {
      $('#sUptime').textContent  = formatTime(info.uptime ?? 0);
      $('#sHeap').textContent    = ((info.heap || 0) / 1024).toFixed(0) + ' kB';
      $('#sRssi').textContent    = (status && status.rssi) || '—';
      $('#sMode').textContent    = info.mode || '—';
      $('#sMqtt').textContent    = ESP.mode === 'mqtt' ? '✓' : (info.mqtt ? '✓' : '✗');
    }
    $('#sRooms').textContent   = state.rooms.length;
    $('#sSwitches').textContent = state.switches.length;
    $('#alarmBanner').hidden   = !(status && status.alarm);

    if (ESP.mode === 'mqtt') updateBoardSelector();

    renderFloorPlan();
    renderRoomList();
    renderSwitchList();
    renderPinOptions();
  } catch (e) {
    $('#connBadge').classList.remove('ok');
    $('#connBadge').textContent = 'offline';
    if (ESP.hasCreds()) toast('Lost: ' + e.message, 'bad');
  }
}

function startPolling() {
  if (state.poll) clearInterval(state.poll);
  if (ESP.mode === 'http') {
    state.poll = setInterval(refreshAll, state.pollMs);
  }
  // MQTT gets real-time updates via subscription
}

function formatTime(s) {
  s = Number(s) || 0;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${ss}s`;
  return `${ss}s`;
}

// ---- Floor Plan ----
function renderFloorPlan() {
  const fp = $('#floorplan');
  fp.innerHTML = '';
  if (state.rooms.length === 0) {
    fp.innerHTML = '<div class="empty">No rooms yet. Click <b>+ Room</b> to begin.</div>';
    return;
  }
  state.rooms.forEach((r, i) => fp.appendChild(buildRoomEl(r, i)));
}

function buildRoomEl(r, index) {
  const el = document.createElement('div');
  el.className = 'room';
  el.dataset.index = index;
  applyPosition(el, r);
  const icon = ROOM_ICONS[r.type] || '🏠';
  const head = document.createElement('div');
  head.className = 'room-head';
  head.innerHTML = `<span><span class="icon">${icon}</span> ${escapeHtml(r.name)}</span><span class="menu" title="Delete">✕</span>`;
  head.querySelector('.menu').addEventListener('click', () => deleteRoom(index));
  el.appendChild(head);

  const body = document.createElement('div');
  body.className = 'room-body';
  const swInRoom = state.switches
    .map((s, i) => ({ ...s, _i: i }))
    .filter((s) => s.roomId === r.id);
  if (swInRoom.length === 0) {
    const e = document.createElement('div');
    e.className = 'muted'; e.style.fontSize = '11px';
    e.textContent = 'No switches assigned';
    body.appendChild(e);
  } else {
    swInRoom.forEach((s) => body.appendChild(buildSwitchEl(s)));
  }
  el.appendChild(body);

  const rz = document.createElement('div');
  rz.className = 'resizer';
  el.appendChild(rz);

  attachDrag(el, head, index, 'move');
  attachDrag(el, rz, index, 'resize');
  return el;
}

function applyPosition(el, r) {
  el.style.left = r.x + '%';
  el.style.top  = r.y + '%';
  el.style.width  = r.width + '%';
  el.style.height = r.height + '%';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}

function buildSwitchEl(s) {
  const row = document.createElement('div');
  row.className = 'device';
  row.innerHTML = `
    <span class="name" title="${escapeHtml(s.pinLabel || '')}">${escapeHtml(s.name)}</span>
    <label class="toggle">
      <input type="checkbox" ${s.state ? 'checked' : ''}>
      <span class="slider"></span>
    </label>`;
  const input = row.querySelector('input');
  input.addEventListener('change', async () => {
    input.disabled = true;
    try {
      await ESP.setSwitch(s._i, input.checked);
      s.state = input.checked;
      toast(`${s.name} → ${input.checked ? 'ON' : 'OFF'}`, 'ok');
    } catch (e) {
      input.checked = !input.checked;
      toast('Failed: ' + e.message, 'bad');
    } finally { input.disabled = false; }
  });
  return row;
}

function attachDrag(el, handle, index, mode) {
  let startX, startY, startRect, startVal, doing = false;
  const onDown = (e) => {
    e.preventDefault();
    const t = (e.touches && e.touches[0]) || e;
    startX = t.clientX; startY = t.clientY;
    const fp = $('#floorplan').getBoundingClientRect();
    startRect = { x: fp.left, y: fp.top, w: fp.width, h: fp.height };
    const r = state.rooms[index];
    startVal = { x: r.x, y: r.y, w: r.width, h: r.height };
    el.classList.add('dragging');
    doing = true;
    window.addEventListener('mousemove', onMove);
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchend', onUp);
  };
  const onMove = (e) => {
    if (!doing) return;
    e.preventDefault();
    const t = (e.touches && e.touches[0]) || e;
    const dx = ((t.clientX - startX) / startRect.w) * 100;
    const dy = ((t.clientY - startY) / startRect.h) * 100;
    const r = state.rooms[index];
    if (mode === 'move') {
      r.x = clamp(startVal.x + dx, 0, 100 - r.width);
      r.y = clamp(startVal.y + dy, 0, 100 - r.height);
    } else {
      r.width  = clamp(startVal.w + dx, 5, 100 - startVal.x);
      r.height = clamp(startVal.h + dy, 5, 100 - startVal.y);
    }
    applyPosition(el, r);
  };
  const onUp = () => {
    if (!doing) return;
    doing = false;
    el.classList.remove('dragging');
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('touchmove', onMove);
    window.removeEventListener('mouseup', onUp);
    window.removeEventListener('touchend', onUp);
    const r = state.rooms[index];
    ESP.updateRoomPos(index, Math.round(r.x), Math.round(r.y),
                      Math.round(r.width), Math.round(r.height))
      .catch((e) => toast('Layout save failed: ' + e.message, 'bad'));
  };
  handle.addEventListener('mousedown', onDown);
  handle.addEventListener('touchstart', onDown, { passive: false });
}

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// ---- Room/Switch Lists ----
function renderRoomList() {
  const ul = $('#roomList');
  ul.innerHTML = '';
  state.rooms.forEach((r, i) => {
    const li = document.createElement('li');
    const icon = ROOM_ICONS[r.type] || '🏠';
    const swCount = state.switches.filter((s) => s.roomId === r.id).length;
    li.innerHTML = `
      <span>${icon} <b>${escapeHtml(r.name)}</b>
        <span class="muted">(${r.type}, ${swCount} switches)</span>
      </span>
      <span class="row gap-8">
        <button class="btn danger" data-del="${i}">Delete</button>
      </span>`;
    li.querySelector('[data-del]').addEventListener('click', () => deleteRoom(i));
    ul.appendChild(li);
  });
}

function renderSwitchList() {
  const ul = $('#switchList');
  ul.innerHTML = '';
  state.switches.forEach((s, i) => {
    const li = document.createElement('li');
    const assigned = state.rooms.find((r) => r.id === s.roomId);
    const roomOpts = ['<option value="-1">Unassigned</option>',
      ...state.rooms.map((r) =>
        `<option value="${r.id}" ${assigned && assigned.id === r.id ? 'selected' : ''}>
          ${ROOM_ICONS[r.type] || '🏠'} ${escapeHtml(r.name)}
        </option>`)].join('');
    li.innerHTML = `
      <span>🔌 <b>${escapeHtml(s.name)}</b>
        <span class="muted">${s.pinLabel || ('GPIO ' + s.pin)}</span>
      </span>
      <span class="row gap-8">
        <select data-assign="${i}">${roomOpts}</select>
        <label class="toggle">
          <input type="checkbox" data-toggle="${i}" ${s.state ? 'checked' : ''}>
          <span class="slider"></span>
        </label>
        <button class="btn danger" data-del="${i}">✕</button>
      </span>`;
    li.querySelector('[data-toggle]').addEventListener('change', async (e) => {
      try {
        await ESP.setSwitch(i, e.target.checked);
        s.state = e.target.checked;
      } catch (err) { e.target.checked = !e.target.checked; toast(err.message, 'bad'); }
    });
    li.querySelector('[data-del]').addEventListener('click', () => deleteSwitch(i));
    li.querySelector('[data-assign]').addEventListener('change', async (e) => {
      try {
        await ESP.assignSwitch(i, parseInt(e.target.value, 10));
        s.roomId = parseInt(e.target.value, 10);
        toast('Assigned', 'ok');
        renderFloorPlan();
      } catch (err) { toast(err.message, 'bad'); }
    });
    ul.appendChild(li);
  });
}

function renderPinOptions() {
  const sel = $('#newSwPin');
  sel.innerHTML = '';
  state.pins.filter((p) => p.free).forEach((p) => {
    const o = document.createElement('option');
    o.value = p.pin;
    o.textContent = `${p.label} (GPIO ${p.pin})`;
    sel.appendChild(o);
  });
  if (sel.options.length === 0) {
    const o = document.createElement('option');
    o.textContent = 'No free pins';
    sel.appendChild(o);
  }
}

// ---- Actions ----
async function addRoom() {
  const name = $('#newRoomName').value.trim();
  const type = $('#newRoomType').value;
  if (!name) { toast('Name required', 'bad'); return; }
  try {
    await ESP.addRoom(name, type);
    $('#newRoomName').value = '';
    toast('Room added', 'ok');
    if (ESP.mode === 'http') refreshAll();
    // MQTT: wait for state update
  } catch (e) { toast(e.message, 'bad'); }
}

async function deleteRoom(i) {
  if (!confirm('Delete this room?')) return;
  try {
    await ESP.deleteRoom(i);
    toast('Room deleted', 'ok');
    if (ESP.mode === 'http') refreshAll();
  } catch (e) { toast(e.message, 'bad'); }
}

async function addSwitch() {
  const name = $('#newSwName').value.trim();
  const pin  = parseInt($('#newSwPin').value, 10);
  if (!name || isNaN(pin)) { toast('Name and pin required', 'bad'); return; }
  try {
    await ESP.addSwitch(name, pin);
    $('#newSwName').value = '';
    toast('Switch added', 'ok');
    if (ESP.mode === 'http') refreshAll();
  } catch (e) { toast(e.message, 'bad'); }
}

async function deleteSwitch(i) {
  if (!confirm('Delete this switch?')) return;
  try {
    await ESP.deleteSwitch(i);
    if (ESP.mode === 'http') refreshAll();
  } catch (e) { toast(e.message, 'bad'); }
}

async function silenceAlarm() {
  try {
    await ESP.silenceAlarm();
    $('#alarmBanner').hidden = true;
    toast('Alarm silenced', 'ok');
  } catch (e) { toast(e.message, 'bad'); }
}

// ---- Settings ----
function prefillConnInputs() {
  if (ESP.mode === 'mqtt') {
    $('#mqttBroker').value = ESP.mqttBroker;
    $('#mqttUser').value = ESP.mqttUser;
    $('#mqttPass').value = ESP.mqttPass;
    $('#mqttBoardId').value = ESP.mqttBoardId;
  } else {
    $('#espHost').value = ESP.httpHost;
    $('#espPass').value = ESP.httpPass;
  }
}

async function loadConfigIntoUI() {
  try {
    const cfg = await ESP.getConfig();
    if (cfg) {
      $('#cfgBoardName').value = cfg.boardName || '';
      $('#cfgDeviceName').value = cfg.deviceName || '';
      $('#cfgRoomName').value = cfg.roomName || '';
      $('#cfgTimezone').value = cfg.timezone || 'UTC';
      $('#cfgMqttServer').value = cfg.mqttServer || '';
      $('#cfgMqttPort').value = cfg.mqttPort || 1883;
      $('#cfgMqttUser').value = cfg.mqttUser || '';
      $('#cfgWifiSSID').value = cfg.wifiSSID || '';
    }
  } catch (_) {}
}

async function saveConfig() {
  const config = {
    boardName: $('#cfgBoardName').value,
    deviceName: $('#cfgDeviceName').value,
    roomName: $('#cfgRoomName').value,
    timezone: $('#cfgTimezone').value,
  };

  const mqttServer = $('#cfgMqttServer').value;
  if (mqttServer) {
    config.mqttServer = mqttServer;
    config.mqttPort = parseInt($('#cfgMqttPort').value) || 1883;
    config.mqttUser = $('#cfgMqttUser').value;
  }

  const wifiSSID = $('#cfgWifiSSID').value;
  if (wifiSSID) {
    config.wifiSSID = wifiSSID;
    config.wifiPass = $('#cfgWifiPass').value;
  }

  try {
    await ESP.setConfig(config);
    toast('Config saved', 'ok');
    if (wifiSSID) {
      toast('Board restarting for Wi-Fi change...', 'ok');
    }
  } catch (e) { toast(e.message, 'bad'); }
}

async function restartBoard() {
  if (!confirm('Restart the ESP32 board?')) return;
  try {
    await ESP.restart();
    toast('Board restarting...', 'ok');
  } catch (e) { toast(e.message, 'bad'); }
}

function disconnect() {
  ESP.disconnect();
  if (state.poll) clearInterval(state.poll);
  state.info = null;
  state.rooms = [];
  state.switches = [];
  $('#connBadge').classList.remove('ok');
  $('#connBadge').textContent = 'offline';
  openModal('connModal');
  toast('Disconnected');
}

// ---- Wire Events ----
function wire() {
  // Close buttons
  $$('[data-close]').forEach((b) => b.addEventListener('click',
    () => closeModal(b.closest('.modal').id)));

  // Connection modal tabs
  bindTabs();

  // MQTT connect
  $('#btnMqttConnect').addEventListener('click', mqttConnectFlow);

  // HTTP connect
  $('#btnConnect').addEventListener('click', httpConnectFlow);
  $('#btnDiscover').addEventListener('click', discoverFlow);

  // Enter key on inputs
  ['#mqttBroker', '#mqttUser', '#mqttPass', '#mqttBoardId'].forEach(s => {
    $(s).addEventListener('keydown', e => { if (e.key === 'Enter') mqttConnectFlow(); });
  });
  ['#espHost', '#espPass'].forEach(s => {
    $(s).addEventListener('keydown', e => { if (e.key === 'Enter') httpConnectFlow(); });
  });

  // Board selector
  $('#boardSelect').addEventListener('change', (e) => {
    ESP.selectBoard(e.target.value);
    refreshAll();
  });

  // Top bar
  $('#btnRefresh').addEventListener('click', () => {
    if (ESP.mode === 'mqtt') {
      ESP.mqttRequestState(ESP.mqttBoardId);
      setTimeout(refreshAll, 500);
    } else {
      refreshAll();
    }
  });

  $('#btnSettings').addEventListener('click', () => {
    prefillConnInputs();
    loadConfigIntoUI();
    openModal('settingsModal');
  });

  // Alarm
  $('#btnSilence').addEventListener('click', silenceAlarm);

  // Room/Switch add buttons (from settings modal tabs)
  $('#btnAddRoom').addEventListener('click', () => {
    prefillConnInputs();
    openModal('settingsModal');
    const tabs = $$('.tabs')[1] ? $$('.tabs')[1].querySelectorAll('.tab') : $$('.tab');
    const panels = $$('.tab-panel');
    tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === 'rooms'));
    panels.forEach((p) => p.classList.toggle('active', p.dataset.panel === 'rooms'));
  });

  $('#btnCreateRoom').addEventListener('click', addRoom);
  $('#btnCreateSw').addEventListener('click', addSwitch);
  $('#btnResetPlan').addEventListener('click', refreshAll);

  // Settings actions
  $('#btnDisconnect').addEventListener('click', disconnect);
  $('#btnReconnect').addEventListener('click', () => {
    closeModal('settingsModal');
    showConnIfNeeded();
  });
  $('#btnSaveConfig').addEventListener('click', saveConfig);
  $('#btnRestartBoard').addEventListener('click', restartBoard);

  // Raw API
  $('#btnRawSend').addEventListener('click', async () => {
    const m = $('#rawMethod').value;
    const p = $('#rawPath').value || '/api/info';
    const b = $('#rawBody').value;
    const out = $('#rawOut');
    out.textContent = '…';
    try {
      const data = b ? await ESP.request(m, p, b) : await ESP.request(m, p);
      out.textContent = JSON.stringify(data, null, 2);
    } catch (e) { out.textContent = 'Error: ' + e.message; }
  });

  // MQTT real-time updates
  ESP.onStateUpdate((boardId, data) => {
    if (boardId === ESP.mqttBoardId && data) {
      state.rooms = data.rooms || [];
      state.switches = data.switches || [];
      renderFloorPlan();
      renderRoomList();
      renderSwitchList();

      $('#sUptime').textContent  = formatTime(data.uptime ?? 0);
      $('#sHeap').textContent    = ((data.heap || 0) / 1024).toFixed(0) + ' kB';
      $('#sRssi').textContent    = data.rssi || '—';
      $('#sRooms').textContent   = state.rooms.length;
      $('#sSwitches').textContent = state.switches.length;
      $('#alarmBanner').hidden   = !data.alarm;
      updateBoardSelector();
    }
  });
}

// ---- Boot ----
document.addEventListener('DOMContentLoaded', () => {
  wire();
  showConnIfNeeded();
  if (ESP.hasCreds()) {
    connectAndLoad().then(() => {
      refreshAll();
      startPolling();
    }).catch(e => {
      console.error('Initial connect failed:', e);
      openModal('connModal');
    });
  }
});
