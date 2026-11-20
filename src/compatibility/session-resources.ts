import type { CompatSnapshot } from './contracts';

/** Resource payloads survive a chat switch in the same document, not a page reload. */
export interface SessionResources {
    characters: CompatSnapshot['assetCatalog']['characters'];
    presets: CompatSnapshot['assetCatalog']['presets'];
    personas: CompatSnapshot['personas'];
    extensions: CompatSnapshot['extensions'];
}
export type SessionSnapshot = Omit<CompatSnapshot, 'assetCatalog' | 'personas' | 'extensions'> & {
    assetCatalog: Omit<CompatSnapshot['assetCatalog'], 'characters' | 'presets'>;
};
export function sessionResources(snapshot: CompatSnapshot): SessionResources {
    return { characters: snapshot.assetCatalog.characters, presets: snapshot.assetCatalog.presets,
        personas: snapshot.personas, extensions: snapshot.extensions };
}
export function sessionSnapshot(snapshot: CompatSnapshot): SessionSnapshot {
    const { personas, extensions, assetCatalog, ...state } = snapshot;
    const { characters, presets, ...selection } = assetCatalog;
    return { ...state, assetCatalog: selection };
}
