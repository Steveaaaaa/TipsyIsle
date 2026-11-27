import type { UserPersona } from '../../types';

export function remapGuidePersona(persona: UserPersona, aliases: Record<string, string>): void {
    for (const link of persona.connections) {
        if (link.type !== 'character') continue;
        if (aliases[link.id]) link.id = aliases[link.id];
        else if (link.id.endsWith('.png') && aliases[link.id.slice(0, -4)]) link.id = `${aliases[link.id.slice(0, -4)]}.png`;
    }
}
