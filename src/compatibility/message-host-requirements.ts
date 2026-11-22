import { regexRuleApplies } from '../pipeline/macro-regex-engine';
import type { NormalizedCharacterCard, RegexScriptRule } from '../types';

/** A script inside a regex widget can need the host even without Helper scripts. */
export function messageNeedsAuthorHost(source: string): boolean {
    return /\b(?:parent|top)\s*\.\s*(?:document\b|SillyTavern\b|TavernHelper\b|jQuery\b|\$|Mvu\b)|\b(?:SillyTavern|TavernHelper|Mvu)\s*\.|\b(?:getChatMessages|setChatMessages?|triggerSlash(?:WithResult)?|executeSlashCommands(?:WithOptions)?|waitGlobalInitialized|initializeGlobal|getVariables|getAllVariables|replaceVariables|updateVariablesWith|insertOrAssignVariables|insertVariables|deleteVariable|registerVariableSchema|registerMvuSchema|eventOn|eventOnce|eventMakeFirst|eventMakeLast|eventEmit(?:AndWait)?|tavern_events|iframe_events|getCurrentMessageId|getCurrentChatId|getLastMessageId|getWorldbook|replaceWorldbook|updateWorldbookWith|substitudeMacros|formatAsTavernRegexedString)\s*\(|\b(?:tavern_events|iframe_events)\s*\.|#send_textarea\b/.test(source);
}

const ruleNeedsHost = new WeakMap<RegexScriptRule, boolean>();
export function regexesNeedAuthorHost(rules: RegexScriptRule[] = []): boolean {
    return rules.some(rule => {
        const cached = ruleNeedsHost.get(rule);
        if (cached !== undefined) return cached;
        const rendered = (['assistant', 'user'] as const).some(role => regexRuleApplies(rule, { stage: 'render', role, ignoreDepth: true }));
        const needsHost = rendered && messageNeedsAuthorHost(rule.replaceString ?? '');
        ruleNeedsHost.set(rule, needsHost);
        return needsHost;
    });
}

const cardNeedsHost = new WeakMap<NormalizedCharacterCard, boolean>();
export function cardNeedsAuthorHost(card: NormalizedCharacterCard): boolean {
    const cached = cardNeedsHost.get(card);
    if (cached !== undefined) return cached;
    const needsHost = messageNeedsAuthorHost(card.firstMessage) || card.alternateGreetings.some(messageNeedsAuthorHost) || regexesNeedAuthorHost(card.regexScripts);
    cardNeedsHost.set(card, needsHost);
    return needsHost;
}
