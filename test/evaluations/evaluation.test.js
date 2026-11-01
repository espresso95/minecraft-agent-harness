import test from 'node:test';
import assert from 'node:assert/strict';
import {
    positions,
    scoreBlocks,
    distribution,
    assertEvaluationHealthy,
    auditWorld,
    parseContainerItems,
} from '../../scripts/lib/team-evaluation.js';

test('independent audit reads a blocked chest without opening or changing it', async () => {
    const bot = {
        username: 'Inspector',
        blockAt: () => ({ name: 'chest' }),
        waitForChunksToLoad: async () => {},
        waitForTicks: async () => {},
        openContainer: async () => {
            throw Error('Chest lid is blocked');
        },
    };
    const audit = await auditWorld({
        bot,
        scenario: {
            blockChecks: [],
            containers: [{ at: [0, 64, 0], name: 'chest', items: [{ name: 'birch_log', minimum: 8 }] }],
        },
        command: async text => {
            if (text === 'data get block 0 64 0 Items')
                return '0, 64, 0 has the following block data: [{Slot: 0b, id: "minecraft:birch_log", count: 8}]';
        },
        profiles: [],
        serverDir: 'unused',
    });
    assert.equal(audit.containers[0].passed, true);
    assert.deepEqual(audit.containers[0].items, [{ name: 'birch_log', count: 8 }]);
});

test('container parser handles structured NBT and refuses failed commands', () => {
    assert.deepEqual(parseContainerItems('Block data: [{id:"minecraft:oak_log",Count:8b,Slot:0b}]'), [
        { name: 'oak_log', count: 8 },
    ]);
    assert.deepEqual(parseContainerItems('Block data: []'), []);
    assert.throws(() => parseContainerItems('Not a block entity'), /did not return/);
});

test('evaluation fails on stopped agents or missing inference instead of reporting an empty successful run', () => {
    const state = { agents: [{ name: 'A', state: 'running', usage: {} }] };
    assertEvaluationHealthy(state, 1000, ['A']);
    assert.throws(() => assertEvaluationHealthy(state, 120000, ['A']), /No model request/);
    state.agents[0].usage.pending = 1;
    assertEvaluationHealthy(state, 120000, ['A']);
    assert.throws(() => assertEvaluationHealthy(state, 180000, ['A']), /No completed model response/);
    state.agents[0].usage.reported = 1;
    assertEvaluationHealthy(state, 180000, ['A']);
    state.agents[0].state = 'stopped';
    state.agents[0].error = 'invalid_grant';
    assert.throws(() => assertEvaluationHealthy(state, 2000, ['A']), /invalid_grant/);
    assert.throws(() => assertEvaluationHealthy(state, 2000, ['B']), /disappeared/);
});

test('audit geometry handles different shapes, positions and materials without cabin-specific scoring', () => {
    const groups = [
        {
            label: 'unknown goal',
            name: 'birch_planks',
            boxes: [
                { from: [-7, 80, 3], to: [-6, 81, 4] },
                { from: [-7, 80, 3], to: [-7, 81, 3] },
            ],
            exclude: [[-7, 81, 4]],
        },
    ];
    const cells = positions(groups[0]);
    assert.equal(cells.length, 7);
    const blocks = cells.map(([x, y, z]) => ({ x, y, z, name: 'birch_planks', properties: {} }));
    assert.equal(scoreBlocks(groups, blocks)[0].passed, true);
    blocks[2].name = 'oak_planks';
    const failed = scoreBlocks(groups, blocks)[0];
    assert.equal(failed.correct, 6);
    assert.equal(failed.failures.length, 1);
    assert.throws(() => positions({ boxes: [{ from: [0, 0, 0], to: [1000, 1000, 1000] }] }), /oversized/);
});
test('audit block-state checks cannot mistake the wrong door half for success', () => {
    const groups = [
        { label: 'state-sensitive', name: 'oak_door', positions: [[0, 65, 0]], properties: { half: 'lower' } },
    ];
    assert.equal(
        scoreBlocks(groups, [{ x: 0, y: 65, z: 0, name: 'oak_door', properties: { half: 'upper' } }])[0].passed,
        false,
    );
});
test('latency distribution handles missing data without claiming zero cost or latency', () => {
    assert.deepEqual(distribution([]), { n: 0, median: null, p90: null, max: null });
    assert.deepEqual(distribution([4, 1, 3, 2]), { n: 4, median: 2.5, p90: 4, max: 4 });
    assert.deepEqual(distribution([5, 2, 3]), { n: 3, median: 3, p90: 5, max: 5 });
});
