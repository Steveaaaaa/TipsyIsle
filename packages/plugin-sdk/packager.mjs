import { generateKeyPairSync, createPrivateKey, createPublicKey, sign, webcrypto } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Ajv from 'ajv';
import { build } from 'esbuild';
import { zipSync } from 'fflate';
import { valid, validRange } from 'semver';
import { entryLimit, expandedLimit, guestExports, hostApi, manifestLimit, maxFiles, packageLimit, resourceLimit, signedPayload, supportedHostApi, validateManifestRelationships } from './package-format.mjs';

const encode = text => new TextEncoder().encode(text);
const utf8 = new TextDecoder('utf-8', { fatal: true });
const manifestSchema = JSON.parse(await readFile(new URL('./manifest.schema.json', import.meta.url), 'utf8'));
const validate = new Ajv({ strict: true, allowUnionTypes: true, ownProperties: true }).compile(manifestSchema);

export async function keygen(filename) {
    if (!filename.endsWith('.pem') && !filename.endsWith('.key')) throw new Error('私钥文件请用 .pem 或 .key 扩展名');
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 });
    console.log(`已创建发布者私钥：${path.resolve(filename)}`);
}

export async function pack(folder, filename, out, outputDirectory = '.') {
    const directory = path.resolve(folder);
    const manifestFile = path.join(directory, 'manifest.json');
    if ((await stat(manifestFile)).size > manifestLimit) throw new Error('插件清单超过大小限制');
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    if (!validate(manifest)) throw new Error(`插件清单无效：${validate.errors[0].instancePath || '/'} ${validate.errors[0].message}`);
    validateManifestRelationships(manifest);
    if (!valid(manifest.version) || !validRange(manifest.hostApi)) throw new Error('插件版本号或宿主 API 版本范围无效');
    if (!supportedHostApi(manifest)) throw new Error(`当前打包工具适配宿主 API ${hostApi}，插件要求 ${manifest.hostApi}`);
    const files = new Map([['manifest.json', encode(`${JSON.stringify(manifest, null, 2)}\n`)]]);
    for (const entry of Object.values(manifest.entrypoints)) {
        let source = entry.replace(/\.js$/, '.ts');
        try { await stat(path.join(directory, source)); }
        catch (error) { if (error.code !== 'ENOENT') throw error; source = entry; }
        const result = await build({ absWorkingDir: directory, entryPoints: [source], bundle: true, write: false,
            format: 'iife', globalName: `globalThis.${guestExports}`, target: 'es2020', platform: 'neutral',
            mainFields: ['module', 'main'], legalComments: 'inline', charset: 'utf8', minify: true, metafile: true });
        if (Object.values(result.metafile.outputs).some(output => output.imports.length)) throw new Error('插件入口必须能够独立运行，不能保留外部模块导入');
        const data = result.outputFiles[0].contents;
        if (data.byteLength > entryLimit) throw new Error(`插件入口超过大小限制：${entry}`);
        files.set(entry, data);
    }
    for (const resource of manifest.resources ?? []) {
        const file = path.join(directory, resource);
        if ((await stat(file)).size > resourceLimit) throw new Error(`插件资源超过大小限制：${resource}`);
        const data = await readFile(file);
        utf8.decode(data);
        files.set(resource, data);
    }
    const privateKey = createPrivateKey(await readFile(filename));
    if (privateKey.asymmetricKeyType !== 'ec' || privateKey.asymmetricKeyDetails.namedCurve !== 'prime256v1') throw new Error('请用 tipsy-plugin keygen 创建 P-256 发布者密钥');
    const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64');
    const payload = await signedPayload(Object.fromEntries(files), webcrypto.subtle);
    const signature = sign('sha256', payload, { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64');
    files.set('signature.json', encode(JSON.stringify({ algorithm: 'ES256', publicKey, signature })));
    if (files.size > maxFiles || [...files.values()].reduce((sum, data) => sum + data.byteLength, 0) > expandedLimit) throw new Error('插件文件超过展开大小限制');
    const archive = zipSync(Object.fromEntries(files), { level: 6, mtime: new Date(2020, 0, 1) });
    if (archive.byteLength > packageLimit) throw new Error('压缩后的插件包超过 2 MiB');
    const output = path.resolve(out ?? path.join(outputDirectory, `${manifest.id}-${manifest.version}.tipsy-plugin`));
    if (!output.toLowerCase().endsWith('.tipsy-plugin')) throw new Error('输出路径必须以 .tipsy-plugin 结尾');
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, archive);
    console.log(`已生成 ${manifest.name} ${manifest.version}：${output}`);
}

export async function runCli([command, ...args], { defaultKey = '.tipsy-plugin/publisher.pem', outputDirectory = '.' } = {}) {
    if (command === 'keygen' && args.length <= 1) await keygen(args[0] ?? defaultKey);
    else if (command === 'pack' && (args.length === 2 || args.length === 3)) await pack(args[0], args[1], args[2], outputDirectory);
    else {
        console.log('tipsy-plugin keygen [发布者私钥.pem]\ntipsy-plugin pack <插件目录> <发布者私钥.pem> [输出路径.tipsy-plugin]');
        if (command && command !== '--help') process.exitCode = 1;
    }
}
