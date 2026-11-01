import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { workChecks, validateWorkChecks, verifyWork, selfWaitTasks } from '../../src/work/checks.js';
import { validate } from '../../src/tools/game/schema.js';
const bot = { entity: { position: { x: 0, y: 64, z: 0 } }, inventory: { items: () => [] } };

test('a task wait cannot depend only on the idle owners own active work', () => {
    const tasks = [
        { id: 1, state: 'working', owner: 'Peter', unmetDependencies: [] },
        { id: 2, state: 'working', owner: 'Chris' },
    ];
    assert.deepEqual(selfWaitTasks({ tasks: [1] }, tasks, 'Peter'), [1]);
    assert.deepEqual(selfWaitTasks({ tasks: [1, 2] }, tasks, 'Peter'), []);
    assert.deepEqual(selfWaitTasks({ tasks: [1], checks: [{ kind: 'inventory' }] }, tasks, 'Peter'), []);
    assert.deepEqual(selfWaitTasks({ tasks: [1] }, tasks, 'Peter', true), []);
    tasks[0].state = 'blocked';
    assert.deepEqual(selfWaitTasks({ tasks: [1] }, tasks, 'Peter'), []);
});

test('area verification covers every wall cell from multiple viewpoints and keeps unseen distinct from wrong', async () => {
    const wall = new EventEmitter();
    wall.entity = { position: new Vec3(0, 65, 1) };
    wall.inventory = { items: () => [] };
    let missing = false;
    wall.blockAt = p => ({ position: p, name: missing && p.x === 10 && p.y === 66 ? 'air' : 'oak_planks' });
    let viewable = true,
        moves = 0;
    const perception = {
        isBlockVisible: (_b, block) => viewable && Math.abs(block.position.x - wall.entity.position.x) <= 4,
    };
    const context = {
        inspectBlock: async cell => {
            moves++;
            wall.entity.position = new Vec3(cell.x, 65, 1);
        },
    };
    const checks = [{ kind: 'blocks', name: 'oak_planks', x1: 0, y1: 65, z1: 0, x2: 19, y2: 67, z2: 0 }];
    const good = await verifyWork(wall, perception, { checks }, context);
    assert.equal(good.passed, true);
    assert.equal(good.checks[0].matched, 60);
    assert.ok(moves > 0 && moves < 10);
    assert.equal(wall.listenerCount('blockUpdate'), 0);
    missing = true;
    const wrong = await verifyWork(wall, perception, { checks }, context);
    assert.equal(wrong.passed, false);
    assert.equal(wrong.checks[0].mismatched, 1);
    assert.equal(wrong.checks[0].unobserved, 0);
    viewable = false;
    const unseen = await verifyWork(
        wall,
        perception,
        { checks },
        {
            inspectBlock: async () => {
                throw Error('No safe viewpoint');
            },
        },
    );
    assert.equal(unseen.passed, null);
    assert.equal(unseen.checks[0].unobserved, 60);
    assert.equal(unseen.checks[0].mismatched, 0);
    assert.throws(() => validateWorkChecks([{ ...checks[0], x2: 100, y2: 100, z2: 100 }]), /4096/);
});

test('verification invalidates observed cells that change during the pass and closes listeners after cancellation', async () => {
    const active = new EventEmitter();
    active.entity = { position: new Vec3(0, 65, 1) };
    active.inventory = { items: () => [] };
    let changed = false;
    active.blockAt = p => ({ position: p, name: changed && p.x === 0 ? 'air' : 'oak_planks' });
    const perception = { isBlockVisible: (_b, b) => Math.abs(b.position.x - active.entity.position.x) <= 1 };
    const checks = [{ kind: 'blocks', name: 'oak_planks', x1: 0, y1: 65, z1: 0, x2: 4, y2: 65, z2: 0 }];
    const r = await verifyWork(
        active,
        perception,
        { checks },
        {
            inspectBlock: async cell => {
                active.entity.position = new Vec3(cell.x, 65, 1);
                if (!changed) {
                    changed = true;
                    active.emit('blockUpdate', null, { position: new Vec3(0, 65, 0) });
                }
            },
        },
    );
    assert.equal(r.passed, false);
    assert.equal(r.checks[0].mismatched, 1);
    const stop = new AbortController();
    stop.abort();
    await assert.rejects(verifyWork(active, perception, { checks }, { signal: stop.signal }), { name: 'AbortError' });
    assert.equal(active.listenerCount('blockUpdate'), 0);
});
test('published schemas and execution accept the same check forms, including exact zero', () => {
    for (const checks of [
        [{ kind: 'block', name: 'chest', x: 1, y: 64, z: 1 }],
        [{ kind: 'inventory', name: 'oak_log', count: 4 }],
        [{ kind: 'inventory', name: 'oak_log', count: 0, comparison: 'equal' }],
        [{ kind: 'container', name: 'cobblestone', count: 64, x: 1, y: 64, z: 1 }],
    ]) {
        validate(workChecks, checks);
        validateWorkChecks(checks);
    }
    for (const checks of [
        [{ kind: 'block', name: 'chest', count: 1, x: 1, y: 64, z: 1 }],
        [{ kind: 'inventory', name: 'oak_log', count: 0 }],
    ]) {
        assert.throws(() => validate(workChecks, checks));
        assert.throws(() => validateWorkChecks(checks), /checks\[0\]/);
    }
});
test('a container must actually contain the requested quantity; an existing chest is insufficient', async () => {
    let amount = 0,
        inspections = 0;
    const context = {
        inspectContainer: async () => {
            inspections++;
            return { chest: { x: 1, y: 64, z: 1 }, contents: { cobblestone: amount } };
        },
    };
    const task = { revision: 5, checks: [{ kind: 'container', name: 'cobblestone', count: 64, x: 1, y: 64, z: 1 }] };
    assert.equal((await verifyWork(bot, {}, task, context)).passed, false);
    amount = 64;
    assert.equal((await verifyWork(bot, {}, task, context)).passed, true);
    assert.equal(inspections, 2);
    assert.equal(
        (await verifyWork(bot, {}, { checks: [{ kind: 'inventory', name: 'oak_log', count: 0, comparison: 'equal' }] }))
            .passed,
        true,
    );
});

test('conditional waits react to meaningful task changes or known material conditions', async () => {
    const { knownChecksMet, waitConditionMet } = await import('../../src/work/checks.js');
    const tasks = [{ id: 1, attentionRevision: 5 }];
    const watch = { tasks: { 1: 5 }, checks: [{ kind: 'container', name: 'oak_log', count: 5, x: 1, y: 64, z: 1 }] };
    let resources = [];
    const met = checks => knownChecksMet(bot, {}, checks, resources);
    assert.equal(waitConditionMet(watch, tasks, met), false);
    tasks[0].revision = 6;
    assert.equal(waitConditionMet(watch, tasks, met), false);
    resources = [{ dimension: 'overworld', location: { x: 1, y: 64, z: 1 }, contents: { oak_log: 5 } }];
    assert.equal(waitConditionMet(watch, tasks, met), true);
    resources = [];
    tasks[0].attentionRevision = 7;
    assert.equal(waitConditionMet(watch, tasks, met), true);
});
