import { satisfies, valid, validRange } from 'semver';

const utf8 = new TextEncoder();
export const hostApi = '1.2.0';
export function supportedHostApi(manifest) {
    const enhanced = (manifest.pipeline?.length || manifest.macros?.length || manifest.tools?.length || manifest.provides?.length || manifest.consumes?.length || manifest.origins?.length
        || manifest.events?.includes('story.changed') || manifest.commands?.some(command => command.surface || command.location === 'workspace')
        || manifest.permissions.some(permission => !['story.read', 'story.events', 'storage.device', 'storage.route', 'storage.reply', 'ui.panel', 'composer.draft', 'generation.contribute', 'resources.read'].includes(permission)));
    const director = manifest.permissions.some(permission => ['jobs.run', 'ui.export', 'ui.stage'].includes(permission)) || manifest.events?.includes('story.replyCheckpoint');
    if (!director && !enhanced && satisfies('1.0.0', manifest.hostApi)) return '1.0.0';
    if (!director && satisfies('1.1.0', manifest.hostApi)) return '1.1.0';
    return satisfies(hostApi, manifest.hostApi) ? hostApi : null;
}
export const guestExports = '__tipsy_plugin_exports__';
export const packageLimit = 2 * 1024 * 1024;
export const expandedLimit = 3 * 1024 * 1024;
export const entryLimit = 384 * 1024;
export const resourceLimit = 256 * 1024;
export const manifestLimit = 32 * 1024;
export const maxFiles = 64;
export const pathPattern = /^(?:[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\/)*[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/;
export const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
export const digest = async (bytes, subtle) => hex(new Uint8Array(await subtle.digest('SHA-256', bytes)));
export async function signedPayload(files, subtle) {
    const entries = await Promise.all(Object.keys(files).filter(name => name !== 'signature.json').sort().map(async name => [name, await digest(files[name], subtle)]));
    return utf8.encode(JSON.stringify(['TipsyIsle native plugin v1', entries]));
}

export function validSetting(field, value) {
    if (field.type === 'boolean') return typeof value === 'boolean';
    if (field.type === 'number') return typeof value === 'number' && Number.isFinite(value) && value >= (field.min ?? -Infinity) && value <= (field.max ?? Infinity);
    if (typeof value !== 'string' || value.length > 2000) return false;
    return field.type === 'text' || field.options?.some(option => option.value === value) === true;
}

export function validateManifestRelationships(manifest) {
    const distinct = (ids, name) => { if (ids.length !== new Set(ids).size) throw new Error(`${name}有重复标识`); };
    const paths = ['manifest.json', 'signature.json', ...Object.values(manifest.entrypoints), ...manifest.resources ?? []];
    distinct(paths.map(name => name.toLowerCase()), '插件文件');
    for (const name of paths) if (name.split('/').some(part => /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)|\.$/i.test(part))) throw new Error(`插件文件名不可移植：${name}`);
    distinct((manifest.commands ?? []).map(x => x.id), '插件操作');
    distinct((manifest.settings ?? []).map(x => x.id), '插件设置');
    for (const field of manifest.settings ?? []) {
        if (!validSetting(field, field.default)) throw new Error(`设置「${field.label}」的默认值不符合类型或范围`);
        if (field.options) distinct(field.options.map(x => x.value), `设置「${field.label}」的选项`);
    }
    if (manifest.events?.length && !manifest.permissions.includes('story.events')) throw new Error('订阅剧情事件需要 story.events 权限');
    if (manifest.generation && !manifest.permissions.includes('generation.contribute')) throw new Error('补充提示词需要 generation.contribute 权限');
    const need = (condition, permission) => { if (condition && !manifest.permissions.includes(permission)) throw new Error(`声明此能力需要 ${permission} 权限`); };
    need(manifest.pipeline?.length, 'generation.pipeline');
    need(manifest.commands?.some(command => command.surface && command.surface !== 'dialog'), 'ui.surface');
    need(manifest.tools?.length, 'generation.tools'); need(manifest.provides?.length, 'services.provide');
    need(manifest.consumes?.length, 'services.call'); need(manifest.origins?.length, 'network.request');
    if (manifest.macros?.length && !manifest.pipeline?.includes('beforeScan')) throw new Error('生成宏需要声明 beforeScan');
    distinct((manifest.tools ?? []).map(item => item.id), '模型工具');
    distinct((manifest.provides ?? []).map(item => item.id), '提供的服务');
    distinct((manifest.consumes ?? []).map(item => item.id), '依赖的服务');
    for (const item of manifest.provides ?? []) if (!item.id.startsWith(`${manifest.id}.`) || !valid(item.version)) throw new Error('服务标识必须以插件 ID 开头并声明有效版本');
    for (const item of manifest.consumes ?? []) if (!validRange(item.range)) throw new Error('服务依赖的版本范围无效');
    for (const value of manifest.origins ?? []) {
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol) || value !== url.origin) throw new Error('网络授权必须是精确的 HTTP(S) origin，不包含路径或凭据');
    }
}
