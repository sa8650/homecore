/* =================================================================
 * api.js — REST client for the ESP32 firmware (GitHub Pages + corsproxy.io)
 * corsproxy.io allows *.github.io for free.
 * URL format: https://corsproxy.io/?url=ENCODED_TARGET
 * ================================================================= */

const API_KEY_HOST = 'smarthome.host';
const API_KEY_PASS = 'smarthome.pass';
const API_KEY_PROXY = 'smarthome.proxyIdx';

const PROXIES = [
  { name: 'corsproxy.io',
    build: (u) => 'https://corsproxy.io/?url=' + encodeURIComponent(u) },
  { name: 'allorigins.win',
    build: (u) => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u) },
  { name: 'thingproxy',
    build: (u) => 'https://thingproxy.freeboard.io/fetch/' + u },
  { name: 'codetabs',
    build: (u) => 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u) },
];

const ESP = {
  host: '',
  pass: '',
  proxyIdx: 0,

  load() {
    this.host = localStorage.getItem(API_KEY_HOST) || '';
    this.pass = localStorage.getItem(API_KEY_PASS) || '';
    this.proxyIdx = parseInt(localStorage.getItem(API_KEY_PROXY) || '0', 10);
  },
  save(host, pass, opts = {}) {
    this.host = host.trim().replace(/\/+$/, '');
    this.pass = pass;
    if (typeof opts.proxyIdx === 'number') this.proxyIdx = opts.proxyIdx;
    localStorage.setItem(API_KEY_HOST, this.host);
    localStorage.setItem(API_KEY_PASS, this.pass);
    localStorage.setItem(API_KEY_PROXY, String(this.proxyIdx));
  },
  hasCreds() { return !!this.host && !!this.pass; },

  buildUrl(p, idx = this.proxyIdx) {
    if (!this.host) throw new Error('No ESP32 host configured');
    const target = this.host + (p.startsWith('/') ? p : '/' + p);
    return PROXIES[idx].build(target);
  },

  async request(method, path, body) {
    const opts = {
      method,
      headers: { 'X-Auth-Password': this.pass },
    };
    if (body && typeof body === 'object' && !(body instanceof FormData)) {
      opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      opts.body = new URLSearchParams(body).toString();
    } else if (body) {
      opts.body = body;
    }

    try {
      const res = await fetch(this.buildUrl(path), opts);
      return await this._parse(res);
    } catch (e1) {
      for (let i = 0; i < PROXIES.length; i++) {
        if (i === this.proxyIdx) continue;
        try {
          const res = await fetch(this.buildUrl(path, i), opts);
          const data = await this._parse(res);
          this.proxyIdx = i;
          localStorage.setItem(API_KEY_PROXY, String(i));
          console.log('[ESP] Switched to proxy: ' + PROXIES[i].name);
          return data;
        } catch (e2) { /* try next */ }
      }
      throw new Error('All proxies failed. ESP32 unreachable from browser.');
    }
  },

  async _parse(res) {
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
  setWifi(mode, ssid, password, newAdmin = null) {
    const body = { mode, ssid, wpass: password };
    if (newAdmin) body.admin = newAdmin;
    return this.post('/api/wifi', body);
  },
  silenceAlarm() { return this.post('/api/silenceAlarm'); },

  async findWorkingProxy(timeoutMs = 5000) {
    if (!this.host) throw new Error('No ESP32 host configured');
    const target = this.host + '/api/info';
    for (let i = 0; i < PROXIES.length; i++) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeoutMs);
        const res = await fetch(PROXIES[i].build(target), {
          signal: ctrl.signal,
          cache: 'no-store',
          headers: { 'X-Auth-Password': this.pass }
        });
        clearTimeout(t);
        if (res.ok) {
          const j = await res.json();
          if (j && (j.name === 'SmartHome' || j.chip)) {
            this.proxyIdx = i;
            localStorage.setItem(API_KEY_PROXY, String(i));
            return { proxy: PROXIES[i].name, info: j };
          }
        }
      } catch (_) { /* try next */ }
    }
    return null;
  },

  async discover(timeoutMs = 1500) {
    const candidates = [];
    const subnets = ['192.168.0', '192.168.1', '192.168.4', '10.0.0'];
    for (const sn of subnets) {
      for (let i = 1; i <= 254; i++) candidates.push(`${sn}.${i}`);
    }
    const oldIdx = this.proxyIdx;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs * 10);
    try {
      for (const ip of candidates) {
        if (ctrl.signal.aborted) break;
        const testHost = `http://${ip}`;
        for (let pi = 0; pi < PROXIES.length; pi++) {
          try {
            const url = PROXIES[pi].build(testHost + '/api/info');
            const res = await fetch(url, {
              signal: ctrl.signal,
              cache: 'no-store',
              headers: { 'X-Auth-Password': this.pass }
            });
            if (res.ok) {
              const j = await res.json();
              if (j && (j.name === 'SmartHome' || j.chip)) {
                this.proxyIdx = pi;
                localStorage.setItem(API_KEY_PROXY, String(pi));
                return { host: testHost, info: j, proxy: PROXIES[pi].name };
              }
            }
          } catch (_) { /* try next proxy */ }
        }
      }
    } finally {
      clearTimeout(t);
      this.proxyIdx = oldIdx;
    }
    return null;
  },

  getProxyList() {
    return PROXIES.map((p, i) => ({ name: p.name, idx: i, current: i === this.proxyIdx }));
  },
};

ESP.load();
