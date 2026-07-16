/* =================================================================
 * api.js — REST client for the ESP32 firmware.
 *
 * The webapp is hosted on HTTPS (GitHub Pages / Netlify). The ESP32
 * serves its API over HTTP. Browsers block "mixed content" by default,
 * so direct calls from an HTTPS page to an HTTP endpoint fail.
 *
 * To work around this, we route requests through a CORS proxy that
 * sits on HTTPS. The proxy fetches the HTTP content and returns it
 * with proper CORS headers.
 * ================================================================= */

const API_KEY_HOST = 'smarthome.host';
const API_KEY_PASS = 'smarthome.pass';

const CORS_PROXY = 'https://corsproxy.io/?';
const CORS_PROXY_FALLBACK = 'https://api.allorigins.win/raw?url=';

const ESP = {
  host: '',
  pass: '',
  useProxy: false,
  useProxyFallback: false,

  load() {
    this.host = localStorage.getItem(API_KEY_HOST) || '';
    this.pass = localStorage.getItem(API_KEY_PASS) || '';
    this.useProxy = localStorage.getItem('smarthome.proxy') === '1';
  },
  save(host, pass, opts = {}) {
    this.host = host.trim().replace(/\/+$/, '');
    this.pass = pass;
    this.useProxy = !!opts.useProxy;
    localStorage.setItem(API_KEY_HOST, this.host);
    localStorage.setItem(API_KEY_PASS, this.pass);
    localStorage.setItem('smarthome.proxy', this.useProxy ? '1' : '0');
  },
  hasCreds() {
    return !!this.host && !!this.pass;
  },

  url(p) {
    if (!this.host) throw new Error('No ESP32 host configured');
    const target = this.host + (p.startsWith('/') ? p : '/' + p);
    if (this.useProxy) {
      return CORS_PROXY + encodeURIComponent(target);
    }
    return target;
  },

  urlFallback(p) {
    if (!this.host) throw new Error('No ESP32 host configured');
    const target = this.host + (p.startsWith('/') ? p : '/' + p);
    return CORS_PROXY_FALLBACK + encodeURIComponent(target);
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

    let res;
    try {
      res = await fetch(this.url(path), opts);
    } catch (networkErr) {
      if (!this.useProxy) {
        console.warn('Direct fetch failed, switching to CORS proxy:', networkErr);
        this.useProxy = true;
        localStorage.setItem('smarthome.proxy', '1');
        return this.request(method, path, body);
      }
      if (!this.useProxyFallback) {
        try {
          res = await fetch(this.urlFallback(path), opts);
          this.useProxyFallback = true;
        } catch (e) {
          throw new Error('Network error (both direct and proxy failed)');
        }
      } else {
        throw networkErr;
      }
    }

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

  async discover(timeoutMs = 1500) {
    const candidates = [];
    const subnets = ['192.168.0', '192.168.1', '192.168.4', '10.0.0'];
    for (const sn of subnets) {
      for (let i = 1; i <= 254; i++) candidates.push(`${sn}.${i}`);
    }
    const oldProxy = this.useProxy;
    this.useProxy = true;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs * 12);
    try {
      for (const ip of candidates) {
        if (ctrl.signal.aborted) break;
        const testHost = `http://${ip}`;
        const prevHost = this.host;
        this.host = testHost;
        try {
          const url = this.url('/api/info');
          const res = await fetch(url, {
            signal: ctrl.signal,
            cache: 'no-store',
            headers: { 'X-Auth-Password': this.pass }
          });
          if (res.ok) {
            const j = await res.json();
            if (j && (j.name === 'SmartHome' || j.chip)) {
              this.host = prevHost;
              return { host: testHost, info: j };
            }
          }
        } catch (_) { /* ignore */ }
        this.host = prevHost;
      }
    } finally {
      clearTimeout(t);
      this.useProxy = oldProxy;
    }
    return null;
  },
};

ESP.load();
