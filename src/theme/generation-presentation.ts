export type GenerationPhase = 'waiting' | 'thinking' | 'writing' | 'layout' | 'page' | 'error' | 'stopped';
export const generationPresentation: Record<GenerationPhase, { text: string; detail: string; mark: string }> = {
    error: { text: '这次回复没能完成', detail: '生成已停止，可在消息菜单中重新生成。', mark: 'M12 8v5m0 3h.01M4 4h16v16H4Z' },
    stopped: { text: '回复已停止', detail: '已保留收到的内容，可在消息菜单中重新生成。', mark: 'M6 6h12v12H6Z' },
    waiting: { text: '静候故事的回音', detail: '等待模型返回内容', mark: 'M15 3a8 8 0 1 0 6 12A8 8 0 0 1 15 3Z' },
    thinking: { text: '故事在字里行间酝酿', detail: '模型正在构思', mark: 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z' },
    writing: { text: '下一行，正落在纸上', detail: '正在接收正文', mark: 'm5 19 3-7L18 3l3 3-9 10-7 3Zm3-7 4 4M4 21h16' },
    layout: { text: '将这一页，轻轻理好', detail: '正在排版互动内容', mark: 'M5 3h10l4 4v14H5V3Zm9 0v5h5M8 12h8M8 16h6' },
    page: { text: '帷幕之后，故事渐显', detail: '等待完整作者页面', mark: 'M3 3h18v18l-5-4V3M3 21l5-4V3M8 17h8' },
};
