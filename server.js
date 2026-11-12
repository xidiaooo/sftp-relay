// sftp-relay — Node + ssh2 小中转：给纯 SFTP 账号（拒绝 shell/PTY 的）用的后端。
// 网页只负责列表 / 上传 / 下载，所有 SSH/SFTP 都由这个服务用 ssh2 库完成。
// 凭证一律走环境变量，不写进代码和文件：
//   SFTP_HOST, SFTP_PORT (默认 2022), SFTP_USER, SFTP_PASS, RELAY_TOKEN, PORT (默认 3000)
// 每次请求新建一个 SSH 连接（无状态，避免旧连接占着不释放导致的死锁）。
// 认证：除 /health 外，所有接口都要带 X-Relay-Token: $RELAY_TOKEN。
'use strict';

const http = require('node:http');
const { Client } = require('ssh2');

const SFTP_HOST = process.env.SFTP_HOST || '';
const SFTP_PORT = parseInt(process.env.SFTP_PORT || '2022', 10);
const SFTP_USER = process.env.SFTP_USER || '';
const SFTP_PASS = process.env.SFTP_PASS || '';
const RELAY_TOKEN = process.env.RELAY_TOKEN || '';
const PORT = parseInt(process.env.PORT || '3000', 10);
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100MB

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function connectSftp() {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const timer = setTimeout(() => { try { conn.end(); } catch (_) {} reject(new Error('SSH connect timeout (15s)')); }, 15000);
    conn.on('ready', () => {
      clearTimeout(timer);
      conn.sftp((err, sftp) => {
        if (err) { try { conn.end(); } catch (_) {} reject(err); return; }
        resolve({ conn, sftp });
      });
    });
    conn.on('error', (err) => { clearTimeout(timer); reject(err); });
    conn.connect({ host: SFTP_HOST, port: SFTP_PORT, username: SFTP_USER, password: SFTP_PASS, readyTimeout: 15000 });
  });
}

function withSftp(fn) {
  return connectSftp().then(({ conn, sftp }) =>
    Promise.resolve()
      .then(() => fn(sftp))
      .finally(() => { try { conn.end(); } catch (_) {} }));
}

function normalizePath(p) {
  if (!p || typeof p !== 'string') return '/';
  if (!p.startsWith('/')) p = '/' + p;
  return p.replace(/\/+/g, '/');
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/health') return sendJson(res, 200, { ok: true, host: SFTP_HOST, port: SFTP_PORT });

  if (!RELAY_TOKEN || req.headers['x-relay-token'] !== RELAY_TOKEN) {
    return sendJson(res, 401, { ok: false, error: 'unauthorized' });
  }
  if (!SFTP_HOST || !SFTP_USER || !SFTP_PASS) {
    return sendJson(res, 500, { ok: false, error: 'SFTP credentials not configured (env)' });
  }

  if (req.method === 'GET' && url.pathname === '/api/list') {
    const dir = normalizePath(url.searchParams.get('path') || '/');
    return withSftp((sftp) => new Promise((resolve, reject) => {
      sftp.readdir(dir, (err, list) => err ? reject(err) : resolve(list.map((e) => ({
        filename: e.filename,
        longname: e.longname,
        attrs: { size: e.attrs.size, mtime: e.attrs.mtime, mode: e.attrs.mode, uid: e.attrs.uid, gid: e.attrs.gid },
        isDir: (e.attrs.mode & 0o170000) === 0o040000,
      }))));
    }))
      .then((entries) => sendJson(res, 200, { ok: true, path: dir, entries }))
      .catch((err) => sendJson(res, 502, { ok: false, error: String(err && err.message || err) }));
  }

  if (req.method === 'GET' && url.pathname === '/api/download') {
    const file = normalizePath(url.searchParams.get('path') || '');
    if (!file || file === '/') return sendJson(res, 400, { ok: false, error: 'path required' });
    // 不走 withSftp：连接必须活到流传完才关，finally 会提前掐断。
    return connectSftp()
      .then(({ conn, sftp }) => {
        const stream = sftp.createReadStream(file);
        const closeConn = () => { try { conn.end(); } catch (_) {} };
        stream.on('error', (err) => { closeConn(); if (!res.headersSent) sendJson(res, 502, { ok: false, error: String(err && err.message || err) }); });
        stream.on('open', () => {
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${encodeURIComponent(file.split('/').pop())}"` });
          stream.pipe(res);
        });
        stream.on('end', closeConn);
        res.on('close', closeConn);
      })
      .catch((err) => { if (!res.headersSent) sendJson(res, 502, { ok: false, error: String(err && err.message || err) }); });
  }

  if (req.method === 'POST' && url.pathname === '/api/upload') {
    const file = normalizePath(url.searchParams.get('path') || '');
    if (!file || file === '/') return sendJson(res, 400, { ok: false, error: 'path required' });
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > MAX_UPLOAD_BYTES) { req.destroy(); } chunks.push(c); });
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      withSftp((sftp) => new Promise((resolve, reject) => {
        const w = sftp.createWriteStream(file);
        w.on('error', reject); w.on('close', resolve); w.end(buf);
      }))
        .then(() => sendJson(res, 200, { ok: true, path: file, size: buf.length }))
        .catch((err) => sendJson(res, 502, { ok: false, error: String(err && err.message || err) }));
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/mkdir') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let dir = '/';
      try { dir = normalizePath(JSON.parse(body || '{}').path || '/'); } catch (_) {}
      withSftp((sftp) => new Promise((resolve, reject) => sftp.mkdir(dir, (err) => err ? reject(err) : resolve())))
        .then(() => sendJson(res, 200, { ok: true, path: dir }))
        .catch((err) => sendJson(res, 502, { ok: false, error: String(err && err.message || err) }));
    });
    return;
  }

  return sendJson(res, 404, { ok: false, error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`sftp-relay listening on :${PORT} -> ${SFTP_USER}@${SFTP_HOST}:${SFTP_PORT}`);
});
