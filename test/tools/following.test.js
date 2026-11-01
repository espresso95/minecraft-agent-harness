import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Vec3 } from 'vec3';
import { createFollowing } from '../../src/tools/game/following.js';
import { createHelpers } from '../../src/tools/game/helpers.js';
import { createActionRunner, installSkillCompatibility, LATE_MUTATION_REFUSED } from '../../src/tools/game/runtime.js';

function setup(t) {
    const bot = new EventEmitter();
    const errors = [],
        goals = [];
    Object.assign(bot, {
        username: 'Companion',
        game: { gameMode: 'survival' },
        entity: { position: new Vec3(0, 64, 0) },
        players: { Human: { entity: { position: new Vec3(5, 64, 0) } } },
        inventory: { items: () => [] },
        pathfinder: {
            setGoal: (goal, dynamic) => goals.push({ goal, dynamic }),
            setMovements: movements => {
                bot.movements = movements;
            },
            stop() {},
        },
        clearControlStates() {},
        stopDigging() {},
        deactivateItem() {},
    });
    installSkillCompatibility(bot);
    const runner = createActionRunner(bot, { onBackgroundError: (name, error) => errors.push({ name, error }) });
    let follow;
    createFollowing({
        bot,
        runner,
        ...createHelpers({}),
        add: (_name, _description, _schema, fn) => {
            follow = fn;
        },
        pathfinderModule: async () => ({
            Movements: class {},
            goals: {
                GoalFollow: class {
                    constructor(entity, distance) {
                        Object.assign(this, { entity, distance });
                    }
                },
            },
        }),
    });
    t.after(() => runner.stop());
    return { bot, runner, follow, errors, goals };
}

test('following starts promptly and tracks the live player while the model is idle', async t => {
    const { bot, runner, follow, goals } = setup(t);
    assert.deepEqual(await follow({ player: 'human' }), { following: 'Human', distance: 3, background: true });
    assert.equal(runner.status.active, 'follow_player');
    assert.equal(runner.status.background, true);
    assert.equal(goals[0].dynamic, true);
    assert.equal(bot.movements.canDig, false);
    assert.equal(bot.movements.allow1by1towers, false);
    assert.equal(bot.movements.allowParkour, false);
    const moving = new Vec3(10, 65, 2);
    bot.players.Human.entity.position = moving;
    await delay(300);
    assert.equal(goals[0].goal.entity.position, moving);
    assert.equal(runner.status.active, 'follow_player');
});

test('another physical action replaces following and releases all follower listeners', async t => {
    const { bot, runner, follow, errors } = setup(t);
    await follow({ player: 'Human' });
    let executed = false;
    await runner.run('craft', async () => {
        executed = true;
    });
    assert.equal(executed, true);
    assert.equal(runner.status.active, null);
    assert.equal(bot.listenerCount('path_update'), 0);
    assert.equal(errors.length, 0);
});

test('stop cancels background following without treating cancellation as a failure', async t => {
    const { bot, runner, follow, errors, goals } = setup(t);
    await follow({ player: 'Human' });
    await runner.stop();
    await delay(20);
    assert.equal(runner.status.active, null);
    assert.equal(bot.listenerCount('path_update'), 0);
    assert.equal(goals.at(-1).goal, null);
    assert.equal(errors.length, 0);
});

test('a lost player ends following and reports one actionable failure', async t => {
    const { bot, runner, follow, errors } = setup(t);
    await follow({ player: 'Human' });
    delete bot.players.Human.entity;
    await delay(350);
    assert.equal(runner.status.active, null);
    assert.equal(errors.length, 1);
    assert.match(errors[0].error.message, /Lost sight of Human/);
    assert.equal(bot.listenerCount('path_update'), 0);
});

test('a stationary nearby player does not trip the no-progress guard', async t => {
    const { bot, runner, follow, errors } = setup(t);
    bot.players.Human.entity.position = new Vec3(1, 64, 0);
    bot.pi_goWatch = { idleMs: 100, noGainMs: 100 };
    await follow({ player: 'Human' });
    await delay(650);
    assert.equal(runner.status.active, 'follow_player');
    assert.equal(errors.length, 0);
});

test('a moving player does not trip no-gain while the follower keeps pace', async t => {
    const { bot, runner, follow, errors } = setup(t);
    bot.pi_goWatch = { idleMs: 1000, noGainMs: 100 };
    await follow({ player: 'Human', distance: 1 });
    const timer = setInterval(() => {
        bot.entity.position.x += 0.5;
        bot.players.Human.entity.position.x += 0.5;
    }, 100);
    t.after(() => clearInterval(timer));
    await delay(1200);
    assert.equal(runner.status.active, 'follow_player');
    assert.equal(errors.length, 0);
});

test('an unreachable route ends following instead of retrying indefinitely', async t => {
    const { bot, runner, follow, errors } = setup(t);
    await follow({ player: 'Human', distance: 1 });
    bot.emit('path_update', { status: 'noPath' });
    await delay(2300);
    assert.equal(runner.status.active, null);
    assert.equal(errors.length, 1);
    assert.match(errors[0].error.message, /no safe progress/);
});

test('native physics ticks use the current action and lose authority when it finishes', async t => {
    const { bot, runner } = setup(t);
    let writes = 0,
        ticking = false;
    bot._client = {
        write: () => {
            writes++;
        },
    };
    bot.on('physicsTick', () => bot._client.write('block_dig', { status: 0 }));
    const timer = setInterval(() => {
        if (ticking) bot.emit('physicsTick');
    }, 5);
    t.after(() => clearInterval(timer));
    await runner.run('gather', async () => {
        ticking = true;
        await delay(30);
        ticking = false;
    });
    assert.ok(writes > 0);
    assert.throws(
        () => bot.emit('physicsTick'),
        e => e.code === LATE_MUTATION_REFUSED,
    );
});

test('an old action cannot gain the next action authority by emitting a physics tick', async t => {
    const { bot, runner } = setup(t);
    let writes = 0,
        release,
        stale;
    bot._client = {
        write: () => {
            writes++;
        },
    };
    bot.on('physicsTick', () => bot._client.write('block_dig', { status: 0 }));
    await runner.run('first', async () => {
        stale = (async () => {
            await new Promise(resolve => {
                release = resolve;
            });
            assert.throws(
                () => bot.emit('physicsTick'),
                e => e.code === LATE_MUTATION_REFUSED,
            );
        })();
    });
    await runner.run('second', async () => {
        release();
        await stale;
    });
    assert.equal(writes, 0);
});
