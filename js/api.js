/* =================================================================
 * api.js — thin REST client for the ESP32 firmware.
 *
 * The webapp saves host + password in localStorage and reuses them
 * across reloads. CORS is allowed by the ESP32 (it sends
 * Access-Control-Allow-Origin: * on every response).
 * ================================================================= */

const API_KEY_HOST = 'smarthome.host';
const API_KEY_PASS = 'smarthome.pass';

const ESP = {
  host: '',
  pass: '',

  load() {
    this.host = localStorage.getItem(API_KEY_HOST) || '';
    this.pass = localStorage.getItem(API_KEY_PASS) || '';
  },
  save(host, pass) {
    this.host = host.trim().replace(/\/+$/, '');
    this.pass = pass;
    localStorage.setItem(API_KEY_HOST, this.host);
    localStorage.setItem(API_KEY_PASS, this.pass);
  },
  hasCreds() {
    return !!this.host && !!this.pass;
  },

  url(p) {
    if (!this.host) throw new Error('No ESP32 host configured');
    return this.host + (p.startsWith('/') ? p : '/' + p);
  },

  async request(method, path, body) {
    const opts = {
      method,
      headers: { 'X-Auth-Password': this.pass },
    };
    if (body && typeof body === 'object' && !(body instanceof FormData)) {
      // urlencoded form (matches what the firmware expects)
      opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      opts.body = new URLSearchParams(body).toString();
    } else if (body) {
      opts.body = body;
    }
    const res = await fetch(this.url(path), opts);
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { /* not json */ }
    if (!res.ok) {
      const msg = (json && json.error) || `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return json ?? text;
  },

  get(path)        { return this.request('GET', path); },
  post(path, body) { return this.request('POST', path, body || {}); },

  // ---- typed endpoints ------------------------------------------------
  info()        { return this.get('/api/info'); },
  login()       { return this.post('/api/login', { password: this.pass }); },
  status()      { return this.get('/api/status'); },
  pins()        { return this.get('/api/pins'); },
  switches()    { return this.get('/api/switches'); },
  setSwitch(i, on) {
    return this.post('/api/switch', { index: i, state: on ? 1 : 0 });
  },
  addSwitch(name, pin) {
    return this.post('/api/switchManage', { action: 'add', name, pin });
  },
  deleteSwitch(i) {
    return this.post('/api/switchManage', { action: 'delete', index: i });
  },
  assignSwitch(swIdx, roomId) {
    return this.post('/api/switchManage', {
      action: 'assign', switchIdx: swIdx, roomId
    });
  },
  rooms()       { return this.get('/api/rooms'); },
  addRoom(name, type) {
    return this.post('/api/rooms', { action: 'add', name, type });
  },
  deleteRoom(i) {
    return this.post('/api/rooms', { action: 'delete', index: i });
  },
  updateRoomPos(i, x, y, w, h) {
    return this.post('/api/rooms', {
      action: 'updatePosition', index: i, x, y, w, h
    });
  },
  wifiConfig() { return this.get('/api/wifi'); },
  setWifi(mode, ssid, password) {
    return this.post('/api/wifi', { mode, ssid, password });
  },
  silenceAlarm() { return this.post('/api/silenceAlarm'); },

  /**
   * Best-effort scan of common router subnets to find the ESP32.
   * Probes /api/info on 192.168.0.* and 192.168.1.*, stops at the
   * first match that responds with the right firmware.
   */
  async discover(timeoutMs = 1500) {
    const candidates = [];
    const subnets = ['192.168.0', '192.168.1', '192.168.4'];
    for (const sn of subnets) {
      for (let i = 1; i <= 254; i++) candidates.push(`${sn}.${i}`);
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs * 8);
    try {
      for (const ip of candidates) {
        if (ctrl.signal.aborted) break;
        try {
          const url = `http://${ip}/api/info`;
          const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
          if (!res.ok) continue;
          const j = await res.json();
          if (j && (j.name === 'SmartHome' || j.chip)) {
            return { host: `http://${ip}`, info: j };
          }
        } catch (_) { /* ignore */ }
      }
    } finally { clearTimeout(t); }
    return null;
  },
};

ESP.load();
