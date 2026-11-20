import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { createGateway } from '../server/gateway.mjs';

async function listen(t, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('gateway survives malformed storage JSON and still persists snapshots', async (t) => {
  const base = await listen(t, createGateway({ databasePath: ':memory:' }));
  const invalid = await fetch(`${base}/api/tipsy-isle/kv/test`, { method: 'PUT', body: '{broken' });
  assert.equal(invalid.status, 400);
  const saved = await fetch(`${base}/api/tipsy-isle/kv/test`, { method: 'PUT', body: JSON.stringify({ value: { messages: ['hello'] } }) });
  assert.equal(saved.status, 200);
  const restored = await fetch(`${base}/api/tipsy-isle/kv/test`).then(r => r.json());
  assert.deepEqual(restored.value, { messages: ['hello'] });
});

test('gateway accepts full completion URL and forwards JSON completion settings', async (t) => {
  let received;
  const upstream = await listen(t, http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    received = { url: req.url, auth: req.headers.authorization, body: JSON.parse(body) };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
  }));
  const base = await listen(t, createGateway({ databasePath: ':memory:' }));
  const response = await fetch(`${base}/api/tipsy-isle/llm/stream`, { method: 'POST', body: JSON.stringify({
    baseUrl: `${upstream}/v1/chat/completions`, apiKey: 'test-key', model: 'test', messages: [],
    stream: false, parameters: { frequency_penalty: 0.5, stream: true, model: 'incorrect' },
  }) });
  assert.match(response.headers.get('content-type'), /application\/json/);
  assert.equal((await response.json()).choices[0].message.content, 'ok');
  assert.equal(received.url, '/v1/chat/completions');
  assert.equal(received.auth, 'Bearer test-key');
  assert.equal(received.body.model, 'test');
  assert.equal(received.body.stream, false);
  assert.equal(received.body.frequency_penalty, 0.5);
});

test('gateway preserves upstream HTTP status and error body', async (t) => {
  const upstream = await listen(t, http.createServer((req, res) => {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'rate limited' } }));
  }));
  const base = await listen(t, createGateway({ databasePath: ':memory:' }));
  const response = await fetch(`${base}/api/tipsy-isle/llm/stream`, { method: 'POST', body: JSON.stringify({
    baseUrl: `${upstream}/v1`, model: 'test', messages: [],
  }) });
  assert.equal(response.status, 429);
  assert.match(response.headers.get('content-type'), /application\/json/);
  assert.equal((await response.json()).error.message, 'rate limited');
});

test('client cancellation closes the upstream generation request', async (t) => {
  let markClosed;
  const upstreamClosed = new Promise(resolve => { markClosed = resolve; });
  const upstream = await listen(t, http.createServer((req, res) => {
    res.once('close', markClosed);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"first"}}]}\n\n');
  }));
  const base = await listen(t, createGateway({ databasePath: ':memory:' }));
  const controller = new AbortController();
  const response = await fetch(`${base}/api/tipsy-isle/llm/stream`, { method: 'POST', signal: controller.signal,
    body: JSON.stringify({ baseUrl: upstream, model: 'test', messages: [] }) });
  const reader = response.body.getReader();
  await reader.read();
  controller.abort();
  let timeout;
  try {
    await Promise.race([upstreamClosed, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('upstream was not cancelled')), 3000);
    })]);
  } finally { clearTimeout(timeout); reader.releaseLock(); }
});

test('invalid endpoint returns 400 without crashing the gateway', async (t) => {
  const base = await listen(t, createGateway({ databasePath: ':memory:' }));
  const response = await fetch(`${base}/api/tipsy-isle/llm/stream`, { method: 'POST',
    body: JSON.stringify({ baseUrl: 'file:///example', model: 'test', messages: [] }) });
  assert.equal(response.status, 400);
  assert.equal((await fetch(`${base}/api/tipsy-isle/health`)).status, 200);
});
