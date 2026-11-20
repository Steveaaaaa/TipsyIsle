import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const bundled = await build({ entryPoints: ['src/core/platform-bridge.ts'], bundle: true,
  write: false, format: 'esm', platform: 'node' });
const { streamLlmCompletion } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const encoder = new TextEncoder();

async function request(t, response, options = {}) {
  const originalFetch = globalThis.fetch;
  let sentBody;
  globalThis.fetch = async (url, init) => {
    if (url === '/api/tipsy-isle/health') return new Response('{}', { status: 404 });
    sentBody = JSON.parse(init.body);
    return response;
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const tokens = [];
  const result = await streamLlmCompletion({ source: 'openai', baseUrl: 'https://example.invalid/v1',
    apiKey: '', model: 'test', messages: [], parameters: {},
    onToken: (content, reasoning) => tokens.push([content, reasoning]), ...options });
  return { result, tokens, sentBody };
}

function sse(...chunks) {
  return new Response(new ReadableStream({ start(controller) {
    for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
    controller.close();
  } }), { headers: { 'Content-Type': 'text/event-stream' } });
}

test('SSE retains final unterminated event and split UTF-8 reasoning', async (t) => {
  const bytes = encoder.encode('data: {"choices":[{"delta":{"content":"你好","reasoning_content":"思考"}}]}');
  const boundary = bytes.indexOf(0xe4) + 1;
  const { result, tokens } = await request(t, sse(bytes.slice(0, boundary), bytes.slice(boundary)));
  assert.deepEqual(result, { content: '你好', reasoning: '思考' });
  assert.deepEqual(tokens, [['你好', '思考']]);
});

test('SSE joins multiline data and handles CRLF split across chunks', async (t) => {
  const { result } = await request(t, sse(': keepalive\r', '\ndata: {"choices":\r',
    '\ndata: [{"delta":{"content":"hello"}}]}\r', '\n\r', '\ndata: [DONE]\r\n\r\n'));
  assert.equal(result.content, 'hello');
});

test('SSE stops reading and cancels at DONE', async (t) => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ start(controller) {
    controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'));
  }, cancel() { cancelled = true; } }));
  const { result } = await request(t, response);
  assert.equal(result.content, 'ok');
  assert.equal(cancelled, true);
});

test('SSE reports upstream errors even after partial output', async (t) => {
  await assert.rejects(request(t, sse('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
    'data: {"error":{"message":"quota exceeded"}}\n\n')), /quota exceeded/);
});

test('malformed SSE does not silently return a successful empty message', async (t) => {
  await assert.rejects(request(t, sse('data: broken-json\n\n')), /无法解析/);
});

test('empty stream reports missing message', async (t) => {
  await assert.rejects(request(t, sse('data: [DONE]\n\n')), /未返回回复消息/);
});

test('JSON response supports disabled streaming and sampling parameters', async (t) => {
  const response = Response.json({ choices: [{ message: { content: 'answer', reasoning: 'thought' } }] });
  const { result, sentBody } = await request(t, response, { stream: false,
    parameters: { frequency_penalty: 0.7, reasoning_effort: 'high' } });
  assert.deepEqual(result, { content: 'answer', reasoning: 'thought' });
  assert.equal(sentBody.stream, false);
  assert.equal(sentBody.frequency_penalty, 0.7);
  assert.equal(sentBody.reasoning_effort, 'high');
});

test('HTTP errors retain status and upstream error message', async (t) => {
  await assert.rejects(request(t, new Response('invalid key', { status: 401 })), /401.*invalid key/);
});

test('abort cancels stream and releases reader', async (t) => {
  const controller = new AbortController();
  let cancelled = false;
  const response = new Response(new ReadableStream({ start(stream) {
    stream.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"first"}}]}\n\n'));
  }, cancel() { cancelled = true; } }));
  await assert.rejects(request(t, response, { signal: controller.signal,
    onToken() { controller.abort(); } }), { name: 'AbortError' });
  assert.equal(cancelled, true);
  assert.equal(response.body.locked, false);
});
