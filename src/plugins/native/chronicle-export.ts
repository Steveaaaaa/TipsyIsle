import { z } from 'zod';
import type { Permission } from '../../../packages/plugin-sdk/index.js';
import { saveExport } from '../../core/platform-files';
import { toBase64 } from './bytes';
import { routeSchema } from './edits';
import { loadMedia } from './media';
import { projectMedia } from './reply-media';
import type { StoryView } from './story-port';

const escapeHtml = (text: string) =>
    text.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));

export async function exportChronicle(
    owner: string,
    args: unknown,
    signal: AbortSignal,
    view: StoryView,
    permissions: Permission[],
) {
    const titleSchema = z.string().min(1).max(100);
    const input = z.union([
        z.strictObject({ title: titleSchema, route: routeSchema }),
        z.strictObject({
            title: titleSchema,
            pages: z.array(z.strictObject({ text: z.string().max(16000), mediaId: z.string().max(480).optional() })).max(256),
        }),
    ]).parse(args);

    if ('route' in input && (!permissions.includes('story.read') || input.route.chatId !== view.route?.chatId || input.route.routeId !== view.route?.routeId)) {
        throw new Error('只能导出已授权的本线故事');
    }

    const data = 'pages' in input
        ? input
        : {
            title: input.title,
            pages: view.path.flatMap((node) => [
                { text: node.content, mediaId: undefined as string | undefined },
                ...projectMedia(node)
                    .filter((slot) => `${slot.plugin.manifest.id}:${slot.plugin.fingerprint}` === owner)
                    .map((slot) => ({
                        text: slot.item.label,
                        mediaId: slot.item.takes?.[slot.item.activeTake ?? 0]?.id,
                    })),
            ]),
        };

    const parts = [
        '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
        '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'">',
        '<style>:root{color-scheme:light dark}body{max-width:68ch;margin:3.5em auto;padding:0 1.4em;background:#f9f6ef;color:#2c2520;font:17px/1.9 "Noto Serif SC",Georgia,serif}h1{font-size:1.7rem;border-bottom:1px solid #d9cfbf;padding-bottom:.6rem;margin-bottom:1.8rem}p{white-space:pre-wrap;margin:1.1em 0}figure{margin:1.6em 0;padding:.6rem;background:#fffdf8;border:1px solid #e7decb;border-radius:10px;box-shadow:0 8px 24px -12px rgba(44,37,32,.18)}img{display:block;width:100%;height:auto;border-radius:6px}figcaption{margin-top:.55rem;font-size:.86rem;color:#6d5f50;text-align:center}@media(prefers-color-scheme:dark){body{background:#151412;color:#eae2d5}h1{border-color:#3a332c}figure{background:#1e1b18;border-color:#352f29}figcaption{color:#baa994}}</style>',
        `<title>${escapeHtml(data.title)}</title><h1>${escapeHtml(data.title)}</h1>`,
    ];

    let bytes = 0;
    for (const page of data.pages) {
        signal.throwIfAborted();
        if (!page.mediaId) {
            parts.push(`<p>${escapeHtml(page.text)}</p>`);
            continue;
        }
        const { blob } = await loadMedia(owner, page.mediaId);
        bytes += blob.size;
        if (bytes > 128 * 1024 * 1024) throw new Error('画册过大，请分段导出');
        if (/^image\/(?:png|jpeg|webp)$/.test(blob.type)) {
            const encoded = toBase64(new Uint8Array(await blob.arrayBuffer()));
            parts.push(`<figure><img alt="${escapeHtml(page.text)}" src="data:${blob.type};base64,${encoded}"><figcaption>${escapeHtml(page.text)}</figcaption></figure>`);
        }
    }

    signal.throwIfAborted();
    await saveExport(
        new Blob(parts, { type: 'text/html;charset=utf-8' }),
        `${data.title.replace(/[\\/:*?"<>|]/g, '_')}.html`,
    );
}
