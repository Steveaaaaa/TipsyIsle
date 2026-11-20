import { platformFetch, compatibilityOrigin } from '../core/native-runtime';
import { platformStorage } from '../core/platform-bridge';
import type { CompatibilityExtension } from './extensions';

const catalogKey = 'native_extension_packages';
const prefix = '/scripts/extensions/third-party/';
interface Package { entry: CompatibilityExtension; repository: string; branch: string; commit: string; directory: string }
interface Item { name: string; folder: boolean; modified: number }
const readPackages = () => platformStorage.loadSnapshot<Package[]>(catalogKey, []);
const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');
const invoke = <T>(action: string, area: string, path: string, data?: Uint8Array) =>
    window.__TAURI_INTERNALS__!.invoke<T>('tipsy_extension_files', { action, area, path, data: data && Array.from(data) });
export const listNativeExtensions = async () => (await readPackages()).map(item => item.entry);

function repositoryPath(value: string) {
    const url = new URL(value);
    const parts = url.pathname.replace(/\.git\/?$/, '').split('/').filter(Boolean);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.search || url.hash ||
        parts.length !== 2 || !parts.every(part => /^[\w-][\w.-]*$/.test(part) && !part.endsWith('.'))) throw new Error('请填写 GitHub 仓库的 HTTPS 地址');
    return parts.join('/');
}

async function repositoryHead(repository: string, branch?: string) {
    const json = async (endpoint: string) => {
        const response = await platformFetch(`https://api.github.com/repos/${repository}${endpoint}`);
        if (!response.ok) throw new Error(`读取 GitHub 扩展失败（${response.status}）`);
        return response.json();
    };
    const selected: string = branch ?? (await json('')).default_branch;
    const { sha } = await json(`/commits/${encodeURIComponent(selected)}`);
    return { branch: selected, commit: String(sha) };
}

async function downloadPackage(repository: string, branch: string, commit: string, type: 'local' | 'global') {
    const id = repository.split('/')[1];
    const directory = `${id}-${commit.slice(0, 12)}-${crypto.randomUUID().slice(0, 8)}`;
    const response = await platformFetch(`https://codeload.github.com/${repository}/zip/${encodeURIComponent(commit)}`);
    if (!response.ok) throw new Error(`下载扩展失败（${response.status}）`);
    const archive = await response.arrayBuffer();
    const { unzip } = await import('fflate');
    const files = await new Promise<Record<string, Uint8Array>>((resolve, reject) => unzip(new Uint8Array(archive), (error, result) => error ? reject(error) : resolve(result)));
    const entries = new Map(Object.entries(files).flatMap(([archivePath, content]) => {
        const path = archivePath.slice(archivePath.indexOf('/') + 1);
        return !path || archivePath.endsWith('/') || path.split('/').some(part => part.startsWith('.')) ? [] : [[path, content] as const];
    }));
    const manifest = JSON.parse(new TextDecoder().decode(entries.get('manifest.json')));
    const asset = (value?: string) => {
        if (!value) return undefined;
        const [path, query] = value.split(/\?(.*)/s, 2);
        if (!entries.has(path)) throw new Error(`扩展包缺少 ${path}`);
        return `${prefix}${directory}/${encodePath(path)}${query ? `?${query}` : ''}`;
    };
    const entry: CompatibilityExtension = { id, name: String(manifest.display_name ?? id), version: String(manifest.version ?? ''), type,
        loadingOrder: Number(manifest.loading_order ?? 100), js: asset(manifest.js), css: asset(manifest.css),
        requires: manifest.requires, dependencies: manifest.dependencies, generateInterceptor: manifest.generate_interceptor };
    try {
        for (const [path, bytes] of entries) await invoke('write', 'packages', `${directory}/${path}`, bytes);
    } catch (error) { await invoke('remove', 'packages', directory).catch(() => {}); throw error; }
    return { entry, repository, branch, commit, directory };
}

let changes: Promise<unknown> = Promise.resolve();
export function manageNativeExtension(params: Record<string, any>) {
    const task = changes.then(async () => {
        const installed = await readPackages();
        const repository = params.action === 'install' ? repositoryPath(params.url) : undefined;
        const id = repository?.split('/')[1] ?? String(params.id).replace(/^third-party\//, '');
        const old = installed.find(item => item.entry.id.toLowerCase() === id.toLowerCase());
        if (params.action === 'install' && old) throw new Error('扩展已存在');
        if (params.action !== 'install' && !old) throw new Error('扩展不存在');
        const rest = installed.filter(item => item !== old);
        if (params.action === 'delete') {
            await platformStorage.saveSnapshot(catalogKey, rest);
            await invoke('remove', 'packages', old!.directory);
            return { message: '扩展已卸载，重新载入运行环境后生效' };
        }
        const origin = old?.repository ?? repository!;
        const head = await repositoryHead(origin, old?.branch);
        if (params.action === 'version') return { remote_url: `https://github.com/${origin}`, current_branch_name: head.branch,
            current_commit_hash: old!.commit, is_up_to_date: head.commit === old!.commit };
        if (params.action === 'update' && head.commit === old!.commit) return { message: '扩展已是最新版本' };
        const next = await downloadPackage(origin, head.branch, head.commit, old?.entry.type === 'global' || params.type === 'global' ? 'global' : 'local');
        await platformStorage.saveSnapshot(catalogKey, [...rest, next]);
        if (old) await invoke('remove', 'packages', old.directory);
        return { message: '扩展已保存，重新载入运行环境后生效', extension: next.entry };
    });
    changes = task.catch(() => {});
    return task;
}

export async function nativeExtensionMedia(route: string, body: Record<string, any>) {
    const area = route.startsWith('/api/images/') ? 'images' : 'files';
    const decode = (url: string, expected: string) => {
        const parsed = new URL(url, compatibilityOrigin);
        const prefix = `/user/${expected}/`;
        if (parsed.origin !== compatibilityOrigin || !parsed.pathname.startsWith(prefix)) throw new Error('扩展媒体路径无效');
        return decodeURIComponent(parsed.pathname.slice(prefix.length));
    };
    if (route.endsWith('/folders')) return (await invoke<Item[]>('list', area, '')).filter(item => item.folder).map(item => item.name);
    if (route.startsWith('/api/images/list')) {
        const folder = body.folder ?? decodeURIComponent(route.split('/').slice(4).join('/'));
        const files = (await invoke<Item[]>('list', area, folder)).filter(item => !item.folder)
            .sort((left, right) => body.sortField === 'name' ? left.name.localeCompare(right.name, undefined, { numeric: true }) : left.modified - right.modified);
        return (body.sortOrder === 'desc' ? files.reverse() : files).map(item => item.name);
    }
    if (route.endsWith('/verify')) return Object.fromEntries(await Promise.all(body.urls.map(async (url: string) => {
        try { return [url, await invoke<boolean>('exists', area, decode(url, area))]; } catch { return [url, false]; }
    })));
    if (route.endsWith('/delete')) return { ok: await invoke<boolean>('remove', area, decode(body.path, area)) };
    const format = String(body.format ?? '').toLowerCase();
    const image = area === 'images';
    if (image && !/^(png|jpe?g|gif|webp|avif|bmp)$/.test(format)) throw new Error('图片格式不支持');
    const filename = image ? `${String(body.filename || Date.now()).replace(/\.[^./]+$/, '')}.${format}` : String(body.name);
    const file = image && body.ch_name ? `${body.ch_name}/${filename}` : filename;
    await invoke('write', area, file, Uint8Array.from(atob(String(image ? body.image : body.data).replace(/^data:[^,]*,/, '')), char => char.charCodeAt(0)));
    return { path: `/user/${area}/${encodePath(file)}` };
}
