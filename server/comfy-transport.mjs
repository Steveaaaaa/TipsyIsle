export async function requestComfyEndpoint(ping, body, signal, transport = fetch) {
    const base = new URL(body.url);
    if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('ComfyUI 地址无效');
    const endpoint = (path) => `${base.href.replace(/\/+$/, '')}/${path}`;
    const fetchComfy = async (path, init) => {
        const response = await transport(endpoint(path), { ...init, signal, redirect: 'error' });
        if (!response.ok) throw new Error(`ComfyUI HTTP ${response.status}: ${await response.text()}`);
        return response;
    };
    if (ping) { await fetchComfy('system_stats'); return { ok: true }; }
    const { prompt_id: id } = await (await fetchComfy('prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body.prompt })).json();
    if (!id) throw new Error('ComfyUI did not accept the workflow');
    const until = Date.now() + 600000;
    while (Date.now() < until) {
        const result = await (await fetchComfy(`history/${encodeURIComponent(id)}`)).json();
        const job = result[id];
        const image = Object.values(job?.outputs ?? {}).flatMap(output => output.images ?? [])[0];
        if (image) {
            const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder ?? '', type: image.type ?? 'output' });
            const response = await fetchComfy(`view?${query}`);
            const bytes = new Uint8Array(await response.arrayBuffer());
            let text = '';
            for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768));
            return { data: btoa(text), format: image.filename.split('.').at(-1)?.toLowerCase() ?? 'png' };
        }
        if (job?.status?.completed || job?.status?.status_str === 'error') throw new Error('ComfyUI 未生成图片，请检查工作流');
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('ComfyUI 等待超时');
}
