import {
    deleteScopedVariableKey,
    getScopedVariables,
    insertOrAssignScopedVariables,
    scopedVariableStore,
} from '../store/scoped-variable-store';
import type { VariableScopeContext } from '../types';
import { executeSlashPipeline } from './slash-core';
import { findExecutableQuickReply, resolvedQuickReplyConfig } from './quick-reply';
import { readExtensionVariables } from '../compatibility/extension-variables';

export interface SlashHostCallbacks {
    onSend?: (text: string) => void | Promise<void>;
    onSendUserMessage?: (text: string) => void | Promise<void>;
    onSystemNotice?: (text: string) => void | Promise<void>;
    onEcho?: (text: string) => void;
    onTriggerGenerate?: (promptOverride?: string) => void | Promise<string | void>;
    scopeContext?: VariableScopeContext;
    variableContext?: VariableScopeContext;
    expand?: (text: string) => string;
}

export async function executeSlashScript(
    rawScript: string,
    callbacks: SlashHostCallbacks = {},
): Promise<string> {
    const ctx = callbacks.scopeContext || callbacks.variableContext || {};
    return executeSlashPipeline(rawScript, {
        variables: {
            get: (key, global) => getScopedVariables(global ? 'global' : 'chat', ctx)[key],
            set: (key, value, global) => { insertOrAssignScopedVariables({ [key]: value }, global ? 'global' : 'chat', ctx); },
            delete: (key, global) => { deleteScopedVariableKey(key, global ? 'global' : 'chat', ctx); },
        },
        echo: callbacks.onEcho, system: callbacks.onSystemNotice ?? callbacks.onEcho,
        send: callbacks.onSendUserMessage ?? callbacks.onSend, generate: callbacks.onTriggerGenerate,
        expand: callbacks.expand,
        quickReply: name => findExecutableQuickReply(resolvedQuickReplyConfig(readExtensionVariables(scopedVariableStore.getState().extension, 'quickReplyV2'), ctx.chatId, ctx.characterId), name),
    });
}

export const runSlashCommand = executeSlashScript;
