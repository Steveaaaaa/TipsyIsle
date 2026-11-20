import { findExecutableQuickReply, quickReplySets, quickReplyContextItems, resolvedQuickReplyConfig, type ExecutableQuickReply, type QuickReplyData, type QuickReplySetData } from '../sandbox/quick-reply';
import { SlashScope, slashOutput, slashTruthy } from '../sandbox/slash-scope';
import { takeSlashToken, unquoteSlash } from '../sandbox/slash-syntax';

interface QuickReplyHost {
    read(): Record<string, any>;
    write(value: Record<string, any>): void;
    session(): { chat: string; character: string };
    slash(source: string, scope: SlashScope): Promise<string>;
    expand(source: string): string;
    input(text?: string): Promise<string>;
    choice(text: string, placement: 'replace' | 'before' | 'after'): Promise<string>;
    send(text: string): Promise<unknown>;
    save(): Promise<void>;
    report(error: unknown): void;
}

/** Public QR API and automation use the resident author executor and existing storage. */
export function createQuickReplyRuntime(host: QuickReplyHost) {
    const state = () => host.read();
    const config = () => resolvedQuickReplyConfig(state(), host.session().chat, host.session().character);
    const sets = () => quickReplySets(state());
    const findSet = (name: string) => sets().find(set => set.name === name);
    const requireSet = (name: string) => { const set = findSet(name); if (!set) throw new Error(`快捷回复集合不存在：${name}`); return set; };
    const findReply = (set: QuickReplySetData, label: string | number) => set.qrList.find(reply => Number.isInteger(label) ? reply.id === label : reply.label === label);
    const requireReply = (set: QuickReplySetData, label: string | number) => { const reply = findReply(set, label); if (!reply) throw new Error(`快捷回复不存在：${set.name}.${label}`); return reply; };
    const persistSet = (set: QuickReplySetData) => {
        const next = structuredClone(state());
        next.sets = [...quickReplySets(next).filter(item => item.name !== set.name), structuredClone(set)].sort((a, b) => a.name.localeCompare(b.name));
        host.write(next);
    };
    const editReply = (setName: string, label: string | number, change: (reply: QuickReplyData, set: QuickReplySetData) => void) => {
        const set = structuredClone(requireSet(setName)); const reply = requireReply(set, label);
        change(reply, set); persistSet(set); return replyView(set.name, reply);
    };
    let preventAutoExecute = false;
    async function execute(selected: ExecutableQuickReply, args: Record<string, any> = {}, options: { isRun?: boolean; scope?: SlashScope } = {}) {
        const set = selected.set ?? requireSet(selected.name);
        const scope = new SlashScope(options.scope);
        for (const [key, value] of Object.entries(args)) if (!key.startsWith('_') && key !== 'isAutoExecute') scope.setMacro(`arg::${key}`, value);
        scope.setMacro('arg::*', '');
        let text = selected.message;
        if (!text) return '';
        const manual = !args.isAutoExecute && !options.isRun;
        if (manual && set.injectInput && !set.disableSend) {
            const input = await host.input();
            if (input) text = set.placeBeforeInput ? `${text} ${input}` : `${input} ${text}`;
        }
        if (text.startsWith('/') && !set.disableSend) return host.slash(text, scope);
        text = host.expand(text.replace(/\{\{arg::([^{}]+)\}\}/g, (_match, key) => slashOutput(scope.macro(`arg::${key}`))));
        if (manual && set.disableSend) {
            await host.choice(text, set.injectInput ? set.placeBeforeInput ? 'before' : 'after' : 'replace');
            return '';
        }
        await host.input(text);
        if (!set.disableSend) { await host.input(''); await host.send(text); }
        return '';
    }
    const replyView = (name: string, reply: QuickReplyData): any => {
        const view: any = structuredClone(reply);
        Object.defineProperties(view, {
            execute: { value: (args: any = {}, _editor = false, isRun = false, options: any = {}) => execute({ name, label: view.label, message: view.message, disableSend: !!requireSet(name).disableSend, set: requireSet(name), reply: view }, args, { ...options, isRun }) },
            onUpdate: { value: () => { const { id } = view; editReply(name, id, current => Object.assign(current, structuredClone(view))); } },
            delete: { value: () => api.deleteQuickReply(name, view.id) },
        });
        return view;
    };
    const setView = (set: QuickReplySetData): any => {
        const view: any = structuredClone(set); view.qrList = set.qrList.map(reply => replyView(set.name, reply));
        Object.defineProperties(view, {
            save: { value: async () => { persistSet(view); await host.save(); } },
            delete: { value: () => api.deleteSet(view.name) },
            addQuickReply: { value: (data: any = {}) => api.createQuickReply(view.name, data.label ?? '', data) },
        });
        return view;
    };
    const linkSet = (name: string, chat: boolean, operation: 'add' | 'remove' | 'toggle', isVisible = true) => {
        requireSet(name); const next = structuredClone(state());
        const target = chat ? ((next.chatConfigs ??= {})[host.session().chat] ??= { setList: [] }) : (next.config ??= { setList: [] });
        target.setList ??= [];
        const index = target.setList.findIndex((link: any) => (typeof link.set === 'string' ? link.set : link.set?.name) === name);
        if (operation === 'remove' || operation === 'toggle' && index >= 0) { if (index >= 0) target.setList.splice(index, 1); }
        else if (index < 0) target.setList.push({ set: name, isVisible });
        else target.setList[index].isVisible = isVisible;
        host.write(next);
    };
    const api = {
        getSetByName: (name: string) => { const set = findSet(name); return set && setView(set); },
        getSetByQr: (reply: QuickReplyData) => { const set = sets().find(set => set.qrList.some(item => item.id === reply.id && item.label === reply.label && item.message === reply.message)); return set && setView(set); },
        getQrByLabel: (name: string, label: string | number) => { const set = findSet(name); const reply = set && findReply(set, label); return reply && replyView(name, reply); },
        executeQuickReplyByIndex: async (index: number) => {
            const selected = config().setList.flatMap((link: any) => link.set.qrList.map((reply: QuickReplyData) => ({ set: link.set, reply })))[index];
            if (!selected) throw new Error(`快捷回复序号不存在：${index}`);
            return execute({ ...selected, message: selected.reply.message, label: selected.reply.label, name: selected.set.name, disableSend: !!selected.set.disableSend });
        },
        executeQuickReply: (name: string, label: string | number, args: any = {}, options: any = {}) => replyView(name, requireReply(requireSet(name), label)).execute(args, false, false, options),
        toggleGlobalSet: (name: string, visible = true) => linkSet(name, false, 'toggle', visible),
        addGlobalSet: (name: string, visible = true) => linkSet(name, false, 'add', visible),
        removeGlobalSet: (name: string) => linkSet(name, false, 'remove'),
        toggleChatSet: (name: string, visible = true) => linkSet(name, true, 'toggle', visible),
        addChatSet: (name: string, visible = true) => linkSet(name, true, 'add', visible),
        removeChatSet: (name: string) => linkSet(name, true, 'remove'),
        createSet: async (name: string, props: any = {}) => {
            if (!name.trim()) throw new Error('快捷回复集合需要名称');
            const set = { name, disableSend: false, placeBeforeInput: false, injectInput: false, ...props, qrList: [], idIndex: 0 };
            persistSet(set); await host.save(); return setView(set);
        },
        updateSet: async (name: string, props: any = {}) => {
            const set = structuredClone(requireSet(name));
            for (const key of ['disableSend', 'placeBeforeInput', 'injectInput']) set[key] = props[key] ?? false;
            persistSet(set); await host.save(); return setView(set);
        },
        deleteSet: async (name: string) => {
            requireSet(name); const next = structuredClone(state()); next.sets = quickReplySets(next).filter(set => set.name !== name);
            for (const cfg of [next.config, next.chatConfig, next.charConfig, ...Object.values(next.chatConfigs ?? {}), ...Object.values(next.characterConfigs ?? {})] as any[]) {
                if (cfg?.setList) cfg.setList = cfg.setList.filter((link: any) => (typeof link.set === 'string' ? link.set : link.set?.name) !== name);
            }
            host.write(next); await host.save();
        },
        createQuickReply: (name: string, label: string, props: any = {}) => {
            const set = structuredClone(requireSet(name));
            const id = Math.max(set.idIndex ?? 0, ...set.qrList.map(reply => reply.id), 0) + 1; set.idIndex = id;
            const reply = { icon: '', showLabel: false, title: '', message: '', isHidden: false, preventAutoExecute: true,
                executeOnStartup: false, executeOnUser: false, executeOnAi: false, executeOnChatChange: false,
                executeOnNewChat: false, executeOnGroupMemberDraft: false, executeBeforeGeneration: false, automationId: '', contextList: [], ...props, id, label };
            set.qrList.push(reply); persistSet(set); return replyView(name, reply);
        },
        updateQuickReply: (name: string, label: string | number, props: any = {}) => editReply(name, label, reply => {
            const { newLabel, ...rest } = props;
            for (const [key, value] of Object.entries(rest)) if (value !== undefined && value !== null && key !== 'id') reply[key] = value;
            if (newLabel != null) reply.label = newLabel;
        }),
        deleteQuickReply: (name: string, label: string | number) => { editReply(name, label, (reply, set) => { set.qrList = set.qrList.filter(item => item !== reply); }); },
        createContextItem: (name: string, label: string | number, contextName: string, isChained = false) => {
            requireSet(contextName); editReply(name, label, reply => { (reply.contextList ??= []).push({ set: contextName, isChained }); });
        },
        deleteContextItem: (name: string, label: string | number, contextName: string) => { editReply(name, label, reply => { reply.contextList = (reply.contextList ?? []).filter((link: any) => (typeof link.set === 'string' ? link.set : link.set?.name) !== contextName); }); },
        clearContextMenu: (name: string, label: string | number) => { editReply(name, label, reply => { reply.contextList = []; }); },
        listSets: () => sets().map(set => set.name),
        listGlobalSets: () => (state().config?.setList ?? []).map((link: any) => typeof link.set === 'string' ? link.set : link.set.name),
        listChatSets: () => (state().chatConfigs?.[host.session().chat]?.setList ?? state().chatConfig?.setList ?? []).map((link: any) => typeof link.set === 'string' ? link.set : link.set.name),
        listQuickReplies: (name: string) => requireSet(name).qrList.map(reply => reply.label),
        listAutomationIds: () => [...new Set(sets().flatMap(set => set.qrList.map(reply => reply.automationId).filter(Boolean)))],
    };
    const executeByName = (name: string, args: any = {}, options: any = {}) => {
        const selected = findExecutableQuickReply(config(), name);
        if (!selected) throw new Error(`快捷回复不存在：${name}`);
        return execute(selected, args, { ...options, isRun: true });
    };
    const executeContext = async (name: string, id: number, path: Array<{ set: string; id: number }>) => {
        let items = quickReplyContextItems(state(), name, id);
        let selected;
        for (const step of path) {
            selected = items.find(item => item.set === step.set && item.id === step.id);
            if (!selected) throw new Error('快捷回复菜单内容已改变，请重新打开菜单');
            items = selected.children;
        }
        if (!selected) throw new Error('请选择快捷回复菜单项');
        const set = requireSet(selected.set), reply = requireReply(set, selected.id);
        return execute({ name: set.name, label: reply.label, message: selected.message, disableSend: !!set.disableSend, set, reply });
    };
    const automatic = async (flag: string, automationIds?: string[]) => {
        if (!state().isEnabled || preventAutoExecute) return;
        const selected = config().setList.flatMap((link: any) => link.set.qrList.filter((reply: QuickReplyData) => automationIds ? reply.automationId && automationIds.includes(reply.automationId) : reply[flag])
            .map((reply: QuickReplyData) => ({ set: link.set, reply })));
        for (const { set, reply } of selected) {
            const previous = preventAutoExecute; preventAutoExecute = reply.preventAutoExecute !== false;
            try { await execute({ set, reply, name: set.name, label: reply.label, message: reply.message, disableSend: !!set.disableSend }, { isAutoExecute: true }); }
            catch (error) { host.report(error); }
            finally { preventAutoExecute = previous; }
        }
    };
    async function command(name: string, args: Record<string, any>, value: unknown, scope: SlashScope): Promise<unknown> {
        const text = slashOutput(value), label = args.id === undefined ? args.label ?? text : Number(args.id);
        const fields = { icon: 'icon', showlabel: 'showLabel', title: 'title', hidden: 'isHidden', startup: 'executeOnStartup', user: 'executeOnUser', bot: 'executeOnAi', load: 'executeOnChatChange', new: 'executeOnNewChat', group: 'executeOnGroupMemberDraft', generation: 'executeBeforeGeneration', automationId: 'automationId', newlabel: 'newLabel' };
        const props: Record<string, any> = {};
        for (const [key, target] of Object.entries(fields)) if (args[key] !== undefined) props[target] = ['icon', 'title', 'automationId', 'newlabel'].includes(key) ? args[key] : slashTruthy(args[key]);
        if (name === 'qr') return api.executeQuickReplyByIndex(Number(text));
        if (name === 'qr-arg') { const head = takeSlashToken(text); const key = unquoteSlash(head.token); scope.setMacro(`arg::${key}`, unquoteSlash(head.rest), key.includes('*')); return ''; }
        if (name === 'qr-set-list') return JSON.stringify(text === 'global' ? api.listGlobalSets() : text === 'chat' ? api.listChatSets() : api.listSets());
        if (name === 'qr-list') return JSON.stringify(api.listQuickReplies(text));
        if (name === 'qr-get') return JSON.stringify(api.getQrByLabel(args.set, label)) ?? '';
        if (name === 'qr-create') { api.createQuickReply(args.set, args.label ?? '', { ...props, message: text }); return ''; }
        if (name === 'qr-update') { api.updateQuickReply(args.set, label, { ...props, ...(text.trim() ? { message: text } : {}) }); return ''; }
        if (name === 'qr-delete') { api.deleteQuickReply(args.set, label); return ''; }
        if (name === 'qr-contextadd') { api.createContextItem(args.set, label, text, slashTruthy(args.chain)); return ''; }
        if (name === 'qr-contextdel') { api.deleteContextItem(args.set, label, text); return ''; }
        if (name === 'qr-contextclear') { api.clearContextMenu(args.set, label); return ''; }
        if (name === 'qr-set-create' || name === 'qr-set-update') { await api[name === 'qr-set-create' ? 'createSet' : 'updateSet'](args.name ?? text, { disableSend: slashTruthy(args.nosend), placeBeforeInput: slashTruthy(args.before), injectInput: slashTruthy(args.inject) }); return ''; }
        if (name === 'qr-set-delete') { await api.deleteSet(text); return ''; }
        const link = /^qr-(chat-)?set(?:-(on|off))?$/.exec(name);
        if (link) { linkSet(text, !!link[1], link[2] === 'on' ? 'add' : link[2] === 'off' ? 'remove' : 'toggle', args.visible === undefined || slashTruthy(args.visible)); return ''; }
        throw new Error(`尚未接入 Slash 命令 /${name}`);
    }
    return { api, config, execute, executeByName, executeContext, automatic, command };
}
