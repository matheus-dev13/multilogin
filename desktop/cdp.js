const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Minimal WebSocket client for the Chrome DevTools Protocol (no npm dependency).
class CdpConnection {
  constructor(socket, head) {
    this.socket = socket;
    this.buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
    this.fragments = [];
    this.nextId = 1;
    this.pending = new Map();
    socket.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this._parse(); });
    socket.on('close', () => this._failAll(new Error('Conexao DevTools fechada')));
    socket.on('error', (e) => this._failAll(e));
  }

  _failAll(err) {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  _parse() {
    while (this.buf.length >= 2) {
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2));
        off = 10;
      }
      if (this.buf.length < off + len) return;
      const payload = this.buf.subarray(off, off + len);
      this.buf = this.buf.subarray(off + len);
      const opcode = b0 & 0x0f;
      if (opcode === 0x8) { this.socket.end(); return; }
      if (opcode === 0x9) { this._write(0xa, payload); continue; }
      if (opcode === 0x1 || opcode === 0x0) {
        this.fragments.push(payload);
        if (b0 & 0x80) {
          const text = Buffer.concat(this.fragments).toString('utf8');
          this.fragments = [];
          this._onMessage(text);
        }
      }
    }
  }

  _onMessage(text) {
    let msg;
    try { msg = JSON.parse(text); } catch (e) { return; }
    if (msg.id === undefined || !this.pending.has(msg.id)) return;
    const p = this.pending.get(msg.id);
    this.pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message || 'Erro DevTools'));
    else p.resolve(msg.result || {});
  }

  _write(opcode, payload) {
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = 0x80 | len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;
    const mask = crypto.randomBytes(4);
    const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  send(method, params, sessionId, timeoutMs) {
    const id = this.nextId++;
    const msg = { id, method, params: params || {} };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Timeout DevTools: ' + method));
      }, timeoutMs || 10000);
      this.pending.set(id, {
        resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject: (e) => { clearTimeout(timer); reject(e); }
      });
      this._write(0x1, Buffer.from(JSON.stringify(msg), 'utf8'));
    });
  }

  close() {
    try { this._write(0x8, Buffer.alloc(0)); this.socket.end(); } catch (e) {}
  }
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const u = new URL(wsUrl);
    const req = http.request({
      host: u.hostname,
      port: u.port,
      path: u.pathname,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
        'Sec-WebSocket-Version': '13'
      }
    });
    req.on('upgrade', (res, socket, head) => resolve(new CdpConnection(socket, head)));
    req.on('response', (res) => reject(new Error('DevTools recusou conexao (HTTP ' + res.statusCode + ')')));
    req.on('error', reject);
    req.end();
  });
}

async function waitForDevToolsUrl(profileDir, timeoutMs) {
  const file = path.join(profileDir, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      if (lines[0] && lines[1]) return 'ws://127.0.0.1:' + lines[0].trim() + lines[1].trim();
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Navegador nao respondeu a tempo para importar cookies');
}

// Accepts exports from EditThisCookie, Cookie-Editor, Puppeteer/Playwright and similar.
function toCdpCookies(list) {
  const now = Date.now() / 1000;
  const out = [];
  for (const ck of list || []) {
    if (!ck || typeof ck !== 'object' || !ck.name) continue;
    const domain = String(ck.domain || '').trim();
    const host = domain.replace(/^\./, '');
    if (!host && !ck.url) continue;
    let secure = !!ck.secure;
    let sameSite;
    const ss = String(ck.sameSite || '').toLowerCase();
    if (ss === 'none' || ss === 'no_restriction') { sameSite = 'None'; secure = true; }
    else if (ss === 'lax') sameSite = 'Lax';
    else if (ss === 'strict') sameSite = 'Strict';
    const expires = Number(ck.expirationDate || ck.expires || ck.expiry || 0);
    if (expires > 0 && expires < now) continue;
    const c = {
      name: String(ck.name),
      value: String(ck.value == null ? '' : ck.value),
      path: ck.path || '/',
      secure: secure,
      httpOnly: !!ck.httpOnly
    };
    if (sameSite) c.sameSite = sameSite;
    if (expires > 0) c.expires = expires;
    if (ck.url) c.url = ck.url;
    else if (ck.hostOnly === true || !domain.startsWith('.')) c.url = (secure ? 'https' : 'http') + '://' + host + c.path;
    else c.domain = domain;
    out.push(c);
  }
  return out;
}

async function setCookies(conn, cookies) {
  try {
    await conn.send('Storage.setCookies', { cookies });
    return { ok: cookies.length, fail: 0 };
  } catch (e) {
    let ok = 0;
    let fail = 0;
    for (const c of cookies) {
      try { await conn.send('Storage.setCookies', { cookies: [c] }); ok++; } catch (e2) { fail++; }
    }
    return { ok, fail };
  }
}

// Runs a short-lived hidden browser on the profile so the visible one never has a DevTools port
// (Google refuses sign-in while one is open). Browser.close makes Chrome write the cookies to disk.
async function importCookiesHeadless(browserPath, profileDir, cookies) {
  try { fs.unlinkSync(path.join(profileDir, 'DevToolsActivePort')); } catch (e) {}
  const proc = spawn(browserPath, [
    '--headless=new',
    '--user-data-dir=' + profileDir,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--remote-debugging-port=0',
    'about:blank'
  ], { stdio: 'ignore' });
  const exited = new Promise((resolve) => {
    proc.once('exit', resolve);
    proc.once('error', resolve);
  });
  const timeout = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    const conn = await connect(await waitForDevToolsUrl(profileDir, 20000));
    try {
      const result = await setCookies(conn, cookies);
      conn.send('Browser.close').catch(() => {});
      await Promise.race([exited, timeout(10000)]);
      return result;
    } finally {
      conn.close();
    }
  } finally {
    if (proc.exitCode === null && proc.signalCode === null) {
      try { proc.kill(); } catch (e) {}
      await Promise.race([exited, timeout(5000)]);
    }
    try { fs.unlinkSync(path.join(profileDir, 'DevToolsActivePort')); } catch (e) {}
  }
}

module.exports = { connect, waitForDevToolsUrl, toCdpCookies, setCookies, importCookiesHeadless };
