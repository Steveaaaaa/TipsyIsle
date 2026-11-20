import { isNativeRuntime } from './native-runtime';

export async function pickNativeAvatar(): Promise<File | undefined> {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const path = await open({ multiple: false, directory: false, pickerMode: 'document', filters: [{ name: '头像', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
    if (!path) return;
    const { readFile } = await import('@tauri-apps/plugin-fs');
    const { basename } = await import('@tauri-apps/api/path');
    return new File([new Uint8Array(await readFile(path)).buffer], await basename(path));
}

export async function pickNativeAsset(): Promise<File | undefined> {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const path = await open({ multiple: false, directory: false, pickerMode: 'document', filters: [{ name: '角色卡、预设与世界书', extensions: ['png', 'json'] }] });
    if (!path) return;
    const { readFile } = await import('@tauri-apps/plugin-fs');
    const bytes = await readFile(path);
    const { basename } = await import('@tauri-apps/api/path');
    // Tauri resolves Android content URIs through the provider's DISPLAY_NAME.
    const name = await basename(path);
    // Android document providers return opaque content URIs, so use the file signature.
    const png = bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71;
    return new File([new Uint8Array(bytes).buffer], name, { type: png ? 'image/png' : 'application/json' });
}

export async function pickNativePlugin(): Promise<File | undefined> {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const path = await open({ multiple: false, directory: false, pickerMode: 'document',
        filters: /Android/i.test(navigator.userAgent) ? undefined : [{ name: '微醺屿插件', extensions: ['tipsy-plugin'] }] });
    if (!path) return;
    const { readFile } = await import('@tauri-apps/plugin-fs');
    const { basename } = await import('@tauri-apps/api/path');
    return new File([new Uint8Array(await readFile(path)).buffer], await basename(path));
}

export async function saveExport(blob: Blob, name: string): Promise<boolean> {
    if (isNativeRuntime()) {
        const { save } = await import('@tauri-apps/plugin-dialog');
        const extension = name.split('.').pop() || 'json';
        const path = await save({ defaultPath: name, filters: [{ name: extension.toUpperCase(), extensions: [extension] }] });
        if (!path) return false;
        const { writeFile } = await import('@tauri-apps/plugin-fs');
        await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
        return true;
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = name;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    return true;
}
