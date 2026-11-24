type LookupResult = { ok: boolean; models?: string[]; reason?: string };
interface AvsPanel {
    mode: HTMLSelectElement;
    preset: HTMLSelectElement;
    model: HTMLInputElement;
    show(models: string[]): void;
    direct(): Promise<LookupResult>;
    warn(reason: string): void;
}

export function bindAvsProxyPanel(panel: AvsPanel, defaultModel: (name: string) => string, lookup: (name: string) => Promise<string[]>) {
    let revision = 0;
    const sync = (changed: boolean) => {
        revision++;
        const model = panel.mode.value === 'proxy' ? defaultModel(panel.preset.value) : '';
        if (changed || !panel.model.value.trim()) panel.model.value = model;
        panel.show(model ? [model] : []);
    };
    panel.mode.addEventListener('change', () => sync(true));
    panel.preset.addEventListener('change', () => sync(true));
    return {
        restore: () => sync(false),
        async refresh() {
            const ticket = ++revision;
            const preset = panel.mode.value === 'proxy' ? panel.preset.value : null;
            if (preset === '') return panel.warn('请先选择代理预设');
            try {
                const result: LookupResult = preset === null ? await panel.direct() : { ok: true, models: await lookup(preset) };
                if (ticket !== revision) return;
                if (!result.ok) return panel.warn(result.reason || '模型列表获取失败');
                const models = result.models ?? [];
                panel.show([...new Set([preset && defaultModel(preset), ...models].filter((name): name is string => !!name))]);
                if (!models.length) panel.warn('此连接未返回模型列表，仍可使用已配置的模型或手动填写');
            } catch (error) {
                if (ticket === revision) panel.warn(String((error as Error)?.message ?? error));
            }
        },
    };
}

export function adaptAvsProxyPanel(source: string): string {
    if (!source.includes("build: '20261108-v410-history-deepen1'")) return source;
    const refresh = "async()=>{const r=await fetchApiModels(draft());if(!r.ok){toast('error',r.reason||'模型列表获取失败');return;}available=r.models||[];restoreSelectedModel(draft());}";
    const fill = 'restoreSelectedModel(c);updateLabels();toggleConnection();}';
    const mount = 'fill(saved);renderStatus();const timer=';
    const anchors = [refresh, fill, mount];
    if (!anchors.every(anchor => source.includes(anchor) && source.indexOf(anchor) === source.lastIndexOf(anchor))) return source;
    return source.replace(refresh, '()=>tipsyPanel.refresh()')
        .replace(fill, 'tipsyPanel.restore();updateLabels();toggleConnection();}')
        .replace(mount, `const tipsyPanel=__tipsyBindAvsProxyPanel({mode,preset:pxy.node,model:inputs.model,
            show(models){available=models;restoreSelectedModel(draft());},direct:()=>fetchApiModels(draft()),warn:reason=>toast('error',reason)});
        ${mount}`);
}
