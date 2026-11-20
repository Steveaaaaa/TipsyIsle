import type { NormalizedCharacterCard } from '../types';
import { readCardScripts } from '../compatibility/contracts';

export interface CompatibilityFinding {
    path: string;
    capability: 'tavern-helper' | 'prompt-template' | 'worldbook' | 'regex';
    message: string;
}
export interface CardCompatibilityReport {
    entries: number;
    enabledEntries: number;
    regexRules: number;
    enabledScripts: number;
    findings: CompatibilityFinding[];
}

/** Read-only inventory; inspecting an asset never executes imported code. */
const reports = new WeakMap<NormalizedCharacterCard, CardCompatibilityReport>();
export function inspectCardCompatibility(card: NormalizedCharacterCard): CardCompatibilityReport {
    const cached = reports.get(card);
    if (cached) return cached;
    const findings: CompatibilityFinding[] = [];
    const book = card.characterBook ?? card.embeddedLorebook;
    const visit = (value: unknown, path: string) => {
        if (typeof value === 'string') {
            if (/\[(?:GENERATE|RENDER):|@INJECT\b|@@(?!private\b)[a-z_]+/i.test(value)) {
                findings.push({ path, capability: 'prompt-template', message: '依赖提示词模板加载器或装饰器；基础准备/生成/渲染阶段已接入，@INJECT/outlet 和全部插件配置仍需核对能力清单。' });
            }
            if (/\bTavernHelper\b|\bSillyTavern\b|<script\b/.test(value)) {
                findings.push({ path, capability: 'tavern-helper', message: '包含脚本或宿主访问；需结合运行时诊断确认接口与原酒馆 DOM 依赖，尚未完整兼容全部助手能力。' });
            }
        } else if (Array.isArray(value)) value.forEach((item, index) => visit(item, `${path}[${index}]`));
        else if (value && typeof value === 'object') {
            for (const [key, item] of Object.entries(value)) {
                if (/tavern[_-]?helper|TavernHelper|prompt[_-]?template|EjsTemplate/i.test(key)) {
                    findings.push({ path: `${path}.${key}`, capability: /template/i.test(key) ? 'prompt-template' : 'tavern-helper',
                        message: '扩展源码与配置已保留；当前兼容模块覆盖范围见能力清单，不等同于上游插件全部功能。' });
                }
                visit(item, `${path}.${key}`);
            }
        }
    };
    // Canonical raw document avoids traversing normalized aliases twice.
    visit({ fields: [card.description, card.personality, card.scenario, card.firstMessage, ...card.alternateGreetings,
        card.mesExample, card.systemPrompt, card.postHistoryInstructions, card.creatorNotes, card.depthPrompt?.prompt],
        extensions: card.extensions, entries: book?.entries.map(entry => ({ comment: entry.comment, content: entry.content })) }, '$');
    for (const rule of card.regexScripts) {
        try {
            const match = /^\/([\s\S]*)\/([dgimsuvy]*)$/.exec(rule.findRegex);
            new RegExp(match ? match[1]! : rule.findRegex, match ? match[2] : 'g');
        } catch {
            findings.push({ path: `regex.${rule.id}`, capability: 'regex', message: `正则「${rule.scriptName}」无法编译，执行时会跳过。` });
        }
        const raw = rule.rawData?.placement;
        if (Array.isArray(raw) && raw.some(p => ![0, 1, 2, 3, 5, 6, 'user_input', 'ai_output', 'slash_command', 'world_info', 'reasoning', 'input', 'output', 'prompt', 'render'].includes(p))) {
            findings.push({ path: `regex.${rule.id}.placement`, capability: 'regex', message: '包含未知的正则执行位置，原始值已保留。' });
        }
    }
    for (const entry of book?.entries ?? []) {
        const ext = entry.rawData?.extensions as Record<string, unknown> | undefined;
        if (entry.vectorized || entry.automationId || entry.triggers?.length || Object.entries(ext ?? {}).some(([key, value]) => /^match_(?:persona|character|scenario|creator)/.test(key) && value === true)) {
            findings.push({ path: `worldbook.${entry.uid}`, capability: 'worldbook', message: '包含尚未实现的向量、自动化、生成类型或额外扫描源条件；参数已保留。' });
        }
    }
    const report = { entries: book?.entries.length ?? 0, enabledEntries: book?.entries.filter(e => !e.disabled).length ?? 0,
        regexRules: card.regexScripts.length, enabledScripts: readCardScripts(card).filter(script => script.enabled).length, findings };
    reports.set(card, report);
    return report;
}
