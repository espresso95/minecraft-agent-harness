import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Vec3 } from 'vec3';
import { createHelpers } from '../../src/tools/game/helpers.js';

test('recovery reports only a walking path prefix and preserves pathfinder coordinates', async () => {
    const registry = createRequire(import.meta.url)('minecraft-data')('1.21.6');
    let generated,
        closed = false;
    const active = {
        registry,
        inventory: { items: () => [] },
        entity: { position: new Vec3(0.5, 64, 0.5) },
        pathfinder: {
            getPathFromTo(movements, start, goal, options) {
                generated = { movements, start, goal, options };
                return (function* () {
                    try {
                        yield { result: { path: [{ x: 3.5, y: 64, z: 0.5, toBreak: [], toPlace: [] }] } };
                    } finally {
                        closed = true;
                    }
                })();
            },
        },
    };
    const { navigationRecovery } = createHelpers({});
    const result = await navigationRecovery(active, { x: 12, y: 64, z: 0 });
    assert.deepEqual(result.waypoint, { x: 3.5, y: 64, z: 0.5 });
    assert.equal(generated.movements.canDig, false);
    assert.equal(generated.movements.allow1by1towers, false);
    assert.equal(generated.movements.allowParkour, false);
    assert.equal(generated.options.searchRadius, 16);
    assert.equal(closed, true);
    assert.match(result.next, /not a complete route/);
    active.pathfinder.getPathFromTo = function* () {
        yield { result: { path: [{ x: 3.5, y: 64, z: 0.5, toBreak: [{}], toPlace: [] }] } };
    };
    assert.deepEqual(await navigationRecovery(active, { x: 12, y: 64, z: 0 }), {});
    const abort = new AbortController();
    abort.abort();
    assert.deepEqual(await navigationRecovery(active, { x: 12, y: 64, z: 0 }, abort.signal), {});
});
