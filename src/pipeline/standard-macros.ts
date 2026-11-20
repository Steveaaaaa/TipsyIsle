import moment from 'moment';
import seedrandom from 'seedrandom';
import droll from 'droll';
import { contentHash } from './content-hash';

export interface StandardMacroContext {
    chatId?: string; maxContextTokens?: number; maxResponseTokens?: number;
    messageCount?: number; currentSwipe?: number; swipeCount?: number; firstIncludedMessage?: number; firstDisplayedMessage?: number;
    input?: string; generationType?: string; lastMessageTime?: number | string;
    characterDescription?: string; characterPersonality?: string; scenario?: string; personaDescription?: string;
    characterPrompt?: string; characterJailbreak?: string; examples?: string;
}

export function standardMacro(macro: string, parts: string[], context: StandardMacroContext, raw: string, offset: number): string | undefined {
    const command = macro.toLowerCase();
    const max = context.maxContextTokens, reply = context.maxResponseTokens;
    const values: Record<string, unknown> = {
        description: context.characterDescription, personality: context.characterPersonality, scenario: context.scenario,
        persona: context.personaDescription, charprompt: context.characterPrompt, charjailbreak: context.characterJailbreak, mesexamples: context.examples,
        maxcontext: max, maxcontexttokens: max, maxresponse: reply, maxresponsetokens: reply,
        maxprompt: max === undefined ? undefined : Math.max(0, max - (reply ?? 0)), maxprompttokens: max === undefined ? undefined : Math.max(0, max - (reply ?? 0)),
        currentswipeid: context.currentSwipe === undefined ? undefined : context.currentSwipe + 1,
        lastswipeid: context.swipeCount, firstincludedmessageid: context.firstIncludedMessage, firstdisplayedmessageid: context.firstDisplayedMessage ?? 0,
        allchatrange: context.messageCount ? `0-${context.messageCount - 1}` : '', input: context.input ?? '', lastgenerationtype: context.generationType ?? '',
    };
    // The first included floor is only known after context trimming.
    if (command === 'firstincludedmessageid' && context.firstIncludedMessage === undefined) return undefined;
    if (command === 'firstincludedmessageid' && context.firstIncludedMessage === -1) return '';
    if (Object.hasOwn(values, command)) return values[command] == null ? '' : String(values[command]);
    if (macro.startsWith('//')) return '';
    if (command === 'isodate') return moment().format('YYYY-MM-DD');
    if (command === 'isotime') return moment().format('HH:mm');
    if (command === 'idle_duration') return context.lastMessageTime ? moment.duration(moment().diff(moment(context.lastMessageTime))).humanize() : 'just now';
    if (command === 'timediff') return moment.duration(moment(parts[0]).diff(moment(parts[1]))).humanize(true);
    const date = /^datetimeformat\s+(.+)$/i.exec(macro); if (date) return moment().format(date[1]);
    const utc = /^time_UTC([-+]\d+)$/i.exec(macro); if (utc) return moment().utc().utcOffset(Number(utc[1])).format('LT');
    if (command === 'reverse' || /^reverse:/i.test(macro)) return Array.from(parts.length ? parts.join('::') : macro.slice(8)).reverse().join('');
    const roll = /^roll(?:\s+|:)(.*)$/i.exec(macro);
    if (roll || command === 'roll') {
        const formula = (roll?.[1] ?? parts.join('::')).replace(/^:/, '').trim();
        const result = droll.roll(/^\d+$/.test(formula) ? `1d${formula}` : formula);
        return result ? String(result.total) : '';
    }
    if (command === 'pick' || /^pick\s*:/i.test(macro)) {
        const list = parts.length ? parts : macro.replace(/^pick\s*::?/i, '').split(/(?<!\\),/).map(value => value.trim().replaceAll('\\,', ','));
        if (!list.length) return '';
        const random = seedrandom(contentHash(`${contentHash(context.chatId ?? '')}-${contentHash(raw)}-${offset}`));
        return list[Math.floor(random() * list.length)] ?? '';
    }
    return undefined;
}
