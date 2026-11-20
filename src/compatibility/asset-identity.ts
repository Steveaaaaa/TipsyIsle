import type { NormalizedCharacterCard } from '../types';

/** The avatar filename is a public identity; image bytes remain in card.avatar. */
export function characterAvatarId(card: Pick<NormalizedCharacterCard, 'id'>): string {
    return card.id.endsWith('.png') ? card.id : `${card.id}.png`;
}
