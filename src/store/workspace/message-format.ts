import { applyRegexScripts, evaluateMacros, orderedRegexScripts } from '../../pipeline/macro-regex-engine';
import { resolveMergedVariables, getScopedVariables } from '../scoped-variable-store';
import type { ChatMessageNode } from '../../types';
import { globalRegexes } from '../global-regex-store';
import { workspaceStore } from './state';
import { getActivePreset, getActiveCharacter } from './library';
import { getActiveChatMessages } from './queries';

export function formatMessageWithoutTemplate(node: ChatMessageNode): string {
    const state = workspaceStore.getState();
    const card = getActiveCharacter(state);
    const preset = getActivePreset(state);
    const scopedMessage = getScopedVariables('message', { messageId: node.id });
    const swipeMessage = (node.extra?.swipeVariables as Record<number, Record<string, unknown>> | undefined)?.[node.activeSwipeIndex];
    const messageVariables = Object.keys(scopedMessage).length > 0 ? scopedMessage : swipeMessage ?? {};
    const macroContext = {
        userName: state.userName,
        charName: card.name,
        variables: resolveMergedVariables({ presetId: preset.id, characterId: card.id, chatId: state.activeChatId, messageId: node.id, floor: node.floor }),
        globalVariables: getScopedVariables('global'),
        variableScopes: {
            global: getScopedVariables('global'), chat: getScopedVariables('chat', { chatId: state.activeChatId }), message: messageVariables,
            character: getScopedVariables('character', { characterId: card.id }), preset: getScopedVariables('preset', { presetId: preset.id }),
        },
        variableContext: {
            presetId: preset.id,
            characterId: card.id,
            chatId: state.activeChatId,
            messageId: node.id,
            floor: node.floor,
        },
    };
    const macroExpanded = node.content.split(/(<%[\s\S]*?%>)/g).map(part => part.startsWith('<%') ? part : evaluateMacros(part, macroContext)).join('');
    const depth = Math.max(0, getActiveChatMessages(state).length - 1 - node.floor);
    return applyRegexScripts(macroExpanded, orderedRegexScripts(globalRegexes(), preset.regexScripts, card.regexScripts), {
        stage: 'render', role: node.role, depth, macroContext,
    });
}
