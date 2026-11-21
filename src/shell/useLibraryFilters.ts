import { useMemo, useRef, useState } from 'react';
import { storyIdentity } from '../core/story-identity';
import type { NormalizedCharacterCard } from '../types';

export const libraryPageSize = 12;

export function useLibraryFilters(characters: NormalizedCharacterCard[]) {
    const [characterSearch, setCharacterSearch] = useState('');
    const characterSearchRef = useRef<HTMLInputElement>(null);
    const [characterTag, setCharacterTag] = useState('');
    const [characterSort, setCharacterSort] = useState('original');
    const [characterPage, setCharacterPage] = useState(0);
    const [denseLibrary, setDenseLibrary] = useState<boolean | null>(null);
    const filteredCharacters = useMemo(() => {
        const query = characterSearch.trim().toLocaleLowerCase();
        const matches = characters.filter(character => (!characterTag || character.tags?.includes(characterTag)) && (!query || `${character.name} ${character.creator ?? ''} ${(character.tags ?? []).join(' ')}`.toLocaleLowerCase().includes(query)));
        return characterSort === 'name' ? matches.sort((a, b) => storyIdentity(a).name.localeCompare(storyIdentity(b).name, 'zh-CN', { numeric: true })) : matches;
    }, [characters, characterSearch, characterTag, characterSort]);
    const characterTags = useMemo(() => [...new Set(characters.flatMap(character => character.tags ?? []))].sort((a, b) => a.localeCompare(b, 'zh-CN')), [characters]);
    const pageCount = Math.max(1, Math.ceil(filteredCharacters.length / libraryPageSize));
    const currentCharacterPage = Math.min(characterPage, pageCount - 1);
    const visibleCharacters = filteredCharacters.slice(currentCharacterPage * libraryPageSize, (currentCharacterPage + 1) * libraryPageSize);

    return { characterSearch, setCharacterSearch, characterSearchRef, characterTag, setCharacterTag, characterSort, setCharacterSort,
        setCharacterPage, denseLibrary, setDenseLibrary, filteredCharacters, characterTags, pageCount, currentCharacterPage, visibleCharacters };
}
