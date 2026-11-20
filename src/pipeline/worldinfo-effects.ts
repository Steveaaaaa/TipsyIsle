import type { LorebookEntry, LorebookTimedState } from '../types';
import { worldinfoHash } from './worldinfo-hash';

type Effect = 'sticky' | 'cooldown' | 'delay';
const effectTypes: Effect[] = ['sticky', 'cooldown', 'delay'];
const keyOf = (entry: LorebookEntry) => `${entry.world}::${entry.uid}`;

/** Shared by the scanner and host commands; each scan owns its working copy. */
export class WorldInfoTimedEffects {
    private readonly states: Record<string, LorebookTimedState>;
    private readonly hashes = new WeakMap<LorebookEntry, number>();
    private readonly active = { sticky: new Set<string>(), cooldown: new Set<string>(), delay: new Set<string>() };
    constructor(private readonly entries: LorebookEntry[], states: Record<string, LorebookTimedState>, private readonly floor: number) {
        this.states = structuredClone(states);
        for (const entry of entries) {
            const hash = entry.hash ?? worldinfoHash(entry);
            this.hashes.set(entry, hash);
            const state = this.states[keyOf(entry)];
            if (!state) continue;
            for (const type of effectTypes) {
                if (state.effects?.[type]?.hash !== hash) {
                    if (state.effects) delete state.effects[type];
                    if (type === 'sticky') state.stickyUntilFloor = 0;
                    if (type === 'cooldown') state.cooldownUntilFloor = 0;
                }
            }
        }
    }
    isValidEffectType(type: string): type is Effect { return effectTypes.includes(type as Effect); }
    getEffectMetadata(type: string, entry: LorebookEntry) {
        if (!this.isValidEffectType(type)) return null;
        const state = this.states[keyOf(entry)];
        const saved = state?.effects?.[type];
        return saved?.hash === (this.hashes.get(entry) ?? entry.hash ?? worldinfoHash(entry)) ? saved : undefined;
    }
    setTimedEffect(type: string, entry: LorebookEntry, enabled: boolean): void {
        if (!this.isValidEffectType(type)) return;
        const key = keyOf(entry);
        const state = this.states[key] ??= { stickyUntilFloor: 0, cooldownUntilFloor: 0 };
        const effects = state.effects ??= {};
        if (enabled) effects[type] = { start: this.floor, end: this.floor + Number(entry[type]), protected: false, hash: this.hashes.get(entry) ?? entry.hash ?? worldinfoHash(entry) };
        else delete effects[type];
        if (type === 'sticky') state.stickyUntilFloor = enabled ? effects[type]!.end : 0;
        if (type === 'cooldown') state.cooldownUntilFloor = enabled ? effects[type]!.end : 0;
    }
    setTimedEffects(entries: LorebookEntry[]): void {
        for (const entry of entries) for (const type of ['sticky', 'cooldown'] as const) {
            if (entry[type] > 0 && !this.getEffectMetadata(type, entry)) this.setTimedEffect(type, entry, true);
        }
    }
    checkTimedEffects(): void {
        this.cleanUp();
        for (const entry of this.entries) {
            for (const type of ['sticky', 'cooldown'] as const) {
                const effect = this.getEffectMetadata(type, entry);
                if (!effect) continue;
                if (!entry[type] || this.floor <= effect.start && !effect.protected) { this.setTimedEffect(type, entry, false); continue; }
                if (this.floor >= effect.end) {
                    this.setTimedEffect(type, entry, false);
                    if (type === 'sticky' && entry.cooldown > 0) {
                        this.setTimedEffect('cooldown', entry, true);
                        this.states[keyOf(entry)].effects!.cooldown!.protected = true;
                    }
                } else this.active[type].add(keyOf(entry));
            }
            if (this.floor < entry.delay) this.active.delay.add(keyOf(entry));
        }
    }
    isEffectActive(type: string, entry: LorebookEntry): boolean {
        return this.isValidEffectType(type) && this.active[type].has(keyOf(entry));
    }
    cleanUp(): void { for (const buffer of Object.values(this.active)) buffer.clear(); }
    snapshot(): Record<string, LorebookTimedState> {
        return Object.fromEntries(Object.entries(this.states).filter(([, state]) => state.stickyUntilFloor > this.floor || state.cooldownUntilFloor > this.floor
            || (state.effects?.delay?.end ?? 0) > this.floor));
    }
}
