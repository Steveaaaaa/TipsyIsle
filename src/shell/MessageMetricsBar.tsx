import { memo, useEffect, useState } from 'react';
import { formatApproxTokens, formatReplyDuration, readMessageMetrics } from '../pipeline/message-metrics';
import type { ChatMessageNode } from '../types';

function LiveDuration({ startedAt }: { startedAt: number }) {
    const [elapsed, setElapsed] = useState(() => Math.max(0, Date.now() - startedAt));
    useEffect(() => {
        setElapsed(Math.max(0, Date.now() - startedAt));
        const timer = window.setInterval(() => {
            setElapsed(Math.max(0, Date.now() - startedAt));
        }, 1000);
        return () => window.clearInterval(timer);
    }, [startedAt]);
    return <>{formatReplyDuration(elapsed, true) ?? '0s'}</>;
}

function MetricSparkIcon() {
    return (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 3l1.9 5.3L19 10.2l-5.1 1.9L12 17.5l-1.9-5.4L5 10.2l5.1-1.9Z" />
        </svg>
    );
}

function MetricClockIcon() {
    return (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2" />
        </svg>
    );
}

function MetricSendIcon() {
    return (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 19V5m-6 6 6-6 6 6" />
        </svg>
    );
}

export const MessageMetricsBar = memo(function MessageMetricsBar({ node }: { node: ChatMessageNode }) {
    const metrics = readMessageMetrics(node);
    if (!metrics) return null;

    const isUser = node.role === 'user';
    const tokenRaw = isUser ? metrics.promptTokens : metrics.outputTokens;
    const tokenText = formatApproxTokens(tokenRaw);
    const hasLiveDuration = metrics.isLive && metrics.startedAt !== undefined;
    const durationText = hasLiveDuration ? undefined : formatReplyDuration(metrics.durationMs, false);

    if (!tokenText && !durationText && !hasLiveDuration) return null;

    const titleParts: string[] = [];
    if (durationText) titleParts.push(`回复耗时 ${durationText}`);
    else if (hasLiveDuration) titleParts.push('正在实时计时');
    if (tokenRaw && tokenRaw > 0) {
        titleParts.push(isUser
            ? `本轮向模型共发送约 ${tokenRaw.toLocaleString()} tokens`
            : `本楼模型输出${metrics.estimatedFallback ? '约 ' : ' '}${tokenRaw.toLocaleString()} tokens`);
    }

    return (
        <div className={`ttm-msg-metrics ${isUser ? 'is-user' : 'is-assistant'} ${hasLiveDuration ? 'is-live' : ''}`} title={titleParts.join(' · ')}>
            <span className="ttm-msg-metrics-pill">
                {(hasLiveDuration || durationText) && (
                    <span className="ttm-msg-metric-item">
                        {hasLiveDuration ? <span className="ttm-msg-metric-live-dot" aria-hidden="true" /> : <MetricClockIcon />}
                        <span>{hasLiveDuration ? <LiveDuration startedAt={metrics.startedAt!} /> : durationText}</span>
                    </span>
                )}
                {(hasLiveDuration || durationText) && tokenText && <span className="ttm-msg-metric-sep" aria-hidden="true" />}
                {tokenText && (
                    <span className="ttm-msg-metric-item">
                        {isUser ? <MetricSendIcon /> : <MetricSparkIcon />}
                        <span>{isUser ? `发送 ${tokenText} tok` : `输出 ${tokenText} tok`}</span>
                    </span>
                )}
            </span>
        </div>
    );
});
