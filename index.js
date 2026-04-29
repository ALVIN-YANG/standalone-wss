#!/usr/bin/env node

const fs = require('fs');
const https = require('https');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.WSS_PORT || 18890);
const CERT_PATH = process.env.WSS_CERT_PATH || '/home/rd/.certs/cert.pem';
const KEY_PATH = process.env.WSS_KEY_PATH || '/home/rd/.certs/key.pem';
const OPENCLAW_BRIDGE_URL = process.env.OPENCLAW_BRIDGE_URL || 'http://35.240.176.107:18800';
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 300000);

function log(message) {
  console.log(`${new Date().toISOString()} ${message}`);
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ ...msg, timestamp: msg.timestamp || new Date().toISOString() }));
  }
}

async function postBridge(path, body, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${OPENCLAW_BRIDGE_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: controller.signal,
    });
    const text = await res.text();
    let json = {};
    if (text.trim()) {
      try {
        json = JSON.parse(text);
      } catch {
        json = { raw: text };
      }
    }
    if (!res.ok || json.success === false) {
      throw new Error(json.error || `bridge ${path} failed with HTTP ${res.status}`);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

async function handleMessage(ws, raw) {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch (err) {
    send(ws, { type: 'error', payload: { error: `invalid json: ${err.message}` } });
    return;
  }

  const payload = msg.payload || {};
  const requestId = payload.requestId || `wss-${Date.now()}`;
  const startedAt = Date.now();
  log(`[WSS] ${msg.type} requestId=${requestId}`);

  try {
    switch (msg.type) {
      case 'start': {
        await postBridge('/webrtc/start', { callId: msg.callId || payload.callId });
        send(ws, { type: 'started', payload: { requestId } });
        break;
      }
      case 'offer': {
        const result = await postBridge('/webrtc/offer', {
          sdp: payload.sdp,
          callId: payload.callId || msg.callId,
        });
        send(ws, result.reply || { type: 'answer', payload: result.payload });
        break;
      }
      case 'ice': {
        await postBridge('/webrtc/ice', { candidate: payload.candidate });
        break;
      }
      case 'end': {
        await postBridge('/webrtc/end', {});
        send(ws, { type: 'ended', payload: { requestId } });
        break;
      }
      case 'interrupt':
      case 'user_interrupt': {
        await postBridge('/webrtc/interrupt', {});
        send(ws, { type: 'interrupted', payload: { requestId } });
        break;
      }
      case 'user_text':
      case 'text_chat': {
        const text = typeof payload.text === 'string' ? payload.text : '';
        const enableTts = payload.enableTts === true || msg.type === 'user_text';
        send(ws, { type: 'user_text_echo', payload: { text, requestId } });
        const result = await postBridge('/webrtc/text', { text, requestId, enableTts }, REQUEST_TIMEOUT_MS + 5000);
        send(ws, result.reply || { type: 'system', payload: { text: 'Empty bridge reply', requestId } });
        break;
      }
      default:
        send(ws, { type: 'error', payload: { error: `unknown type: ${msg.type}`, requestId } });
    }
    log(`[WSS] ${msg.type} done requestId=${requestId} elapsed=${Date.now() - startedAt}ms`);
  } catch (err) {
    log(`[WSS] ${msg.type} failed requestId=${requestId} elapsed=${Date.now() - startedAt}ms error=${err.message}`);
    send(ws, { type: 'error', payload: { error: err.message, requestId } });
  }
}

const server = https.createServer({
  cert: fs.readFileSync(CERT_PATH),
  key: fs.readFileSync(KEY_PATH),
  minVersion: 'TLSv1.2',
  maxVersion: 'TLSv1.3',
  ciphers: 'DEFAULT:@SECLEVEL=0',
}, (_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Standalone WSS Signaling Server\n');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  log(`[WSS] client connected from ${req.socket.remoteAddress}`);
  ws.on('message', (data) => {
    void handleMessage(ws, data);
  });
  ws.on('close', (code, reason) => {
    log(`[WSS] client disconnected code=${code} reason=${reason || 'none'}`);
  });
  ws.on('error', (err) => {
    log(`[WSS] client error: ${err.message}`);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  log(`[WSS] listening on wss://0.0.0.0:${PORT}, bridge=${OPENCLAW_BRIDGE_URL}`);
});

process.on('SIGTERM', () => {
  log('[WSS] SIGTERM received, shutting down');
  wss.close();
  server.close(() => process.exit(0));
});
