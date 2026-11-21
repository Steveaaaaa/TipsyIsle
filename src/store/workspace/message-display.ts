import { StreamProjector, createStreamPlan, type StreamDisplayMode, type MessageStreamPreview } from '../../pipeline/streaming-message';
import { orderedRegexScripts, regexRuleApplies } from '../../pipeline/macro-regex-engine';
import { scopedVariableStore } from '../scoped-variable-store';
import { readExtensionVariables } from '../../compatibility/extension-variables';
import type { ChatMessageNode } from '../../types';
import { normalizeTemplateFeatures, templateEntryEnabled } from '../../pipeline/template-features';
import { globalRegexes } from '../global-regex-store';
import { workspaceStore } from './state';
import { getActivePreset, getActiveLorebooks, getActiveCharacter } from './library';
import { persistWorkspace } from './storage';
import { getActiveChatMessages } from './queries';
import { readMessageTemplate } from './prompt';
import { formatMessageWithoutTemplate } from './message-format';
import { routeContent } from '../route-message-data';

const streamProjectors = new Map<string, { sources: unknown[]; projector: StreamProjector; node?: ChatMessageNode; content?: string; pending?: boolean; thinking?: boolean; value?: MessageStreamPreview }>();

export function clearStreamProjectors() { streamProjectors.clear(); }

const componentTargetsCache = new Map<string, { sources: unknown[]; targets: Array<{ key: string; selector: string }> }>();

export function getMessageComponentTargets(node: ChatMessageNode) {
    const state = workspaceStore.getState(), card = getActiveCharacter(state), preset = getActivePreset(state);
    const key = `${card.id}:${preset.id}:${node.role}`;
    const sources = [card, preset, globalRegexes()];
    const cached = componentTargetsCache.get(key);
    if (cached && sources.every((value, i) => cached.sources[i] === value)) return cached.targets;
    // Measurement targets do not control rendering; keep them stable as new floors arrive.
    const rules = orderedRegexScripts(globalRegexes(), preset.regexScripts, card.regexScripts).filter(rule => regexRuleApplies(rule, { stage: 'render', role: node.role, ignoreDepth: true }));
    const plan = createStreamPlan(rules, `${card.id}:${preset.id}`, state.userName, card.name, 'auto');
    const targets = [...plan.tags.values()].flatMap(info => info.selector ? [{ key: info.key, selector: info.selector }] : []);
    if (componentTargetsCache.size > 32) componentTargetsCache.delete(componentTargetsCache.keys().next().value!);
    componentTargetsCache.set(key, { sources, targets }); return targets;
}

export function setStreamDisplayMode(mode: StreamDisplayMode): void {
    workspaceStore.setState(draft => { draft.streamDisplayModes[draft.activeCharacterId] = mode; draft.templateRenderRevision++; });
    streamProjectors.clear(); persistWorkspace();
}

export function getMessageStreamPreview(node: ChatMessageNode) {
    const pending = !node.extra?.tipsy_generation_incomplete && isMessageTemplatePending(node);
    if (!node.extra?.tipsy_generation_incomplete && !pending) { streamProjectors.delete(node.id); return undefined; }
    const state = workspaceStore.getState();
    const card = getActiveCharacter(state), preset = getActivePreset(state);
    const depth = Math.max(0, getActiveChatMessages(state).length - 1 - node.floor);
    const mode = state.streamDisplayModes[card.id] ?? 'auto';
    const extension = scopedVariableStore.getState().extension;
    const books = getActiveLorebooks(state);
    const sources = [card, preset, globalRegexes(), extension.EjsTemplate, books, state.userName, depth, mode, state.activeChatId, node.role];
    let cache = streamProjectors.get(node.id);
    if (!cache || sources.some((value, i) => cache!.sources[i] !== value)) {
        const rules = orderedRegexScripts(globalRegexes(), preset.regexScripts, card.regexScripts).filter(rule => regexRuleApplies(rule, { stage: 'render', role: node.role, depth }));
        const features = normalizeTemplateFeatures(readExtensionVariables(extension, 'EjsTemplate'));
        const templateDocument = features.enabled && features.render_enabled && (features.depth_limit < 0 || depth <= features.depth_limit)
            && books.some(book => book.entries.some(entry => templateEntryEnabled(entry, features)
                && /\[RENDER:|@@render_(?:before|after)/.test(entry.comment + '\n' + entry.content)
                && /<!doctype\s+html\b|<html\b|<body\b/i.test(entry.content)));
        const plan = createStreamPlan(rules, `${card.id}:${preset.id}`, state.userName, card.name, mode, templateDocument, { role: node.role, depth });
        cache = { sources, projector: new StreamProjector(plan) };
        if (streamProjectors.size > 12) streamProjectors.delete(streamProjectors.keys().next().value!);
        streamProjectors.set(node.id, cache);
    }
    const temporary = state.nativeToolPreview?.id === node.id ? state.nativeToolPreview : undefined;
    const content = temporary?.content ?? node.content;
    const thinking = !content && !!(temporary?.reasoning ?? state.streamingReasoning);
    const terminal = node.extra?.tipsy_generation_terminal as { swipe: number; phase: 'error' | 'stopped'; detail: string } | undefined;
    const ended = terminal?.swipe === node.activeSwipeIndex ? terminal : node.extra?.tipsy_generation_incomplete && !state.isGenerating && !state.helperGenerationCount
        ? { phase: 'stopped' as const, detail: '', swipe: node.activeSwipeIndex } : undefined;
    const sameTerminal = ended ? cache.value?.phase === ended.phase : cache.value?.phase !== 'error' && cache.value?.phase !== 'stopped';
    if (cache.node === node && cache.content === content && cache.pending === pending && cache.thinking === thinking && sameTerminal) return cache.value;
    cache.node = node; cache.content = content; cache.pending = pending; cache.thinking = thinking;
    const preview = cache.projector.update(content, pending, thinking);
    if (!ended) return cache.value = preview;
    return cache.value = { ...preview, phase: ended.phase, errorDetail: ended.detail,
        status: ended.phase === 'error' ? '这次回复没能完成' : '回复已停止', document: false,
        parts: preview.document ? (node.content ? [{ id: 'interrupted-content', type: 'reasoning', content: node.content, complete: true, label: '已收到的内容（未完成）' }] : []) : preview.parts };
}

export function formatMessageForDisplay(node: ChatMessageNode): string {
    const content = routeContent(node, workspaceStore.getState().chatMetadata);
    if (content !== node.content) return formatMessageWithoutTemplate({ ...node, content });
    const streaming = getMessageStreamPreview(node);
    if (streaming) return streaming.source;
    const rendered = readMessageTemplate(node.id);
    if (rendered && rendered.content === node.content && rendered.swipe === node.activeSwipeIndex) return rendered.formatted;
    return formatMessageWithoutTemplate(node);
}

export function isMessageTemplatePending(node: ChatMessageNode): boolean {
    if (workspaceStore.getState().sessionKind === 'free' || node.extra?.tipsy_generation_incomplete) return false;
    const cached = readMessageTemplate(node.id);
    if (cached && cached.content === node.content && cached.swipe === node.activeSwipeIndex) return false;
    const features = normalizeTemplateFeatures(readExtensionVariables(scopedVariableStore.getState().extension, 'EjsTemplate'));
    if (!features.enabled || !features.render_enabled || features.depth_limit >= 0 && getActiveChatMessages().length - 1 - node.floor > features.depth_limit) return false;
    return getActiveChatMessages().some(message => message.content.includes('<%')) || getActiveLorebooks().some(book => book.entries.some(entry =>
        templateEntryEnabled(entry, features) && /\[RENDER:|@@render_(?:before|after)/.test(entry.comment + '\n' + entry.content)));
}
