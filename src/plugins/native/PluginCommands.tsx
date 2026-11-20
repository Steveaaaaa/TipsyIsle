import { useEffect, useRef, useState } from 'react';
import type { CommandInput, MessageRef, Panel } from '../../../packages/plugin-sdk/index.js';
import { createReactiveStore } from '../../store/reactive-store';
import type { ChatMessageNode } from '../../types';
import { AnchoredDialog } from '../../shell/AnchoredDialog';
import { Icon } from '../../shell/Icon';
import { nativePluginStore, errorMessage } from './catalog';
import { listNativeCommands, runNativeCommand, watchNativeCommand, type CommandSession, type PluginCommand } from './host';
import { liveStory, messageRef, type StoryView } from './story-port';
import { PluginPanel, SurfaceTask } from './PluginSurface';
import './native-plugins.css';

interface Request { commands: PluginCommand[]; view: StoryView; target?: MessageRef; selected?: PluginCommand; nonce: number; anchor?: HTMLElement }
const picker = createReactiveStore<{ request: Request | null }>(() => ({ request: null }));
let sequence = 0;
const close = () => picker.setState({ request: null });
export function openMessagePluginPicker(id: string, swipe: string, updatedAt?: number) {
    const view = liveStory();
    const node = view.path.find(item => item.id === id);
    if (!node || messageRef(node).swipeId !== swipe || node.updatedAt !== updatedAt) throw new Error('这条回复已经改变，请重新打开消息菜单');
    const target = messageRef(node), commands = listNativeCommands('message', view, target);
    if (!commands.length) throw new Error('这条回复没有可用的插件操作');
    picker.setState({ request: { commands, view, target, nonce: ++sequence } });
}

export function PluginButtons({ message, onOpen }: { message?: ChatMessageNode; onOpen?(): void }) {
    nativePluginStore.useStore(state => state.catalog);
    nativePluginStore.useStore(state => state.maintenance);
    const view = liveStory();
    const target = message ? messageRef(message) : undefined;
    const commands = listNativeCommands(message ? 'message' : 'composer', view, target);
    return <>{commands.map(command => <button type="button" key={command.key} title={command.plugin.manifest.name}
        className={message ? 'ttm-btn-ghost' : 'ttm-btn-secondary'} onClick={event => {
            onOpen?.(); picker.setState({ request: { commands: [command], selected: command, view, target, nonce: ++sequence, anchor: event.currentTarget } });
        }}>{command.spec.label}</button>)}</>;
}

export function WorkspacePluginMenu() {
    nativePluginStore.useStore(state => state.catalog);
    nativePluginStore.useStore(state => state.maintenance);
    const view = liveStory(), commands = listNativeCommands('workspace', view);
    if (!commands.length) return null;
    return <button type="button" className="ttm-icon-btn ttm-native-workspace-trigger" title="插件工具" aria-label="插件工具" aria-haspopup="dialog"
        onClick={event => picker.setState({ request: { commands, view, nonce: ++sequence, anchor: event.currentTarget } })}><Icon name="plugin" /></button>;
}

function CommandDialog({ request }: { request: Request }) {
    const [selected, select] = useState(request.selected);
    const [reply, setReply] = useState<{ panel: Panel; step: number } | null>(null);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    const [invalid, setInvalid] = useState(false);
    const [completion, setCompletion] = useState<{ id: string; state: string }>();
    const delivered = useRef(new Set<string>());
    const running = useRef<AbortController>();
    const cancel = () => { const controller = running.current; running.current = undefined; controller?.abort(); };
    const session = (command: PluginCommand): CommandSession => ({ command, view: request.view, target: request.target });
    useEffect(() => {
        const subscriptions = (selected ? [selected] : request.commands).map(command => watchNativeCommand(session(command), () => {
            cancel(); setPending(false); setInvalid(true);
        }));
        return () => subscriptions.forEach(unsubscribe => unsubscribe());
    }, [selected, request]);
    const run = async (command: PluginCommand, action?: CommandInput['action']) => {
        if (running.current || invalid) return;
        const controller = new AbortController();
        running.current = controller;
        setPending(true); setError('');
        try {
            const panel = await runNativeCommand(session(command), controller.signal, action);
            if (controller.signal.aborted) return;
            if (panel) setReply(previous => ({ panel, step: (previous?.step ?? 0) + 1 })); else close();
        } catch (error) { if (!controller.signal.aborted) setError(errorMessage(error)); }
        finally { if (running.current === controller) { running.current = undefined; setPending(false); } }
    };
    useEffect(() => { if (selected) void run(selected); return cancel; }, [selected]);
    const task = reply?.panel.task;
    useEffect(() => {
        if (!pending && !invalid && selected && task?.onFinished && completion?.id === task.id && !delivered.current.has(task.id)) {
            delivered.current.add(task.id);
            void run(selected, { id: task.onFinished, values: { taskId: task.id, taskState: completion.state }, state: reply?.panel.state });
        }
    }, [pending, invalid, selected, task, completion]);
    const title = reply?.panel.title ?? selected?.spec.label ?? (request.target ? '本楼插件' : '插件工具');
    const surface = selected?.spec.surface ?? 'dialog';
    const owner = selected && `${selected.plugin.manifest.id}:${selected.plugin.fingerprint}`;
    return <AnchoredDialog anchor={request.anchor ?? document.body} title={title} compact={surface === 'dialog'} centered fitContent surface={surface} className="ttm-native-command-dialog" onClose={close}>
        {invalid ? <p role="status" className="ttm-settings-note">剧情或插件状态已改变。请关闭面板，在当前路线重新打开。</p> : <>
            {selected && <p className="ttm-native-panel-byline">{selected.plugin.manifest.name}</p>}
            {!selected && <div className="ttm-native-command-list">{request.commands.map(command => <button type="button" key={command.key} className="ttm-btn-secondary" onClick={() => select(command)}>{command.spec.label}<small>{command.plugin.manifest.name}</small></button>)}</div>}
            {pending && <p role="status" className="ttm-settings-note">正在运行…</p>}
            {error && <p role="alert" className="ttm-native-error">{error}</p>}
            {task && owner && <SurfaceTask key={task.id} owner={owner} id={task.id} onFinished={state => setCompletion({ id: task.id, state })} />}
            {reply && selected && owner && <PluginPanel key={reply.step} owner={owner} panel={reply.panel} disabled={pending} onAction={action => void run(selected, action)} />}
            {error && !reply && selected && <button type="button" className="ttm-btn-secondary" disabled={pending} onClick={() => void run(selected)}>重试</button>}
        </>}
    </AnchoredDialog>;
}

export function NativePluginCommandHost() {
    const request = picker.useStore(state => state.request);
    return request ? <CommandDialog key={request.nonce} request={request} /> : null;
}
