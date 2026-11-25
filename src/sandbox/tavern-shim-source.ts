export interface SandboxDocContext {
    componentTargets?: Array<{ key: string; selector: string }>;
    frameId?: string;
    messageId: string;
    floor: number;
    chatId?: string;
    characterName?: string;
    userName?: string;
    htmlBody?: string;
    initialVariables?: Record<string, unknown>;
    themeVars?: Record<string, string>;
    colorScheme?: 'light' | 'dark';
}

import { observeFrameHeight } from '../compatibility/frame-sizing';
import { observeComponentSizes } from '../shell/stream-layout';
import { authorBrowserRuntime } from '../compatibility/author-browser-runtime';
import { authorDocument } from '../compatibility/author-document';
import { observeReadingActivity } from '../shell/reading-navigation';
import { findSandboxParagraphAnchor, installSandboxMediaBridge } from './sandbox-media-shim';

export function buildSandboxSrcDoc(
    first: string | SandboxDocContext,
    second?: SandboxDocContext,
): string {
    const isObjFirst = typeof first === 'object' && first !== null;
    const rawHtml = isObjFirst ? (first.htmlBody || '') : first;
    const context: SandboxDocContext = isObjFirst
        ? first
        : second || { messageId: 'msg_0', floor: 0 };

    const safeCtxJson = JSON.stringify({
        frameId: context.frameId || '',
        messageId: context.messageId,
        floor: context.floor,
        chatId: context.chatId || '',
        characterName: context.characterName || 'Character',
        userName: context.userName || 'User',
        initialVariables: context.initialVariables || {},
        themeVars: context.themeVars || {},
        colorScheme: context.colorScheme || 'light',
        componentTargets: context.componentTargets ?? [],
    }).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

    const head = `<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
${authorBrowserRuntime}
<style>
@layer tipsy-reader {
  :where(html) { font-size: 16px; -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
  :where(body) {
    margin: 0;
    padding: 0;
    background: transparent;
    color: var(--tt-text, #252d3b);
    font-family: var(--tt-font, system-ui);
    font-size: var(--tt-size, 16px);
    line-height: var(--tt-leading, 1.9);
    overflow-x: hidden;
  }
  :where(body > *) { min-width: 0; }
}
</style>
<script>
(function() {
  const CTX = ${safeCtxJson};
  const themeKeys = new Set(['--tt-text', '--tt-bg', '--tt-accent', '--tt-font', '--tt-size', '--tt-leading']);
  function applyTheme(values, scheme) {
    for (const [key, value] of Object.entries(values || {})) {
      if (themeKeys.has(key) && typeof value === 'string') document.documentElement.style.setProperty(key, value);
    }
    if (scheme === 'light' || scheme === 'dark') {
      document.documentElement.style.colorScheme = scheme;
      document.documentElement.dataset.colorScheme = scheme;
    }
  }
  applyTheme(CTX.themeVars, CTX.colorScheme);
  let seq = 1;
  const pending = new Map();
  const eventListeners = new Map();

  function callRpc(method, params) {
    return new Promise((resolve, reject) => {
      const id = 'rpc_' + CTX.floor + '_' + (seq++);
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error('Sandbox RPC timed out: ' + method));
      }, 30000);
      pending.set(id, { resolve, reject, timeout });
      window.parent.postMessage({
        jsonrpc: '2.0',
        id,
        frameId: CTX.frameId,
        method,
        params: Object.assign({ messageId: CTX.messageId, floor: CTX.floor }, params || {})
      }, '*');
    });
  }

  window.addEventListener('message', (ev) => {
    const data = ev.data;
    if (ev.source !== window.parent || !data) return;
    if (data.kind === 'tipsy:sandbox-theme') { applyTheme(data.themeVars, data.colorScheme); return; }
    if (data.kind === 'tipsy:sandbox-media') { applySandboxMedia(data.slots || []); return; }
    if ((data.__tt_sandbox_event__ || data.type === '__tt_sandbox_event__') && data.event) {
      const handlers = eventListeners.get(data.event);
      if (handlers) {
        handlers.forEach((fn) => {
          try { fn(...(data.args || [])); } catch (err) { console.error(err); }
        });
      }
      return;
    }
    if (data.jsonrpc !== '2.0' || !data.id) return;
    const item = pending.get(data.id);
    if (!item) return;
    pending.delete(data.id);
    clearTimeout(item.timeout);
    if (data.error) item.reject(new Error(data.error.message || 'Sandbox RPC Error'));
    else item.resolve(data.result);
  });

  window.TavernHelper = {
    getVariables: (option) => callRpc('variables.get', { option: option || {} }),
    insertOrAssignVariables: (variables, option) =>
      callRpc('variables.insertOrAssign', { variables, option: option || {} }),
    replaceVariables: (variables, option) =>
      callRpc('variables.replace', { variables, option: option || {} }),
    deleteVariable: (key, option) =>
      callRpc('variables.delete', { key, option: option || {} }),
    triggerSlash: (command) => callRpc('slash.trigger', { command }),
    generate: (options) => callRpc('generation.generate', { options: options || {} }),
    getChatMessages: (range) => callRpc('chat.getMessages', { range }),
    setChatMessage: (newContent, floorOrId) =>
      callRpc('chat.setMessage', { newContent, floorOrId: floorOrId ?? CTX.floor }),
    getWorldbook: () => callRpc('worldbook.get', {}),
    replaceWorldbook: (entries) => callRpc('worldbook.replace', { entries }),
    eventOn: (eventName, handler) => {
      if (!eventListeners.has(eventName)) eventListeners.set(eventName, new Set());
      eventListeners.get(eventName).add(handler);
      return () => eventListeners.get(eventName)?.delete(handler);
    },
    eventOff: (eventName, handler) => {
      eventListeners.get(eventName)?.delete(handler);
    },
    eventOnce: (eventName, handler) => {
      const wrapper = (...args) => {
        eventListeners.get(eventName)?.delete(wrapper);
        handler(...args);
      };
      return window.TavernHelper.eventOn(eventName, wrapper);
    }
  };

  // The helper exposes its functions as globals inside message iframes.
  Object.keys(window.TavernHelper).forEach(key => { window[key] = window.TavernHelper[key]; });
  window.getCurrentMessageId = () => CTX.floor;
  window.tavern_events = {
    MESSAGE_SENT: 'message_sent', MESSAGE_RECEIVED: 'message_received',
    MESSAGE_EDITED: 'message_edited', MESSAGE_DELETED: 'message_deleted',
    MESSAGE_SWIPED: 'message_swiped', CHAT_CHANGED: 'chat_changed',
    GENERATION_STARTED: 'generation_started', GENERATION_ENDED: 'generation_ended'
  };

  window.SillyTavern = {
    getContext: () => ({
      name1: CTX.userName,
      name2: CTX.characterName,
      chatId: CTX.chatId,
      eventSource: { on: window.TavernHelper.eventOn, removeListener: window.TavernHelper.eventOff }
    })
  };

  function reportHeight(h) {
    window.parent.postMessage({
      jsonrpc: '2.0',
      id: 'resize_' + Date.now(),
      frameId: CTX.frameId,
      method: 'sandbox.resize',
      params: { height: h }
    }, '*');
  }

  const applySandboxMedia = (${installSandboxMediaBridge.toString()})(
    (${findSandboxParagraphAnchor.toString()}),
    (keys) => window.parent.postMessage({
      jsonrpc: '2.0',
      id: 'media_' + Date.now(),
      frameId: CTX.frameId,
      method: 'sandbox.mediaMounted',
      params: { keys }
    }, '*'),
    (key, action) => callRpc('sandbox.mediaAction', { key, action }),
    () => reportHeight(Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0))
  );

  window.addEventListener('DOMContentLoaded', () => {
    if (CTX.componentTargets.length) (${observeComponentSizes.toString()})(CTX.componentTargets, values => window.parent.postMessage({ jsonrpc: '2.0', id: 'sizes', frameId: CTX.frameId, method: 'sandbox.componentSizes', params: { values } }, '*'));
    (${observeFrameHeight.toString()})(reportHeight);
    (${observeReadingActivity.toString()})(window, activity => window.parent.postMessage({
      jsonrpc: '2.0', id: 'reading_' + Date.now(), frameId: CTX.frameId, method: 'sandbox.reading', params: { activity }
    }, '*'));
  }, { once: true });
})();
</script>`;
    return authorDocument(rawHtml, head, '');
}
