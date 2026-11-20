export interface QuickReplyData extends Record<string, any> { id: number; label: string; message: string }
export interface QuickReplySetData extends Record<string, any> { name: string; qrList: QuickReplyData[]; idIndex?: number; disableSend?: boolean; injectInput?: boolean; placeBeforeInput?: boolean }
export interface ExecutableQuickReply { message: string; name: string; label: string; disableSend: boolean; reply?: QuickReplyData; set?: QuickReplySetData }
export interface QuickReplyContextItem {
    set: string; id: number; label: string; title: string; icon: string; message: string;
    path: Array<{ set: string; id: number }>; children: QuickReplyContextItem[];
}

/** Chains retain parent labels and target-set execution options, as upstream does. */
export function quickReplyContextItems(settings: any, setName: string, id: number): QuickReplyContextItem[] {
    const sets = quickReplySets(settings);
    const rootSet = sets.find(set => set.name === setName);
    const root = rootSet?.qrList.find(reply => reply.id === id);
    if (!root || !rootSet) return [];
    const build = (set: QuickReplySetData, reply: QuickReplyData, prefix: string, visited: string[], labels: string[], path: QuickReplyContextItem['path']): QuickReplyContextItem[] => {
        const message = (prefix && reply.message ? `${prefix} | ` : '') + reply.message;
        return (reply.contextList ?? []).flatMap((link: any) => {
            const target = sets.find(set => set.name === (typeof link.set === 'string' ? link.set : link.set?.name));
            if (!target || visited.includes(target.name)) return [];
            const parents = [...labels, reply.label];
            return target.qrList.filter(child => target.name === set.name ? child.isHidden && !!child.icon : !child.isHidden).map(child => {
                const chained = link.isChained ? message : '';
                const childMessage = (chained && child.message ? `${chained} | ` : '') + child.message;
                const childPath = [...path, { set: target.name, id: child.id }];
                return { set: target.name, id: child.id, label: child.label, title: child.title ?? '', icon: child.icon ?? '', path: childPath,
                    message: childMessage.replace(/%%parent(-\d+)?%%/g, (_match, index) => parents.slice(Number(index ?? -1))[0] ?? ''),
                    children: build(target, child, chained, [...visited, target.name], parents, childPath) };
            });
        });
    };
    return build(rootSet, root, '', [], [], []);
}

/** Resolve persisted set names and embedded community exports through the same view. */
export function quickReplySets(settings: any): QuickReplySetData[] {
    const sets = new Map<string, QuickReplySetData>();
    for (const set of settings?.sets ?? []) if (typeof set?.name === 'string' && Array.isArray(set.qrList)) sets.set(set.name, set);
    const configs = [settings?.config, settings?.chatConfig, settings?.charConfig, settings,
        ...Object.values(settings?.chatConfigs ?? {}), ...Object.values(settings?.characterConfigs ?? {})];
    for (const config of configs as any[]) for (const link of config?.setList ?? []) {
        if (typeof link?.set?.name === 'string' && Array.isArray(link.set.qrList) && !sets.has(link.set.name)) sets.set(link.set.name, link.set);
    }
    return [...sets.values()];
}
export function resolvedQuickReplyConfig(settings: any, chatId?: string, characterId?: string) {
    const sets = quickReplySets(settings);
    const configs = [settings?.config ?? settings, settings?.chatConfigs?.[chatId ?? ''] ?? settings?.chatConfig,
        settings?.characterConfigs?.[characterId ?? ''] ?? settings?.characterConfigs?.[`${characterId}.png`] ?? settings?.charConfig];
    return { sets, setList: configs.flatMap(config => (config?.setList ?? []).map((link: any) => ({ ...link,
        set: sets.find(set => set.name === (typeof link.set === 'string' ? link.set : link.set?.name)) })).filter((link: any) => link.set)) };
}

/** Resolve exact labels first, then Set.Label without splitting dotted set names. */
export function findExecutableQuickReply(config: any, name: string): ExecutableQuickReply | undefined {
    const links: any[] = config?.setList ?? [];
    const candidates = links.filter(link => link?.isActive !== false && link?.set);
    for (const qualified of [false, true]) for (const set of qualified ? config?.sets ?? candidates.map(link => link.set) : candidates.map(link => link.set)) {
        const reply = set.qrList?.find((item: QuickReplyData) => typeof item?.message === 'string' && (qualified ? `${set.name}.${item.label}` : item.label) === name);
        if (reply) return { message: reply.message, name: set.name, label: reply.label, disableSend: !!set.disableSend, set, reply };
    }
    return undefined;
}
