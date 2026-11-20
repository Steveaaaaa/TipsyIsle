import type { AssemblePromptInput } from './prompt-assembler';

function scriptTree(items: any): any {
    return Array.isArray(items) ? items.map(({ data: _data, scripts, ...script }) => ({ ...script, ...(scripts ? { scripts: scriptTree(scripts) } : {}) })) : items;
}
function resource(document: any): any {
    if (!document || typeof document !== 'object') return document;
    const { rawData, data, extensions, ...rest } = document;
    const nextExtensions = extensions ? { ...extensions } : undefined;
    for (const name of ['tavern_helper', 'TavernHelper']) if (nextExtensions?.[name]) {
        const { variables: _variables, scripts, ...helper } = nextExtensions[name];
        nextExtensions[name] = { ...helper, scripts: scriptTree(scripts) };
    }
    return { ...rest, ...(rawData ? { rawData: resource(rawData) } : {}), ...(data ? { data: resource(data) } : {}), ...(extensions ? { extensions: nextExtensions } : {}) };
}

const resourceKeys = new WeakMap<object, string>();
function resourceKey(value: any, stripVariables = false): string {
    if (!value || typeof value !== 'object') return JSON.stringify(value);
    let key = resourceKeys.get(value);
    if (key === undefined) {
        const text = JSON.stringify(stripVariables ? resource(value) : value);
        let left = 2166136261, right = 5381;
        for (let i = 0; i < text.length; i++) { left = Math.imul(left ^ text.charCodeAt(i), 16777619); right = Math.imul(right, 33) ^ text.charCodeAt(i); }
        key = `${text.length}:${left >>> 0}:${right >>> 0}`;
        resourceKeys.set(value, key);
    }
    return key;
}

/** Immutable documents are fingerprinted once, not serialized again on every
 * variable update or chat switch. Catalog changes still invalidate preparation. */
export function templatePreparationKey(input: AssemblePromptInput): string {
    return JSON.stringify([input.chatId, resourceKey(input.character, true), input.characterCatalog?.map(card => resourceKey(card, true)), resourceKey(input.preset, true),
        input.lorebooks.map(book => resourceKey(book)), input.lorebookCatalog?.map(book => resourceKey(book)), input.worldbookGroups, input.worldinfoSettings, input.userName, input.persona, input.modelName, input.templateFeatures, input.quickReplyConfig, input.globalRegexScripts?.map(rule => resourceKey(rule))]);
}
