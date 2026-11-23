import type { RegexPlacementStage, RegexScriptRule, VariableScopeContext } from '../types';
import { applyVariableMacros, type MacroVariableScopes } from './variable-macros';
import { standardMacro, type StandardMacroContext } from './standard-macros';
import { messageCodeBlocks } from './message-code-blocks';

export interface MacroContext extends StandardMacroContext {
    userName: string;
    charName: string;
    lastMessage?: string;
    lastUserMessage?: string;
    lastCharMessage?: string;
    lastMessageId?: number;
    modelName?: string;
    // Compatibility metadata only: the Worker never imports or accesses a store.
    variableContext?: VariableScopeContext;
    variables?: Record<string, unknown>;
    onSetVariable?: (key: string, value: unknown) => void;
    globalVariables?: Record<string, unknown>;
    onSetGlobalVariable?: (key: string, value: unknown) => void;
    variableScopes?: MacroVariableScopes;
}
export type MacroEvalContext = MacroContext;

export interface ApplyRegexOptions {
    stage?: RegexPlacementStage;
    placement?: RegexPlacementStage;
    depth?: number;
    ignoreDepth?: boolean;
    role?: 'system' | 'user' | 'assistant';
    isMarkdown?: boolean;
    isPrompt?: boolean;
    isEdit?: boolean;
    macroContext?: MacroContext;
    onError?: (rule: RegexScriptRule, error: Error) => void;
}

const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor']);
function pathParts(path: string): string[] | null {
    const parts = path.trim().replace(/\[(\d+)\]/g, '.$1').split('.');
    return parts.length && parts.every((p) => p && !unsafeKeys.has(p)) ? parts : null;
}
function getPath(root: unknown, path: string): unknown {
    const parts = pathParts(path);
    if (!parts) return undefined;
    let value = root;
    for (const key of parts) {
        if (!value || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, key)) return undefined;
        value = (value as Record<string, unknown>)[key];
    }
    return value;
}
function setPath(root: Record<string, unknown>, path: string, value: unknown): string | null {
    const parts = pathParts(path);
    if (!parts) return null;
    let target = root;
    for (const key of parts.slice(0, -1)) {
        if (!Object.prototype.hasOwnProperty.call(target, key) || !target[key] || typeof target[key] !== 'object') target[key] = {};
        target = target[key] as Record<string, unknown>;
    }
    target[parts[parts.length - 1]!] = value;
    return parts[0]!;
}
function stringify(value: unknown): string {
    if (value == null) return '';
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
}
function truthy(value: unknown): boolean {
    return value !== undefined && value !== null && value !== false && value !== 0 && value !== '' && value !== 'false' && value !== '0';
}

type MacroNode = { raw: string; macro?: string; offset?: number; kind?: 'if' | 'each'; expression?: string; children?: MacroNode[]; otherwise?: MacroNode[] };
// Balanced tokens permit nested macro arguments without interpreting arbitrary JavaScript.
function tokenize(text: string): MacroNode[] {
    const nodes: MacroNode[] = [];
    let cursor = 0;
    while (cursor < text.length) {
        const start = text.indexOf('{{', cursor);
        if (start < 0) { nodes.push({ raw: text.slice(cursor) }); break; }
        if (start > cursor) nodes.push({ raw: text.slice(cursor, start) });
        let end = start + 2;
        let depth = 1;
        while (end < text.length && depth) {
            if (text.startsWith('{{', end)) { depth++; end += 2; }
            else if (text.startsWith('}}', end)) { depth--; end += 2; }
            else end++;
        }
        if (depth) { nodes.push({ raw: text.slice(start) }); break; }
        nodes.push({ raw: text.slice(start, end), offset: start, macro: text.slice(start + 2, end - 2).trim() });
        cursor = end;
    }
    return nodes;
}
function splitArguments(macro: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < macro.length - 1; i++) {
        if (macro.startsWith('{{', i)) { depth++; i++; }
        else if (macro.startsWith('}}', i)) { depth--; i++; }
        else if (!depth && macro.startsWith('::', i)) { parts.push(macro.slice(start, i)); start = i + 2; i++; }
    }
    parts.push(macro.slice(start));
    return parts;
}
function parseBlocks(tokens: MacroNode[]): MacroNode[] {
    const root: MacroNode[] = [];
    const stack: Array<{ node: MacroNode; parent: MacroNode[] }> = [];
    let current = root;
    for (const token of tokens) {
        const opening = /^(?:#)?(if|each)(?:::|\s+)([\s\S]*)$/i.exec(token.macro ?? '');
        if (opening && stack.length < 64) {
            const node: MacroNode = { ...token, kind: opening[1]!.toLowerCase() as 'if' | 'each', expression: opening[2], children: [], otherwise: [] };
            current.push(node);
            stack.push({ node, parent: current });
            current = node.children!;
        } else if (/^else$/i.test(token.macro ?? '') && stack.length) {
            current = stack[stack.length - 1]!.node.otherwise!;
        } else if (/^(?:\/(if|each)|end(if|each))$/i.test(token.macro ?? '') && stack.length) {
            const frame = stack[stack.length - 1]!;
            if ((token.macro ?? '').toLowerCase().endsWith(frame.node.kind!)) {
                stack.pop();
                current = frame.parent;
            } else current.push(token);
        } else current.push(token);
    }
    // Malformed blocks are visible, never silently discarded.
    return stack.length ? tokens : root;
}

export function evaluateMacros(rawText: string, ctx: MacroContext): string {
    if (!rawText) return '';
    rawText = rawText.replace(/(?:\r?\n)*\{\{trim\}\}(?:\r?\n)*/gi, '').replace(/<(?:USER|BOT|CHAR|CHARIFNOTGROUP|GROUP)>/gi,
        token => token.toUpperCase() === '<USER>' ? ctx.userName : ctx.charName);
    const variables = ctx.variables ?? {};
    const globals = ctx.globalVariables ?? {};
    let budget = 20000;
    const render = (text: string, locals: Record<string, unknown> = {}, level = 0): string => {
        if (level > 64 || budget <= 0) return text;
        const resolve = (expression: string): unknown => {
            const value = render(expression, locals, level + 1).trim();
            if (value !== expression.trim()) {
                if (/^[\[{]/.test(value)) {
                    try { return JSON.parse(value) as unknown; } catch { /* plain text */ }
                }
                return value;
            }
            if (value === 'true') return true;
            if (value === 'false') return false;
            if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
            if (/^(["']).*\1$/s.test(value)) return value.slice(1, -1);
            return getPath(locals, value) ?? getPath(variables, value);
        };
        const walk = (nodes: MacroNode[], scope: Record<string, unknown>): string => nodes.map((node) => {
            if (--budget < 0) return node.raw;
            if (node.kind) {
                const value = resolve(node.expression ?? '');
                if (node.kind === 'if') return walk(truthy(value) ? node.children! : node.otherwise!, scope);
                const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const)
                    : value && typeof value === 'object' ? Object.entries(value) : [];
                if (!entries.length) return walk(node.otherwise!, scope);
                return entries.slice(0, 1000).map(([key, item], index) => {
                    const childScope = { ...scope, this: item, '@index': index, '@key': key };
                    // Render the parsed body under the iteration's local scope.
                    return renderNodes(node.children!, childScope, level + 1);
                }).join('');
            }
            if (node.macro === undefined) return node.raw;
            const parts = splitArguments(node.macro);
            const command = parts.shift()!.toLowerCase();
            if (/^(?:description|personality|scenario|persona|charprompt|charjailbreak|mesexamples|max(?:context|response|prompt)(?:tokens)?|(?:current|last)swipeid|first(?:included|displayed)messageid|allchatrange|input|lastgenerationtype|isodate|isotime|idle_duration|timediff|reverse|pick|roll)$|^(?:datetimeformat\s|time_utc[-+]|reverse:|pick\s*:|roll[\s:]|\/\/)/i.test(command)) {
                const standard = standardMacro(parts.length ? command : node.macro, parts.map(part => render(part, scope, level + 1)), ctx, rawText, node.offset ?? 0);
                if (standard !== undefined) return standard;
            }
            const basic: Record<string, unknown> = {
                user: ctx.userName || 'User', char: ctx.charName || 'Character',
                lastmessage: ctx.lastMessage ?? '', lastusermessage: ctx.lastUserMessage ?? '',
                lastcharmessage: ctx.lastCharMessage ?? '', model: ctx.modelName ?? '',
                ...(ctx.lastMessageId === undefined ? {} : { lastmessageid: ctx.lastMessageId }),
                newline: '\n', noop: '', empty: '',
            };
            if (Object.prototype.hasOwnProperty.call(basic, command)) return stringify(basic[command]);
            if (command === 'time') return new Date().toLocaleTimeString();
            if (command === 'date') return new Date().toLocaleDateString();
            if (command === 'weekday') return new Intl.DateTimeFormat('zh-CN', { weekday: 'long' }).format(new Date());
            if (command === 'random') {
                const choices = parts.map((p) => render(p, scope, level + 1));
                return choices[Math.floor(Math.random() * choices.length)] ?? '';
            }
            if (/^random\s*:/i.test(node.macro)) {
                const choices = node.macro.replace(/^random\s*:/i, '').split(/(?<!\\),/).map(choice => render(choice.trim().replaceAll('\\,', ','), scope, level + 1));
                return choices[Math.floor(Math.random() * choices.length)] ?? '';
            }
            const dice = /^roll(?:::|:)(\d+)d(\d+)$/i.exec(node.macro);
            if (dice) {
                let total = 0;
                for (let i = 0; i < Math.min(100, Math.max(1, Number(dice[1]))); i++) total += 1 + Math.floor(Math.random() * Math.min(1000, Math.max(2, Number(dice[2]))));
                return String(total);
            }
            if (/^(?:get|set|add|inc|dec)(?:global)?var$/.test(command)) {
                const isGlobal = command.includes('global');
                const root = isGlobal ? globals : variables;
                const key = render(parts.shift() ?? '', scope, level + 1).trim();
                if (!pathParts(key)) return node.raw;
                if (command.startsWith('get')) return stringify(getPath(root, key));
                const argument = render(parts.join('::'), scope, level + 1);
                let value: unknown = argument;
                if (!command.startsWith('set')) {
                    const previous = Number(getPath(root, key) ?? 0);
                    const delta = command.startsWith('inc') ? 1 : command.startsWith('dec') ? -1 : Number(argument);
                    if (!Number.isFinite(previous) || !Number.isFinite(delta)) return node.raw;
                    value = previous + delta;
                }
                const changedRoot = setPath(root, key, value);
                if (!changedRoot) return node.raw;
                (isGlobal ? ctx.onSetGlobalVariable : ctx.onSetVariable)?.(changedRoot, root[changedRoot]);
                return command.startsWith('inc') || command.startsWith('dec') ? stringify(value) : '';
            }
            const localValue = getPath(scope, node.macro);
            return localValue === undefined ? node.raw : stringify(localValue);
        }).join('');
        return walk(parseBlocks(tokenize(text)), locals);
    };
    const renderNodes = (nodes: MacroNode[], locals: Record<string, unknown>, level: number): string => {
        const source = (items: MacroNode[]): string => items.map((n) => n.kind
            ? `${n.raw}${source(n.children!)}${n.otherwise!.length ? `{{else}}${source(n.otherwise!)}` : ''}{{/${n.kind}}}` : n.raw).join('');
        return render(source(nodes), locals, level);
    };
    return applyVariableMacros(render(rawText), { global: globals, chat: variables, message: variables, ...ctx.variableScopes });
}

const compiledRegexes = new Map<string, RegExp>();
/** SillyTavern SCRIPT_TYPES order: GLOBAL, PRESET, SCOPED.
 * Preset filters must run before character rules expand text into HTML. */
export function orderedRegexScripts(global: RegexScriptRule[] = [], preset: RegexScriptRule[] = [], character: RegexScriptRule[] = []): RegexScriptRule[] {
    return [...global, ...preset, ...character];
}
function compiledRegex(pattern: string): RegExp {
    let regex = compiledRegexes.get(pattern);
    if (!regex) {
        // Community exports may leave whitespace outside /pattern/flags.
        // Preserve whitespace inside the expression and in bare patterns.
        const match = /^\s*\/([\s\S]*)\/([dgimsuvy]*)\s*$/.exec(pattern);
        regex = match ? new RegExp(match[1]!, match[2]) : new RegExp(pattern, 'g');
        if (compiledRegexes.size >= 256) compiledRegexes.delete(compiledRegexes.keys().next().value!);
        compiledRegexes.set(pattern, regex);
    }
    regex.lastIndex = 0;
    return regex;
}

export function applyRegexScripts(
    input: string,
    rules: RegexScriptRule[] = [],
    stageOrOpts: RegexPlacementStage | ApplyRegexOptions = 'output',
    depth = 0,
): string {
    if (!input || !Array.isArray(rules) || rules.length === 0) return input;
    const stage: RegexPlacementStage =
        typeof stageOrOpts === 'string'
            ? stageOrOpts
            : (stageOrOpts.stage ?? stageOrOpts.placement ?? 'output');
    const opts = typeof stageOrOpts === 'string' ? {} : stageOrOpts;
    const effectiveDepth = opts.depth ?? depth;
    const isPrompt = opts.isPrompt ?? stage === 'prompt';
    const isMarkdown = opts.isMarkdown ?? stage === 'render';
    const role = opts.role ?? (stage === 'input' || stage === 'user_input' ? 'user' : 'assistant');
    const activeRules = rules.filter(rule => regexRuleApplies(rule, { ...opts, stage, depth: effectiveDepth, isPrompt, isMarkdown, role }));
    let current = input;
    for (const rule of activeRules) {
        try {
            const context = opts.macroContext;
            const expand = (text: string) => context ? evaluateMacros(text, context) : text;
            let pattern = rule.findRegex;
            if (Number(rule.substituteRegex) && context) {
                if (Number(rule.substituteRegex) === 2) {
                    pattern = pattern.replace(/\{\{[^{}]*\}\}/g, macro => expand(macro).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'));
                } else pattern = expand(pattern);
            }
            const regex = compiledRegex(pattern);
            current = current.replace(regex, (...args: any[]) => {
                const named = typeof args.at(-1) === 'object' ? args.at(-1) : {};
                const captureCount = args.length - (typeof args.at(-1) === 'object' ? 3 : 2);
                const replacement = (rule.replaceString ?? '').replace(/\{\{match\}\}/gi, '$0')
                    .replace(/\$(\d+)|\$<([^>]+)>/g, (_token, index: string, name: string) => {
                        let capture = index !== undefined ? (Number(index) < captureCount ? args[Number(index)] : '') : named[name];
                        capture = typeof capture === 'string' ? capture : '';
                        for (const trim of rule.trimStrings ?? []) {
                            const value = expand(trim);
                            if (value) capture = capture.split(value).join('');
                        }
                        return capture;
                    });
                return expand(replacement);
            });
        } catch (error) {
            opts.onError?.(rule, error instanceof Error ? error : new Error(String(error)));
        }
    }
    return current;
}

export function regexRuleApplies(rule: RegexScriptRule, opts: ApplyRegexOptions): boolean {
    if (!rule || rule.disabled || !rule.findRegex) return false;
    const stage = opts.stage ?? 'render';
    const isPrompt = opts.isPrompt ?? stage === 'prompt';
    const isMarkdown = opts.isMarkdown ?? stage === 'render';
    const role = opts.role ?? 'assistant';
    const effectiveDepth = opts.depth ?? 0;
    const matchesPlacement = (placement: RegexPlacementStage): boolean => {
        if (placement === 'user_input') return role === 'user' && !['world_info', 'slash_command', 'reasoning'].includes(stage);
        if (placement === 'ai_output') return role === 'assistant' && !['world_info', 'slash_command', 'reasoning'].includes(stage);
        // Explicit processing stages remain distinct: output never consumes render.
        return placement === stage;
    };


        if (rule.promptOnly || rule.markdownOnly) {
            if (!(rule.promptOnly && isPrompt) && !(rule.markdownOnly && isMarkdown)) return false;
        } else if ((isPrompt || isMarkdown) && rule.rawData) return false;
        if (opts.isEdit && !rule.runOnEdit) return false;
        if (Array.isArray(rule.placement) && !rule.placement.some(matchesPlacement)) return false;
        if (!opts.ignoreDepth && rule.minDepth != null && effectiveDepth < rule.minDepth) return false;
        if (!opts.ignoreDepth && rule.maxDepth != null && rule.maxDepth >= 0 && effectiveDepth > rule.maxDepth) return false;
        return true;
}

const EMPTY_SLOT_ELEMENT = /<(div|section|span)\b(?![^>]*(?:\bstyle\s*=|\son[a-z]+\s*=|<%|\{\{|\[RENDER:|(?:javascript|data:text\/html)\s*:))[^>]*>(?:\s|<!--[\s\S]*?-->)*<\/\1\s*>/gi;

function stripEmptySlotPlaceholders(html: string): string {
    let current = html;
    for (let next = current.replace(EMPTY_SLOT_ELEMENT, ''); next !== current; next = current.replace(EMPTY_SLOT_ELEMENT, '')) {
        current = next;
    }
    return current;
}

export function isEmptySlotPlaceholder(html: string): boolean {
    if (!/<[a-z][\w-]*\b/i.test(html) || /<!doctype\s+html\b|<html\b|<body\b/i.test(html)) return false;
    return stripEmptySlotPlaceholders(html).replace(/<!--[\s\S]*?-->/g, '').trim() === '';
}

const VOID_HTML_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const ANCHORED_EMPTY_SLOT = /^(?:<(div|section|span)\b(?![^>]*(?:\bstyle\s*=|\son[a-z]+\s*=|<%|\{\{|\[RENDER:|(?:javascript|data:text\/html)\s*:))[^>]*>(?:\s|<!--[\s\S]*?-->)*<\/\1\s*>)/i;
const AUTHORED_TAG = /<(?:script\b|style\b|div\b|section\b|details\b|iframe\b)/i;

function keepEmptySlotWithScripts(slotHtml: string, hasScript: boolean, scriptBodies: string): boolean {
    if (!hasScript) return false;
    const openTag = /^<[^\s>]+\b([^>]*)>/.exec(slotHtml)?.[1] ?? '';
    if (/\bid\s*=/i.test(openTag)) return true;
    const dataAttrs = [...openTag.matchAll(/\b(data-[\w-]+)\b/gi)].map(match => match[1]);
    if (!dataAttrs.length) return true;
    return dataAttrs.some(attr => scriptBodies.includes(attr));
}

function splitTopLevelEmptySlots(content: string): Array<{ type: 'markdown' | 'mixed'; content: string }> {
    const segments: Array<{ type: 'markdown' | 'mixed'; content: string }> = [];
    const hasScript = /<script\b/i.test(content);
    const scriptBodies = hasScript
        ? [...content.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)].map(match => match[1]).join('\n')
        : '';
    const pushSegment = (text: string, forced?: 'markdown') => {
        if (!text.trim()) {
            const last = segments.at(-1);
            if (last) last.content += text;
            return;
        }
        const type = forced ?? (AUTHORED_TAG.test(stripEmptySlotPlaceholders(text)) ? 'mixed' : 'markdown');
        const last = segments.at(-1);
        if (last && last.type === type) last.content += text;
        else segments.push({ type, content: text });
    };
    const tokens = /<!--[\s\S]*?-->|<script\b[\s\S]*?<\/script\s*>|<style\b[\s\S]*?<\/style\s*>|<(\/?)([a-zA-Z][\w-]*)\b[^>]*>/gi;
    let depth = 0;
    let chunkStart = 0;
    for (let match: RegExpExecArray | null; (match = tokens.exec(content));) {
        const index = match.index;
        const full = match[0];
        if (full.startsWith('<!--') || /^<(?:script|style)\b/i.test(full)) continue;
        if (depth === 0 && !match[1]) {
            const slot = ANCHORED_EMPTY_SLOT.exec(content.slice(index));
            if (slot && !keepEmptySlotWithScripts(slot[0], hasScript, scriptBodies)) {
                if (index > chunkStart) pushSegment(content.slice(chunkStart, index));
                pushSegment(slot[0], 'markdown');
                chunkStart = index + slot[0].length;
                tokens.lastIndex = chunkStart;
                continue;
            }
        }
        if (match[1]) depth = Math.max(0, depth - 1);
        else if (!/\/>$/.test(full) && !VOID_HTML_TAGS.has(match[2].toLowerCase())) depth++;
    }
    if (chunkStart < content.length) pushSegment(content.slice(chunkStart));
    return segments.map(segment => ({ ...segment, content: segment.content.trim() })).filter(segment => segment.content.length > 0);
}

export function extractHtmlSandboxBlocks(markdown: string): Array<{ type: 'markdown' | 'html' | 'mixed'; content: string }> {
    const blocks: Array<{ type: 'markdown' | 'html' | 'mixed'; content: string }> = [];
    const appendText = (source: string) => {
        const content = source.trim();
        if (!content) return;
        const document = /^(?:<!doctype\s+html\b|<html\b)/i.test(content);
        const authored = AUTHORED_TAG.test(stripEmptySlotPlaceholders(content));
        if (document || !authored) {
            blocks.push({ type: document ? 'html' : 'markdown', content });
            return;
        }
        const split = splitTopLevelEmptySlots(content);
        blocks.push(...(split.length ? split : [{ type: 'mixed' as const, content }]));
    };
    const appendFormattedText = (source: string) => {
        // Prompt Template has already converted fences to HTML wrappers. Extract
        // complete author documents before a DOM parser discards their html/body
        // boundaries and lets their page-level CSS change surrounding prose.
        const documents = /<div class="tipsy-template-html">\s*((?:<!doctype\s+html\b[^>]*>\s*)?<html\b[\s\S]*?<\/html\s*>)\s*<\/div>|((?:<!doctype\s+html\b[^>]*>\s*)?<html\b[\s\S]*?<\/html\s*>)/gi;
        const wrapper = /^\s*(<div class=["']tipsy-template-message["'](?:\s[^>]*)?>)([\s\S]*)<\/div>\s*$/i.exec(source);
        const content = wrapper ? wrapper[2] : source;
        const appendFragment = (fragment: string) => {
            if (!fragment.trim()) return;
            if (!wrapper) { appendText(fragment); return; }
            const parts = splitTopLevelEmptySlots(fragment);
            if (!parts.some(part => part.type === 'markdown' && stripEmptySlotPlaceholders(part.content) !== part.content)) {
                appendText(`${wrapper[1]}${fragment}</div>`);
                return;
            }
            for (const part of parts) {
                blocks.push(part.type === 'mixed' ? { ...part, content: `${wrapper[1]}${part.content}</div>` } : part);
            }
        };
        let offset = 0;
        for (const match of content.matchAll(documents)) {
            appendFragment(content.slice(offset, match.index));
            blocks.push({ type: 'html', content: match[1] ?? match[2] });
            offset = match.index! + match[0].length;
        }
        appendFragment(content.slice(offset));
    };
    let offset = 0;
    for (const block of messageCodeBlocks(markdown)) {
        appendFormattedText(markdown.slice(offset, block.start));
        if (block.isHtml) {
            if (block.content) blocks.push({ type: 'html', content: block.content });
        } else blocks.push({ type: 'markdown', content: block.source });
        offset = block.end;
    }
    appendFormattedText(markdown.slice(offset));
    return blocks;
}
