import _ from 'lodash';

export function validateExtensionVariableId(id: unknown): asserts id is string {
    if (typeof id !== 'string' || !id || _.toPath(id).some((part: string) => ['__proto__', 'prototype', 'constructor'].includes(part))) throw new Error('扩展变量必须指定有效的 extension_id');
}

/** Like upstream extension_settings, extension IDs use lodash paths. */
export function readExtensionVariables(root: Record<string, unknown>, id: string): Record<string, any> {
    validateExtensionVariableId(id);
    return _.get(root, id, {});
}

export function writeExtensionVariables(root: Record<string, unknown>, id: string, value: Record<string, unknown>): void {
    validateExtensionVariableId(id);
    _.set(root, id, structuredClone(value));
}
