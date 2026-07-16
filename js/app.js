/* =================================================================
 * app.js — Smart Home webapp (GitHub Pages)
 *
 * Renders the 2D floor plan, room list, and switch controls. Pulls
 * data from the ESP32 via api.js. Drags / resizes rooms and writes
 * positions back to the device.
 * ================================================================= */

const ROOM_ICONS = {
  bedroom: '🛏️', kitchen: '🍳', bathroom: '🚿', garage: '🚗',
  balcony: '🌿', dining: '🍽️', living: '🛋️', custom: '🏠',
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  info: null,
  rooms: [],
  switches: [],
  pins: [],
  poll: null,
  pollMs: 5000,
};

// ---------- toast ----------
const toast = (msg, kind = '') => {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), 2400);
};

// ---------- modal helpers ----------
const openModal = (id) => {
  const m = document.getElementById(id);
  if (m) m.dataset.open = 'true';
};
const closeModal = (id) => {
  const m = document.getElementById(id);
  if (m) m.dataset.open = 'false';
};

// ---------- connection flow ----------
function showConnIfNeeded() {
  if (ESP.hasCreds()) {
    testConnection().catch(() => openModal('connModal'));
  } else {
    openModal('connModal');
  }
}

async function testConnection() {
  if (!ESP.hasCreds()) throw new Error('No credentials');
  const info = await ESP.info();
  state.info = info;
  $('#connBadge').textContent = `${info.mode} · ${info.ip || ''}`;
  $('#connBadge').classList.add('ok');
  return info;
}

async function connectFlow() {
  const host = $('#espHost').value.trim();
  const pass = $('#espPass').value;
  if (!host || !pass) { toast('Host and password required', 'bad'); return; }
  ESP.save(host, pass);
  const hint = $('#connHint');
  hint.textContent = 'Connecting…';
  try {
    await testConnection();
    closeModal('connModal');
    toast('Connected', 'ok');
    startPolling();
    refreshAll();
  } catch (e) {
    hint.textContent = 'Failed: ' + e.message;
  }
}

async function discoverFlow() {
  const hint = $('#connHint');
  hint.textContent = 'Scanning local subnets… (this takes ~10s)';
  try {
    const res = await ESP.discover();
    if (res) {
      $('#espHost').value = res.host;
      hint.textContent = `Found ${res.info.name} v${res.info.version} at ${res.host}`;
    } else {
      hint.textContent = 'No device responded. Make sure you are on the same Wi-Fi.';
    }
  } catch (e) {
    hint.textContent = 'Scan failed: ' + e.message;
  }
}

// ---------- tabs ----------
function bindTabs() {
  $$('.tab').forEach((t) => {
    t.addEventListener('click', () => {
      const name = t.dataset.tab;
      $$('.tab').forEach((x) => x.classList.toggle('active', x === t));
      $$('.tab-panel').forEach((p) =>
        p.classList.toggle('active', p.dataset.panel === name)
      );
    });
  });
}

// ---------- data load ----------
async function refreshAll() {
  try {
    const [info, status, rooms, switches, pins] = await Promise.all([
      ESP.info(),
      ESP.status().catch(() => null),
      ESP.rooms().catch(() => ({ rooms: [] })),
      ESP.switches().catch(() => ({ switches: [] })),
      ESP.pins().catch(() => ({ pins: [] })),
    ]);
    state.info = info;
    state.rooms = (rooms && rooms.rooms) || [];
    state.switches = (switches && switches.switches) || [];
    state.pins = (pins && pins.pins) || [];

    // stats
    $('#sUptime').textContent = formatTime(info.uptime ?? 0);
    $('#sHeap').textContent = ((info.heap || 0) / 1024).toFixed(0) + ' kB';
    $('#sRssi').textContent = (status && status.rssi) || '—';
    $('#sMode').textContent = info.mode || '—';
    $('#sRooms').textContent = state.rooms.length;
    $('#sSwitches').textContent = state.switches.length;

    // alarm
    $('#alarmBanner').hidden = !(status && status.alarm);

    renderFloorPlan();
    renderRoomList();
    renderSwitchList();
    renderPinOptions();
  } catch (e) {
    $('#connBadge').classList.remove('ok');
    $('#connBadge').textContent = 'offline';
    if (ESP.hasCreds()) toast('Connection lost: ' + e.message, 'bad');
  }
}

function startPolling() {
  if (state.poll) clearInterval(state.poll);
  state.poll = setInterval(refreshAll, state.pollMs);
}

function formatTime(s) {
  s = Number(s) || 0;
  const h = Math.floor(s / 3600),
        m = Math.floor((s % 3600) / 60),
        ss = s % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${ss}s`;
  return `${ss}s`;
}

// ---------- floor plan rendering ----------
function renderFloorPlan() {
  const fp = $('#floorplan');
  fp.innerHTML = '';
  if (state.rooms.length === 0) {
    fp.innerHTML = '<div class="empty">No rooms yet. Click <b>+ Room</b> to begin.</div>';
    return;
  }
  for (let i = 0; i < state.rooms.length; i++) {
    fp.appendChild(buildRoomEl(state.rooms[i], i));
  }
}

function buildRoomEl(r, index) {
  const el = document.createElement('div');
  el.className = 'room';
  el.dataset.index = index;
  applyPosition(el, r);

  const icon = ROOM_ICONS[r.type] || '🏠';
  const head = document.createElement('div');
  head.className = 'room-head';
  head.innerHTML = `<span><span class="icon">${icon}</span> ${escapeHtml(r.name)}</span>
                    <span class="menu" title="Delete">✕</span>`;
  head.querySelector('.menu').addEventListener('click', () => deleteRoom(index));
  el.appendChild(head);

  const body = document.createElement('div');
  body.className = 'room-body';
  const swInRoom = state.switches
    .map((s, i) => ({ ...s, _i: i }))
    .filter((s) => s.roomId === r.id);
  if (swInRoom.length === 0) {
    const e = document.createElement('div');
    e.className = 'muted';
    e.style.fontSize = '11px';
    e.textContent = 'No switches assigned';
    body.appendChild(e);
  } else {
    for (const s of swInRoom) body.appendChild(buildSwitchEl(s));
  }
  el.appendChild(body);

  const rz = document.createElement('div');
  rz.className = 'resizer';
  el.appendChild(rz);

  // dragging the head
  attachDrag(el, head, index, 'move');
  // resizing
  attachDrag(el, rz, index, 'resize');
  return el;
}

function applyPosition(el, r) {
  el.style.left = r.x + '%';
  el.style.top = r.y + '%';
  el.style.width = r.width + '%';
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

// ---------- dragging ----------
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
    window.addEventListener(mode === 'move' ? 'mousemove' : 'touchmove', onMove, { passive: false });
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

// ---------- settings UI ----------
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
        <button class="btn" data-move="-1" data-i="${i}">←</button>
        <button class="btn" data-move="1"  data-i="${i}">→</button>
        <button class="btn danger" data-del="${i}">Delete</button>
      </span>`;
    li.querySelector('[data-del]').addEventListener('click', () => deleteRoom(i));
    li.querySelectorAll('[data-move]').forEach((b) =>
      b.addEventListener('click', () => reassignRoom(i, +b.dataset.move)));
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

// ---------- actions ----------
async function addRoom() {
  const name = $('#newRoomName').value.trim();
  const type = $('#newRoomType').value;
  if (!name) { toast('Name required', 'bad'); return; }
  try {
    await ESP.addRoom(name, type);
    $('#newRoomName').value = '';
    toast('Room added', 'ok');
    refreshAll();
  } catch (e) { toast(e.message, 'bad'); }
}

async function deleteRoom(i) {
  if (!confirm('Delete this room?')) return;
  try {
    await ESP.deleteRoom(i);
    toast('Room deleted', 'ok');
    refreshAll();
  } catch (e) { toast(e.message, 'bad'); }
}

async function reassignRoom(i, dir) {
  // Cycle the room to next/previous switch in the unassigned pool.
  const r = state.rooms[i];
  const assigned = new Set(state.switches
    .map((s, idx) => (s.roomId === r.id ? idx : -1))
    .filter((x) => x >= 0));
  const pool = state.switches
    .map((s, idx) => ({ s, idx }))
    .filter((x) => x.s.roomId !== r.id);
  if (pool.length === 0) { toast('No unassigned switches', 'bad'); return; }
  const pick = pool[(dir > 0 ? assigned.size : 0) % pool.length].idx;
  try {
    await ESP.assignSwitch(pick, r.id);
    refreshAll();
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
    refreshAll();
  } catch (e) { toast(e.message, 'bad'); }
}

async function deleteSwitch(i) {
  if (!confirm('Delete this switch?')) return;
  try {
    await ESP.deleteSwitch(i);
    refreshAll();
  } catch (e) { toast(e.message, 'bad'); }
}

async function silenceAlarm() {
  try {
    await ESP.silenceAlarm();
    $('#alarmBanner').hidden = true;
    toast('Alarm silenced', 'ok');
  } catch (e) { toast(e.message, 'bad'); }
}

async function saveConn() {
  const host = $('#setHost').value.trim();
  const pass = $('#setPass').value;
  if (!host || !pass) { toast('Both fields required', 'bad'); return; }
  ESP.save(host, pass);
  try {
    await testConnection();
    toast('Connected', 'ok');
    refreshAll();
    startPolling();
  } catch (e) { toast(e.message, 'bad'); }
}

async function testConn() {
  const host = $('#setHost').value.trim() || ESP.host;
  const pass = $('#setPass').value || ESP.pass;
  if (!host || !pass) { toast('Both fields required', 'bad'); return; }
  const old = { host: ESP.host, pass: ESP.pass };
  ESP.host = host.replace(/\/+$/, '');
  ESP.pass = pass;
  try {
    const info = await ESP.info();
    $('#testResult').textContent = `OK — ${info.name} v${info.version} (${info.chip})`;
    toast('Connection works', 'ok');
  } catch (e) {
    ESP.host = old.host; ESP.pass = old.pass;
    $('#testResult').textContent = 'Failed: ' + e.message;
    toast(e.message, 'bad');
  }
}

async function saveWifi() {
  const mode = $('#wifiMode').value;
  const ssid = $('#wifiSSID').value;
  const pass = $('#wifiPass').value;
  if (mode === 'sta' && !ssid) { toast('SSID required', 'bad'); return; }
  if (!confirm('This will restart the ESP32. Continue?')) return;
  try {
    await ESP.setWifi(mode, ssid, pass);
    toast('Wi-Fi saved. Reconnecting in 10s…', 'ok');
    setTimeout(() => location.reload(), 10000);
  } catch (e) { toast(e.message, 'bad'); }
}

async function loadWifiIntoUi() {
  try {
    const w = await ESP.wifiConfig();
    $('#wifiMode').value = w.mode || 'sta';
    $('#wifiStaBox').style.display = w.mode === 'sta' ? '' : 'none';
    $('#wifiSSID').value = w.ssid || '';
  } catch (_) { /* ignore */ }
}

function prefillConnInputs() {
  $('#espHost').value = ESP.host;
  $('#espPass').value = ESP.pass;
  $('#setHost').value = ESP.host;
  $('#setPass').value = ESP.pass;
}

// ---------- wiring ----------
function wire() {
  // modal close buttons
  $$('[data-close]').forEach((b) => b.addEventListener('click',
    () => closeModal(b.closest('.modal').id)));

  $('#btnConnect').addEventListener('click', connectFlow);
  $('#btnDiscover').addEventListener('click', discoverFlow);
  $('#btnSettings').addEventListener('click', () => {
    prefillConnInputs();
    loadWifiIntoUi();
    openModal('settingsModal');
  });
  $('#btnRefresh').addEventListener('click', refreshAll);
  $('#btnSilence').addEventListener('click', silenceAlarm);
  $('#btnAddRoom').addEventListener('click', () => {
    prefillConnInputs();
    openModal('settingsModal');
    // jump to rooms tab
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === 'rooms'));
    $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === 'rooms'));
  });
  $('#btnResetPlan').addEventListener('click', () => {
    if (!confirm('Reset all rooms to default grid?')) return;
    // Just trigger a refresh — the firmware auto-lays-out new rooms.
    refreshAll();
  });
  $('#btnCreateRoom').addEventListener('click', addRoom);
  $('#btnCreateSw').addEventListener('click', addSwitch);
  $('#btnSaveConn').addEventListener('click', saveConn);
  $('#btnTestConn').addEventListener('click', testConn);
  $('#btnSaveWifi').addEventListener('click', saveWifi);
  $('#wifiMode').addEventListener('change', (e) => {
    $('#wifiStaBox').style.display = e.target.value === 'sta' ? '' : 'none';
  });

  // raw API
  $('#btnRawSend').addEventListener('click', async () => {
    const m = $('#rawMethod').value;
    const p = $('#rawPath').value || '/api/info';
    const b = $('#rawBody').value;
    const out = $('#rawOut');
    out.textContent = '…';
    try {
      const data = b
        ? await ESP.request(m, p, b)
        : await ESP.request(m, p);
      out.textContent = JSON.stringify(data, null, 2);
    } catch (e) {
      out.textContent = 'Error: ' + e.message;
    }
  });

  bindTabs();

  // allow Enter on connect modal
  ['#espHost', '#espPass'].forEach((s) => {
    $(s).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') connectFlow();
    });
  });
}

document.addEventListener('DOMContentLoaded', () => {
  wire();
  showConnIfNeeded();
  if (ESP.hasCreds()) {
    refreshAll().then(startPolling);
  }
});
