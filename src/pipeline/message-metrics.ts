import type { ChatMessageNode } from '../types';
import { estimateTokenCount } from './token-counter';

export interface MessageTurnMetrics {
    promptTokens?: number;
    outputTokens?: number;
    durationMs?: number;
    startedAt?: number;
}

export interface ResolvedMessageMetrics extends MessageTurnMetrics {
    isLive: boolean;
    estimatedFallback?: boolean;
}

const fallbackCache = new WeakMap<ChatMessageNode, { swipe: number; content: string; reasoning: string; tokens: number }>();

/** O(n) single-pass token estimator used during streaming to accumulate chunk deltas without scanning full text. */
export function estimateTokenDelta(text: string): number {
    if (!text) return 0;
    let cjk = 0;
    for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);
        if (code >= 0x2e80 && code <= 0x9fff) cjk++;
    }
    return cjk * 1.4 + (text.length - cjk) / 3.8;
}

/** Bucket token counts to ~100 increments so live UI only re-renders on meaningful progress. */
export function tokenDisplayBucket(tokens: number): number {
    if (!Number.isFinite(tokens) || tokens <= 0) return 0;
    if (tokens < 100) return 50;
    return Math.round(tokens / 100) * 100;
}

export function formatApproxTokens(tokens: number | undefined): string | undefined {
    if (tokens === undefined || !Number.isFinite(tokens) || tokens <= 0) return undefined;
    if (tokens < 100) return '<100';
    const rounded = Math.round(tokens / 100) * 100;
    if (rounded < 1000) return `~${rounded}`;
    const k = (rounded / 1000).toFixed(1).replace(/\.0$/, '');
    return `~${k}k`;
}

export function formatReplyDuration(ms: number | undefined, live = false): string | undefined {
    if (ms === undefined || !Number.isFinite(ms) || ms < 0) return undefined;
    if (live) {
        const totalSeconds = Math.floor(ms / 1000);
        if (totalSeconds < 60) return `${totalSeconds}s`;
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `${minutes}m ${seconds}s`;
    }
    if (ms < 60_000) return `${Math.max(0.1, ms / 1000).toFixed(1)}s`;
    const totalSeconds = Math.round(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}m ${seconds}s`;
}

function swipeMetricNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function readSwipeMetrics(node: ChatMessageNode, swipe = node.activeSwipeIndex): MessageTurnMetrics | undefined {
    const table = node.extra?.tipsy_metrics as Record<string, MessageTurnMetrics> | undefined;
    const raw = table?.[swipe];
    if (!raw || typeof raw !== 'object') return undefined;
    const metrics: MessageTurnMetrics = {
        ...(swipeMetricNumber(raw.promptTokens) !== undefined ? { promptTokens: raw.promptTokens } : {}),
        ...(swipeMetricNumber(raw.outputTokens) !== undefined ? { outputTokens: raw.outputTokens } : {}),
        ...(swipeMetricNumber(raw.durationMs) !== undefined ? { durationMs: raw.durationMs } : {}),
        ...(swipeMetricNumber(raw.startedAt) !== undefined ? { startedAt: raw.startedAt } : {}),
    };
    return Object.keys(metrics).length ? metrics : undefined;
}

export function setSwipeMetrics(
    node: ChatMessageNode,
    swipe: number,
    patch: Partial<MessageTurnMetrics>,
): Record<string, unknown> {
    const table = { ...(node.extra?.tipsy_metrics as Record<string, MessageTurnMetrics> | undefined) };
    const next: Record<string, number | undefined> = { ...(table[swipe] ?? {}) };
    for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete next[key];
        else next[key] = value;
    }
    if (Object.keys(next).length) table[swipe] = next;
    else delete table[swipe];
    const extra = { ...(node.extra ?? {}) };
    if (Object.keys(table).length) extra.tipsy_metrics = table;
    else delete extra.tipsy_metrics;
    return extra;
}

function activeSwipeText(node: ChatMessageNode, swipe = node.activeSwipeIndex): { content: string; reasoning: string } {
    const item = node.swipes?.[swipe];
    if (swipe === node.activeSwipeIndex || item === undefined) {
        return {
            content: node.content ?? '',
            reasoning: node.reasoning ?? (typeof item === 'object' ? item.reasoning ?? '' : ''),
        };
    }
    return typeof item === 'string'
        ? { content: item, reasoning: '' }
        : { content: item.content ?? '', reasoning: item.reasoning ?? '' };
}

export function readMessageMetrics(node: ChatMessageNode, swipe = node.activeSwipeIndex): ResolvedMessageMetrics | undefined {
    const stored = readSwipeMetrics(node, swipe);
    const isLive = Boolean(node.extra?.tipsy_generation_incomplete && stored?.startedAt);
    if (node.role === 'user') {
        if (!stored?.promptTokens) return undefined;
        return { promptTokens: stored.promptTokens, isLive: false };
    }
    if (node.role === 'assistant') {
        if (stored && (stored.outputTokens !== undefined || stored.durationMs !== undefined || isLive)) {
            return { ...stored, isLive };
        }
        // Only estimate legacy completed replies (skip greeting floor 0 and incomplete nodes).
        if (node.floor > 0 && !node.extra?.tipsy_generation_incomplete) {
            const { content, reasoning } = activeSwipeText(node, swipe);
            if (!content && !reasoning) return undefined;
            const cached = fallbackCache.get(node);
            if (cached && cached.swipe === swipe && cached.content === content && cached.reasoning === reasoning) {
                return cached.tokens > 0 ? { outputTokens: cached.tokens, isLive: false, estimatedFallback: true } : undefined;
            }
            const tokens = estimateTokenCount(content) + (reasoning ? estimateTokenCount(reasoning) : 0);
            fallbackCache.set(node, { swipe, content, reasoning, tokens });
            return tokens > 0 ? { outputTokens: tokens, isLive: false, estimatedFallback: true } : undefined;
        }
    }
    return undefined;
}
