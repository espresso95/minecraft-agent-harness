import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { installRespawn } from '../../src/body/respawn.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function fixture({
    pauseMs = 0,
    pauseNever = false,
    spawnOnRespawn = true,
    recoveryTimeoutMs = 300,
    pauseTimeoutMs = 2000,
} = {}) {
    const bot = new EventEmitter();
    const log = { events: [], finished: [], respawnCalls: 0, resumed: 0 };
    bot.respawn = () => {
        log.respawnCalls++;
        if (spawnOnRespawn) setTimeout(() => bot.emit('spawn'), 20);
    };
    installRespawn(bot, {
        allowed: () => true,
        stopBody: async () => {
            await sleep(10);
        },
        pauseSession: () => (pauseNever ? new Promise(() => {}) : sleep(pauseMs)),
        resumeSession: () => {
            log.resumed++;
        },
        record: event => log.events.push(event),
        finish: reason => log.finished.push(reason),
        delay: 10,
        recoveryTimeoutMs,
        pauseTimeoutMs,
    });
    return { bot, log };
}

test('a fast session pause respawns and resumes once', async () => {
    const { bot, log } = fixture();
    bot.emit('death');
    await sleep(150);
    assert.equal(log.respawnCalls, 1);
    assert.deepEqual(log.events, ['death', 'respawn']);
    assert.equal(log.resumed, 1);
    assert.deepEqual(log.finished, []);
});

test('a session pause slower than the recovery watchdog still respawns and resumes when it settles', async () => {
    const { bot, log } = fixture({ pauseMs: 600, recoveryTimeoutMs: 300 });
    bot.emit('death');
    await sleep(200);
    assert.equal(log.respawnCalls, 1, 'body respawns before the session pause settles');
    assert.equal(log.resumed, 0, 'session does not resume before it is paused');
    await sleep(600);
    assert.deepEqual(log.finished, [], 'no respawn_timeout while the body is already back');
    assert.deepEqual(log.events, ['death', 'respawn']);
    assert.equal(log.resumed, 1);
});

test('no spawn after respawn still fails closed with respawn_timeout', async () => {
    const { bot, log } = fixture({ spawnOnRespawn: false, recoveryTimeoutMs: 200 });
    bot.emit('death');
    await sleep(400);
    assert.equal(log.respawnCalls, 1);
    assert.deepEqual(log.finished, ['respawn_timeout']);
    assert.equal(log.resumed, 0);
});

test('a session pause that never settles fails closed with pause_timeout, not respawn_timeout', async () => {
    const { bot, log } = fixture({ pauseNever: true, recoveryTimeoutMs: 200, pauseTimeoutMs: 400 });
    bot.emit('death');
    await sleep(700);
    assert.equal(log.respawnCalls, 1);
    assert.deepEqual(log.finished, ['pause_timeout']);
    assert.equal(log.resumed, 0);
});

test('a second death after recovery is handled again', async () => {
    const { bot, log } = fixture();
    bot.emit('death');
    await sleep(120);
    bot.emit('death');
    await sleep(120);
    assert.equal(log.respawnCalls, 2);
    assert.deepEqual(log.events, ['death', 'respawn', 'death', 'respawn']);
    assert.equal(log.resumed, 2);
    assert.deepEqual(log.finished, []);
});

test('a permanent-death policy change cancels a respawn already waiting for the body', async () => {
    const bot = new EventEmitter(),
        finished = [];
    let allowed = true,
        respawns = 0;
    bot.respawn = () => respawns++;
    installRespawn(bot, {
        allowed: () => true,
        respawnAllowed: () => allowed,
        stopBody: async () => {
            await sleep(30);
        },
        pauseSession: async () => {},
        resumeSession: () => assert.fail('must not resume'),
        record: () => {},
        finish: r => finished.push(r),
        delay: 10,
    });
    bot.emit('death');
    allowed = false;
    await sleep(80);
    assert.equal(respawns, 0);
    assert.deepEqual(finished, ['death']);
});
