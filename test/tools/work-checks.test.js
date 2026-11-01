import test from 'node:test';
import assert from 'node:assert/strict';
import { workChecks, validateWorkChecks, verifyWork } from '../../src/work/checks.js';
import { validate } from '../../src/tools/game/schema.js';
const bot = { entity: { position: { x: 0, y: 64, z: 0 } }, inventory: { items: () => [] } };
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
