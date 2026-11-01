import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { installDamageWake } from '../../src/body/damage.js';
import { causeLabel, installDamageTypes, isStarvationDamage, attackDamageStop } from '../../src/body/hurt-cause.js';

test('combat handles starvation without an attacker while preserving other damage responses', () => {
    assert.equal(attackDamageStop(undefined, 'starve', 9, 'starvation'), null);
    assert.equal(attackDamageStop(null, 'fall', 9, 'fall'), 'environment_damage');
    assert.equal(attackDamageStop(undefined, null, 9, 'unknown'), 'environment_damage');
    assert.equal(attackDamageStop({ id: 9 }, null, 9, 'current target'), null);
    assert.equal(attackDamageStop({ id: 10 }, null, 9, 'another attacker'), 'hit_by_other: another attacker');
});

function rig(active = 'gather') {
    const client = new EventEmitter();
    client.prependListener = client.prependListener.bind(client);
    const bot = Object.assign(new EventEmitter(), { _client: client, entity: { id: 7 }, health: 20, food: 20 });
    const calls = [];
    installDamageTypes(bot);
    client.emit('registry_data', {
        id: 'minecraft:damage_type',
        entries: [{ key: 'minecraft:starve' }, { key: 'minecraft:fall' }],
    });
    installDamageWake(bot, () => ({ enqueue: (event, opts) => calls.push({ event, opts }) }), {
        status: { active },
    });
    const hurt = (type, health) => {
        client.emit('damage_event', { entityId: 7, sourceTypeId: type === 'starve' ? 0 : 1 });
        bot.health = health;
        bot.emit('health');
    };
    return { bot, calls, hurt };
}

test('starvation damage queues quietly without waking or interrupting', () => {
    const { bot, calls, hurt } = rig();
    bot.food = 0;
    hurt('starve', 19);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].event.cause, 'starvation');
    assert.deepEqual(calls[0].opts, { key: 'damage', urgent: false, interrupt: false });
});

test('other environment damage still wakes and interrupts', () => {
    const { bot, calls, hurt } = rig();
    bot.food = 0;
    hurt('fall', 15);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].event.cause, undefined);
    assert.equal(calls[0].opts.urgent, true);
    assert.equal(calls[0].opts.interrupt, true);
});

test('starvation check uses the recent damage type, then falls back to an empty food bar', () => {
    const now = 1000000;
    assert.equal(isStarvationDamage({ pi_recentDamage: { type: 'starve', at: now - 100 } }, now), true);
    assert.equal(isStarvationDamage({ pi_recentDamage: { type: 'fall', at: now - 100 }, food: 0 }, now), false);
    assert.equal(isStarvationDamage({ pi_damageTypes: [], food: 0 }, now), true);
    assert.equal(isStarvationDamage({ pi_damageTypes: ['fall'], food: 0 }, now), false);
    assert.equal(causeLabel('starve'), 'starvation (food bar is empty)');
});
