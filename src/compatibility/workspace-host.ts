import { routesAt, swipeId } from '../store/chat-tree';
import { activePlugins, nativePluginStore } from '../plugins/native/catalog';
import { connectionStore } from '../plugins/native/connections';
import { openMessagePluginPicker } from '../plugins/native/PluginCommands';
import { readNativeAfterScan } from '../plugins/native/generation-stages';
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_RESPONSE_TOKENS } from '../core/generation-defaults';
import { helperRenderDepth } from './render-settings';
import { installCompatibilityHost, syncCompatibilityFrame, publishCompatibilityGenerationProgress, commandCompatibilityRuntime } from './runtime-client';
import { analyzeMvuReply } from './mvu-extra-analysis';
import { prepareTokenCounter, type TokenizerSelection } from '../pipeline/token-counter';
import { extensionCatalog, extensionCatalogStore, requestExtension } from './extension-host';
import { writeExtensionVariables, validateExtensionVariableId } from './extension-variables';
import { generateForHelper, stopHelperGeneration, helperModelList, proxyPresetSummaries } from './helper-generation';
import { worldbookBindings, requestWorldbook, worldinfoSettings } from './worldbook-host';
import { type CompatSnapshot } from './contracts';
import { baibaiBody, baibaiBundleIds, baibaiBundles, baibaiHash, baibaiLeaf, pruneBaibaiSummaries } from './baibai-route';
import { captureBaibaiVectorContext } from './baibai-vector-context';
import { compatibilityRouteAddress, compatibilityRouteIsReplacingState } from './route-address';
import { routeContent, routeMessageDataKey, routeMessageKey } from '../store/route-message-data';
import { messageExtra } from './chat-message-codec';
import {
    workspaceStore, authorMessageRevision, getActiveCharacter, getActiveChatMessages, getActiveLorebooks, getActivePreset, getActivePersona,
    formatMessageForDisplay, getMessageStreamPreview, getMessageComponentTargets, isMessageTemplatePending, appendChatMessage, editHelperChatMessage, deleteChatMessage, swipeChatMessage,
    sendUserMessageAndGenerate, stopActiveGeneration, setStatusBanner, saveHelperVariables, saveLegacyChat,
    persistWorkspaceNow, sealBranchPoint, retryStoryFrom,
    refreshMessageTemplates, refreshTemplateLifecycle, templateLifecycleKey, invalidateTemplateEnvironment,
    setHelperChatMessages, createHelperChatMessages, deleteHelperChatMessages, rotateHelperChatMessages,
    commitMvuInitialization,
    commitMvuMessage,
    reprocessLastMvuMessage,
    repairLastMvuMessage,
    getEffectiveMvuSettings,
    undoMvuRepair,
    createPromptAssemblyInput, commitPromptTask,
    getWorkspaceScriptTrees, getWorkspaceScripts, replaceWorkspaceScriptTrees,
    readHelperChatArchives, importHelperChat, selectCharacter,
} from '../store/workspace-store';
import { getScopedVariables, readScopedVariables, resolveMergedVariables, scopedVariableStore } from '../store/scoped-variable-store';
import { executeSlashScript } from '../sandbox/slash-interpreter';
import { evaluateMacros, regexRuleApplies } from '../pipeline/macro-regex-engine';
import { globalRegexes } from '../store/global-regex-store';
import { regexCatalog, replaceHostRegexes } from './regex-host';
import { assetCatalog, requestAsset } from './asset-host';
import { requestPersona } from './persona-host';
import { requestFile } from './file-host';
import { requestNativeResource } from './native-resource-host';
import { applyCompatibilityComposerWrite, compatibilityComposer, stageCompatibilityChoice, submitCompatibilityComposer } from './composer-bridge';
import { schemaRegistryStore } from '../registry/schema-registry';
import { cancelTavernCompletion, openTavernCompletion, readTavernCompletion } from './completion-http';
import { detectRuntimeFlavor } from '../core/platform-bridge';
import { commitNewChatOpening, startExtensionChat } from '../store/workspace/sessions';
import { commitWorkspaceMutation } from '../store/workspace/storage';
import { normalizeChatPayload } from '../pipeline/normalizer';
import { hostHiddenKey } from './chat-message-codec';
import type { VariableScopeContext, VariableScopeLevel } from '../types';

let revision = 0;
let legacySaveTail: Promise<unknown> = Promise.resolve();
let installed = false;
let initializedSession: string | undefined;
let templateEnvironmentRevision = 0;
let cachedBooks: CompatSnapshot['worldbooks'] = [];
let cachedBookSources: unknown[] = [];
let cachedRegex: ReturnType<typeof regexCatalog>;
let regexSources: unknown[] = [];
let lastScripts: ReturnType<typeof getWorkspaceScripts> | undefined;
let cachedScriptVariables: CompatSnapshot['scriptVariables'] = {};
let personaSources: unknown[] = [];
let cachedPersonas: CompatSnapshot['personas'] = [];
let depthSources: unknown[] = [];
let depthBoundaries: number[] = [];
const messageCache = new Map<string, { node: unknown; dependencies: unknown[]; value: CompatSnapshot['messages'][number] }>();
function context(): VariableScopeContext {
    const state = workspaceStore.getState();
    const last = getActiveChatMessages(state).at(-1);
    return { chatId: state.activeChatId, characterId: state.activeCharacterId, presetId: state.activePresetId, messageId: last?.id, floor: last?.floor };
}
let snapshotSources: unknown[] = [];
let cachedSnapshot: CompatSnapshot | undefined;
let nativeMenu: NonNullable<CompatSnapshot['nativeMessageMenu']> = [];
function snapshot(): CompatSnapshot {
    const state = workspaceStore.getState();
    const replacing = compatibilityRouteIsReplacingState(state);
    const sources = [replacing, state.branchEpoch, state.chatMetadata, state.characters, state.activeCharacterId, state.activeChatId, state.activeLeafId, authorMessageRevision(state.messages),
        state.presets, state.activePresetId, state.inUsePreset, state.lorebooks, state.activeLorebookIds,
        state.characterWorldbookBindings, state.chatWorldbookBindings, state.userName, state.personas, state.activePersonaId, state.storyPersona, state.storyCharacter, state.storyWorldbooks, state.storyCharacterBinding,
        state.isGenerating, state.helperGenerationCount, state.mvuExtraAnalysisActive, state.lastAssembledPrompt, state.templateRenderRevision, !!state.streamingReasoning, state.nativeToolPreview,
        scopedVariableStore.getState(), schemaRegistryStore.getState().values, extensionCatalogStore.getState(), connectionStore.getState().items, nativeMenu];
    if (cachedSnapshot && sources.every((value, index) => value === snapshotSources[index])) return cachedSnapshot;
    snapshotSources = sources;
    const ctx = context();
    const card = getActiveCharacter(state);
    const mvu = getEffectiveMvuSettings(state).settings;
    const books = getActiveLorebooks(state);
    if (books.length !== cachedBookSources.length || books.some((b, i) => b !== cachedBookSources[i])) {
        cachedBooks = books.map(book => ({ ...book, rawData: undefined })); cachedBookSources = books;
    }
    const variableState = scopedVariableStore.getState();
    const preset = getActivePreset(state);
    const settings = schemaRegistryStore.getState().values;
    const scripts = getWorkspaceScripts(state);
    if (scripts !== lastScripts) { lastScripts = scripts; cachedScriptVariables = Object.fromEntries(scripts.map(script => [script.id, script.data])); }
    const nextRegexSources = [state.characters, state.storyCharacter, state.presets, state.activePresetId, state.inUsePreset, variableState.extension.tipsy_regex];
    if (!cachedRegex || nextRegexSources.some((value, index) => value !== regexSources[index])) { cachedRegex = regexCatalog(); regexSources = nextRegexSources; }
    const activeMessages = getActiveChatMessages(state);
    const globalRules = globalRegexes();
    const depthInputs = [globalRules, preset.regexScripts, card.regexScripts];
    if (depthInputs.some((value, index) => value !== depthSources[index])) {
        depthSources = depthInputs;
        const rules = [...globalRules, ...preset.regexScripts ?? [], ...card.regexScripts ?? []];
        depthBoundaries = [...new Set(rules.filter(rule => (['assistant', 'user', 'system'] as const).some(role =>
            regexRuleApplies(rule, { stage: 'render', role, ignoreDepth: true })))
            .flatMap(rule => [rule.minDepth ?? 0, rule.maxDepth != null && rule.maxDepth >= 0 ? rule.maxDepth + 1 : 0])
            .filter(depth => depth > 0))].sort((left, right) => left - right);
    }
    const messages = activeMessages.map(node => {
        const content = routeContent(node, state.chatMetadata);
        const routeCount = routesAt(state.messages, node.id).length;
        const depth = activeMessages.length - 1 - node.floor;
        const boundary = depthBoundaries.findIndex(value => value > depth);
        const dependencies = [routeCount, variableState.global, variableState.preset[state.activePresetId], variableState.character[card.id], variableState.chat[state.activeChatId], variableState.message[node.id],
            card, preset, globalRules, variableState.extension.EjsTemplate, books, state.userName, state.activeChatId, boundary, state.templateRenderRevision,
            !!node.extra?.tipsy_generation_incomplete && (state.isGenerating || state.helperGenerationCount > 0),
            !node.content && !!state.streamingReasoning, state.nativeToolPreview?.id === node.id ? state.nativeToolPreview : undefined, content];
        const old = messageCache.get(node.id);
        if (old?.node === node && old.dependencies.every((value, i) => value === dependencies[i])) return old.value;
        const formatted = formatMessageForDisplay(node);
        const templatePending = isMessageTemplatePending(node);
        const streamPreview = getMessageStreamPreview(node);
        const { branchStates, branchBases, nativePluginReplies, nativePluginOpeningRoutes, ...publicNode } = node;
        const value = { ...publicNode, content, routeCount, formatted, templatePending, streamPreview, streamStatus: streamPreview?.status, componentTargets: streamPreview ? undefined : getMessageComponentTargets(node), variables: readScopedVariables('message', { ...ctx, messageId: node.id }) };
        messageCache.set(node.id, { node, dependencies, value });
        return value;
    });
    const messageIds = new Set(messages.map(message => message.id));
    for (const key of messageCache.keys()) if (!messageIds.has(key)) messageCache.delete(key);
    const persona = getActivePersona(state);
    if (personaSources[0] !== state.personas || personaSources[1] !== persona) {
        personaSources = [state.personas, persona];
        cachedPersonas = persona ? [...state.personas.filter(item => item.avatar_id !== persona.avatar_id), persona] : state.personas;
    }
    const leaves = new Set<string>();
    if (state.chatMetadata?.baibai_book) for (const node of activeMessages) {
        const extra = messageExtra(node, node.activeSwipeIndex, state.chatMetadata);
        const leaf = baibaiLeaf(extra, node.activeSwipeIndex);
        if (leaf) leaves.add(leaf.id);
    }
    const route = compatibilityRouteAddress(state);
    return cachedSnapshot = {
        session: state.activeChatId, branchEpoch: state.branchEpoch, revision: ++revision, character: { id: card.id, name: card.name }, userName: state.userName,
        routeId: route.routeId, routeReplacing: replacing,
        chatMetadata: pruneBaibaiSummaries(state.chatMetadata, leaves),
        generating: state.isGenerating || state.helperGenerationCount > 0, assembledMessages: state.lastAssembledPrompt?.messages ?? [],
        nativeMessageMenu: nativeMenu,
        modelSettings: { source: String(settings['api.chat_completion_source'] ?? 'openai'), model: String(settings['api.model'] ?? ''), stream: settings['api.stream'] !== false,
            maxContext: Number(settings['sampler.context_max_tokens'] ?? preset.maxContextTokens ?? DEFAULT_CONTEXT_TOKENS), maxResponse: Number(settings['sampler.max_tokens'] ?? preset.maxResponseTokens ?? DEFAULT_RESPONSE_TOKENS) },
        mvuExtraAnalysisActive: state.mvuExtraAnalysisActive,
        helperRenderDepth: helperRenderDepth(settings['helper.render_depth']),
        mvuSettings: { updateChat: mvu['mvu.update_chat'] === true, sendasAssistant: mvu['mvu.sendas_assistant'] === true,
            notifyLoading: mvu['mvu.notify_loading'] !== false, notifyInitialized: mvu['mvu.notify_initialized'] !== false, notifyError: mvu['mvu.notify_error'] === true },
        extensions: extensionCatalog(),
        messages,
        scopes: Object.fromEntries(['global', 'preset', 'character', 'chat', 'message'].map(level => [level, readScopedVariables(level as VariableScopeLevel, ctx)])) as CompatSnapshot['scopes'],
        worldbooks: cachedBooks,
        worldbookBindings: worldbookBindings(),
        worldinfoSettings: worldinfoSettings(),
        scriptVariables: cachedScriptVariables,
        scriptTrees: getWorkspaceScriptTrees(state),
        extensionVariables: variableState.extension,
        regexCatalog: cachedRegex,
        assetCatalog: assetCatalog(),
        personas: cachedPersonas,
        activePersonaId: persona?.avatar_id ?? state.activePersonaId,
        proxyPresets: proxyPresetSummaries(),
    };
}
export function installWorkspaceCompatibility(): void {
    if (installed) return;
    installed = true;
    installCompatibilityHost({
        session: () => workspaceStore.getState().activeChatId,
        snapshot,
        scripts: () => getWorkspaceScripts(),
        diagnostic: item => setStatusBanner(`兼容运行${item.level === 'error' ? '错误' : '提示'} · ${item.name}：${item.message.slice(0, 500)}`, { kind: item.level === 'error' ? 'error' : 'info' }),
        request: async (method, params) => {
            if (method === 'worldbook.scan') return (await import('./worldbook-scan')).scanCompatibilityWorldbooks(params);
            if (method === 'extension.memoryVector') {
                const binding = params.action === 'status' ? undefined : captureBaibaiVectorContext();
                return (await import('./memory-vector-host')).handleMemoryVectorRequest(params.action, params.body, binding);
            }
            if (method.startsWith('asset.')) return requestAsset(method, params);
            if (method.startsWith('persona.')) return requestPersona(method.slice(8), params);
            if (method.startsWith('file.')) return requestFile(method.slice(5), params);
            if (method === 'extensions.manage') return requestExtension(params);
            if (method.startsWith('worldbook.')) return requestWorldbook(method, params);
            const ctx = context();
            switch (method) {
                case 'extension.illustration.open': window.dispatchEvent(new CustomEvent('tipsy-extension-illustration', { detail: String(params.id) })); return;
                case 'extension.media': {
                    const path = String(params.path);
                    if (!/^\/api\/(images\/(?:upload|folders|list(?:\/[^/]+)?|delete)|files\/(?:upload|delete|verify))$/.test(path)) throw new Error('无效的扩展媒体接口');
                    const flavor = await detectRuntimeFlavor();
                    if (flavor === 'tauri-native') {
                        const { nativeExtensionMedia } = await import('./native-extension-files');
                        const body = await nativeExtensionMedia(path, params.body);
                        return { status: path.endsWith('/delete') && !Array.isArray(body) && body.ok === false ? 404 : 200, body };
                    }
                    if (flavor !== 'local-gateway') return { status: 501, body: { error: '当前平台未接入扩展媒体存储' } };
                    const response = await fetch(`/api/tipsy-isle/extensions/media/${path.slice(5)}`, {
                        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params.body),
                    });
                    return { status: response.status, body: await response.json() };
                }
                case 'extension.completion.open': return openTavernCompletion(params.id, params.path, params.body, params.useCurrent === true);
                case 'extension.completion.read': return readTavernCompletion(params.id);
                case 'extension.completion.cancel': return cancelTavernCompletion(params.id);
                case 'extension.interceptorInput': {
                    const state = workspaceStore.getState();
                    return { globalRegexScripts: globalRegexes(), presetRegex: getActivePreset(state).regexScripts,
                        characterRegex: getActiveCharacter(state).regexScripts, initialVariables: resolveMergedVariables(ctx),
                        initialGlobalVariables: getScopedVariables('global') };
                }
                case 'host.http': return requestNativeResource(String(params.path), params.body);
                case 'host.character.select': {
                    const state = workspaceStore.getState();
                    const card = typeof params.id === 'number' || /^\d+$/.test(String(params.id)) ? state.characters[Number(params.id)]
                        : state.characters.find(card => card.id === params.id);
                    if (!card) throw new Error('角色索引不存在');
                    if (state.isGenerating) throw new Error('生成期间不能切换角色');
                    await selectCharacter(card.id);
                    await persistWorkspaceNow();
                    return;
                }
                case 'runtime.ready': {
                    initializedSession = workspaceStore.getState().activeChatId;
                    templateEnvironmentRevision++;
                    previousTemplateKey = '';
                    const session = initializedSession, environment = templateEnvironmentRevision;
                    templateRefreshRunning = true;
                    try {
                        while (initializedSession === session && environment === templateEnvironmentRevision) {
                            if (await refreshTemplateLifecycle()) { previousTemplateKey = templateLifecycleKey(); break; }
                            await new Promise(resolve => setTimeout(resolve, 32));
                        }
                        syncCompatibilityFrame();
                    } finally { templateRefreshRunning = false; }
                    return;
                }
                case 'runtime.sync': return undefined;
                case 'story.seal': sealBranchPoint(params.replace === true); await persistWorkspaceNow(); return;
                case 'story.routes': window.dispatchEvent(new CustomEvent('tipsy-open-branches', { detail: { messageId: params.id } })); return;
                case 'nativePlugins.message': openMessagePluginPicker(params.id, params.swipe, params.updatedAt); return;
                case 'story.retry': return retryStoryFrom(params.id, undefined, true);
                case 'extensions.settings': {
                    if (!Object.keys(params.settings).length && !params.removed?.length) return;
                    const current = scopedVariableStore.getState().extension.tipsy_host_settings ?? {};
                    const values = { ...(current.values as Record<string, unknown> ?? {}) };
                    const removed = new Set(current.removed as string[] ?? []);
                    for (const id of [...Object.keys(params.settings), ...params.removed ?? []]) validateExtensionVariableId(id);
                    scopedVariableStore.setState(draft => {
                        for (const [id, value] of Object.entries(params.settings)) {
                            removed.delete(id);
                            if (value && typeof value === 'object' && !Array.isArray(value)) {
                                writeExtensionVariables(draft.extension, id, value as Record<string, unknown>); delete values[id];
                            } else values[id] = value;
                        }
                        for (const id of params.removed ?? []) { removed.add(id); delete values[id]; }
                        draft.extension.tipsy_host_settings = { values, removed: [...removed] };
                    });
                    await persistWorkspaceNow(); return;
                }
                case 'runtime.refresh': await refreshMessageTemplates(); return;
                case 'mvu.initialize': return commitMvuInitialization(params as Parameters<typeof commitMvuInitialization>[0]);
                case 'mvu.message.commit': return commitMvuMessage(params.expected, params.result);
                case 'mvu.message.analyze': {
                    const node = getActiveChatMessages().find(message => message.id === params.expected.id);
                    if (workspaceStore.getState().activeChatId !== params.expected.session || !node || node.activeSwipeIndex !== params.expected.swipe || node.content !== params.expected.content) throw new Error('额外解析所属消息已改变');
                    return analyzeMvuReply(node.content, params.before, new AbortController().signal, false, undefined, node.id);
                }
                case 'mvu.reprocess': return reprocessLastMvuMessage(params.extra === true);
                case 'mvu.repair': return repairLastMvuMessage(String(params.direction ?? ''));
                case 'mvu.repair.undo': return undoMvuRepair();
                case 'template.input': return createPromptAssemblyInput();
                case 'nativePlugins.afterScan': return readNativeAfterScan(params.id, params.activations, params.count);
                case 'regex.replace': await replaceHostRegexes(params.regexes, params.option); return;
                case 'scripts.replace': replaceWorkspaceScriptTrees(params.trees, params.type); await persistWorkspaceNow(); return;
                case 'chat.archives': return readHelperChatArchives(params.characterId, params.files);
                case 'chat.import': return importHelperChat(params.content);
                case 'template.commit': {
                    await commitPromptTask(params.result, params.expected); return;
                }
                case 'template.save': await persistWorkspaceNow(); return;
                case 'runtime.timeout': setStatusBanner('兼容运行环境初始化超时，请确认 5181 服务已启动并刷新页面。'); return undefined;
                case 'runtime.disconnect':
                    cancelTavernCompletion();
                    if (initializedSession === params.session) initializedSession = undefined;
                    templateEnvironmentRevision++;
                    invalidateTemplateEnvironment();
                    previousTemplateKey = '';
                    return stopHelperGeneration(undefined, params.session);
                case 'variables.replace': {
                    if (params.messageTarget) {
                        const floor = params.option?.message_id === undefined || params.option?.message_id === 'latest' ? -1 : Number(params.option.message_id);
                        const node = getActiveChatMessages().at(floor);
                        if (!node || node.id !== params.messageTarget.id || node.activeSwipeIndex !== params.messageTarget.swipe) throw new Error('变量写入期间消息或 swipe 已切换，请重试操作');
                    }
                    const result = saveHelperVariables(params.variables, params.option);
                    await persistWorkspaceNow(); return result;
                }
                case 'legacy.save': {
                    const session = workspaceStore.getState().activeChatId, epoch = workspaceStore.getState().branchEpoch;
                    const saved = legacySaveTail.then(() => commitWorkspaceMutation(() => {
                        const current = workspaceStore.getState();
                        if (current.activeChatId !== session || current.branchEpoch !== epoch) throw new Error('保存所属路线已切换');
                        saveLegacyChat(params.messageState ?? [], params.variables, params.metadata);
                    }));
                    legacySaveTail = saved.catch(() => {});
                    await saved;
                    return;
                }
                case 'legacy.newChat': {
                    if (params.deleteCurrentChat === true) throw new Error('兼容接口仅支持保留原会话');
                    cancelTavernCompletion();
                    stopHelperGeneration(undefined, workspaceStore.getState().activeChatId);
                    const session = await startExtensionChat();
                    initializedSession = session; templateEnvironmentRevision++; previousTemplateKey = '';
                    return session;
                }
                case 'legacy.sendAs': return createHelperChatMessages([{ ...params.message, role: 'assistant' }], {}, true);
                case 'legacy.commitOpening': {
                    const state = workspaceStore.getState();
                    const hidden: Record<string, boolean> = {};
                    const scopedMessages: Record<string, { memoryBody: string }> = {};
                    const messages = normalizeChatPayload(params.rows.map((row: any) => {
                        const active = Number.isInteger(row.swipe_id) ? row.swipe_id : 0;
                        const swipes = Array.isArray(row.swipes) && row.swipes.length ? [...row.swipes] : [row.mes ?? ''];
                        swipes[Math.max(0, Math.min(swipes.length - 1, active))] = row.mes ?? '';
                        return { ...row, mes: row.mes ?? '', swipes, is_system: row.role === 'system', uid: `msg_${crypto.randomUUID()}` };
                    }));
                    for (const [index, node] of messages.entries()) {
                        const row = params.rows[index], parent = messages[index - 1];
                        if (parent) node.parentSwipeId = swipeId(parent);
                        node.extra = { ...node.extra, helperSwipeInfo: { ...row.swipe_info, [node.activeSwipeIndex]: row.extra ?? {} } };
                        if (row.is_system) hidden[swipeId(node)] = true;
                        if (baibaiLeaf(row.extra ?? {}, node.activeSwipeIndex)) scopedMessages[routeMessageKey(node)] = { memoryBody: baibaiHash(baibaiBody(node.content)) };
                    }
                    const metadata: Record<string, unknown> = { ...params.metadata, [hostHiddenKey]: hidden, [routeMessageDataKey]: scopedMessages };
                    if (Object.hasOwn(metadata, baibaiBundles)) metadata[baibaiBundles] = baibaiBundleIds(metadata).filter(hash => params.allowedBundles.includes(hash));
                    return commitNewChatOpening(state.activeChatId, params.opening, messages, metadata, params.variables);
                }
                case 'chat.setMessage': return editHelperChatMessage(params.floor, params.message, params.options);
                case 'chat.setMessages': {
                    return setHelperChatMessages(params.messages, params.options);
                }
                case 'chat.createMessages': return createHelperChatMessages(params.messages, params.options);
                case 'chat.deleteMessages': return deleteHelperChatMessages(params.ids, params.options);
                case 'chat.rotateMessages': return rotateHelperChatMessages(params.begin, params.middle, params.end, params.options);
                case 'chat.delete': {
                    const node = getActiveChatMessages().find(m => m.floor === Number(params.floor));
                    if (!node) throw new Error('消息楼层不存在');
                    await deleteChatMessage(node.id, true); return true;
                }
                case 'chat.swipe': {
                    const node = getActiveChatMessages().find(m => m.floor === Number(params.floor));
                    if (!node) throw new Error('消息楼层不存在');
                    await swipeChatMessage(node.id, params.direction, true); return true;
                }
                case 'composer.input': return compatibilityComposer(params.text);
                case 'composer.write': return applyCompatibilityComposerWrite(params.text, params.previous);
                case 'composer.choice': return stageCompatibilityChoice(params.text, params.placement, params.separator);
                case 'composer.send': return submitCompatibilityComposer(String(params.text ?? compatibilityComposer()));
                case 'composer.focus': document.getElementById('tipsy-chat-composer')?.focus(); return;
                case 'slash.generate': return sendUserMessageAndGenerate(params.text, params.generationType);
                case 'slash.stop': stopActiveGeneration(); return;
                case 'slash.error': setStatusBanner(`角色互动生成失败：${String(params.message)}`); return;
                case 'slash.trigger': return executeSlashScript(params.command, {
                    variableContext: ctx, onEcho: setStatusBanner,
                    expand: text => evaluateMacros(text, { userName: workspaceStore.getState().userName, charName: getActiveCharacter().name,
                        lastMessageId: getActiveChatMessages().length - 1, variables: getScopedVariables('chat', ctx), globalVariables: getScopedVariables('global') }),
                    onSendUserMessage: text => { appendChatMessage('user', text); },
                    onSystemNotice: text => { appendChatMessage('system', text); },
                    onTriggerGenerate: sendUserMessageAndGenerate,
                });
                case 'generation.generate': return generateForHelper(params.options, false, publishCompatibilityGenerationProgress, params.injections);
                case 'generation.generateRaw': return generateForHelper(params.options, true, publishCompatibilityGenerationProgress, params.injections);
                case 'generation.stop': return stopHelperGeneration(params.id, workspaceStore.getState().activeChatId);
                case 'generation.models': return helperModelList(params.api);
                case 'generation.tokens': {
                    const settings = schemaRegistryStore.getState().values;
                    const counter = await prepareTokenCounter(String(settings['api.model'] ?? ''), (settings['sampler.tokenizer'] ?? 'auto') as TokenizerSelection);
                    return counter(String(params.text ?? ''));
                }
                default: throw new Error(`兼容宿主尚未实现接口：${method}`);
            }
        },
    });
    let queued = false;
    let templateRefreshQueued = false;
    let templateRefreshRunning = false;
    let previousTemplateKey = '';
    const schedule = () => {
        if (queued) return;
        queued = true;
        setTimeout(() => { queued = false; syncCompatibilityFrame(); }, 32);
    };
    const scheduleTemplates = () => {
        if (initializedSession !== workspaceStore.getState().activeChatId || templateRefreshQueued || templateRefreshRunning || workspaceStore.getState().isGenerating) return;
        templateRefreshQueued = true;
        setTimeout(() => {
            templateRefreshQueued = false;
            if (initializedSession !== workspaceStore.getState().activeChatId || templateRefreshRunning || workspaceStore.getState().isGenerating) return;
            const key = templateLifecycleKey();
            if (key === previousTemplateKey) return;
            previousTemplateKey = key;
            const environment = templateEnvironmentRevision;
            templateRefreshRunning = true;
            void refreshTemplateLifecycle().then(completed => { if (environment === templateEnvironmentRevision && !completed) previousTemplateKey = ''; })
                .catch(error => {
                    if (environment === templateEnvironmentRevision) setStatusBanner(`模板阶段执行失败：${error instanceof Error ? error.message : String(error)}`);
                })
                .finally(() => {
                    templateRefreshRunning = false;
                    // Keep the key that actually ran. Writes arriving during the
                    // task must schedule another pass, not be marked processed.
                    if (templateLifecycleKey() !== previousTemplateKey) scheduleTemplates();
                });
        }, 100);
    };
    workspaceStore.subscribe((state, previous) => {
        schedule();
        if (state.characters !== previous.characters || state.lorebooks !== previous.lorebooks || authorMessageRevision(state.messages) !== authorMessageRevision(previous.messages) ||
            state.characterWorldbookBindings !== previous.characterWorldbookBindings || state.chatWorldbookBindings !== previous.chatWorldbookBindings ||
            state.activeLorebookIds !== previous.activeLorebookIds || state.activeChatId !== previous.activeChatId || state.activeLeafId !== previous.activeLeafId ||
            state.isGenerating !== previous.isGenerating || state.presets !== previous.presets || state.inUsePreset !== previous.inUsePreset || state.activePresetId !== previous.activePresetId || state.userName !== previous.userName || state.personas !== previous.personas || state.activePersonaId !== previous.activePersonaId) scheduleTemplates();
    });
    scopedVariableStore.subscribe(() => { schedule(); scheduleTemplates(); });
    schemaRegistryStore.subscribe((state, previous) => {
        schedule(); scheduleTemplates();
        if (initializedSession !== workspaceStore.getState().activeChatId || state.values === previous.values) return;
        const notify = (name: string, value?: unknown) => void commandCompatibilityRuntime('event', [name, ...(value === undefined ? [] : [value])])
            .catch(error => setStatusBanner(`设置事件：${String(error)}`));
        if (state.values['api.chat_completion_source'] !== previous.values['api.chat_completion_source']) notify('chatcompletion_source_changed', state.values['api.chat_completion_source']);
        if (state.values['api.model'] !== previous.values['api.model']) notify('chatcompletion_model_changed', state.values['api.model']);
        notify('settings_updated');
    });
    extensionCatalogStore.subscribe(schedule);
    connectionStore.subscribe(schedule);
    nativePluginStore.subscribe((state, previous) => {
        if (state.catalog === previous.catalog && state.maintenance === previous.maintenance) return;
        const rules = activePlugins().flatMap(plugin => plugin.manifest.commands?.filter(item => item.location === 'message').map(item => ({ role: item.role, latestOnly: item.latestOnly })) ?? []);
        if (JSON.stringify(rules) !== JSON.stringify(nativeMenu)) { nativeMenu = rules; schedule(); }
    });
}
