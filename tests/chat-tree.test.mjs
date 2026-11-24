import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['src/store/chat-tree.ts'], bundle: true,
    write: false, format: 'esm', platform: 'node' });
const { activePath, removeChatTreeNode, removeStoryBranch, routeKey, storyRoutes, swipeId } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

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

test('removeStoryBranch deletes a single-swipe branch and its descendants while preserving siblings', () => {
    const opening = message('opening', 0);
    const shared = message('shared', 1, opening.id, swipeId(opening));
    const branchA = message('branchA', 2, shared.id, swipeId(shared));
    const leafA = message('leafA', 3, branchA.id, swipeId(branchA));
    const branchB = message('branchB', 2, shared.id, swipeId(shared));
    const nodes = [opening, shared, branchA, leafA, branchB].map(Object.freeze);

    const res = removeStoryBranch(nodes, routeKey(branchA), leafA.id);
    assert.equal(res.changed, true);
    assert.equal(res.affectedActive, true);
    assert.deepEqual(res.removedNodeIds.sort(), ['branchA', 'leafA']);
    assert.deepEqual(res.nodes.map(n => n.id), ['opening', 'shared', 'branchB']);
    assert.equal(res.fallbackLeafId, 'branchB');
    assert.equal(res.fallbackRoute?.nodeId, 'branchB');
});

test('removeStoryBranch deletes one swipe from a multi-swipe node and preserves sibling swipes and swipeIds', () => {
    const opening = message('opening', 0);
    const parent = {
        ...message('parent', 1, opening.id, swipeId(opening)),
        swipes: ['reply0', 'reply1', 'reply2'],
        swipeIds: ['parent:0', 'parent:1', 'parent:2'],
        activeSwipeIndex: 1,
        content: 'reply1',
        branchStates: { 'parent:0': { a: 0 }, 'parent:1': { a: 1 }, 'parent:2': { a: 2 } },
        extra: { swipeVariables: { 0: { v: 0 }, 1: { v: 1 }, 2: { v: 2 } } },
    };
    const childOn0 = message('child0', 2, parent.id, 'parent:0');
    const childOn1 = message('child1', 2, parent.id, 'parent:1');
    const childOn2 = message('child2', 2, parent.id, 'parent:2');
    const nodes = [opening, parent, childOn0, childOn1, childOn2];

    const res = removeStoryBranch(nodes, routeKey(parent, 1), childOn1.id);
    assert.equal(res.changed, true);
    assert.equal(res.affectedActive, true);
    assert.deepEqual(res.removedNodeIds, ['child1']);

    const updatedParent = res.nodes.find(n => n.id === 'parent');
    assert.deepEqual(updatedParent.swipes, ['reply0', 'reply2']);
    assert.deepEqual(updatedParent.swipeIds, ['parent:0', 'parent:2']);
    assert.equal(updatedParent.activeSwipeIndex, 0);
    assert.equal(updatedParent.content, 'reply0');
    assert.deepEqual(updatedParent.branchStates, { 'parent:0': { a: 0 }, 'parent:2': { a: 2 } });
    assert.deepEqual(updatedParent.extra.swipeVariables, { 0: { v: 0 }, 1: { v: 2 } });

    const remainingRoutes = storyRoutes(res.nodes);
    assert.equal(remainingRoutes.length, 2);
    assert.equal(activePath(res.nodes, childOn2.id)[1].content, 'reply2');
});

test('removeStoryBranch falls back to opening when no other routes remain and refuses deleting floor 0', () => {
    const opening = message('opening', 0);
    const first = message('first', 1, opening.id, swipeId(opening));
    const nodes = [opening, first];

    const floor0Res = removeStoryBranch(nodes, routeKey(opening), first.id);
    assert.equal(floor0Res.changed, false);

    const res = removeStoryBranch(nodes, routeKey(first), first.id);
    assert.equal(res.changed, true);
    assert.equal(res.affectedActive, true);
    assert.equal(res.fallbackRoute, undefined);
    assert.equal(res.fallbackLeafId, 'opening');
    assert.deepEqual(res.nodes, [opening]);
});
