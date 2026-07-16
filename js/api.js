/* api.js — REST client via corsproxy.io (free for github.io) */
const ESP_HOST_KEY = 'smarthome.host';
const ESP_PASS_KEY = 'smarthome.pass';

const ESP = {
  host: '', pass: '',
  proxyUrl(u) { return 'https://corsproxy.io/?url=' + encodeURIComponent(u); },
  load() {
    this.host = (localStorage.getItem(ESP_HOST_KEY) || '').trim().replace(/\/+$/, '');
    this.pass = localStorage.getItem(ESP_PASS_KEY) || '';
  },
  save(host, pass) {
    this.host = (host || '').trim().replace(/\/+$/, '');
    this.pass = pass || '';
    localStorage.setItem(ESP_HOST_KEY, this.host);
    localStorage.setItem(ESP_PASS_KEY, this.pass);
  },
  hasCreds() { return !!this.host && !!this.pass; },
  url(p) {
    if (!this.host) throw new Error('No ESP32 host configured');
    return this.proxyUrl(this.host + (p.startsWith('/') ? p : '/' + p));
  },
  async request(method, path, body) {
    const opts = { method, headers: { 'X-Auth-Password': this.pass } };
    if (body && typeof body === 'object' && !(body instanceof FormData)) {
      opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      opts.body = new URLSearchParams(body).toString();
    } else if (body) opts.body = body;
    const res = await fetch(this.url(path), opts);
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) {}
    if (!res.ok) {
      const msg = (json && json.error) || `HTTP ${res.status}: ${text.slice(0, 100)}`;
      throw new Error(msg);
    }
    return json ?? text;
  },
  get(p) { return this.request('GET', p); },
  post(p, body) { return this.request('POST', p, body || {}); },
  info() { return this.get('/api/info'); },
  login() { return this.post('/api/login', { password: this.pass }); },
  status() { return this.get('/api/status'); },
  pins() { return this.get('/api/pins'); },
  switches() { return this.get('/api/switches'); },
  rooms() { return this.get('/api/rooms'); },
  wifi() { return this.get('/api/wifi'); },
  silenceAlarm() { return this.post('/api/silenceAlarm'); },
  setSwitch(i, on) { return this.post('/api/switch', { index: i, state: on ? 1 : 0 }); },
  addSwitch(name, pin) { return this.post('/api/switchManage', { action: 'add', name, pin }); },
  deleteSwitch(i) { return this.post('/api/switchManage', { action: 'delete', index: i }); },
  assignSwitch(swIdx, roomId) {
    return this.post('/api/switchManage', { action: 'assign', switchIdx: swIdx, roomId });
  },
  addRoom(name, type) { return this.post('/api/rooms', { action: 'add', name, type }); },
  deleteRoom(i) { return this.post('/api/rooms', { action: 'delete', index: i }); },
  updateRoomPos(i, x, y, w, h) {
    return this.post('/api/rooms', { action: 'updatePosition', index: i, x, y, w, h });
  },
  setWifi(mode, ssid, password, newAdmin) {
    const body = { mode, ssid, wpass: password };
    if (newAdmin) body.admin = newAdmin;
    return this.post('/api/wifi', body);
  },
  async discover() {
    const subnets = ['192.168.0', '192.168.1', '192.168.4', '10.0.0'];
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 30000);
    try {
      for (const sn of subnets) {
        for (let i = 1; i <= 254; i++) {
          if (ctrl.signal.aborted) return null;
          const testHost = `http://${sn}.${i}`;
          try {
            const res = await fetch(this.proxyUrl(testHost + '/api/info'), {
              signal: ctrl.signal, cache: 'no-store',
              headers: { 'X-Auth-Password': this.pass }
            });
            if (res.ok) {
              const j = await res.json();
              if (j && (j.name === 'SmartHome' || j.chip)) return { host: testHost, info: j };
            }
          } catch (_) {}
        }
      }
    } finally { clearTimeout(t); }
    return null;
  },
};
ESP.load();
