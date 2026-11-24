import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['src/store/chat-tree.ts'], bundle: true,
    write: false, format: 'esm', platform: 'node' });
const { activePath, removeChatTreeNode, swipeId } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

function message(id, floor, parentId = null, parentSwipeId) {
    return { id, floor, parentId, parentSwipeId, swipes: [id], activeSwipeIndex: 0, content: id };
}

test('deleting a middle message reattaches all its branches to the original reply variant', () => {
    const opening = message('opening', 0);
    const parent = { ...message('parent', 1, opening.id), swipes: ['first', 'second'], content: 'first' };
    const target = message('target', 2, parent.id, swipeId(parent, 1));
    const child = message('child', 3, target.id, swipeId(target));
    const descendant = message('descendant', 4, child.id, swipeId(child));
    const alternative = message('alternative', 3, target.id, swipeId(target));
    const unrelated = message('unrelated', 2, parent.id, swipeId(parent));
    const nodes = [opening, parent, target, child, descendant, alternative, unrelated].map(Object.freeze);

    const next = removeChatTreeNode(nodes, target);
    assert.deepEqual(next.map(node => [node.id, node.floor]), [['opening', 0], ['parent', 1], ['child', 2], ['descendant', 3], ['alternative', 2], ['unrelated', 2]]);
    for (const id of [child.id, alternative.id]) {
        const moved = next.find(node => node.id === id);
        assert.equal(moved.parentId, parent.id);
        assert.equal(moved.parentSwipeId, swipeId(parent, 1));
        assert.equal(activePath(next, id)[1].content, 'second');
    }
    assert.equal(next.at(-1), unrelated);
    assert.equal(child.parentId, target.id);
    assert.equal(child.floor, 3);
});

test('deleting the opening or last message leaves valid paths and serializable data', () => {
    const opening = message('opening', 0);
    const middle = message('middle', 1, opening.id, swipeId(opening));
    const last = message('last', 2, middle.id, swipeId(middle));
    const nodes = [opening, middle, last];

    const withoutOpening = structuredClone(removeChatTreeNode(nodes, opening));
    assert.deepEqual(activePath(withoutOpening, last.id).map(node => [node.id, node.floor]), [['middle', 0], ['last', 1]]);
    assert.equal(withoutOpening[0].parentId, null);
    assert.equal(withoutOpening[0].parentSwipeId, undefined);
    assert.deepEqual(removeChatTreeNode(nodes, last), [opening, middle]);
    assert.deepEqual(removeChatTreeNode([opening], opening), []);
});
