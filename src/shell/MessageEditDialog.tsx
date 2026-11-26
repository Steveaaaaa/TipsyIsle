import { useEffect, useRef, useState } from 'react';
import { copyTextToClipboard } from '../core/clipboard';
import { storySpeakerName } from '../core/story-identity';
import { editMessageInPlace, getActiveChatMessages, setStatusBanner, workspaceStore } from '../store/workspace-store';
import type { ChatMessageNode } from '../types';
import { Icon } from './Icon';

export function openMessageEditor(messageId: string): void {
    window.dispatchEvent(new CustomEvent('tipsy-edit-message', { detail: { messageId } }));
}

export function MessageEditDialog({
    freeChat,
    userName,
    characterName,
}: {
    freeChat?: boolean;
    userName: string;
    characterName: string;
}) {
    const isGenerating = workspaceStore.useStore(state => state.isGenerating);
    const helperGenerationCount = workspaceStore.useStore(state => state.helperGenerationCount);
    const [target, setTarget] = useState<ChatMessageNode | null>(null);
    const [draft, setDraft] = useState('');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const dialogRef = useRef<HTMLDialogElement | null>(null);

    useEffect(() => {
        const handleOpen = (event: Event) => {
            const messageId = (event as CustomEvent<{ messageId?: string }>).detail?.messageId;
            if (!messageId) return;
            const node = getActiveChatMessages().find(item => item.id === messageId);
            if (!node) return;
            setTarget(node);
            setDraft(node.content);
            setError('');
            setSaving(false);
        };
        window.addEventListener('tipsy-edit-message', handleOpen);
        return () => window.removeEventListener('tipsy-edit-message', handleOpen);
    }, []);

    useEffect(() => {
        const dialog = dialogRef.current;
        if (!dialog) return;
        if (target && !dialog.open) dialog.showModal();
        else if (!target && dialog.open) dialog.close();
    }, [target]);

    if (!target) return null;

    const busy = saving || isGenerating || helperGenerationCount > 0;
    const speaker = target.role === 'user'
        ? userName
        : target.role === 'assistant'
            ? (freeChat ? characterName : storySpeakerName(target.speakerName, characterName))
            : target.speakerName;

    const close = () => {
        if (saving) return;
        setTarget(null);
        setError('');
    };

    const handleCopy = async () => {
        const ok = await copyTextToClipboard(draft);
        setStatusBanner(ok ? '已复制到剪贴板' : '复制失败，请在编辑框内全选复制', { kind: ok ? 'success' : 'error' });
    };

    const handleSave = async () => {
        if (busy) return;
        setSaving(true);
        setError('');
        try {
            const saved = await editMessageInPlace(target.id, draft);
            if (!saved) {
                setError('未找到要修改的消息');
                setSaving(false);
                return;
            }
            setTarget(null);
            setSaving(false);
            setStatusBanner('已保存消息修改', { kind: 'success' });
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
            setSaving(false);
        }
    };

    return (
        <dialog
            ref={dialogRef}
            className="ttm-action-dialog ttm-message-edit-dialog"
            aria-labelledby="message-edit-title"
            onCancel={(event) => {
                if (saving) { event.preventDefault(); return; }
                close();
            }}
            onClick={(event) => {
                if (event.target === event.currentTarget) close();
            }}
        >
            <div className="ttm-bottom-sheet ttm-message-edit-sheet">
                <div className="ttm-bottom-sheet-handle" />
                <div className="ttm-section-head-row">
                    <h3 id="message-edit-title">修改 {speaker} · #{target.floor}</h3>
                    <button type="button" className="ttm-icon-btn" aria-label="关闭消息编辑" disabled={saving} onClick={close}>
                        <Icon name="close" />
                    </button>
                </div>
                <textarea
                    className="ttm-message-edit-textarea"
                    aria-label="消息正文编辑"
                    value={draft}
                    disabled={saving}
                    onChange={event => setDraft(event.target.value)}
                />
                {error && <p className="ttm-message-edit-error" role="alert">{error}</p>}
                <div className="ttm-message-edit-footer">
                    <button type="button" className="ttm-btn-secondary" disabled={saving} onClick={() => void handleCopy()}>
                        复制
                    </button>
                    <button type="button" className="ttm-btn-secondary" disabled={saving} onClick={close}>
                        取消
                    </button>
                    <button type="button" className="ttm-btn-primary" disabled={busy} onClick={() => void handleSave()}>
                        {saving ? '保存中…' : '保存修改'}
                    </button>
                </div>
            </div>
        </dialog>
    );
}
