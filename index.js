#!/usr/bin/env node

const fs = require('fs');
const https = require('https');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.WSS_PORT || 18890);
const CERT_PATH = process.env.WSS_CERT_PATH || '/home/rd/.certs/cert.pem';
const KEY_PATH = process.env.WSS_KEY_PATH || '/home/rd/.certs/key.pem';

const server = https.createServer({
  cert: fs.readFileSync(CERT_PATH),
  key: fs.readFileSync(KEY_PATH),
  minVersion: 'TLSv1.2',
  maxVersion: 'TLSv1.3',
  ciphers: 'DEFAULT:@SECLEVEL=0',
}, (_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Standalone WSS Relay Server\n');
});

const wss = new WebSocketServer({ server });

// Map of deviceId -> WebSocket
const devices = new Map();
// Map of deviceId -> Set of WebSockets
const clients = new Map();

function log(message) {
  console.log(`${new Date().toISOString()} [Relay] ${message}`);
}

wss.on('connection', (ws, req) => {
  const url = req.url; // e.g., /device/12345 or /client/12345
  const parts = url.split('/').filter(Boolean);
  if (parts.length < 2) {
    ws.close(1008, 'Invalid URL');
    return;
  }
  
  const role = parts[0]; // 'device' or 'client'
  const deviceId = parts[1];

  log(`${role} connected for device: ${deviceId} from ${req.socket.remoteAddress}`);

  if (role === 'device') {
    // If an old device socket exists, close it
    if (devices.has(deviceId)) {
      devices.get(deviceId).close(1000, 'Replaced');
    }
    devices.set(deviceId, ws);
  } else if (role === 'client') {
    if (!clients.has(deviceId)) {
      clients.set(deviceId, new Set());
    }
    clients.get(deviceId).add(ws);
  } else {
    ws.close(1008, 'Invalid role');
    return;
  }

  ws.on('message', (data) => {
    // Relay message to the other side
    if (role === 'client') {
      const deviceWs = devices.get(deviceId);
      if (deviceWs && deviceWs.readyState === ws.OPEN) {
        deviceWs.send(data);
      } else {
        // Device not online
        ws.send(JSON.stringify({ type: 'system', payload: { text: '设备未在线' } }));
      }
    } else if (role === 'device') {
      const clientSet = clients.get(deviceId);
      if (clientSet) {
        for (const clientWs of clientSet) {
          if (clientWs.readyState === ws.OPEN) {
            clientWs.send(data);
          }
        }
      }
    }
  });

  ws.on('close', () => {
    log(`${role} disconnected for device: ${deviceId}`);
    if (role === 'device') {
      if (devices.get(deviceId) === ws) {
        devices.delete(deviceId);
      }
    } else if (role === 'client') {
      const clientSet = clients.get(deviceId);
      if (clientSet) {
        clientSet.delete(ws);
      }
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  log(`Listening on wss://0.0.0.0:${PORT}`);
});

process.on('SIGTERM', () => {
  log('SIGTERM received, shutting down');
  wss.close();
  server.close(() => process.exit(0));
});
