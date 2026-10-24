import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 10000);
const ENABLE_RELAY = process.env.ENABLE_RELAY === 'true';
const MAX_PAYLOAD = 2 * 1024 * 1024;
const MAX_QUEUED_BYTES = 1024 * 1024;
const routes = new Map();
let UPSTREAM_HOST = '';
let RELAY_TOKEN = '';

if (ENABLE_RELAY) {
  UPSTREAM_HOST = (process.env.UPSTREAM_HOST || '').trim().toLowerCase();
  RELAY_TOKEN = process.env.RELAY_TOKEN || '';
  if (!/^[a-z0-9.-]+$/.test(UPSTREAM_HOST) || !UPSTREAM_HOST.includes('.')) {
    throw new Error('UPSTREAM_HOST must be a hostname only');
  }
  if (!RELAY_TOKEN || RELAY_TOKEN.length < 32) {
    throw new Error('RELAY_TOKEN must be at least 32 characters');
  }
  for (let i = 1; i <= 6; i += 1) {
    const value = process.env[`UPSTREAM_PATH_${i}`] || '';
    if (!value) continue;
    if (!value.startsWith('/') || value.startsWith('//') || value.includes('..') || /[\r\n\\]/.test(value) || value.length > 2048) {
      throw new Error(`UPSTREAM_PATH_${i} is invalid`);
    }
    routes.set(`/relay/${i}`, value);
  }
  if (routes.size === 0) throw new Error('Configure at least one UPSTREAM_PATH_n');
}

function tokenMatches(candidate) {
  if (typeof candidate !== 'string') return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(RELAY_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end('ok');
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end('not found');
});

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });

server.on('upgrade', (req, socket, head) => {
  if (!ENABLE_RELAY) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  const pathname = new URL(req.url || '/', 'http://relay.invalid').pathname;
  const upstreamPath = routes.get(pathname);
  if (!upstreamPath) {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  if (!tokenMatches(req.headers['x-relay-token'])) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (client) => bridge(client, upstreamPath));
});

function bridge(client, upstreamPath) {
  const upstreamUrl = `wss://${UPSTREAM_HOST}${upstreamPath}`;
  const upstream = new WebSocket(upstreamUrl, {
    maxPayload: MAX_PAYLOAD,
    perMessageDeflate: false,
    handshakeTimeout: 15000,
  });
  const pending = [];
  let pendingBytes = 0;
  let ended = false;

  const closePeer = (peer, code, reason) => {
    if (peer.readyState === WebSocket.OPEN || peer.readyState === WebSocket.CONNECTING) {
      try {
        if (code >= 1000 && code <= 4999 && code !== 1004 && code !== 1005 && code !== 1006 && code !== 1015) {
          peer.close(code, reason.slice(0, 100));
        } else {
          peer.terminate();
        }
      } catch {
        peer.terminate();
      }
    }
  };

  const stop = (code = 1011, reason = 'upstream unavailable') => {
    if (ended) return;
    ended = true;
    closePeer(client, code, reason);
    closePeer(upstream, code, reason);
  };

  client.on('message', (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(data, { binary: isBinary }, (err) => { if (err) stop(); });
      return;
    }
    if (upstream.readyState !== WebSocket.CONNECTING || pendingBytes + data.length > MAX_QUEUED_BYTES) {
      stop(1009, 'early data limit exceeded');
      return;
    }
    pending.push({ data: Buffer.from(data), isBinary });
    pendingBytes += data.length;
  });

  upstream.on('open', () => {
    for (const item of pending) {
      if (client.readyState !== WebSocket.OPEN || upstream.readyState !== WebSocket.OPEN) break;
      upstream.send(item.data, { binary: item.isBinary }, (err) => { if (err) stop(); });
    }
    pending.length = 0;
    pendingBytes = 0;
  });

  upstream.on('message', (data, isBinary) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data, { binary: isBinary }, (err) => { if (err) stop(); });
    }
  });

  client.on('close', (code, reason) => {
    if (ended) return;
    ended = true;
    closePeer(upstream, code, reason.toString());
  });
  upstream.on('close', (code, reason) => {
    if (ended) return;
    ended = true;
    closePeer(client, code, reason.toString());
  });
  client.on('error', () => stop());
  upstream.on('error', () => stop());

  const keepalive = setInterval(() => {
    if (ended) {
      clearInterval(keepalive);
      return;
    }
    if (client.readyState === WebSocket.OPEN) client.ping();
    if (upstream.readyState === WebSocket.OPEN) upstream.ping();
  }, 25000);
  keepalive.unref();
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`WebSocket relay listening on port ${PORT}; enabled=${ENABLE_RELAY}; ${routes.size} route(s) configured`);
});
