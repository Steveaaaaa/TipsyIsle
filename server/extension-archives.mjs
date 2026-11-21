import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { unzip } from 'fflate';

const exec = promisify(execFile);
export const archiveMetadata = '.tipsyisle-package.json';
const maxArchiveBytes = 64 * 1024 * 1024;

export function githubRepository(value) {
    const url = new URL(value);
    const match = /^\/([\w-]+)\/([\w.-]+)\/?$/.exec(url.pathname);
    if (url.origin !== 'https://github.com' || !match) return undefined;
    const name = match[2].replace(/\.git$/i, '');
    if (!name || name.startsWith('.') || name.endsWith('.')) return undefined;
    return `${match[1]}/${name}`;
}

async function githubDownload(url, description, maxBytes) {
    try {
        const { stdout } = await exec('curl', ['-q', '--fail', '--silent', '--show-error', '--location',
            '--proto', '=https', '--proto-redir', '=https', '--connect-timeout', '8', '--max-time', '25',
            '--max-filesize', String(maxBytes), '--', url], { encoding: 'buffer', maxBuffer: maxBytes, windowsHide: true, timeout: 27000 });
        return stdout;
    } catch (error) {
        const stderr = String(error.stderr ?? '');
        const status = /returned error: (\d{3})/.exec(stderr)?.[1];
        const reason = error.code === 'ENOENT' ? '系统未找到 curl' : status ? `GitHub 返回 HTTP ${status}` :
            error.code === 28 || error.killed ? '请求超时' : error.code === 63 ? '文件超过大小限制' : '无法连接或下载未完成';
        throw new Error(`${description}失败：${reason}`, { cause: error });
    }
}

export async function githubHead(repository, branch) {
    const api = `https://api.github.com/repos/${repository}`;
    const json = async (url, description) => JSON.parse((await githubDownload(url, description, 2 * 1024 * 1024)).toString('utf8'));
    branch ??= (await json(api, '读取 GitHub 仓库')).default_branch;
    if (typeof branch !== 'string' || !branch) throw new Error('GitHub 未返回默认分支');
    const { sha: commit } = await json(`${api}/commits/${encodeURIComponent(branch)}`, '查询扩展版本');
    if (typeof commit !== 'string' || !/^[a-f0-9]{40}$/i.test(commit)) throw new Error('GitHub 未返回有效的扩展版本');
    return { repository, branch, commit };
}

export async function downloadGithubArchive(directory, head) {
    const { repository, commit } = head;
    const zip = await githubDownload(`https://codeload.github.com/${repository}/zip/${commit}`, '下载 GitHub 扩展 ZIP', maxArchiveBytes);
    const entries = [];
    const names = new Set();
    let totalSize = 0;
    let root;
    const files = await new Promise((resolve, reject) => unzip(zip, { filter(file) {
        const [folder, ...parts] = file.name.split('/');
        if (!folder || root && root !== folder) throw new Error('扩展 ZIP 的目录结构无效');
        root ??= folder;
        if (!parts.length || parts.at(-1) === '' || parts.some(part => part.startsWith('.') && part !== '..' && part !== '.')) return false;
        if (parts.some(part => !part || /^[.]{1,2}$/.test(part) || /[<>:"\\|?*\x00-\x1f]|[ .]$|^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))) {
            throw new Error('扩展 ZIP 包含无效文件路径');
        }
        const relative = parts.join('/');
        const key = relative.toLowerCase();
        totalSize += file.originalSize;
        if (names.has(key)) throw new Error('扩展 ZIP 包含同名文件');
        if (totalSize > 256 * 1024 * 1024 || entries.length >= 12000) throw new Error('解压后的扩展超过大小限制');
        names.add(key);
        entries.push([file.name, relative]);
        return true;
    } }, (error, result) => error ? reject(error) : resolve(result)));
    await fs.mkdir(directory);
    for (const [name, relative] of entries) {
        const destination = path.join(directory, relative);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, files[name], { flag: 'wx' });
    }
    await fs.writeFile(path.join(directory, archiveMetadata), JSON.stringify(head), { flag: 'wx' });
}
