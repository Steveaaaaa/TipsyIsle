type AudioType = 'bgm' | 'ambient';
interface Track { title: string; url: string }
interface Settings { enabled: boolean; mode: 'repeat_one' | 'repeat_all' | 'shuffle' | 'play_one_and_stop'; muted: boolean; volume: number }
interface Channel { player: HTMLAudioElement; list: Track[]; settings: Settings; selected: string }
const defaults: Settings = { enabled: true, mode: 'repeat_one', muted: false, volume: 50 };
const track = (value: { title?: string; url: string }): Track => ({ title: value.title || value.url.split('/').at(-1)?.split('.')[0] || value.url, url: value.url });

/** One player per channel, shared by all scripts in this author document. */
export function createAudioRuntime(read: () => any, save: (value: any) => void, report: (error: unknown) => void) {
    const channels = new Map<AudioType, Channel>();
    const persist = () => {
        const value = { ...read() };
        for (const [type, channel] of channels) value[type] = { list: channel.list, settings: channel.settings };
        save(value);
    };
    const apply = (channel: Channel) => {
        channel.player.volume = channel.settings.volume / 100; channel.player.muted = channel.settings.muted;
        channel.player.loop = channel.settings.mode === 'repeat_one';
        if (!channel.settings.enabled) channel.player.pause();
    };
    const channel = (type: AudioType): Channel => {
        if (type !== 'bgm' && type !== 'ambient') throw new Error('音频类型必须为 bgm 或 ambient');
        let value = channels.get(type);
        if (!value) {
            const stored = read()[type] ?? {};
            value = { player: new Audio(), list: stored.list ?? [], settings: { ...defaults, ...stored.settings }, selected: '' };
            channels.set(type, value); apply(value);
            const current = value;
            current.player.addEventListener('ended', () => {
                if (!current.settings.enabled || current.settings.mode === 'play_one_and_stop' || !current.list.length) return;
                const index = current.list.findIndex(item => item.url === current.selected);
                const next = current.settings.mode === 'shuffle' ? Math.floor(Math.random() * current.list.length) : (index + 1) % current.list.length;
                play(type, current.list[next]);
            });
            current.player.addEventListener('error', () => report(new Error(`音频加载失败：${current.selected}`)));
        }
        return value;
    };
    const play = (type: AudioType, input: { title?: string; url: string }) => {
        const current = channel(type); const value = track(input);
        const index = current.list.findIndex(item => item.title === value.title || item.url === value.url);
        if (index < 0) current.list.push(value); else current.list[index] = value;
        current.selected = value.url; current.player.src = value.url; current.player.currentTime = 0;
        if (current.settings.enabled) void current.player.play().catch(report);
        persist();
    };
    window.addEventListener('pagehide', () => { for (const value of channels.values()) value.player.pause(); });
    return {
        playAudio: play,
        pauseAudio: (type: AudioType) => channel(type).player.pause(),
        getAudioList: (type: AudioType) => structuredClone(channel(type).list),
        replaceAudioList: (type: AudioType, values: Track[]) => { channel(type).list = values.map(track); persist(); },
        appendAudioList: (type: AudioType, values: Track[]) => {
            const current = channel(type);
            for (const item of values.map(track)) if (!current.list.some(old => old.url === item.url || old.title === item.title)) current.list.push(item);
            persist();
        },
        getAudioSettings: (type: AudioType) => ({ ...channel(type).settings }),
        setAudioSettings: (type: AudioType, value: Partial<Settings>) => {
            const current = channel(type); Object.assign(current.settings, value);
            current.settings.volume = Math.max(0, Math.min(100, Number(current.settings.volume)));
            apply(current); persist();
        },
        getCurrentAudio: (type: AudioType) => {
            const current = channel(type); const player = current.player;
            return { src: current.selected, title: current.list.find(item => item.url === current.selected)?.title ?? '', playing: !player.paused && !player.ended,
                progress: Number.isFinite(player.duration) && player.duration > 0 ? player.currentTime / player.duration * 100 : 0 };
        },
    };
}
