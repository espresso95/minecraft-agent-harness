import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createGameTools, createActionRunner, interruptsOnHit, KEEP_MOVING_TOOLS } from '../../src/tools/game-tools.js';

const vector = (x = 0, y = 64, z = 0) => ({
    x,
    y,
    z,
    offset(dx, dy, dz) {
        return vector(x + dx, y + dy, z + dz);
    },
    distanceTo(p) {
        return Math.hypot(x - p.x, y - p.y, z - p.z);
    },
});
function bot() {
    const b = new EventEmitter();
    Object.assign(b, {
        username: 'Test',
        game: { gameMode: 'survival' },
        entity: { id: 0, position: vector(), yaw: 0, pitch: 0 },
        entities: {},
        health: 20,
        food: 20,
        inventory: { items: () => [], slots: new Array(46).fill(null) },
        pathfinder: { setMovements() {}, setGoal() {}, stop() {} },
        pvp: { stop() {} },
        collectBlock: { cancelTask() {} },
        clearControlStates() {},
        stopDigging() {},
        deactivateItem() {},
        quit() {},
        chat() {},
    });
    return b;
}

test('movement tools are not cut short by a hit; other body actions are', () => {
    for (const t of ['go_to', 'move', 'flee', 'return_to_surface']) {
        assert.ok(KEEP_MOVING_TOOLS.has(t));
        assert.equal(interruptsOnHit(t, true), false);
    }
    assert.equal(interruptsOnHit('attack', true), false);
    for (const t of ['gather', 'break_area', 'place_line', 'craft']) assert.equal(interruptsOnHit(t, true), true);
    assert.equal(interruptsOnHit('gather', false), false);
    assert.equal(interruptsOnHit(null, true), false);
});

test('a hit during move is reported in the completed result and the listener is removed', async () => {
    const b = bot();
    const skills = {
        move: async active => {
            await new Promise(r => setTimeout(r, 40));
            active.health = 16;
            active.emit('pi_hit', { by: 'Zombie', id: 7, distance: 1.2, health: 16 });
            await new Promise(r => setTimeout(r, 40));
            return true;
        },
    };
    const runner = createActionRunner(b, { settleTimeoutMs: 200 });
    const tools = createGameTools({
        bot: b,
        skills,
        actionRunner: runner,
        observe: async () => ({ state: {}, frame: null }),
    });
    const res = await tools.find(t => t.name === 'move').execute('id', { controls: ['forward'], seconds: 0.1 });
    assert.equal(res.isError, undefined, JSON.stringify(res));
    assert.equal(res.details.outcome, 'success');
    assert.deepEqual(res.details.hitsDuring, [{ by: 'Zombie', id: 7, distance: 1.2, health: 16 }]);
    assert.equal(res.details.healthNow, 16);
    assert.equal(b.listenerCount('pi_hit'), 0);
    const quiet = await tools.find(t => t.name === 'move').execute('id', { controls: ['forward'], seconds: 0.1 });
    assert.equal(quiet.details.hitsDuring?.length, 1);
});
