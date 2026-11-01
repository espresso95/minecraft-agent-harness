import test from 'node:test';
import assert from 'node:assert/strict';
import { serializeObservation } from '../../src/tools/game-tools.js';

// Reconstruct meaning independently of the encoder; scripts still get normal
// objects, while this checks every field the model receives in the table form.
function expandTable(value) {
    if (Array.isArray(value)) return value;
    return value.rows.map(row => {
        const record = {};
        value.columns.forEach((path, index) => {
            let parent = record;
            path.forEach((key, depth) => {
                if (!Object.hasOwn(parent, key))
                    Object.defineProperty(parent, key, {
                        value: depth === path.length - 1 ? row[index] : {},
                        enumerable: true,
                    });
                parent = parent[key];
            });
        });
        return record;
    });
}
function expand(snapshot) {
    for (const [parent, key] of [
        [snapshot, 'blocks'],
        [snapshot, 'entities'],
        [snapshot.inventory, 'items'],
        [snapshot.recentPublicChat, 'messages'],
    ])
        if (parent && Object.hasOwn(parent, key)) parent[key] = expandTable(parent[key]);
    return snapshot;
}
const canonical = value => JSON.parse(JSON.stringify(value));
function scene() {
    return {
        capturedAt: '2026-10-31T17:00:00.000Z',
        player: 'Ada',
        position: { x: 1.123456789012345, y: 69, z: -2.987654321098765 },
        yaw: 1.23456789012345,
        pitch: -0.11223344556677,
        health: 7,
        food: 0,
        oxygen: 5,
        raining: true,
        action: { active: 'follow_player', background: true, blocked: false },
        rules: { difficulty: 'hard', permanentDeath: true },
        blocks: Array.from({ length: 64 }, (_, i) => ({
            name: i % 2 ? 'dirt' : 'stone',
            position: { x: i - 32, y: 68, z: i % 8 },
        })),
        entities: Array.from({ length: 40 }, (_, i) => ({
            id: i,
            name: 'zombie',
            position: { x: i + 0.123456789, y: 69, z: -i },
        })),
        inventory: {
            items: Array.from({ length: 12 }, (_, i) => ({ name: 'oak_log', count: i + 1, slot: i + 9 })),
            heldItem: null,
            equipment: [null, null, null, null],
            offHand: null,
        },
        recentPublicChat: {
            since: 12345,
            messages: Array.from({ length: 6 }, (_, i) => ({
                id: i,
                sender: 'Player',
                text: 'Bring exactly 16 logs to (-4,69,1). 🌳',
                createdAt: 12345 + i,
                mention: false,
            })),
        },
        visibility: 'local line-of-sight',
    };
}

test('full observations become smaller without losing precision, order, messages or world facts', () => {
    const input = scene(),
        before = structuredClone(input);
    const text = serializeObservation(input),
        compact = JSON.parse(text);
    assert.ok(compact.blocks.columns);
    assert.ok(compact.entities.columns);
    assert.ok(Buffer.byteLength(text) < Buffer.byteLength(JSON.stringify(input)) * 0.75);
    assert.deepEqual(expand(compact), canonical(before));
    assert.deepEqual(input, before, 'does not mutate the ordinary state used by scripts');
});

test('each snapshot is self-contained and immediately reflects changed health, inventory and terrain', () => {
    const state = scene();
    const first = expand(JSON.parse(serializeObservation(state)));
    state.health = 3;
    state.inventory.items[0].count = 1;
    state.blocks[0].name = 'lava';
    state.entities[0].position.x = -0.987654321012345;
    const second = expand(JSON.parse(serializeObservation(state)));
    assert.deepEqual(second, canonical(state));
    assert.equal(first.health, 7);
    assert.equal(first.blocks[0].name, 'stone');
});

test('mixed schemas, doors and new metadata retain all optional fields', () => {
    const state = scene();
    state.blocks[1] = { name: 'oak_door', position: { x: 1, y: 69, z: 2 }, open: false };
    state.entities[1].username = 'Human';
    state.extension = { newFeature: ['unknown', null, { nested: true }] };
    const compact = JSON.parse(serializeObservation(state));
    assert.ok(Array.isArray(compact.blocks), 'mixed records keep the ordinary shape');
    assert.deepEqual(expand(compact), canonical(state));
});

test('new nested fields and literal dotted keys remain distinguishable from column paths', () => {
    const state = scene();
    for (const block of state.blocks) {
        block.extension = { 'position.x': 42, empty: {}, nullable: null, values: [1, { x: 2 }] };
        Object.defineProperty(block, '__proto__', { value: 'literal field', enumerable: true });
    }
    assert.deepEqual(expand(JSON.parse(serializeObservation(state))), canonical(state));
    assert.equal({}.polluted, undefined);
});

test('empty, tiny and non-record collections stay intact; JSON omission semantics are unchanged', () => {
    for (const blocks of [[], [{ name: 'stone', unknown: undefined }], [null, 'stone'], [{}, {}]]) {
        const state = { blocks, entities: [], inventory: { items: [] }, future: undefined };
        assert.deepEqual(expand(JSON.parse(serializeObservation(state))), canonical(state));
    }
});
