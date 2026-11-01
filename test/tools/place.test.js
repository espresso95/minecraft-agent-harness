import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import * as perception from '../../src/skills/perception.js';
import * as survival from '../../src/skills/survival.js';
import { createGameTools, createActionRunner, failureCode } from '../../src/tools/game-tools.js';
import minecraftData from 'minecraft-data';
const registry = minecraftData('1.21.4');

const key = p => `${p.x},${p.y},${p.z}`;
function makeWorld(solids, { mode = 'creative', at = [0.5, -60, 0.5], path = () => 'success', item = true } = {}) {
    const cells = new Map(solids.map(([x, y, z, name = 'stone']) => [key({ x, y, z }), name]));
    const block = p => {
        const n = cells.get(key(p)) ?? 'air';
        return {
            name: n,
            position: new Vec3(p.x, p.y, p.z),
            shapes: n === 'air' ? [] : [[0, 0, 0, 1, 1, 1]],
            boundingBox: n === 'air' ? 'empty' : 'block',
        };
    };
    const placed = [],
        log = [],
        dug = [];
    const b = {
        username: 'T',
        game: { gameMode: mode },
        pi_game_mode: mode,
        version: '1.21.4',
        registry,
        entity: { id: 1, position: new Vec3(...at), eyeHeight: 1.62, yaw: 0, pitch: 0, onGround: true },
        entities: {},
        inventory: {
            items: () => [],
            slots: new Array(46).fill(null),
            findInventoryItem: n => (item || n === 'dirt' ? { name: n, type: 1, count: 64 } : null),
        },
        world: { getBlock: p => block(new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))) },
        creative: {
            setInventorySlot: async () => {
                log.push('GIVE_SCAFFOLD');
            },
        },
        pathfinder: {
            setMovements(m) {
                b._moves = m;
            },
            setGoal() {},
            stop() {},
            getPathTo(m, goal) {
                const s = path(m, goal);
                log.push(`PATH ${m.allow1by1towers ? 'scaf' : 'plain'} ${goal.x},${goal.y},${goal.z} ${s}`);
                return { status: s, path: [] };
            },
            goto: async goal => {
                log.push(
                    `GOTO ${goal.x},${goal.y},${goal.z} towers=${b._moves?.allow1by1towers} floor=${cells.has(key({ x: goal.x, y: goal.y - 1, z: goal.z }))}`,
                );
                b.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5);
            },
        },
        clearControlStates() {},
        stopDigging() {},
        deactivateItem() {},
        setControlState(k, v) {
            if (k === 'jump' && v) {
                b._jump = true;
                b.entity.onGround = false;
                b.entity.position = b.entity.position.offset(0, 1.1, 0);
            }
        },
        dig: async blk => {
            dug.push(key(blk.position));
            cells.delete(key(blk.position));
            const q = b.entity.position;
            let y = Math.floor(q.y);
            while (!cells.has(key({ x: Math.floor(q.x), y: y - 1, z: Math.floor(q.z) })) && y > -61) y--;
            b.entity.position = new Vec3(q.x, y, q.z);
        },
        equip: async () => {},
        lookAt: async () => {},
        heldItem: { type: 1 },
        chat() {},
        placeBlock: async (ref, face) => {
            const t = ref.position.plus(face);
            cells.set(key(t), b._jump ? 'dirt' : 'oak_planks');
            placed.push(key(t));
            if (b._jump) {
                b._jump = false;
                b.entity.position = new Vec3(b.entity.position.x, t.y + 1, b.entity.position.z);
                b.entity.onGround = true;
            }
        },
    };
    b.blockAt = p => block(p);
    const tools = createGameTools({
        bot: b,
        perception,
        skills: survival,
        observe: async () => ({ state: {}, frame: null }),
    });
    return { b, cells, placed, log, dug, run: (n, a) => tools.find(t => t.name === n).execute('id', a), tools };
}
const floor = [];
for (let x = -8; x <= 8; x++) for (let z = -8; z <= 8; z++) floor.push([x, -61, z, 'grass_block']);

test('tool surface: place replaces place_block/approach_to_place; go_to/break_block/place_line kept', () => {
    const names = makeWorld(floor).tools.map(t => t.name);
    for (const n of ['place', 'place_line', 'go_to', 'break_block']) assert.ok(names.includes(n), n);
    for (const n of ['place_block', 'approach_to_place']) assert.ok(!names.includes(n), n);
});
test('in reach: places without moving, reports movement none', async () => {
    const w = makeWorld(floor, { at: [0.5, -60, 0.5] });
    const r = await w.run('place', { x: 3, y: -60, z: 0, block: 'oak_planks' });
    assert.equal(r.isError, undefined, JSON.stringify(r.details));
    assert.equal(r.details.movement.mode, 'none');
    assert.deepEqual(w.placed, ['3,-60,0']);
    assert.ok(!w.log.some(l => l.startsWith('GOTO')));
});
test('off-by-one fixed: never stands where the placer would step away (feet/head < 1.1 of the target corner)', async () => {
    const w = makeWorld(floor, { at: [-7.5, -60, -7.5] });
    const r = await w.run('place', { x: 6, y: -60, z: 6, block: 'oak_planks' });
    assert.equal(r.isError, undefined, JSON.stringify(r.details));
    const s = r.details.movement.stand;
    const feet = { x: s.x + 0.5, y: s.y, z: s.z + 0.5 };
    assert.ok(Math.hypot(feet.x - 6, feet.y + 60, feet.z - 6) >= 1.1);
    assert.ok(Math.hypot(feet.x - 6, feet.y + 1 + 60, feet.z - 6) >= 1.1);
    assert.equal(r.details.movement.mode, 'walk');
    assert.deepEqual(w.placed, ['6,-60,6']);
});
test('standing at the target corner moves away first instead of letting the placer walk silently', async () => {
    const w = makeWorld(floor, { at: [5.5, -60, 5.5] });
    const r = await w.run('place', { x: 5, y: -60, z: 6, block: 'oak_planks' });
    assert.equal(r.isError, undefined, JSON.stringify(r.details));
    assert.notEqual(r.details.movement.mode, 'none');
});
test('no_support: structured failure with missingSupport chain and a concrete next call; repeat flag on second try', async () => {
    const w = makeWorld(floor, { at: [0.5, -60, 0.5] });
    const r = await w.run('place', { x: 2, y: -57, z: 0, block: 'oak_planks' });
    assert.equal(r.isError, true);
    assert.equal(failureCode(r), 'no_support');
    const f = r.details;
    assert.equal(f.code, 'no_support');
    assert.equal(f.facts.repeat, false);
    assert.deepEqual(f.facts.missingSupport.placeFirst, { x: 2, y: -60, z: 0 });
    assert.deepEqual(f.facts.missingSupport.touchesTarget, { x: 2, y: -58, z: 0 });
    assert.equal(f.facts.missingSupport.blocksNeeded, 3);
    assert.equal(f.facts.next, 'place(2,-60,0,oak_planks)');
    assert.ok(f.facts.reason);
    const r2 = await w.run('place', { x: 2, y: -57, z: 0, block: 'oak_planks' });
    assert.equal(r2.details.facts.repeat, true);
    assert.deepEqual(w.placed, []);
});
test('occupied: same block is success (already present); other block fails occupied_target with next', async () => {
    const w = makeWorld([...floor, [1, -60, 0, 'oak_planks'], [2, -60, 0, 'cobblestone']]);
    const ok = await w.run('place', { x: 1, y: -60, z: 0, block: 'oak_planks' });
    assert.equal(ok.details.alreadyPresent, true);
    const bad = await w.run('place', { x: 2, y: -60, z: 0, block: 'oak_planks' });
    assert.equal(failureCode(bad), 'occupied_target');
    assert.match(bad.details.facts.next, /another cell/);
    assert.deepEqual(w.dug, []);
});
test('natural terrain in the target cell is mined out first, then placed', async () => {
    const w = makeWorld([...floor, [1, -60, 0, 'dirt']]);
    const r = await w.run('place', { x: 1, y: -60, z: 0, block: 'oak_planks' });
    assert.equal(r.details?.cleared, 'dirt', JSON.stringify(r.details).slice(0, 400));
    assert.ok(w.dug.length >= 1);
});
test('place_line skips a failed cell and keeps going', async () => {
    const w = makeWorld([...floor, [2, -60, 0, 'cobblestone']]);
    const r = await w.run('place_line', { block: 'oak_planks', x: 1, y: -60, z: 0, axis: 'x', count: 3 });
    const res = r.details;
    assert.equal(res?.placedCount, 2, JSON.stringify(r.details).slice(0, 400));
    assert.equal(res.failedCount, 1);
    assert.equal(res.failures[0].code, 'occupied_target');
});
test('air is rejected (place never removes)', async () => {
    const w = makeWorld(floor);
    const r = await w.run('place', { x: 1, y: -60, z: 0, block: 'air' });
    assert.equal(failureCode(r), 'validation');
});
test('scaffold: no walkable stand, walks to a tower base, towers with dirt one jump per level, target placed, scaffold removed, movement reported', async () => {
    const pillar = [];
    for (let y = -60; y <= -55; y++) pillar.push([0, y, 3]);
    const w = makeWorld([...floor, ...pillar], {
        at: [0.5, -60, -6.5],
        path: (m, g) => (g.y === -60 ? 'success' : 'noPath'),
    });
    const r = await w.run('place', { x: 0, y: -54, z: 3, block: 'oak_planks' });
    assert.equal(r.isError, undefined, JSON.stringify(r.details));
    const mv = r.details.movement;
    assert.equal(mv.mode, 'scaffold');
    assert.ok(mv.scaffoldPlaced >= 1, JSON.stringify(mv));
    assert.equal(mv.scaffoldRemoved, mv.scaffoldPlaced);
    assert.deepEqual(mv.scaffoldLeft, []);
    assert.equal(w.cells.get('0,-54,3'), 'oak_planks');
    assert.ok(![...w.cells.values()].includes('dirt'));
    assert.ok(w.placed.includes('0,-54,3'));
    for (const d of w.dug) assert.notEqual(d, '0,-54,3');
    assert.equal(w.log.filter(l => l.startsWith('GOTO')).length, 1);
});
test('no_path when neither walking nor scaffolding can reach: suggests go_to, single attempt', async () => {
    const w = makeWorld(floor, { at: [-7.5, -60, -7.5], path: () => 'noPath' });
    const r = await w.run('place', { x: 6, y: -60, z: 6, block: 'oak_planks' });
    assert.equal(failureCode(r), 'no_path');
    assert.match(r.details.facts.next, /^go_to\(/);
    assert.equal(w.log.filter(l => l.startsWith('GOTO')).length, 0);
});
test('above eye height uses the stricter reach margin (reach - 0.8)', async () => {
    const w = makeWorld([...floor, [7, -59, 6], [7, -58, 6]], { at: [-7.5, -60, -7.5] });
    const r = await w.run('place', { x: 6, y: -58, z: 6, block: 'oak_planks' });
    assert.equal(r.isError, undefined, JSON.stringify(r.details));
    const mv = r.details.movement;
    assert.equal(mv.mode, 'walk');
    assert.ok(-58 >= mv.stand.y + 1.62 - 0.5);
    assert.ok(mv.faceDistance <= 5 - 0.8, JSON.stringify(mv));
});
test('place_line is a batch of place calls: skips present cells, stops at first failure with structured fields', async () => {
    const w = makeWorld([...floor, [1, -60, 0, 'oak_planks']], { at: [0.5, -60, -2.5] });
    const r = await w.run('place_line', { block: 'oak_planks', x: 0, y: -60, z: 0, axis: 'x', count: 3 });
    assert.equal(r.isError, undefined, JSON.stringify(r.details));
    assert.deepEqual(r.details.placed, [
        { x: 0, y: -60, z: 0 },
        { x: 2, y: -60, z: 0 },
    ]);
    assert.deepEqual(r.details.skipped, [{ x: 1, y: -60, z: 0 }]);
    const f = await w.run('place_line', { block: 'oak_planks', x: 3, y: -56, z: 0, axis: 'x', count: 2 });
    assert.equal(failureCode(f), 'no_support');
    assert.ok(f.details.facts.firstFailure.next);
    assert.equal(typeof f.details.facts.firstFailure.repeat, 'boolean');
    assert.ok(f.details.facts.firstFailure.missingSupport);
});
test('placement never digs, even if the target fills between preflight and click', async () => {
    const w = makeWorld(floor, { at: [0.5, -60, 0.5] });
    const realEquip = w.b.equip;
    w.b.equip = async (...a) => {
        w.cells.set('3,-60,0', 'stone');
        return realEquip(...a);
    };
    const r = await w.run('place', { x: 3, y: -60, z: 0, block: 'oak_planks' });
    assert.equal(r.isError, true);
    assert.deepEqual(w.dug, []);
    assert.ok(r.details.facts.next);
});

test('place_line stops starting new cells before its deadline margin (never cut off mid-cell)', async () => {
    const w = makeWorld(floor, { at: [0.5, -60, 0.5] });
    const realNow = Date.now;
    let shift = 0;
    const realPlace = w.b.placeBlock;
    w.b.placeBlock = async (ref, face) => {
        await realPlace(ref, face);
        shift = 95000;
    };
    Date.now = () => realNow() + shift;
    try {
        const r = await w.run('place_line', { block: 'oak_planks', x: 2, y: -60, z: 0, axis: 'z', count: 3 });
        const s = r.details;
        assert.equal(s.placedCount, 1);
        assert.equal(s.stoppedEarly, 'deadline_margin');
        assert.equal(s.notAttempted, 2);
    } finally {
        Date.now = realNow;
    }
});

test('scaffold left by an aborted place is never dug by a later action (may be a peer block by then)', async () => {
    const pillar = [];
    for (let y = -60; y <= -55; y++) pillar.push([0, y, 3]);
    const w = makeWorld([...floor, ...pillar], {
        at: [0.5, -60, -6.5],
        path: (m, g) => (g.y === -60 ? 'success' : 'noPath'),
    });
    const ctl = new AbortController(),
        realPlace = w.b.placeBlock;
    w.b.placeBlock = async (ref, face) => {
        if (w.b._jump) return realPlace(ref, face);
        ctl.abort(new Error('deadline'));
        throw new Error('interrupted');
    };
    const tools = createGameTools({
        bot: w.b,
        perception,
        skills: survival,
        observe: async () => ({ state: {}, frame: null }),
        actionRunner: createActionRunner(w.b, { settleTimeoutMs: 15000 }),
    });
    const run = (n, a, sig) => tools.find(t => t.name === n).execute('id', a, sig);
    const r = await run('place', { x: 0, y: -54, z: 3, block: 'oak_planks' }, ctl.signal);
    assert.equal(r.isError, true);
    w.b.placeBlock = realPlace;
    const dirt = [...w.cells.entries()].filter(([, n]) => n === 'dirt').map(([k]) => k);
    assert.ok(dirt.length > 0, 'abort left scaffold');
    const dugBefore = w.dug.length;
    const r2 = await run('place', { x: 1, y: -54, z: 3, block: 'oak_planks' });
    const res = r2.details ?? r2.details.facts ?? r2.details;
    assert.equal(res.earlierScaffold, undefined);
    for (const k of dirt) assert.equal(w.cells.get(k), 'dirt', 'left scaffold untouched: ' + k);
    assert.equal(w.dug.length, dugBefore);
});
test('place_line margin follows the real action deadline (timeout_ms)', async () => {
    const w = makeWorld(floor, { at: [0.5, -60, 0.5] });
    const realNow = Date.now;
    let shift = 0;
    const realPlace = w.b.placeBlock;
    w.b.placeBlock = async (ref, face) => {
        await realPlace(ref, face);
        shift = 16000;
    };
    Date.now = () => realNow() + shift;
    try {
        const r = await w.run('place_line', {
            block: 'oak_planks',
            x: 2,
            y: -60,
            z: 0,
            axis: 'z',
            count: 3,
            timeout_ms: 30000,
        });
        assert.equal(r.details.stoppedEarly, 'deadline_margin');
        assert.equal(r.details.placedCount, 1);
    } finally {
        Date.now = realNow;
    }
});
