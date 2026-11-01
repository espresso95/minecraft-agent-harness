import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import * as perception from '../../src/skills/perception.js';
import { createGameTools } from '../../src/tools/game-tools.js';

function bot(solid, start) {
    const gone = new Set(),
        calls = [];
    const k = (x, y, z) => `${x},${y},${z}`;
    const blk = v => {
        const p = new Vec3(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z));
        return !gone.has(k(p.x, p.y, p.z)) && solid(p.x, p.y, p.z)
            ? { name: 'stone', position: p, boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]], diggable: true }
            : { name: 'air', position: p, boundingBox: 'empty', shapes: [] };
    };
    return {
        calls,
        gone,
        username: 'T',
        game: { gameMode: 'survival' },
        health: 20,
        food: 20,
        entity: {
            id: 0,
            position: new Vec3(...start),
            velocity: new Vec3(0, 0, 0),
            onGround: true,
            yaw: 0,
            pitch: 0,
            eyeHeight: 1.62,
        },
        entities: {},
        inventory: { items: () => [], slots: new Array(46).fill(null) },
        world: { getBlock: blk },
        blockAt: blk,
        pathfinder: { goto: async () => {}, setGoal: () => {}, stop: () => {}, setMovements: () => {} },
        clearControlStates() {},
        stopDigging() {},
        deactivateItem() {},
        quit() {},
        chat() {},
        emit() {},
    };
}
const tool = (b, skills, name) =>
    createGameTools({ bot: b, perception, skills, observe: async () => ({ state: {}, frame: null }) }).find(
        t => t.name === name,
    );
const parse = r => JSON.parse(r.content[0].text);

test('a block whose centre is hidden but whose top face is in view counts as visible', () => {
    const b = bot(
        (x, y, z) => y <= 63 || (x === 1 && y === 64 && z === 0) || (x === 2 && y === 64 && z === 0),
        [0.5, 64, 0.5],
    );
    const target = b.blockAt(new Vec3(2, 64, 0));
    assert.equal(perception.isBlockVisible(b, target, 4.5), false);
    assert.equal(perception.isBlockFaceVisible(b, target, 4.5), true);
});

test('a fully buried block reports what is in the way', () => {
    const b = bot((x, y, z) => y <= 63 || (x >= 1 && x <= 3 && z === 0 && y <= 66), [0.5, 64, 0.5]);
    const s = perception.blockSight(b, b.blockAt(new Vec3(3, 64, 0)), 64);
    assert.equal(s.visible, false);
    assert.equal(s.obstruction.x, 1);
});

test('break_area does not abort when one block is hidden; it retries it after the rest, then skips with a reason', async () => {
    const b = bot((x, y, z) => y <= 63, [0.5, 64, 0.5]);
    let hiddenTries = 0;
    const skills = {
        goToPosition: async () => true,
        breakAt: async (bb, x, y, z) => {
            if (x === 3 && y === 63) {
                hiddenTries++;
                throw new Error(
                    `Block at 3, 63, 0 is not visible within 64 blocks. Every line of sight to it is blocked; the first block in the way is stone at 2, 63, 0. Break that one first, or stand where a face of it is open.`,
                );
            }
            b.gone.add(`${x},${y},${z}`);
            return true;
        },
    };
    const r = await tool(b, skills, 'break_area').execute(
        'id',
        { x1: 2, y1: 63, z1: 0, x2: 4, y2: 63, z2: 0 },
        new AbortController().signal,
    );
    assert.equal(r.isError, undefined, JSON.stringify(r.content));
    const out = parse(r).result;
    assert.equal(out.broke, 2);
    assert.equal(hiddenTries, 2);
    assert.match(out.skipped[0].reason, /first block in the way is stone/);
});

test('go_to stops early when the body sits still, and explains a target below your feet', async () => {
    const b = bot((x, y, z) => y <= 63, [0.5, 64, 0.5]);
    b.pi_goWatch = { idleMs: 1200, noGainMs: 60000 };
    const skills = {
        goToPosition: () =>
            new Promise(r => {
                b.pathfinder.stop = () => r(false);
            }),
    };
    const t0 = Date.now();
    const r = await tool(b, skills, 'go_to').execute(
        'id',
        { x: 0, y: 62, z: 0, distance: 0.5 },
        new AbortController().signal,
    );
    assert.ok(Date.now() - t0 < 5000);
    const body = parse(r);
    assert.equal(r.isError, true);
    assert.equal(body.code, 'no_progress');
    assert.match(body.error, /without moving or digging/);
    assert.match(body.error, /target is below you/);
});

test('go_to into solid rock names the block', async () => {
    const b = bot((x, y, z) => y <= 63, [0.5, 64, 0.5]);
    b.pi_goWatch = { idleMs: 800, noGainMs: 60000 };
    const skills = {
        goToPosition: () =>
            new Promise(r => {
                b.pathfinder.stop = () => r(false);
            }),
    };
    const r = await tool(b, skills, 'go_to').execute('id', { x: 6, y: 60, z: 0 }, new AbortController().signal);
    assert.match(parse(r).error, /inside solid stone/);
});

test('ground-block coordinates route to the open feet position above without digging', async () => {
    const b = bot((_x, y, _z) => y <= 68, [-6, 69, 2]);
    const visited = [];
    const skills = {
        goToPosition: async (_active, x, y, z) => {
            visited.push({ x, y, z });
            b.entity.position = new Vec3(x, y, z);
            return true;
        },
    };
    const result = await tool(b, skills, 'go_to').execute('test', { x: -8, y: 68, z: 1, distance: 0.5 });
    assert.equal(result.isError, undefined);
    assert.deepEqual(visited, [{ x: -8, y: 69, z: 1 }]);
    assert.deepEqual(parse(result).result.target, { x: -8, y: 68, z: 1 });
    assert.deepEqual(parse(result).result.navigationTarget, visited[0]);
    assert.ok(parse(result).result.distanceToTarget <= parse(result).result.acceptedWithin);
    assert.equal(b.gone.size, 0);
});

test('navigation never reports success outside the requested acceptance radius', async () => {
    const b = bot((_x, y, _z) => y <= 63, [0.5, 64, 0.5]);
    const result = await tool(b, { goToPosition: async () => true }, 'go_to').execute('test', { x: 10, y: 64, z: 0 });
    assert.equal(result.isError, true);
});
