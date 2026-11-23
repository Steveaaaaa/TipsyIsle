import { describe, it, expect } from 'vitest';
import { compactCharacterCard, compactLorebook, normalizeCharacterCard, normalizeLorebook } from '../src/pipeline/normalizer';
import { serializeCharacterCard, serializeLorebook } from '../src/pipeline/asset-serializer';
import { decodeSnapshot, encodeSnapshots } from '../src/core/snapshot-codec';

describe('large card normalization compaction and lossless serialization', () => {
    it('strips duplicate rawData payloads on normalize while preserving lossless serialization round-trips', () => {
        const longText = '魂力流转于经脉之中。'.repeat(200);
        const rawCard = {
            spec: 'chara_card_v3',
            spec_version: '3.0',
            data: {
                name: '测试角色',
                description: '角色简介',
                first_mes: '<开局创建角色>',
                extensions: {
                    world: '测试世界书',
                    tavern_helper: {
                        scripts: [{ id: 's1', name: '脚本', content: 'console.log(1);', enabled: true }],
                        variables: { foo: 1 },
                    },
                    regex_scripts: [{ id: 'r1', scriptName: '正则', findRegex: '/a/g', replaceString: 'b', placement: [2] }],
                },
                character_book: {
                    name: '测试世界书',
                    entries: [
                        { id: 0, uid: 0, comment: '非空条目', content: longText, keys: ['唐三'], enabled: true, constant: false },
                        { id: 1, uid: 1, comment: '空条目', content: '', keys: [], enabled: false, constant: false },
                    ],
                },
            },
        };

        const card = normalizeCharacterCard(rawCard);
        expect((card.rawData as any).data.character_book).toBeUndefined();
        expect((card.rawData as any).data.extensions.tavern_helper).toBeUndefined();
        expect((card.rawData as any).data.extensions.world).toBe('测试世界书');
        expect((card.embeddedLorebook?.rawData as any).entries).toEqual([]);
        expect(card.embeddedLorebook?.entries[0].rawData && 'content' in card.embeddedLorebook.entries[0].rawData).toBe(false);
        expect(card.embeddedLorebook?.entries[0].content).toBe(longText);
        expect(card.embeddedLorebook?.entries[1].content).toBe('');

        const roundTripped = serializeCharacterCard(card) as any;
        expect(roundTripped.data.extensions.tavern_helper.scripts[0].name).toBe('脚本');
        expect(roundTripped.data.character_book.entries[0].content).toBe(longText);
        expect(roundTripped.data.character_book.entries[1].content).toBe('');
    });

    it('preserves object-map lorebook keys through compaction and serialization', () => {
        const rawBook = {
            name: 'MapBook',
            entries: {
                custom_alpha: { uid: 10, comment: 'Alpha', content: 'alpha body', key: ['a'], disable: false },
                custom_beta: { id: 20, comment: 'Beta', content: 'beta body', keys: ['b'], enabled: false },
            },
        };

        const book = normalizeLorebook(rawBook, 'MapBook');
        expect((book.rawData as any).entries).toEqual({
            custom_alpha: { uid: 10 },
            custom_beta: { id: 20 },
        });

        const serialized = serializeLorebook(book) as any;
        expect(Object.keys(serialized.entries)).toEqual(['custom_alpha', 'custom_beta']);
        expect(serialized.entries.custom_alpha.content).toBe('alpha body');
        expect(serialized.entries.custom_beta.content).toBe('beta body');
    });

    it('compacts legacy bloated character cards and lorebooks idempotently', () => {
        const legacyCard = {
            ...normalizeCharacterCard({ name: '旧版卡' }),
            rawData: {
                spec: 'chara_card_v3',
                spec_version: '3.0',
                data: {
                    name: '旧版卡',
                    extensions: { tavern_helper: { scripts: [{ name: 'old' }] } },
                    character_book: { name: 'book', entries: [{ uid: 0, content: 'dup' }] },
                },
            },
            embeddedLorebook: {
                ...normalizeLorebook({ name: 'book', entries: [{ uid: 0, content: 'dup' }] }),
                rawData: { name: 'book', entries: [{ uid: 0, content: 'dup' }] },
                entries: [
                    { ...normalizeLorebook({ entries: [{ uid: 0, content: 'dup' }] }).entries[0], rawData: { uid: 0, content: 'dup' } },
                ],
            },
        };

        const first = compactCharacterCard(legacyCard);
        expect(first.changed).toBe(true);
        expect((first.value.rawData as any).data.character_book).toBeUndefined();
        expect((first.value.rawData as any).data.extensions.tavern_helper).toBeUndefined();
        expect((first.value.embeddedLorebook?.rawData as any).entries).toEqual([]);
        expect((first.value.embeddedLorebook?.entries[0].rawData as any).content).toBeUndefined();

        const second = compactCharacterCard(first.value);
        expect(second.changed).toBe(false);

        const compactBookAgain = compactLorebook(first.value.embeddedLorebook!);
        expect(compactBookAgain.changed).toBe(false);
    });

    it('pools embedded books/story characters and loads asset records one key at a time', async () => {
        const sharedCard = normalizeCharacterCard({
            spec: 'chara_card_v3',
            spec_version: '3.0',
            data: {
                name: '大卡',
                character_book: {
                    name: '大书',
                    entries: [{ uid: 0, content: '内容'.repeat(50) }],
                },
            },
        });
        const cardA = { ...sharedCard, id: 'char_a' };
        const bookA = { ...sharedCard.embeddedLorebook!, id: 'book_a' };
        cardA.embeddedLorebook = bookA;

        const encoded = await encodeSnapshots({
            workspace_assets: { characters: [cardA], lorebooks: [bookA], presets: [] },
            workspace_snapshot: {
                activeCharacterId: 'char_a',
                storyCharacter: cardA,
                storyWorldbooks: [bookA],
                messages: [{ id: 'm0', content: 'hi' }],
            },
        });
        encoded.committed();

        // Embedded book is pooled into a snapshot-branch rather than duplicated across assets and snapshot
        const assetCharRecord = encoded.writes['snapshot-record:assets:characters:char_a'];
        const assetBookRecord = encoded.writes['snapshot-record:assets:lorebooks:book_a'];
        expect(assetCharRecord.embeddedLorebook).toEqual({ $tipsyRecord: expect.stringMatching(/^snapshot-branch:/) });
        expect(assetBookRecord).toBeDefined();
        expect(encoded.writes.workspace_snapshot.value.storyCharacter).toEqual({ $tipsyRecord: expect.stringMatching(/^snapshot-branch:/) });
        expect(encoded.writes.workspace_snapshot.value.storyWorldbooks).toEqual({ $tipsyRecord: expect.stringMatching(/^snapshot-branch:/) });

        const store = new Map<string, unknown>(Object.entries(encoded.writes));
        const readManyCalls: string[][] = [];
        const decodedAssets = await decodeSnapshot(
            store.get('workspace_assets'),
            async key => store.get(key) ?? null,
            async keys => {
                readManyCalls.push(keys);
                return Object.fromEntries(keys.map(k => [k, store.get(k) ?? null]));
            },
            'workspace_assets',
        );

        const assetBatches = readManyCalls.filter(batch => batch.some(k => k.startsWith('snapshot-record:assets:')));
        expect(assetBatches.length).toBeGreaterThanOrEqual(2);
        for (const batch of assetBatches) {
            expect(batch).toHaveLength(1);
        }
        expect(decodedAssets.characters[0].name).toBe('大卡');
        expect(decodedAssets.lorebooks[0].entries[0].content).toBe('内容'.repeat(50));
    });
});
