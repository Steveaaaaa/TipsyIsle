import http from 'node:http';
import os from 'node:os';
import crypto from 'node:crypto';
import { discoverLan } from './lan-discovery.mjs';

const clientOrigins = new Set(['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost', 'http://localhost:5179', 'http://127.0.0.1:5179']);

/** Dedicated opt-in LAN listener. Never exposes the application gateway or credentials. */
export function createLanSync(db) {
  const key = 'lan_transport';
  const read = () => JSON.parse(db.prepare('SELECT value FROM kv_store WHERE key=?').get(key)?.value ?? '{}');
  const save = value => db.prepare('INSERT INTO kv_store(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').run(key, JSON.stringify(value), Date.now());
  let listener;
  let discovery;
  const addresses = () => Object.values(os.networkInterfaces()).flat().filter(item => item && item.family === 'IPv4' && !item.internal).map(item => `http://${item.address}:5192`);
  async function start() {
    if (listener) return;
    listener = http.createServer(async (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      // Tauri's native HTTP plugin adds the app origin; gateway requests have none.
      if (req.headers.origin && !clientOrigins.has(req.headers.origin)) {
        res.writeHead(403); res.end(JSON.stringify({ error: '请求来源不受支持，请通过微醺屿应用进行同步' })); return;
      }
      try {
        const state = read();
        if (req.headers.authorization !== `Bearer ${state.token}` || !state.enabled) { res.writeHead(401); res.end(JSON.stringify({ error: '配对码不正确或连接已关闭' })); return; }
        if (req.url === '/hello' && req.method === 'GET') { res.end(JSON.stringify({ deviceId: state.deviceId, name: state.name, protocol: 2, packetId: state.outgoing?.iv ?? null })); return; }
        if (req.url === '/exchange' && req.method === 'POST') {
          const chunks = []; for await (const chunk of req) chunks.push(chunk);
          const packet = JSON.parse(Buffer.concat(chunks).toString());
          const latest = read();
          if (latest.lastIncomingIv !== packet.iv) {
            (latest.queue ??= []).push({ id: crypto.randomUUID(), packet });
            latest.lastIncomingIv = packet.iv; save(latest);
          }
          // The durable mailbox is independent of the UI; neither peer waits on the other's event loop.
          res.end(JSON.stringify({ packet: read().outgoing ?? null })); return;
        }
        res.writeHead(404); res.end('{}');
      } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: error.message })); }
    });
    const current = listener;
    try { await new Promise((resolve, reject) => { current.once('error', reject); current.listen(5192, '0.0.0.0', resolve); }); }
    catch (error) { listener = undefined; throw error; }
  }
  return {
    async control(action, payload = {}) {
      const state = read();
      if (action === 'start') {
        if (state.secret && state.secret !== payload.secret) { state.queue = []; delete state.incoming; delete state.outgoing; delete state.lastIncomingIv; }
        Object.assign(state, payload, { enabled: true }); save(state); await start();
        if (discovery) discovery.update({ deviceId: state.deviceId, name: state.name });
        else discovery = await discoverLan({ deviceId: state.deviceId, name: state.name });
      }
      else if (action === 'stop') { state.enabled = false; save(state); listener?.close(); listener = undefined; discovery?.close(); discovery = undefined; }
      else if (action === 'publish') { if (state.outgoing?.iv !== payload.packet.iv) { state.outgoing = payload.packet; save(state); } }
      else if (action === 'ack') { state.queue = (state.queue ?? []).filter(item => item.id !== payload.id); if (state.incoming?.id === payload.id) delete state.incoming; save(state); }
      else if (action === 'scan') discovery?.scan();
      else if (action === 'revoke') { state.queue = []; delete state.incoming; delete state.outgoing; delete state.lastIncomingIv; Object.assign(state, payload); save(state); }
      const result = read();
      const { outgoing, token, ...status } = result;
      return { ...status, enabled: !!listener && !!result.enabled, addresses: addresses(), nearby: discovery?.list() ?? [] };
    },
    close() { discovery?.close(); listener?.close(); },
  };
}
