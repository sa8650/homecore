/* =================================================================
 * api.js — Dual-mode client: MQTT (remote) + HTTP (local)
 * The webapp talks to ESP32 boards via MQTT broker or direct HTTP.
 * ================================================================= */

const STORAGE_KEYS = {
  mode: 'smarthome.mode',         // 'mqtt' or 'http'
  mqttBroker: 'smarthome.mqttBroker',
  mqttUser: 'smarthome.mqttUser',
  mqttPass: 'smarthome.mqttPass',
  mqttBoardId: 'smarthome.mqttBoardId',
  httpHost: 'smarthome.httpHost',
  httpPass: 'smarthome.httpPass',
};

const ESP = {
  mode: 'mqtt',        // 'mqtt' or 'http'
  mqttClient: null,
  mqttBroker: '',
  mqttUser: '',
  mqttPass: '',
  mqttBoardId: '',     // Currently selected board ID
  boards: {},          // { boardId: { state, config, lastSeen } }
  stateCallbacks: [],  // Called when state updates

  httpHost: '',
  httpPass: '',

  // ---- Initialization ----
  load() {
    this.mode = localStorage.getItem(STORAGE_KEYS.mode) || 'mqtt';
    this.mqttBroker = localStorage.getItem(STORAGE_KEYS.mqttBroker) || '';
    this.mqttUser = localStorage.getItem(STORAGE_KEYS.mqttUser) || '';
    this.mqttPass = localStorage.getItem(STORAGE_KEYS.mqttPass) || '';
    this.mqttBoardId = localStorage.getItem(STORAGE_KEYS.mqttBoardId) || '';
    this.httpHost = localStorage.getItem(STORAGE_KEYS.httpHost) || '';
    this.httpPass = localStorage.getItem(STORAGE_KEYS.httpPass) || '';
  },

  save(mode, opts) {
    this.mode = mode;
    localStorage.setItem(STORAGE_KEYS.mode, mode);

    if (mode === 'mqtt') {
      this.mqttBroker = opts.broker || '';
      this.mqttUser = opts.user || '';
      this.mqttPass = opts.pass || '';
      this.mqttBoardId = opts.boardId || '';
      localStorage.setItem(STORAGE_KEYS.mqttBroker, this.mqttBroker);
      localStorage.setItem(STORAGE_KEYS.mqttUser, this.mqttUser);
      localStorage.setItem(STORAGE_KEYS.mqttPass, this.mqttPass);
      localStorage.setItem(STORAGE_KEYS.mqttBoardId, this.mqttBoardId);
    } else {
      this.httpHost = opts.host || '';
      this.httpPass = opts.pass || '';
      localStorage.setItem(STORAGE_KEYS.httpHost, this.httpHost);
      localStorage.setItem(STORAGE_KEYS.httpPass, this.httpPass);
    }
  },

  hasCreds() {
    if (this.mode === 'mqtt') return !!this.mqttBroker;
    return !!this.httpHost && !!this.httpPass;
  },

  // ---- MQTT Connection ----
  async connectMqtt(broker, user, pass, boardId) {
    return new Promise((resolve, reject) => {
      if (this.mqttClient) {
        this.mqttClient.end(true);
        this.mqttClient = null;
      }

      this.boards = {};

      const opts = {
        clientId: 'SmartHomeWeb_' + Math.random().toString(16).slice(2, 8),
        clean: true,
        connectTimeout: 10000,
        reconnectPeriod: 5000,
      };
      if (user) { opts.username = user; opts.password = pass; }

      try {
        this.mqttClient = mqtt.connect(broker, opts);
      } catch (e) {
        reject(new Error('Invalid broker URL: ' + e.message));
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error('Connection timeout'));
        this.mqttClient.end(true);
      }, 12000);

      this.mqttClient.on('connect', () => {
        clearTimeout(timeout);
        console.log('MQTT connected');

        // Subscribe to all board state/status/config topics
        this.mqttClient.subscribe('smarthome/+/state', { qos: 1 });
        this.mqttClient.subscribe('smarthome/+/status', { qos: 1 });
        this.mqttClient.subscribe('smarthome/+/config/response', { qos: 1 });

        // Request config from specific board or all
        if (boardId) {
          this.mqttClient.publish('smarthome/' + boardId + '/config/get', '{"cmd":"getConfig"}');
          this.mqttClient.publish('smarthome/' + boardId + '/command', '{"cmd":"getState"}');
        } else {
          // Request state from all boards
          this.mqttClient.publish('smarthome/+/command', '{"cmd":"getState"}');
        }

        resolve();
      });

      this.mqttClient.on('message', (topic, payload) => {
        this.handleMqttMessage(topic, payload);
      });

      this.mqttClient.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      this.mqttClient.on('close', () => {
        console.log('MQTT disconnected');
      });

      this.mqttClient.on('reconnect', () => {
        console.log('MQTT reconnecting...');
      });
    });
  },

  handleMqttMessage(topic, payload) {
    const parts = topic.split('/');
    if (parts.length < 3 || parts[0] !== 'smarthome') return;

    const boardId = parts[1];
    const suffix = parts.slice(2).join('/');

    let data;
    try {
      data = JSON.parse(payload.toString());
    } catch (e) {
      console.warn('Invalid JSON on', topic);
      return;
    }

    // Ensure board exists in registry
    if (!this.boards[boardId]) {
      this.boards[boardId] = { state: null, config: null, lastSeen: 0 };
    }
    this.boards[boardId].lastSeen = Date.now();

    if (suffix === 'state') {
      this.boards[boardId].state = data;
      // Auto-select first discovered board if none selected
      if (!this.mqttBoardId) {
        this.mqttBoardId = boardId;
        localStorage.setItem(STORAGE_KEYS.mqttBoardId, boardId);
      }
      // Notify listeners
      this.stateCallbacks.forEach(cb => cb(boardId, data));
    }
    else if (suffix === 'status') {
      this.boards[boardId].status = data.status;
      this.stateCallbacks.forEach(cb => cb(boardId, this.boards[boardId].state));
    }
    else if (suffix === 'config/response') {
      this.boards[boardId].config = data;
      this.stateCallbacks.forEach(cb => cb(boardId, this.boards[boardId].state));
    }
  },

  onStateUpdate(callback) {
    this.stateCallbacks.push(callback);
  },

  getActiveBoard() {
    if (this.mode === 'http') {
      return { boardId: 'local', state: null, config: null };
    }
    return this.boards[this.mqttBoardId] || null;
  },

  getAllBoards() {
    return Object.keys(this.boards).map(id => ({
      boardId: id,
      ...this.boards[id]
    }));
  },

  selectBoard(boardId) {
    this.mqttBoardId = boardId;
    localStorage.setItem(STORAGE_KEYS.mqttBoardId, boardId);
  },

  // ---- MQTT Publish Commands ----
  mqttPublish(topic, payload) {
    if (!this.mqttClient || !this.mqttClient.connected) {
      throw new Error('MQTT not connected');
    }
    this.mqttClient.publish(topic, JSON.stringify(payload));
  },

  mqttCommand(boardId, cmd) {
    this.mqttPublish('smarthome/' + boardId + '/command', cmd);
  },

  mqttSetConfig(boardId, config) {
    this.mqttPublish('smarthome/' + boardId + '/config/set', { cmd: 'setConfig', ...config });
  },

  mqttRequestConfig(boardId) {
    this.mqttPublish('smarthome/' + boardId + '/config/get', { cmd: 'getConfig' });
  },

  mqttRequestState(boardId) {
    this.mqttPublish('smarthome/' + boardId + '/command', { cmd: 'getState' });
  },

  // ---- HTTP Connection ----
  async httpRequest(method, path, body) {
    const opts = {
      method,
      headers: { 'X-Auth-Password': this.httpPass },
    };
    if (body && typeof body === 'object' && !(body instanceof FormData)) {
      opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      opts.body = new URLSearchParams(body).toString();
    } else if (body) {
      opts.body = body;
    }
    const res = await fetch(this.httpHost + path, opts);
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) {}
    if (!res.ok) {
      const msg = (json && json.error) || `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return json ?? text;
  },

  async httpGet(path) { return this.httpRequest('GET', path); },
  async httpPost(path, body) { return this.httpRequest('POST', path, body || {}); },

  // ---- Unified API (works for both MQTT and HTTP) ----
  async info() {
    if (this.mode === 'mqtt') {
      const board = this.getActiveBoard();
      if (board && board.state) {
        return {
          boardId: board.state.boardId,
          name: board.state.boardName,
          deviceName: board.state.deviceName,
          version: board.state.version,
          heap: board.state.heap,
          ip: board.state.ip,
          mode: 'STA',
          mqtt: true,
        };
      }
      throw new Error('No board data yet');
    }
    return this.httpGet('/api/info');
  },

  async status() {
    if (this.mode === 'mqtt') {
      const board = this.getActiveBoard();
      if (board && board.state) {
        return {
          heap: board.state.heap,
          uptime: board.state.uptime,
          rssi: board.state.rssi,
          ip: board.state.ip,
          mode: 'STA',
          version: board.state.version,
          alarm: board.state.alarm,
          mqtt: true,
          rooms: board.state.rooms || [],
        };
      }
      throw new Error('No board data yet');
    }
    return this.httpGet('/api/status');
  },

  async rooms() {
    if (this.mode === 'mqtt') {
      const board = this.getActiveBoard();
      if (board && board.state) {
        return { rooms: board.state.rooms || [], count: (board.state.rooms || []).length };
      }
      throw new Error('No board data yet');
    }
    return this.httpGet('/api/rooms');
  },

  async switches() {
    if (this.mode === 'mqtt') {
      const board = this.getActiveBoard();
      if (board && board.state) {
        return { switches: board.state.switches || [], count: (board.state.switches || []).length };
      }
      throw new Error('No board data yet');
    }
    return this.httpGet('/api/switches');
  },

  async pins() {
    if (this.mode === 'mqtt') {
      // For MQTT, return a generic ESP32-S3 pin list
      const pins = [];
      [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,21].forEach(n => {
        pins.push({ pin: n, label: 'GPIO ' + n, free: true });
      });
      return { pins };
    }
    return this.httpGet('/api/pins');
  },

  async setSwitch(index, state) {
    if (this.mode === 'mqtt') {
      this.mqttCommand(this.mqttBoardId, { cmd: 'switch', index, state });
      return { success: true };
    }
    return this.httpPost('/api/switch', { index, state: state ? 1 : 0 });
  },

  async addSwitch(name, pin) {
    if (this.mode === 'mqtt') {
      this.mqttCommand(this.mqttBoardId, { cmd: 'switchAdd', name, pin });
      return { success: true };
    }
    return this.httpPost('/api/switchManage', { action: 'add', name, pin });
  },

  async deleteSwitch(index) {
    if (this.mode === 'mqtt') {
      this.mqttCommand(this.mqttBoardId, { cmd: 'switchDelete', index });
      return { success: true };
    }
    return this.httpPost('/api/switchManage', { action: 'delete', index });
  },

  async assignSwitch(swIdx, roomId) {
    if (this.mode === 'mqtt') {
      this.mqttCommand(this.mqttBoardId, { cmd: 'switchAssign', index: swIdx, roomId });
      return { success: true };
    }
    return this.httpPost('/api/switchManage', { action: 'assign', switchIdx: swIdx, roomId });
  },

  async addRoom(name, type) {
    if (this.mode === 'mqtt') {
      this.mqttCommand(this.mqttBoardId, { cmd: 'roomAdd', name, type });
      return { success: true };
    }
    return this.httpPost('/api/rooms', { action: 'add', name, type });
  },

  async deleteRoom(index) {
    if (this.mode === 'mqtt') {
      this.mqttCommand(this.mqttBoardId, { cmd: 'roomDelete', index });
      return { success: true };
    }
    return this.httpPost('/api/rooms', { action: 'delete', index });
  },

  async updateRoomPos(index, x, y, w, h) {
    if (this.mode === 'mqtt') {
      this.mqttCommand(this.mqttBoardId, { cmd: 'roomUpdate', index, x, y, width: w, height: h });
      return { success: true };
    }
    return this.httpPost('/api/rooms', { action: 'updatePosition', index, x, y, w, h });
  },

  async silenceAlarm() {
    if (this.mode === 'mqtt') {
      this.mqttCommand(this.mqttBoardId, { cmd: 'silenceAlarm' });
      return { success: true };
    }
    return this.httpPost('/api/silenceAlarm');
  },

  async getConfig() {
    if (this.mode === 'mqtt') {
      const board = this.getActiveBoard();
      if (board && board.config) return board.config;
      // Request config and wait
      this.mqttRequestConfig(this.mqttBoardId);
      throw new Error('Config requested, wait for response');
    }
    return this.httpGet('/api/config');
  },

  async setConfig(config) {
    if (this.mode === 'mqtt') {
      this.mqttSetConfig(this.mqttBoardId, config);
      return { success: true };
    }
    return this.httpPost('/api/config', JSON.stringify(config));
  },

  async restart() {
    if (this.mode === 'mqtt') {
      this.mqttCommand(this.mqttBoardId, { cmd: 'restart' });
      return { success: true };
    }
    // HTTP restart not directly supported, use config endpoint
    return { success: true };
  },

  async setWifi(mode, ssid, password) {
    if (this.mode === 'mqtt') {
      this.mqttSetConfig(this.mqttBoardId, { wifiSSID: ssid, wifiPass: password });
      return { success: true, restart: true };
    }
    return this.httpPost('/api/wifi', { mode, ssid, wpass: password });
  },

  async login() {
    if (this.mode === 'mqtt') return { success: true };
    return this.httpPost('/api/login', { password: this.httpPass });
  },

  async request(method, path, body) {
    if (this.mode === 'mqtt') throw new Error('Raw API only available in HTTP mode');
    return this.httpRequest(method, path, body);
  },

  // ---- Discovery ----
  async discover(timeoutMs = 1500) {
    if (this.mode === 'http') {
      const subnets = ['192.168.0', '192.168.1', '192.168.4', '10.0.0'];
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs * 8);
      try {
        for (const sn of subnets) {
          for (let i = 1; i <= 254; i++) {
            if (ctrl.signal.aborted) break;
            const testHost = `http://${sn}.${i}`;
            try {
              const res = await fetch(testHost + '/api/info', {
                signal: ctrl.signal, cache: 'no-store',
                headers: { 'X-Auth-Password': this.httpPass }
              });
              if (res.ok) {
                const j = await res.json();
                if (j && (j.name || j.chip)) return { host: testHost, info: j };
              }
            } catch (_) {}
          }
        }
      } finally { clearTimeout(t); }
      return null;
    }
    // MQTT: boards auto-discover via state messages
    return null;
  },

  // ---- Disconnect ----
  disconnect() {
    if (this.mqttClient) {
      this.mqttClient.end(true);
      this.mqttClient = null;
    }
    this.boards = {};
    this.mqttBoardId = '';
    localStorage.removeItem(STORAGE_KEYS.mqttBoardId);
  },
};

ESP.load();
