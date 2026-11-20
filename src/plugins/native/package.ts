import Ajv from 'ajv';
import { unzipSync } from 'fflate';
import { valid, validRange } from 'semver';
import manifestSchema from '../../../packages/plugin-sdk/manifest.schema.json';
import { digest, entryLimit, expandedLimit, hostApi, manifestLimit, maxFiles, packageLimit, pathPattern, resourceLimit, signedPayload, supportedHostApi, validateManifestRelationships } from '../../../packages/plugin-sdk/package-format.mjs';
import type { PluginManifest } from '../../../packages/plugin-sdk/index.js';

export interface PluginPackage {
    manifest: PluginManifest;
    fingerprint: string;
    digest: string;
    code: string;
    migration?: string;
    texts: Record<string, string>;
}

const decoder = new TextDecoder('utf-8', { fatal: true });
let validate: ReturnType<Ajv['compile']> | undefined;
const base64 = (text: string) => Uint8Array.from(atob(text), char => char.charCodeAt(0));

export async function inspectPluginPackage(file: File): Promise<PluginPackage> {
    if (!file.name.toLowerCase().endsWith('.tipsy-plugin')) throw new Error('请选择 .tipsy-plugin 插件包');
    if (file.size > packageLimit || file.size < 22) throw new Error('插件包大小无效（上限 2 MiB）');
    if (!globalThis.crypto?.subtle) throw new Error('插件签名验证需要在应用、本机地址或 HTTPS 下使用');
    const bytes = new Uint8Array(await file.arrayBuffer());
    let expanded = 0;
    const members = new Set<string>();
    const files = unzipSync(bytes, { filter({ name, originalSize, size, compression }) {
        if (!pathPattern.test(name) || name.length > 180 || name === '__proto__' || members.has(name.toLowerCase())) throw new Error(`插件包文件名无效：${name}`);
        members.add(name.toLowerCase());
        expanded += originalSize;
        const limit = name === 'manifest.json' || name === 'signature.json' ? manifestLimit : name.endsWith('.js') ? entryLimit : resourceLimit;
        if (members.size > maxFiles || expanded > expandedLimit || originalSize > limit || size > packageLimit || ![0, 8].includes(compression)
            || compression === 0 && size !== originalSize) throw new Error(`插件包文件超过配额：${name}`);
        return true;
    } });
    const read = (path: string) => {
        if (!Object.hasOwn(files, path)) throw new Error(`插件包缺少 ${path}`);
        return decoder.decode(files[path]);
    };
    const manifest = JSON.parse(read('manifest.json')) as PluginManifest;
    validate ??= new Ajv({ strict: true, allowUnionTypes: true, ownProperties: true }).compile(manifestSchema);
    if (!validate(manifest)) throw new Error(`插件清单无效：${validate.errors?.[0]?.instancePath || '/'} ${validate.errors?.[0]?.message ?? ''}`);
    validateManifestRelationships(manifest);
    if (!valid(manifest.version) || !validRange(manifest.hostApi)) throw new Error('插件版本或宿主 API 版本范围无效');
    if (!supportedHostApi(manifest)) throw new Error(`此插件需要宿主 API ${manifest.hostApi}，当前为 ${hostApi}`);
    const resources = manifest.resources ?? [];
    const declared = new Set(['manifest.json', 'signature.json', ...Object.values(manifest.entrypoints), ...resources]);
    if (declared.size !== members.size || [...declared].some(name => !Object.hasOwn(files, name))) throw new Error('插件包内容与清单不一致');
    if (resources.some(name => files[name].byteLength > resourceLimit)) throw new Error('插件资源超过配额');
    const proof = JSON.parse(read('signature.json'));
    if (proof?.algorithm !== 'ES256' || typeof proof.publicKey !== 'string' || proof.publicKey.length > 256 || typeof proof.signature !== 'string' || proof.signature.length > 128) throw new Error('插件缺少有效的发布者签名');
    const publicKey = base64(proof.publicKey);
    const subtle = crypto.subtle;
    const key = await subtle.importKey('spki', publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const payload = await signedPayload(files, subtle);
    if (!await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, base64(proof.signature), payload)) throw new Error('插件签名不匹配，文件可能已被修改');
    if (manifest.tools?.length) {
        const { checkToolSchema } = await import('./tool-schema');
        for (const tool of manifest.tools) await checkToolSchema(tool.parameters);
    }
    return { manifest, fingerprint: await digest(publicKey, subtle), digest: await digest(payload, subtle),
        code: read(manifest.entrypoints.main), migration: manifest.entrypoints.migrate ? read(manifest.entrypoints.migrate) : undefined,
        texts: Object.fromEntries(resources.map(path => [path, read(path)])) };
}
