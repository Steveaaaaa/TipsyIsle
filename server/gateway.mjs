import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import { manageExtension } from './extensions.mjs';
import { extensionMediaRequest } from './extension-media.mjs';
import { requestComfyEndpoint } from './comfy-transport.mjs';
import { usesProviderAdapter, relayProviderCompletion, fetchModelList, providerCatalog, removePath } from './llm-providers.mjs';
import { createVectorStore } from './vector-store.mjs';
import { createModelAuth } from './model-auth.mjs';
import { writeGallery, removeGallery } from './story-gallery.mjs';
import { createLanSync } from './lan-sync.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
export function createGateway({ databasePath = path.join(DATA_DIR, 'tipsy-isle.sqlite') } = {}) {
if (databasePath !== ':memory:') fs.mkdirSync(path.dirname(databasePath), { recursive: true });
const db = new DatabaseSync(databasePath);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS kv_store (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

const getStmt = db.prepare('SELECT value FROM kv_store WHERE key = ?');
const lanSync = createLanSync(db);
const queryWorldbookVectors = createVectorStore(db);
const modelAuth = createModelAuth(db);
const upsertStmt = db.prepare(`
  INSERT INTO kv_store (key, value, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
`);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
    req.on('aborted', () => reject(new Error('请求已断开')));
  });
}

const server = http.createServer(async (req, res) => {
  try {
  const requestOrigin = req.headers.origin;
  const allowedOrigins = new Set(['http://localhost:5179', 'http://127.0.0.1:5179', 'http://localhost:4173', 'http://127.0.0.1:4173', 'tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost']);
  if (requestOrigin && !allowedOrigins.has(requestOrigin)) {
    res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'This origin cannot access the application gateway' }));
    return;
  }
  if (requestOrigin) res.setHeader('Access-Control-Allow-Origin', requestOrigin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);

  const isGatewayRoute = url.pathname.startsWith('/api/tipsy-isle/');
  if (url.pathname === '/api/tipsy-isle/lan' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    res.end(JSON.stringify(await lanSync.control(body.action, body.payload))); return;
  }
  if (url.pathname === '/api/tipsy-isle/lan-request' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    const destination = new URL(body.address);
    if (destination.protocol !== 'http:' || !/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.|127\.|169\.254\.)/.test(destination.hostname)) throw new Error('请填写局域网 IPv4 地址');
    const response = await fetch(`${destination.origin}/${body.route === 'hello' ? 'hello' : 'exchange'}`, {
      method: body.route === 'hello' ? 'GET' : 'POST', headers: { Authorization: `Bearer ${body.secret}`, 'Content-Type': 'application/json' },
      body: body.route === 'hello' ? undefined : JSON.stringify(body.packet), signal: AbortSignal.timeout(20000),
    });
    res.writeHead(response.status, { 'Content-Type': 'application/json' }); res.end(await response.text()); return;
  }
  const gallery = /^\/api\/tipsy-isle\/gallery\/([\w~-]+)$/.exec(url.pathname);
  if (gallery && (req.method === 'PUT' || req.method === 'DELETE')) {
    if (req.method === 'DELETE') await removeGallery(gallery[1]);
    else {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      await writeGallery(gallery[1], url.searchParams.get('path') || '', Buffer.concat(chunks));
    }
    res.writeHead(204); res.end(); return;
  }
  if (!isGatewayRoute) {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Not Found' }));
    return;
  }

  // Health probe used by the frontend runtime-flavor detection (same payload as ping).
  if (url.pathname === '/api/tipsy-isle/health' && req.method === 'GET') {
    const uptime = Math.round(process.uptime());
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, flavor: 'local-gateway', storage: 'sqlite', uptime }));
    return;
  }

  const extensionRoute = /^\/api\/tipsy-isle\/extensions\/(list|version|install|update|reinstall|delete)$/.exec(url.pathname);
  const extensionMedia = /^\/api\/tipsy-isle\/extensions\/media\/(images\/(?:upload|folders|list(?:\/[^/]+)?|delete)|files\/(?:upload|verify|delete))$/.exec(url.pathname);
  if (extensionMedia && req.method === 'POST') {
    try {
      const result = await extensionMediaRequest(`/api/${extensionMedia[1]}`, JSON.parse(await readBody(req)));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(error.status ?? 400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }
  const comfyRoute = /^\/api\/tipsy-isle\/extensions\/comfy\/(ping|generate)$/.exec(url.pathname);
  if (comfyRoute && req.method === 'POST') {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    res.once('close', cancel);
    try {
      const payload = JSON.parse(await readBody(req));
      const result = await requestComfyEndpoint(comfyRoute[1] === 'ping', payload, AbortSignal.any([controller.signal, AbortSignal.timeout(600000)]));
      if (!res.destroyed) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(result));
      }
    } finally { res.off('close', cancel); }
    return;
  }
  if (extensionRoute && (req.method === 'POST' || req.method === 'GET' && extensionRoute[1] === 'list')) {
    try {
      const result = await manageExtension(extensionRoute[1], req.method === 'POST' ? JSON.parse(await readBody(req)) : {});
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(error.status ?? 400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ message: error.message }));
    }
    return;
  }

  if (url.pathname === '/api/tipsy-isle/kv-batch' && req.method === 'POST') {
    const { keys } = JSON.parse(await readBody(req));
    const values = Object.fromEntries(keys.map(key => {
      const row = getStmt.get(key);
      return [key, row ? JSON.parse(row.value) : null];
    }));
    res.end(JSON.stringify({ values })); return;
  }
  if (url.pathname === '/api/tipsy-isle/kv-batch' && req.method === 'PUT') {
    const body = JSON.parse((await readBody(req)) || '{}');
    if (!body.values || typeof body.values !== 'object' || Array.isArray(body.values)) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'values must be an object' })); return;
    }
    const entries = Object.entries(body.values);
    if (!entries.length || entries.some(([key]) => !key || ['__proto__', 'prototype', 'constructor'].includes(key))) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Invalid snapshot collections' })); return;
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      const updated = Date.now();
      for (const [key, value] of entries) upsertStmt.run(key, JSON.stringify(value), updated);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, keys: entries.map(([key]) => key) })); return;
  }

  // REST shape used by platform-bridge: GET/PUT /api/tipsy-isle/kv/<collection>
  const kvMatch = /^\/api\/tipsy-isle\/kv\/([^/]+)$/.exec(url.pathname);
  if (kvMatch) {
    const key = decodeURIComponent(kvMatch[1]);
    if (req.method === 'GET') {
      const row = getStmt.get(key);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ key, value: row ? JSON.parse(row.value) : null }));
      return;
    }
    if (req.method === 'PUT') {
      const body = JSON.parse((await readBody(req)) || '{}');
      upsertStmt.run(key, JSON.stringify(body.value ?? null), Date.now());
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, key }));
      return;
    }
  }

  if (url.pathname === '/api/tipsy-isle/llm/models' && req.method === 'POST') {
    const payload = JSON.parse((await readBody(req)) || '{}');
    const result = await fetchModelList(payload);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(result)); return;
  }
  const authRoute = /^\/api\/tipsy-isle\/llm\/auth\/(status|start|poll|answer|cancel|logout)$/.exec(url.pathname);
  if (authRoute && req.method === 'POST') {
    const result = await modelAuth.handle(authRoute[1], JSON.parse(await readBody(req)));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(result)); return;
  }
  if (url.pathname === '/api/tipsy-isle/vectors/query' && req.method === 'POST') {
    const controller = new AbortController();
    const abort = () => controller.abort(); res.once('close', abort);
    try {
      const result = await queryWorldbookVectors(JSON.parse(await readBody(req)), controller.signal);
      if (!res.destroyed) { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(result)); }
    } finally { res.off('close', abort); }
    return;
  }
  if (url.pathname === '/api/tipsy-isle/llm/catalog' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(await providerCatalog(url.searchParams.get('provider')))); return;
  }

  if (url.pathname === '/api/tipsy-isle/llm/image' && req.method === 'POST') {
    const input = JSON.parse(await readBody(req));
    const destination = new URL(input.url);
    const paths = {
      openai: /\/images\/(?:generations|edits)$/,
      moss: /\/(?:images\/generations|tasks\/[\w-]+)$/,
      novelai: /\/ai\/generate-image$/,
      gemini: /\/models\/[\w.-]+:generateContent$/,
      webui: /\/sdapi\/v1\/txt2img$/,
      comfyui: /\/(?:upload\/image|prompt|view|history\/[\w-]+)$/,
    };
    const isPrivateHost = (host) =>
      ['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0'].includes(host) ||
      /^(?:10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host);
    const checkUrl = (targetUrl, allowLocalOrigin) => {
      if (!['https:', 'http:'].includes(targetUrl.protocol) || targetUrl.username || targetUrl.password || targetUrl.hash) {
        throw new Error('不支持的生图地址');
      }
      if (input.protocol === 'result_url' && isPrivateHost(targetUrl.hostname) && targetUrl.origin !== allowLocalOrigin) {
        throw new Error('不允许的结果地址');
      }
    };
    const isResultUrl = input.protocol === 'result_url';
    if (!isResultUrl && (!Object.hasOwn(paths, input.protocol) || !paths[input.protocol].test(destination.pathname))) {
      throw new Error('不支持的生图地址');
    }
    checkUrl(destination, input.approvedOrigin);
    const readOnly =
      isResultUrl ||
      (input.protocol === 'comfyui' && /\/(?:view|history\/[\w-]+)$/.test(destination.pathname)) ||
      (input.protocol === 'moss' && /\/tasks\/[\w-]+$/.test(destination.pathname));
    if (input.method !== (readOnly ? 'GET' : 'POST')) throw new Error('请求方式无效');
    const multipart = input.binary !== undefined;
    if (multipart && (!/\/(?:images\/edits|upload\/image)$/.test(destination.pathname) || !/^multipart\/form-data; boundary=[\w-]{1,100}$/.test(input.contentType) || typeof input.binary !== 'string' || input.binary.length > 32 * 1024 * 1024)) {
      throw new Error('参考图上传格式无效');
    }
    const controller = new AbortController();
    res.once('close', () => controller.abort());
    try {
      let current = destination;
      let upstream;
      for (let hop = 0; hop <= (isResultUrl ? 2 : 0); hop++) {
        upstream = await fetch(current, {
          method: input.method,
          signal: controller.signal,
          redirect: isResultUrl ? 'manual' : 'error',
          headers: isResultUrl
            ? {}
            : {
                'Content-Type': multipart ? input.contentType : 'application/json',
                ...(input.key ? (input.protocol === 'gemini' ? { 'x-goog-api-key': input.key } : { Authorization: `Bearer ${input.key}` }) : {}),
              },
          body: readOnly ? undefined : multipart ? Buffer.from(input.binary, 'base64') : JSON.stringify(input.body),
        });
        if (isResultUrl && [301, 302, 303, 307, 308].includes(upstream.status)) {
          const location = upstream.headers.get('location');
          await upstream.body?.cancel();
          if (!location || hop === 2) throw new Error('结果地址重定向过多');
          current = new URL(location, current);
          checkUrl(current, input.approvedOrigin);
          continue;
        }
        break;
      }
      res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream', 'Cache-Control': 'no-store' });
      let bytes = 0;
      if (upstream.body) {
        for await (const chunk of upstream.body) {
          bytes += chunk.length;
          if (bytes > 40 * 1024 * 1024) throw new Error('模型结果过大');
          if (!res.write(chunk)) await once(res, 'drain', { signal: controller.signal });
        }
      }
      res.end();
    } finally {
      controller.abort();
    }
    return;
  }
  if (url.pathname === '/api/tipsy-isle/llm/artifact' && req.method === 'POST') {
    const { url: target, body, key } = JSON.parse(await readBody(req));
    const destination = new URL(target);
    if (!['https:', 'http:'].includes(destination.protocol) || destination.username || destination.password || destination.hash
        || !/\/(?:images\/generations|audio\/speech|embeddings)$/.test(destination.pathname)) throw new Error('不支持的模型任务地址');
    const controller = new AbortController(), close = () => controller.abort(); res.once('close', close);
    try {
      const upstream = await fetch(destination, { method: 'POST', signal: controller.signal, redirect: 'error',
        headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body) });
      const headers = { 'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream', 'Cache-Control': 'no-store' };
      const length = upstream.headers.get('content-length');
      if (length && !upstream.headers.get('content-encoding')) headers['Content-Length'] = length;
      res.writeHead(upstream.status, headers);
      if (upstream.body) for await (const chunk of upstream.body) if (!res.write(chunk)) await once(res, 'drain', { signal: controller.signal });
      res.end();
    } finally { res.off('close', close); controller.abort(); }
    return;
  }

  if (url.pathname === '/api/tipsy-isle/llm/stream' && req.method === 'POST') {
    const controller = new AbortController();
    const cancelUpstream = () => controller.abort();
    res.once('close', cancelUpstream);
    try {
      const payload = JSON.parse((await readBody(req)) || '{}');
      if (!Array.isArray(payload.messages) || !payload.model) throw new Error('请求必须包含 model 和 messages');
      if (usesProviderAdapter(payload)) {
        if (payload.provider?.authType === 'oauth') {
          const { auth, env } = await modelAuth.resolve(payload.provider.provider, controller.signal);
          payload.apiKey = auth.apiKey;
          payload.includeHeaders = { ...auth.headers, ...payload.includeHeaders };
          if (auth.baseUrl && !payload.baseUrl) payload.baseUrl = auth.baseUrl;
          payload.provider.env = env;
        }
        await relayProviderCompletion(payload, res, controller.signal);
        return;
      }
      const baseUrl = String(payload.baseUrl || '').replace(/\/+$/, '');
      let endpoint;
      try {
        endpoint = new URL(baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`);
        if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('invalid protocol');
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '请输入有效的 HTTP(S) API 地址' }));
        return;
      }
      const messages = payload.messages.map(message => message.role === 'tool'
        ? { role: 'tool', content: message.content, tool_call_id: message.tool_call_id } : message);
      const completionBody = { ...(payload.parameters || {}), model: payload.model, messages, stream: payload.stream !== false, ...payload.includeBody };
      for (const key of payload.excludeBody ?? []) removePath(completionBody, key);
      const upstream = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(payload.apiKey ? { Authorization: `Bearer ${payload.apiKey}` } : {}),
          ...payload.includeHeaders,
        },
        body: JSON.stringify(completionBody),
        signal: controller.signal,
      });

      res.writeHead(upstream.status, {
        'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      if (upstream.body) {
        for await (const chunk of upstream.body) {
          if (res.destroyed) break;
          if (!res.write(chunk)) await once(res, 'drain', { signal: controller.signal });
        }
      }
      res.end();
    } catch (err) {
      if (res.destroyed || controller.signal.aborted) return;
      if (res.headersSent) {
        res.end(`data: ${JSON.stringify({ error: { message: err instanceof Error ? err.message : String(err) } })}\n\n`);
      } else {
        res.writeHead(err instanceof SyntaxError ? 400 : 502, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
    } finally {
      res.off('close', cancelUpstream);
      controller.abort();
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: 'Not Found' }));
  } catch (err) {
    if (res.destroyed) return;
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(err instanceof SyntaxError || err instanceof URIError ? 400 : 500, {
      'Content-Type': 'application/json; charset=utf-8',
    });
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  }
});

server.once('close', () => { lanSync.close(); modelAuth.close(); db.close(); });
return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
const PORT = Number(process.env.TIPSY_PORT || 5180);
const server = createGateway();
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[TipsyIsle Gateway] Listening on http://127.0.0.1:${PORT}`);
});
}
