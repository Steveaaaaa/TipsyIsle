import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { archiveMetadata, downloadGithubArchive, githubHead, githubRepository } from './extension-archives.mjs';

const exec = promisify(execFile);
export const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/extensions');
const integrated = new Set(['JS-Slash-Runner', 'ST-Prompt-Template', 'regex', 'quick-reply']);
const identifier = value => {
    const id = String(value ?? '').replace(/^third-party\//, '');
    if (!/^[\w.-]+$/.test(id) || id.startsWith('.') || /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i.test(id)) throw new Error('扩展标识无效');
    return id;
};
const refusedLocalProxy = /Failed to connect to (?:127\.0\.0\.1|localhost|\[?::1\]?) port \d+[^\r\n]*: Connection refused/i;
async function runGit(directory, args, { timeout = 120000, retryDirect = true } = {}) {
    const config = ['-c', `core.hooksPath=${path.join(extensionRoot, '.disabled-hooks')}`, '-c', 'protocol.file.allow=never'];
    const options = { cwd: directory, windowsHide: true, timeout, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } };
    const run = async (extra = []) => (await exec('git', [...config, ...extra, ...args], options)).stdout.trim();
    try { return await run(); }
    catch (error) {
        if (!retryDirect || !refusedLocalProxy.test(error.stderr ?? '')) throw error;
        try { return await run(['-c', 'http.proxy=', '-c', 'remote.origin.proxy=']); }
        catch (directError) {
            const reason = directError.killed ? '下载超时' : directError.stderr?.trim().split(/\r?\n/).at(-1) || '请求失败';
            throw new Error(`本机 Git 代理未启动，直连重试：${reason}`, { cause: directError });
        }
    }
}
const git = (directory, ...args) => runGit(directory, args);
function repositoryUrl(value) {
    const url = new URL(String(value));
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('扩展仓库需要不含凭据的 HTTPS 地址');
    return url.href;
}
async function checkoutExtension(staging, remote) {
    const checkout = path.join(staging, 'checkout');
    const repository = githubRepository(remote);
    try {
        await runGit(staging, ['clone', '--depth', '1', '--', remote, 'checkout'], repository ? { timeout: 12000, retryDirect: false } : undefined);
        return checkout;
    } catch (error) {
        if (!repository) throw error;
        const archive = path.join(staging, 'archive');
        try {
            await downloadGithubArchive(archive, await githubHead(repository));
            return archive;
        } catch (archiveError) {
            const gitReason = refusedLocalProxy.test(error.stderr ?? '') ? '本机 Git 代理未启动' : 'Git 克隆未完成';
            throw new Error(`${gitReason}；${archiveError.message}`, { cause: archiveError });
        }
    }
}
async function readArchiveMetadata(directory) {
    const text = await fs.readFile(path.join(directory, archiveMetadata), 'utf8').catch(error => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
    });
    if (text === undefined) return undefined;
    const metadata = JSON.parse(text);
    if (typeof metadata.repository !== 'string' || githubRepository(`https://github.com/${metadata.repository}`) !== metadata.repository ||
        typeof metadata.branch !== 'string' || !metadata.branch || typeof metadata.commit !== 'string' || !/^[a-f0-9]{40}$/i.test(metadata.commit)) {
        throw new Error('扩展的下载记录无效，请重新安装');
    }
    return metadata;
}
async function info(directory, id, type) {
    const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
    const asset = async value => {
        if (!value) return undefined;
        const [relative, query] = String(value).replaceAll('\\', '/').split(/\?(.*)/s, 2);
        if (relative.startsWith('/') || relative.split('/').some(part => part === '..') || /^[a-z]+:/i.test(relative)) throw new Error('扩展入口必须是仓库内文件');
        const entryFile = await fs.stat(path.join(directory, relative)).catch(error => { if (error.code !== 'ENOENT') throw error; });
        if (!entryFile?.isFile()) throw new Error(`扩展包缺少 ${relative}`);
        return `/scripts/extensions/third-party/${encodeURIComponent(id)}/${relative.split('/').map(encodeURIComponent).join('/')}${query ? `?${query}` : ''}`;
    };
    const [js, css] = await Promise.all([asset(manifest.js), asset(manifest.css)]);
    return { id, type, name: String(manifest.display_name ?? id), version: String(manifest.version ?? ''),
        loadingOrder: Number(manifest.loading_order ?? 100), js, css,
        generateInterceptor: typeof manifest.generate_interceptor === 'string' ? manifest.generate_interceptor : undefined,
        requires: Array.isArray(manifest.requires) ? manifest.requires.map(String) : [],
        dependencies: Array.isArray(manifest.dependencies) ? manifest.dependencies.map(String) : [] };
}
export async function listExtensions() {
    const entries = [];
    for (const type of ['local', 'global']) {
        const directory = path.join(extensionRoot, type);
        const children = await fs.readdir(directory, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
        for (const child of children) if (child.isDirectory() && !child.name.startsWith('.') && !entries.some(entry => entry.id === child.name)) {
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
    if (relative.split(/[\\/]/).some(part => ['.git', archiveMetadata].includes(part.replace(/[ .]+$/, '').toLowerCase()))) {
        throw Object.assign(new Error('Not found'), { status: 404 });
    }
    const file = await fs.realpath(path.resolve(directory, relative));
    if (!file.startsWith(await fs.realpath(directory) + path.sep)) throw new Error('扩展资源超出目录');
    return { data: await fs.readFile(file), extension: path.extname(file) };
}
async function replaceExtension(directory, entry, download) {
    const staging = await fs.mkdtemp(path.join(path.dirname(directory), '.reinstall-'));
    const previous = path.join(staging, 'previous');
    let cleanup = true;
    try {
        const checkout = await download(staging);
        const updated = await info(checkout, entry.id, entry.type);
        await fs.rename(directory, previous);
        try { await fs.rename(checkout, directory); }
        catch (error) {
            cleanup = false;
            await fs.rename(previous, directory);
            cleanup = true;
            throw error;
        }
        return updated;
    } finally { if (cleanup) await fs.rm(staging, { recursive: true, force: true }); }
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
            const base = await fs.realpath(extensionRoot).catch(error => {
                if (error.code !== 'ENOENT') throw error;
                return fs.mkdir(extensionRoot, { recursive: true }).then(() => fs.realpath(extensionRoot));
            });
            const parent = path.join(base, params.type);
            await fs.mkdir(parent, { recursive: true });
            if (await fs.realpath(parent) !== parent) throw new Error('扩展安装目录超出允许范围');
            const directory = path.join(parent, id);
            const staging = await fs.mkdtemp(path.join(parent, '.install-'));
            try {
                const checkout = await checkoutExtension(staging, repositoryUrl(params.url));
                const entry = await info(checkout, id, params.type);
                await fs.rename(checkout, directory);
                return { message: '扩展已安装，重新载入兼容运行环境后生效', extension: entry };
            } finally { await fs.rm(staging, { recursive: true, force: true }); }
        }
        const { entry, directory } = await locate(id);
        if (action === 'delete') { await fs.rm(directory, { recursive: true }); return { message: '扩展已卸载，重新载入兼容运行环境后生效' }; }
        const hasGit = await fs.stat(path.join(directory, '.git')).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
        const archive = hasGit ? undefined : await readArchiveMetadata(directory);
        if (archive && ['version', 'update', 'reinstall'].includes(action)) {
            const head = await githubHead(archive.repository, archive.branch);
            const latest = head.commit === archive.commit;
            if (action === 'version') return { current_branch_name: archive.branch, current_commit_hash: archive.commit, is_up_to_date: latest, remote_url: `https://github.com/${archive.repository}` };
            if (action === 'update' && latest) return { message: '扩展已是最新版本' };
            const extension = await replaceExtension(directory, entry, async staging => {
                const next = path.join(staging, 'archive');
                await downloadGithubArchive(next, head);
                return next;
            });
            return { message: `扩展已${action === 'update' ? '更新' : '重新安装'}，重新载入兼容运行环境后生效`, extension };
        }
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
            const extension = await replaceExtension(directory, entry, staging => checkoutExtension(staging, remote));
            return { message: '扩展已重新安装，重新载入兼容运行环境后生效', extension };
        }
        throw new Error('未知扩展操作');
    });
    queue = task.catch(() => {});
    return task;
}
