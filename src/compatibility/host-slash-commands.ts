import { slashOutput, slashTruthy } from '../sandbox/slash-scope';

interface HostCommands {
    helper: Record<string, any>;
    register(command: { name: string; aliases?: string[]; callback(args: any, value: any): Promise<unknown> }): void;
    request(method: string, params?: Record<string, any>): Promise<any>;
    expand(text: string): string;
    regex(text: string, character?: string): string;
    isTemplateExecuting(): boolean;
}

/** Reuse Helper's storage, message notifications and generation pipeline. */
export function installHostSlashCommands(host: HostCommands): void {
    const h = host.helper;
    const add = (name: string, aliases: string[], mutate: boolean, callback: (args: any, text: string) => Promise<unknown> | unknown) => {
        host.register({ name, aliases, callback: async (args, value) => {
            if (mutate && host.isTemplateExecuting()) throw new Error(`模板装配期间不能执行 /${name}，请在模板任务结束后调用`);
            return callback(args, slashOutput(value));
        } });
    };
    const selected = (range: string, args: any = {}) => h.getChatMessages(range || '-1', {
        ...(args.role ? { role: args.role } : {}), hide_state: args.hidden === undefined || slashTruthy(args.hidden) ? 'all' : 'unhidden',
    }) as any[];
    add('messages', ['message'], false, (args, text) => selected(text, args)
        .map(message => slashTruthy(args.names) ? `${message.name}: ${message.message}` : message.message).join('\n\n'));
    for (const name of ['hide', 'unhide']) add(name, [], true, async (args, text) => {
        const messages = selected(text).filter(message => !args.name || message.name === args.name);
        if (messages.length) await h.setChatMessages(messages.map(message => ({ message_id: message.message_id, is_hidden: name === 'hide' })));
        return '';
    });
    add('delname', [], true, async (_args, text) => {
        const messages = selected(`0-${h.getLastMessageId()}`).filter(message => message.name === text);
        if (messages.length) await h.deleteChatMessages(messages.map(message => message.message_id));
        return '';
    });
    add('cut', [], true, async (_args, text) => {
        const messages = selected(text);
        const content = messages.map(message => message.message).join('\n\n');
        if (messages.length) await h.deleteChatMessages(messages.map(message => message.message_id));
        return content;
    });
    for (const [name, role] of [['send', 'user'], ['sendas', 'assistant'], ['sys', 'system'], ['comment', 'system']] as const) {
        add(name, name === 'sys' ? ['narrator'] : [], true, async (args, text) => {
            const message = { role, message: role === 'user' ? text.trim() : host.regex(text.trim(), args.name),
                ...(args.name !== undefined ? { name: String(args.name) } : {}), ...(name === 'comment' ? { is_hidden: true } : {}) };
            if (name === 'sendas' && args.at === undefined) await host.request('legacy.sendAs', { message });
            else await h.createChatMessages([message], args.at === undefined ? {} : { insert_before: Number(args.at) });
            return args.return === 'text' ? message.message : args.return === 'object' ? JSON.stringify(message) : '';
        });
    }
    add('setinput', [], true, async (_args, text) => { await host.request('composer.input', { text }); return text; });
    add('input', [], true, (args, text) => window.prompt(text, String(args.default ?? '')) ?? '');
    add('popup', [], true, (_args, text) => { window.alert(text); return ''; });
    add('stop', [], true, async () => { h.stopAllGeneration(); await host.request('slash.stop'); return ''; });
    for (const name of ['trigger', 'regenerate']) add(name, name === 'regenerate' ? ['regen'] : [], true, async args => {
        await host.request('composer.input', { text: '' });
        const task = host.request('slash.generate', { generationType: name === 'regenerate' ? 'regenerate' : 'normal' });
        if (slashTruthy(args.await)) await task;
        else void task.catch(error => {
            console.error(`Slash ${name} failed`, error);
            void host.request('slash.error', { message: error instanceof Error ? error.message : String(error) });
        });
        return '';
    });
    for (const raw of [false, true]) add(raw ? 'genraw' : 'gen', [], true, async (args, text) => {
        const config: any = { should_silence: !slashTruthy(args.lock), should_stream: false };
        const resolve = (value: any) => args._scope?.existsVariable(String(value)) ? args._scope.getVariable(String(value))
            : h.getVariables({ type: 'chat' })[value] ?? h.getVariables({ type: 'global' })[value] ?? value;
        if (args.length !== undefined && Number(resolve(args.length)) > 0) config.custom_api = { max_tokens: Number(resolve(args.length)) };
        if (args.stop !== undefined) {
            const value = resolve(args.stop); let stop: unknown;
            try { stop = JSON.parse(value); } catch { stop = [String(value)]; }
            config.custom_api = { ...config.custom_api, custom_include_body: { stop } };
        }
        const role = args.as === 'char' ? 'assistant' : 'system';
        if (raw) config.ordered_prompts = [
            ...(args.system ? [{ role: 'system', content: String(resolve(args.system)) }] : []),
            { role, content: text }, ...(args.prefill ? [{ role: 'assistant', content: String(resolve(args.prefill)) }] : []),
        ];
        else config.injects = [{ role, content: text, position: 'in_chat', depth: 0, should_scan: false }];
        await host.request('composer.input', { text: '' });
        const result = await (raw ? h.generateRaw(config) : h.generate(config));
        let content = typeof result === 'string' ? result : result.content;
        if (slashTruthy(args.trim)) { const match = /[\s\S]*[.!?。！？](?:["'”’）)]*)/.exec(content); if (match) content = match[0]; }
        return content;
    });
    add('addswipe', [], true, async (args, text) => {
        const message = h.getChatMessages(-1, { include_swipes: true })[0];
        if (!message || message.role !== 'assistant' || !text) return '';
        const index = message.swipes.length;
        await h.setChatMessages([{ message_id: message.message_id, swipes: [...message.swipes, text],
            swipes_data: [...message.swipes_data, {}], swipes_info: [...message.swipes_info, {}],
            swipe_id: slashTruthy(args.switch) ? index : message.swipe_id }]);
        return String(index);
    });
    add('delswipe', [], true, async (_args, text) => {
        const message = h.getChatMessages(-1, { include_swipes: true })[0];
        if (!message || message.swipes.length < 2) return '';
        const index = text ? Number(text) - 1 : message.swipe_id;
        if (!Number.isInteger(index) || index < 0 || index >= message.swipes.length) throw new Error('候选消息序号不存在');
        const swipe_id = Math.max(0, Math.min(message.swipes.length - 2, message.swipe_id - Number(index < message.swipe_id)));
        await h.setChatMessages([{ message_id: message.message_id, swipe_id,
            swipes: message.swipes.filter((_value: any, i: number) => i !== index),
            swipes_data: message.swipes_data.filter((_value: any, i: number) => i !== index),
            swipes_info: message.swipes_info.filter((_value: any, i: number) => i !== index) }]);
        await h.eventEmit('message_swipe_deleted', message.message_id);
        return String(swipe_id);
    });
    add('tokens', [], false, async (_args, text) => String(await host.request('generation.tokens', { text })));
    const regexFrom = (pattern: string) => { const match = /^\/([\s\S]*)\/([dgimsuvy]*)$/.exec(pattern); return match ? new RegExp(match[1], match[2]) : new RegExp(pattern); };
    add('replace', ['re'], false, (args, text) => {
        if (!args.pattern) throw new Error('/replace 需要 pattern 参数');
        return args.mode === 'regex' ? text.replace(regexFrom(String(args.pattern)), String(args.replacer ?? '')) : text.replaceAll(String(args.pattern), String(args.replacer ?? ''));
    });
    add('test', [], false, (args, text) => { if (!args.pattern) throw new Error('/test 需要 pattern 参数'); return String(regexFrom(String(args.pattern)).test(text)); });
    add('getglobalbooks', ['getgloballore', 'getglobalwi'], false, () => JSON.stringify(h.getGlobalWorldbookNames()));
    add('world', [], true, async (args, text) => {
        const names = h.getGlobalWorldbookNames() as string[];
        if (!text) await h.rebindGlobalWorldbooks([]);
        else { const remove = args.state === 'off' || args.state === 'toggle' && names.includes(text);
            await h.rebindGlobalWorldbooks(remove ? names.filter(name => name !== text) : [...new Set([...names, text])]); }
        return '';
    });
    add('getchatbook', ['getchatlore', 'getchatwi'], false, async args => {
        const current = h.getChatWorldbookName('current');
        if (current || args.create !== undefined && !slashTruthy(args.create)) return current ?? '';
        if (host.isTemplateExecuting()) throw new Error('模板装配期间请使用 getchatbook create=false 查询已有世界书');
        return h.getOrCreateChatWorldbook('current', args.name);
    });
    add('getcharbook', ['getcharlore', 'getcharwi'], false, async (args, text) => {
        const books = h.getCharWorldbookNames(text || 'current');
        if (!books.primary && slashTruthy(args.create)) {
            if (host.isTemplateExecuting()) throw new Error('模板装配期间不能创建角色世界书');
            const name = args.name ?? `${text || h.getCurrentCharacterName()} Book`;
            await h.createWorldbook(name); books.primary = name; await h.rebindCharWorldbooks(text || 'current', books);
        }
        return args.type === 'all' ? JSON.stringify([books.primary, ...books.additional].filter(Boolean))
            : args.type === 'additional' ? JSON.stringify(books.additional) : books.primary ?? '';
    });
    add('getentryfield', ['getlorefield', 'getwifield'], false, async (args, text) => {
        const entries = await host.request('worldbook.native.read', { name: args.file });
        const entry = entries.find((entry: any) => String(entry.uid) === text);
        const field = args.field ?? 'content';
        const aliases: Record<string, string> = { characterFilterNames: 'names', characterFilterTags: 'tags', characterFilterExclude: 'isExclude' };
        return host.expand(slashOutput(aliases[field] ? entry?.characterFilter?.[aliases[field]] : entry?.[field]));
    });
    add('setentryfield', ['setlorefield', 'setwifield'], true, async (args, text) => {
        await host.request('worldbook.native.field', { name: args.file, uid: args.uid, field: args.field ?? 'content', value: text }); return '';
    });
    add('findentry', ['findlore', 'findwi'], false, async (args, text) => {
        const entries = await host.request('worldbook.native.read', { name: args.file });
        const { default: Fuse } = await import('fuse.js');
        const field = args.field ?? 'key';
        const value = typeof entries[0]?.[field] === 'boolean' ? /^(true|on|yes|1)$/i.test(text) ? 'true' : /^(false|off|no|0)$/i.test(text) ? 'false' : text : text;
        return String(new Fuse<any>(entries, { keys: [{ name: field, weight: 1 }], includeScore: true, threshold: 0.3 }).search(value)[0]?.item.uid ?? '');
    });
    add('createentry', ['createlore', 'createwi'], true, async (args, text) => host.request('worldbook.native.create', { name: args.file, key: args.key, content: text }));
    add('wi-get-timed-effect', [], false, (args, text) => host.request('worldbook.effect.get', { name: args.file, uid: text, effect: args.effect, format: args.format }));
    add('wi-set-timed-effect', [], true, (args, text) => host.request('worldbook.effect.set', { name: args.file, uid: args.uid, effect: args.effect, value: text }));
    add('mvu-reparse', [], true, () => host.request('mvu.reprocess', { extra: false }));
    add('mvu-retry', [], true, () => host.request('mvu.reprocess', { extra: true }));
    add('mvu-repair', [], true, (_args, direction) => host.request('mvu.repair', { direction }));
    add('mvu-undo', [], true, () => host.request('mvu.repair.undo'));
}
