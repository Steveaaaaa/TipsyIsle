import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
export const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/extensions');
const integrated = new Set(['JS-Slash-Runner', 'ST-Prompt-Template', 'regex', 'quick-reply']);
const identifier = value => {
    const id = String(value ?? '').replace(/^third-party\//, '');
    if (!/^[\w.-]+$/.test(id) || id.startsWith('.') || /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i.test(id)) throw new Error('扩展标识无效');
    return id;
};
const git = async (directory, ...args) => {
    const { stdout } = await exec('git', ['-c', `core.hooksPath=${path.join(extensionRoot, '.disabled-hooks')}`, '-c', 'protocol.file.allow=never', ...args], { cwd: directory, windowsHide: true, timeout: 120000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    return stdout.trim();
};
function repositoryUrl(value) {
    const url = new URL(String(value));
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('扩展仓库需要不含凭据的 HTTPS 地址');
    return url.href;
}
async function info(directory, id, type) {
    const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
    const asset = value => {
        if (!value) return undefined;
        const [relative, query] = String(value).replaceAll('\\', '/').split(/\?(.*)/s, 2);
        if (relative.startsWith('/') || relative.split('/').some(part => part === '..') || /^[a-z]+:/i.test(relative)) throw new Error('扩展入口必须是仓库内文件');
        return `/scripts/extensions/third-party/${encodeURIComponent(id)}/${relative.split('/').map(encodeURIComponent).join('/')}${query ? `?${query}` : ''}`;
    };
    return { id, type, name: String(manifest.display_name ?? id), version: String(manifest.version ?? ''),
        loadingOrder: Number(manifest.loading_order ?? 100), js: asset(manifest.js), css: asset(manifest.css),
        generateInterceptor: typeof manifest.generate_interceptor === 'string' ? manifest.generate_interceptor : undefined,
        requires: Array.isArray(manifest.requires) ? manifest.requires.map(String) : [],
        dependencies: Array.isArray(manifest.dependencies) ? manifest.dependencies.map(String) : [] };
}
export async function listExtensions() {
    const entries = [];
    for (const type of ['local', 'global']) {
        const directory = path.join(extensionRoot, type);
        const children = await fs.readdir(directory, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
        for (const child of children) if (child.isDirectory() && !child.name.startsWith('.reinstall-') && !entries.some(entry => entry.id === child.name)) {
            try { entries.push(await info(path.join(directory, child.name), child.name, type)); }
            catch (error) { entries.push({ id: child.name, type, name: child.name, version: '', loadingOrder: 100, error: error.message }); }
        }
    }
    return entries.sort((a, b) => a.loadingOrder - b.loadingOrder || a.id.localeCompare(b.id));
}
async function locate(value) {
    const id = identifier(value);
    for (const type of ['local', 'global']) {
        const directory = path.resolve(extensionRoot, type, id);
        const exists = await fs.stat(directory).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
        if (!exists?.isDirectory()) continue;
        const real = await fs.realpath(directory), base = await fs.realpath(extensionRoot);
        if (!real.startsWith(base + path.sep)) throw new Error('扩展目录超出允许范围');
        return { entry: { id, type }, directory };
    }
    throw Object.assign(new Error('扩展不存在'), { status: 404 });
}
export async function readExtensionAsset(id, relative) {
    const { directory } = await locate(id);
    if (relative.split(/[\\/]/).includes('.git')) throw Object.assign(new Error('Not found'), { status: 404 });
    const file = await fs.realpath(path.resolve(directory, relative));
    if (!file.startsWith(await fs.realpath(directory) + path.sep)) throw new Error('扩展资源超出目录');
    return { data: await fs.readFile(file), extension: path.extname(file) };
}
let queue = Promise.resolve();
export function manageExtension(action, params = {}) {
    const task = queue.then(async () => {
        if (action === 'list') return { extensions: await listExtensions(), canManage: true };
        const id = action === 'install' ? identifier(new URL(repositoryUrl(params.url)).pathname.split('/').filter(Boolean).at(-1)?.replace(/\.git$/i, '')) : identifier(params.id);
        if ([...integrated].some(name => name.toLowerCase() === id.toLowerCase())) {
            if (action === 'version') return null;
            throw Object.assign(new Error('此能力由 TipsyIsle 内置适配层提供，随应用更新；不能用上游仓库覆盖内置模块'), { status: 409 });
        }
        if (action === 'install') {
            if (!['local', 'global'].includes(params.type)) throw new Error('扩展类型必须是 local 或 global');
            if ((await listExtensions()).some(entry => entry.id.toLowerCase() === id.toLowerCase())) throw Object.assign(new Error('扩展已存在'), { status: 409 });
            const parent = path.join(extensionRoot, params.type);
            await fs.mkdir(parent, { recursive: true });
            const directory = path.join(parent, id);
            await git(parent, 'clone', '--depth', '1', '--', repositoryUrl(params.url), id);
            const entry = await info(directory, id, params.type);
            return { message: '扩展已安装，重新载入兼容运行环境后生效', extension: entry };
        }
        const { entry, directory } = await locate(id);
        if (action === 'delete') { await fs.rm(directory, { recursive: true }); return { message: '扩展已卸载，重新载入兼容运行环境后生效' }; }
        const remote = repositoryUrl(await git(directory, 'remote', 'get-url', 'origin'));
        if (action === 'version') {
            const branch = await git(directory, 'branch', '--show-current');
            const commit = await git(directory, 'rev-parse', 'HEAD');
            const remoteHead = await git(directory, 'ls-remote', 'origin', `refs/heads/${branch}`);
            return { current_branch_name: branch, current_commit_hash: commit, is_up_to_date: remoteHead.split(/\s+/)[0] === commit, remote_url: remote };
        }
        if (action === 'update') {
            await git(directory, 'pull', '--ff-only', 'origin');
            return { message: '扩展已更新，重新载入兼容运行环境后生效', extension: await info(directory, id, entry.type) };
        }
        if (action === 'reinstall') {
            const parent = path.join(extensionRoot, entry.type);
            const staging = await fs.mkdtemp(path.join(parent, '.reinstall-'));
            try {
                await git(staging, 'clone', '--depth', '1', '--', remote, 'checkout');
                await info(path.join(staging, 'checkout'), id, entry.type);
                await fs.rm(directory, { recursive: true });
                await fs.rename(path.join(staging, 'checkout'), directory);
            } finally { await fs.rm(staging, { recursive: true, force: true }); }
            return { message: '扩展已重新安装，重新载入兼容运行环境后生效' };
        }
        throw new Error('未知扩展操作');
    });
    queue = task.catch(() => {});
    return task;
}
