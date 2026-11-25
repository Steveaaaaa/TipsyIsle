import type { ImageModelRequest, Permission } from '../../../packages/plugin-sdk/index.js';
import { isNativeRuntime, platformFetch } from '../../core/native-runtime';
import { detectRuntimeFlavor } from '../../core/platform-bridge';
import { fromBase64, readLimited, toBase64 } from './bytes';
import { httpEndpoint, type Connection } from './connections';
import { PluginApiError } from './errors';
import { composition, dimensions, novelImage, novelRequest, safeAvoidClause, workflow } from './image-protocol';
import { mediaLimit } from './media';
import { resolveReference } from './media-ref';

async function normalizeReferenceBlob(blob: Blob, protocol: string, role: string): Promise<Blob> {
    if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') return blob;
    let bitmap: ImageBitmap;
    try {
        bitmap = await createImageBitmap(blob);
    } catch {
        return blob;
    }
    try {
        if (protocol === 'novelai' && role === 'character') {
            const ratio = bitmap.width / Math.max(1, bitmap.height);
            const [targetW, targetH] = ratio < 0.85 ? [1024, 1536] : ratio > 1.18 ? [1536, 1024] : [1472, 1472];
            const scale = Math.min(targetW / bitmap.width, targetH / bitmap.height);
            const drawW = Math.max(1, Math.round(bitmap.width * scale));
            const drawH = Math.max(1, Math.round(bitmap.height * scale));
            const dx = Math.floor((targetW - drawW) / 2);
            const dy = Math.floor((targetH - drawH) / 2);
            const canvas = new OffscreenCanvas(targetW, targetH);
            const ctx = canvas.getContext('2d');
            if (!ctx) return blob;
            ctx.fillStyle = '#000000';
            ctx.fillRect(0, 0, targetW, targetH);
            ctx.drawImage(bitmap, dx, dy, drawW, drawH);
            return await canvas.convertToBlob({ type: 'image/png' });
        }
        const maxEdge = Math.max(bitmap.width, bitmap.height);
        if (maxEdge > 1536 || blob.size > 1_500_000) {
            const scale = maxEdge > 1536 ? 1536 / maxEdge : 1;
            const targetW = Math.max(1, Math.round(bitmap.width * scale));
            const targetH = Math.max(1, Math.round(bitmap.height * scale));
            const canvas = new OffscreenCanvas(targetW, targetH);
            const ctx = canvas.getContext('2d');
            if (!ctx) return blob;
            ctx.drawImage(bitmap, 0, 0, targetW, targetH);
            return await canvas.convertToBlob({ type: blob.type === 'image/png' ? 'image/png' : 'image/webp', quality: 0.92 });
        }
        return blob;
    } catch {
        return blob;
    } finally {
        bitmap.close();
    }
}

export async function generateImage(
    connection: Connection,
    data: ImageModelRequest,
    owner: string,
    permissions: Permission[],
    signal: AbortSignal,
) {
    const rawProtocol = connection.providerKind ?? 'openai';
    const base = httpEndpoint(connection.baseUrl);
    const protocol =
        rawProtocol === 'openai' && (/moss/i.test(connection.model) || /(?:mosi\.cn|siliconflow)/i.test(base.hostname))
            ? 'moss'
            : rawProtocol;
    const gateway = (await detectRuntimeFlavor()) === 'local-gateway';
    const root = base.href
        .replace(/\/(?:images\/(?:edits|generations)|ai\/generate-image|sdapi\/v1\/txt2img|prompt|chat\/completions)\/?$/, '')
        .replace(/\/$/, '');

    const references = [...(data.references ?? [])];
    for (const actor of data.actors ?? []) {
        if (actor.reference && !references.some((item) => JSON.stringify(item.image) === JSON.stringify(actor.reference))) {
            references.push({ image: actor.reference, role: 'character', subject: actor.name });
        }
    }

    const refs: { blob: Blob; role: string; subject?: string; weight: number }[] = [];
    if (protocol !== 'moss') {
        let total = 0;
        for (const ref of references) {
            try {
                const rawBlob = await resolveReference(owner, ref.image, permissions, signal);
                const blob = await normalizeReferenceBlob(rawBlob, protocol, ref.role);
                if ((total += blob.size) > mediaLimit) throw new Error('参考图合计超过 20 MiB');
                refs.push({ blob, role: ref.role, subject: ref.subject, weight: ref.weight ?? 0.8 });
            } catch (error) {
                if (signal.aborted || error instanceof PluginApiError) throw error;
                if (error instanceof Error && error.message === '参考图合计超过 20 MiB') throw error;
                console.warn('[lumina] 跳过不可用的参考图:', error);
            }
        }
    }

    const encoded = async () =>
        Promise.all(refs.map(async (ref) => ({ ...ref, data: toBase64(new Uint8Array(await ref.blob.arrayBuffer())) })));

    const sendRequest = async (path: string, body?: unknown, protocolOverride = protocol): Promise<Response> => {
        const url = `${root}/${path}`;
        const method = body === undefined ? 'GET' : 'POST';
        const multipart = body instanceof FormData;
        const headers: Record<string, string> = multipart ? {} : { 'Content-Type': 'application/json' };
        if (connection.apiKey) {
            if (protocolOverride === 'gemini') headers['x-goog-api-key'] = connection.apiKey;
            else headers.Authorization = `Bearer ${connection.apiKey}`;
        }
        if (gateway) {
            const payload = new Request(url, {
                method,
                headers,
                body: body === undefined ? undefined : multipart ? body : JSON.stringify(body),
            });
            return fetch('/api/tipsy-isle/llm/image', {
                method: 'POST',
                signal,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url,
                    method,
                    protocol: protocolOverride,
                    key: connection.apiKey,
                    contentType: payload.headers.get('content-type'),
                    ...(multipart
                        ? { binary: toBase64(new Uint8Array(await payload.arrayBuffer())) }
                        : { body }),
                }),
            });
        }
        return platformFetch(url, {
            method,
            signal,
            credentials: 'omit',
            redirect: 'error',
            ...(isNativeRuntime() && { maxRedirections: 0 }),
            headers,
            body: body === undefined ? undefined : multipart ? body : JSON.stringify(body),
        });
    };

    const request = async (path: string, body?: unknown, protocolOverride = protocol) => {
        const response = await sendRequest(path, body, protocolOverride);
        if (!response.ok) {
            await response.body?.cancel();
            throw new Error(`生图服务返回 ${response.status}`);
        }
        return response;
    };

    const json = async (path: string, body?: unknown, protocolOverride = protocol) =>
        JSON.parse(await (await readLimited(await request(path, body, protocolOverride), mediaLimit * 2, signal)).text());

    const fromImage = (text: unknown, mime = 'image/png') => {
        if (typeof text !== 'string' || text.length > mediaLimit * 1.4) throw new Error('没有可读取的图像');
        return new Blob([fromBase64(text)], { type: mime });
    };

    const fetchResultUrl = async (rawUrl: string): Promise<Blob> => {
        const url = httpEndpoint(rawUrl);
        if (
            (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.origin !== base.origin) ||
            (typeof location !== 'undefined' && location.origin === url.origin)
        ) {
            throw new Error('不允许的结果地址');
        }
        if (gateway) {
            const response = await fetch('/api/tipsy-isle/llm/image', {
                method: 'POST',
                signal,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url: url.href,
                    method: 'GET',
                    protocol: 'result_url',
                    approvedOrigin: base.origin,
                }),
            });
            if (!response.ok) {
                await response.body?.cancel();
                throw new Error('读取结果失败');
            }
            return readLimited(response, mediaLimit, signal);
        }
        const response = await platformFetch(url.href, {
            signal,
            redirect: 'error',
            credentials: 'omit',
            ...(isNativeRuntime() && { maxRedirections: 0 }),
        });
        if (!response.ok) throw new Error('读取结果失败');
        return readLimited(response, mediaLimit, signal);
    };

    const seed = data.seed ?? crypto.getRandomValues(new Uint32Array(1))[0];
    const prompt = composition(data);
    const avoid = safeAvoidClause(data.negativePrompt);
    const naturalPrompt = avoid ? `${prompt}\nAvoid: ${avoid}` : prompt;
    const size = dimensions(data);

    if (protocol === 'novelai') {
        const encodedRefs = await encoded();
        let response: Response;
        if (encodedRefs.length) {
            response = await sendRequest('ai/generate-image', novelRequest(connection.model, data, encodedRefs, seed));
            if (!response.ok) {
                await response.body?.cancel();
                if ([400, 402, 403].includes(response.status)) {
                    response = await request('ai/generate-image', novelRequest(connection.model, data, [], seed));
                } else {
                    throw new Error(`生图服务返回 ${response.status}`);
                }
            }
        } else {
            response = await request('ai/generate-image', novelRequest(connection.model, data, [], seed));
        }
        return {
            seed,
            blob: novelImage(
                new Uint8Array(
                    await (
                        await readLimited(response, mediaLimit + 65536, signal)
                    ).arrayBuffer(),
                ),
            ),
        };
    }

    if (protocol === 'gemini') {
        const parts: Record<string, unknown>[] = [];
        for (const item of await encoded()) {
            parts.push(
                { text: `${item.role} reference: ${item.subject ?? ''}` },
                { inlineData: { mimeType: item.blob.type, data: item.data } },
            );
        }
        parts.push({ text: naturalPrompt });
        const result = await json(
            `models/${encodeURIComponent(connection.model.replace(/^models\//, ''))}:generateContent`,
            {
                contents: [{ role: 'user', parts }],
                generationConfig: {
                    responseModalities: ['IMAGE'],
                    ...(data.aspectRatio && { imageConfig: { aspectRatio: data.aspectRatio } }),
                },
            },
        );
        const image = result.candidates?.[0]?.content?.parts?.find((part: { inlineData?: unknown }) => part.inlineData)?.inlineData;
        return { blob: fromImage(image?.data, image?.mimeType) };
    }

    if (protocol === 'webui') {
        const images = (await encoded()).map((item) => item.data);
        const result = await json('sdapi/v1/txt2img', {
            prompt,
            negative_prompt: data.negativePrompt ?? '',
            seed,
            ...size,
            override_settings: { sd_model_checkpoint: connection.model },
            override_settings_restore_afterwards: true,
            ...(images.length && {
                alwayson_scripts: {
                    controlnet: { args: images.map((image) => ({ enabled: true, module: 'reference_only', image })) },
                },
            }),
        });
        return { blob: fromImage(result.images?.[0]), seed: JSON.parse(result.info ?? '{}').seed ?? seed };
    }

    if (protocol === 'comfyui') {
        if (data.workflow && data.workflow.profile !== 'default') throw new Error('工作流不存在');
        const { graph, slots } = workflow(connection.workflowText ?? '');
        Object.assign(slots, connection.slotOverrides);
        const values: Record<string, unknown> = { prompt, negativePrompt: data.negativePrompt ?? '', seed, ...size };
        for (const item of refs) {
            const slot = item.role === 'style' ? 'styleRef' : 'charRef';
            if (!slots[slot]) continue;
            const form = new FormData();
            form.append('image', item.blob, `tipsy-${crypto.randomUUID()}.${item.blob.type.split('/')[1]}`);
            const uploaded = await json('upload/image', form);
            values[slot] = uploaded.name;
        }
        for (const [slot, [node, input]] of Object.entries(slots)) {
            if (Object.hasOwn(values, slot)) graph[node].inputs[input] = values[slot] as string | number;
        }
        for (const [key, value] of Object.entries(data.workflow?.params ?? {})) {
            if (!['seed', 'width', 'height'].includes(key) || !slots[key] || typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > (key === 'seed' ? 0xffffffff : 4096)) {
                throw new Error('无效工作流参数');
            }
            const [node, input] = slots[key];
            graph[node].inputs[input] = value;
        }
        const result = await json('prompt', { prompt: graph, client_id: crypto.randomUUID() });
        if (!/^[\w-]{1,100}$/.test(result.prompt_id ?? '')) throw new Error('无效的工作流队列号');
        for (;;) {
            signal.throwIfAborted();
            const history = (await json(`history/${result.prompt_id}`))[result.prompt_id];
            if (history?.status?.status_str === 'error') throw new Error('工作流执行失败');
            const image = (Object.values(history?.outputs ?? {}) as { images?: { filename: string; subfolder: string; type: string }[] }[])
                .flatMap((row) => row.images ?? [])[0];
            if (image) {
                return {
                    seed,
                    blob: await readLimited(
                        await request('view?' + new URLSearchParams({ filename: image.filename, subfolder: image.subfolder, type: image.type })),
                        mediaLimit,
                        signal,
                    ),
                };
            }
            await new Promise((resolve) => setTimeout(resolve, 800));
        }
    }

    if (protocol === 'moss') {
        const sizeString = data.size && data.size !== 'auto' ? data.size : `${size.width}x${size.height}`;
        const body = {
            model: connection.model,
            prompt,
            size: sizeString,
            ...(/siliconflow/i.test(base.hostname) && { image_size: sizeString }),
            ...(data.negativePrompt && { negative_prompt: data.negativePrompt }),
            seed,
        };
        let result = await json('images/generations', body);
        if (typeof result.task_id === 'string' && !result.data?.length && !result.images?.length && !result.output?.images?.length) {
            if (!/^[\w-]{1,120}$/.test(result.task_id)) throw new Error('无效的 MOSS 任务号');
            for (let attempt = 0; attempt < 180; attempt++) {
                signal.throwIfAborted();
                const polled = await json(`tasks/${encodeURIComponent(result.task_id)}`);
                const status = String(polled.status ?? '').toLowerCase();
                if (['failed', 'error', 'cancelled'].includes(status)) {
                    throw new Error(polled.error?.message ?? 'MOSS 生图任务失败');
                }
                if (['success', 'succeeded', 'completed'].includes(status) || polled.output?.images?.length || polled.data?.length) {
                    result = polled;
                    break;
                }
                await new Promise((resolve) => setTimeout(resolve, 1000));
            }
        }
        const image =
            result.data?.[0] ??
            result.images?.[0] ??
            result.output?.images?.[0] ??
            (typeof result.output?.url === 'string' ? { url: result.output.url } : undefined);
        const resolvedSeed = typeof result.seed === 'number' ? result.seed : seed;
        if (typeof image?.url === 'string') {
            return { seed: resolvedSeed, blob: await fetchResultUrl(image.url) };
        }
        return { seed: resolvedSeed, blob: fromImage(image?.b64_json) };
    }

    const body = {
        model: connection.model,
        prompt: naturalPrompt,
        ...(data.size || data.aspectRatio ? { size: data.size ?? `${size.width}x${size.height}` } : {}),
    };
    let result: { data?: { url?: string; b64_json?: string }[] } | undefined;
    if (refs.length) {
        const form = new FormData();
        for (const [key, value] of Object.entries(body)) form.append(key, value);
        for (const ref of refs) form.append('image[]', ref.blob, `reference.${ref.blob.type.split('/')[1]}`);
        const editRes = await sendRequest('images/edits', form);
        if (editRes.ok) {
            result = JSON.parse(await (await readLimited(editRes, mediaLimit * 2, signal)).text());
        } else {
            await editRes.body?.cancel();
            if ([400, 404, 405, 415, 422, 501].includes(editRes.status)) {
                result = await json('images/generations', body);
            } else {
                throw new Error(`生图服务返回 ${editRes.status}`);
            }
        }
    } else {
        result = await json('images/generations', body);
    }

    const image = result?.data?.[0];
    if (typeof image?.url === 'string') {
        return { blob: await fetchResultUrl(image.url) };
    }
    return { blob: fromImage(image?.b64_json) };
}
