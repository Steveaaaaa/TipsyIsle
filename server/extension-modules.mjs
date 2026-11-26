// Small host adapters. Unsupported named exports fail explicitly at import time.
export function extensionModule(pathname) {
    if (pathname === '/script.js') return `
const context = () => globalThis.__tipsyHostContext();
export let chat, chat_metadata, name1, name2, characters, this_chid, streamingProcessor, main_api;
function refresh() { const c=context(); chat=c.chat; chat_metadata=c.chatMetadata; name1=c.name1; name2=c.name2; characters=c.characters; this_chid=c.characterId; streamingProcessor=c.streamingProcessor; main_api=c.mainApi; }
refresh(); window.addEventListener('tipsy-host-context', refresh);
export const eventSource=context().eventSource, event_types=context().eventTypes;
export const getCurrentChatId=()=>context().getCurrentChatId();
export const getCharacterCardFields=()=>context().getCharacterCardFields();
export const getRequestHeaders=()=>context().getRequestHeaders();
export const getOneCharacter=(avatar)=>context().getOneCharacter(avatar);
export const selectCharacterById=(id,options)=>context().selectCharacterById(id,options);
export const reloadCurrentChat=()=>context().reloadCurrentChat();
export const doNewChat=(options)=>context().doNewChat(options);
export const isGenerating=()=>Boolean(context().isGenerating);
export const isStreamingEnabled=()=>Boolean(context().chatCompletionSettings?.stream_openai);
export const extension_prompts=context().extensionPrompts;
export const saveSettings=()=>context().saveSettings();
export const saveSettingsDebounced=()=>context().saveSettingsDebounced();
export const saveMetadata=()=>context().saveMetadata();
export const saveMetadataDebounced=()=>context().saveMetadataDebounced();
export const saveChat=(...args)=>context().saveChat(...args);
export const saveChatDebounced=()=>context().saveChatDebounced();
export const getMaxPromptTokens=()=>Number(context().chatCompletionSettings?.openai_max_context ?? 0);
export const setExtensionPrompt=(...args)=>context().setExtensionPrompt(...args);
export const extension_prompt_types={NONE:-1,IN_PROMPT:0,IN_CHAT:1,BEFORE_PROMPT:2};
export const extension_prompt_roles={SYSTEM:0,USER:1,ASSISTANT:2};
export const substituteParams=(text)=>globalThis.substitudeMacros(text);
export const substituteParamsExtended=(text)=>globalThis.substitudeMacros(text);
export const generateQuietPrompt=(text)=>globalThis.generateRaw({user_input:text,should_silence:true});
export const callPopup=(...args)=>context().callPopup(...args);
` ;
    if (pathname === '/scripts/popup.js') return `
const api=globalThis.__tipsyHostContext();
export const { Popup, PopupUtils, POPUP_TYPE, POPUP_RESULT, callGenericPopup, getTopmostModalLayer, fixToastrForDialogs }=api;
`;
    if (pathname === '/scripts/extensions.js') return `
const context=()=>globalThis.__tipsyHostContext();
export const getContext=context;
export const extension_settings=context().extensionSettings;
export const extensionTypes=context().extensionTypes;
export const findExtension=(id)=>context().findExtension(id);
export const saveMetadataDebounced=()=>context().saveMetadataDebounced();
`;
    if (pathname === '/scripts/world-info.js') return `
const context=()=>globalThis.__tipsyHostContext();
export const METADATA_KEY='world_info';
export const worldInfoCache=context().worldInfoCache;
export const originalWIDataKeyMap=context().originalWIDataKeyMap;
export const createWorldInfoEntry=(name,data)=>context().createWorldInfoEntry(name,data);
export const setWIOriginalDataValue=(data,uid,key,value)=>context().setWIOriginalDataValue(data,uid,key,value);
export const deleteWIOriginalDataValue=(data,uid)=>context().deleteWIOriginalDataValue(data,uid);
export const updateWorldInfoList=()=>context().updateWorldInfoList();
export const checkWorldInfo=(...args)=>context().checkWorldInfo(...args);
export const getWorldInfoPrompt=(...args)=>context().getWorldInfoPrompt(...args);
export const loadWorldInfo=(name)=>context().loadWorldInfo(name);
export const saveWorldInfo=(name,data,immediately=false)=>context().saveWorldInfo(name,data,immediately);
export const parseRegexFromString=(value)=>globalThis.builtin.parseRegexFromString(value);
export const world_info_position={before:0,after:1,ANTop:2,ANBottom:3,atDepth:4,EMTop:5,EMBottom:6,outlet:7};
export const world_info_logic={AND_ANY:0,NOT_ALL:1,NOT_ANY:2,AND_ALL:3};
export const world_info_insertion_strategy={evenly:0,character_first:1,global_first:2};
export let world_names=context().worldInfoNames, selected_world_info=context().selectedWorldInfo, world_info=context().worldInfo;
const refreshWorldInfo=()=>{world_names=context().worldInfoNames;selected_world_info=context().selectedWorldInfo;world_info=context().worldInfo;};
window.addEventListener('tipsy-host-worldbooks',refreshWorldInfo);
window.addEventListener('tipsy-host-context',refreshWorldInfo);
export const getWorldInfoSettings=()=>context().getWorldInfoSettings();
`;
    if (pathname === '/scripts/openai.js') return `
const context=()=>globalThis.__tipsyHostContext();
export let oai_settings=context().chatCompletionSettings;
window.addEventListener('tipsy-host-context',()=>{oai_settings=context().chatCompletionSettings;});
export const getChatCompletionModel=(settings)=>settings?.openai_model ?? context().getChatCompletionModel();
export const promptManager=context().promptManager;
`;
    if (pathname === '/scripts/extensions/regex/engine.js') return `
const context=()=>globalThis.__tipsyHostContext();
export const SCRIPT_TYPES={GLOBAL:0,SCOPED:1,PRESET:2};
export const getScriptsByType=(type,options)=>context().getRegexScriptsByType(type,options);
`;
    if (pathname === '/scripts/preset-manager.js') return `
const context=()=>globalThis.__tipsyHostContext();
export const getPresetManager=(apiId='openai')=>context().getPresetManager(apiId);
`;
    if (pathname === '/scripts/showdown-underscore.js') return `export const markdownUnderscoreExt=()=>[];`;
    if (pathname === '/scripts/showdown-exclusion.js') return `export const markdownExclusionExt=()=>[];`;
    if (pathname === '/scripts/power-user.js') return `
const context=()=>globalThis.__tipsyHostContext();
export const power_user=context().powerUserSettings;
export const fixMarkdown=(text)=>String(text??'');
`;
    if (pathname === '/scripts/user.js') return 'export const isAdmin=()=>globalThis.isAdmin();';
    if (pathname === '/scripts/slash-commands.js') return `const c=globalThis.__tipsyHostContext(); export const executeSlashCommands=c.executeSlashCommands; export const executeSlashCommandsWithOptions=c.executeSlashCommandsWithOptions; export const registerSlashCommand=c.registerSlashCommand;`;
    if (pathname === '/scripts/extensions/quick-reply/index.js') return 'export const quickReplyApi=globalThis.quickReplyApi;';
    const slash = pathname.match(/\/slash-commands\/([A-Za-z]+)\.js$/)?.[1];
    const modules = { SlashCommand: ['SlashCommand'], SlashCommandArgument: ['SlashCommandArgument','SlashCommandNamedArgument','ARGUMENT_TYPE'],
        SlashCommandScope:['SlashCommandScope'], SlashCommandClosure:['SlashCommandClosure'], SlashCommandParser:['SlashCommandParser'],
        SlashCommandAbortController:['SlashCommandAbortController','SlashCommandAbortSignal'], SlashCommandBreakController:['SlashCommandBreakController'], SlashCommandClosureResult:['SlashCommandClosureResult'] };
    if (modules[slash]) return modules[slash].map(name=>`export const ${name}=globalThis.${name};`).join('');
    return undefined;
}
