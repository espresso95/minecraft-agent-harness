import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import * as survival from '../../src/skills/survival.js';
import {
    createGameTools,
    createActionRunner,
    createObservation,
    installSkillCompatibility,
    failureCode,
    LATE_MUTATION_REFUSED,
} from '../../src/tools/game-tools.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
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
    const calls = [];
    return {
        calls,
        username: 'Test',
        game: { gameMode: 'survival' },
        entity: { id: 0, position: vector(), yaw: 0, pitch: 0 },
        entities: {},
        health: 20,
        food: 20,
        inventory: { items: () => [], slots: new Array(46).fill(null) },
        pathfinder: {
            setMovements: m => calls.push(['movements', m]),
            setGoal: () => calls.push('goalStop'),
            stop: () => calls.push('pathStop'),
        },
        pvp: { stop: () => calls.push('pvpStop') },
        collectBlock: { cancelTask: () => calls.push('collectStop') },
        clearControlStates: () => calls.push('clear'),
        stopDigging: () => calls.push('digStop'),
        deactivateItem: () => calls.push('itemStop'),
        quit: reason => calls.push(['quit', reason]),
        dig: () => calls.push('dig'),
        chat: text => calls.push(['chat', text]),
    };
}
function setup(extra = {}) {
    const b = bot();
    const tools = createGameTools({
        bot: b,
        observe: async () => ({ state: { visible: true }, frame: null }),
        ...extra,
    });
    return {
        b,
        tools,
        run: (name, args = {}, signal) => tools.find(t => t.name === name).execute('call-id', args, signal),
    };
}

test('native schemas are typed, closed, unique and do not expose commands/paths/actors', () => {
    const { tools } = setup();
    assert.equal(new Set(tools.map(t => t.name)).size, tools.length);
    assert.ok(tools.length >= 25);
    for (const t of tools) {
        assert.equal(t.parameters.type, 'object');
        assert.equal(t.parameters.additionalProperties, false);
        for (const key of ['actor', 'sender', 'command', 'path', 'code']) assert.ok(!(key in t.parameters.properties));
        assert.ok(!t.name.startsWith('!'));
    }
});

test('idle status metadata is owned by the actual tools; work remains conservative by default', () => {
    const { tools } = setup({ mailbox: {}, peers: [] });
    for (const name of ['message_status', 'read_chat', 'read_dms', 'inventory', 'observe_world', 'look'])
        assert.equal(tools.find(t => t.name === name).idle, true, name);
    for (const name of ['post_chat', 'send_dm', 'gather', 'go_to', 'place_line'])
        assert.equal(tools.find(t => t.name === name).idle, false, name);
});

test('disabled-only compatibility refuses a real modes manager and bounds logs', () => {
    const b = bot();
    installSkillCompatibility(b);
    b.modes.pause('self_defense');
    b.modes.unpause('self_defense');
    assert.equal(b.modes.isOn('cheat'), false);
    assert.equal(b.modes.isOn('self_defense'), false);
    b.output = 'x'.repeat(15000);
    assert.equal(b.output.length, 12000);
    const movement = { canDig: true, allow1by1towers: true, scafoldingBlocks: [1] };
    b.pathfinder.setMovements(movement);
    assert.equal(movement.canDig, true);
    assert.deepEqual(movement.scafoldingBlocks, [1]);
    assert.equal(installSkillCompatibility(b), b);
    assert.throws(() => installSkillCompatibility({ modes: {} }), /existing modes/);
    assert.equal(b.armorManager, undefined);
});

test('tool arguments reject extra keys, NaN, unsafe counts and non-survival actions', async () => {
    let invoked = 0;
    const { b, run } = setup({
        skills: {
            equip: async () => {
                invoked++;
                return true;
            },
        },
    });
    assert.equal((await run('equip', { item: 'stone', actor: 'Other' })).isError, true);
    assert.equal((await run('go_to', { x: NaN, y: 64, z: 0 })).isError, true);
    assert.equal((await run('gather', { block: 'stone', count: 1000 })).isError, true);
    b.game.gameMode = 'creative';
    assert.equal((await run('equip', { item: 'stone' })).isError, true);
    assert.equal(invoked, 0);
});

test('native dispatch calls functions, includes log, surfaces false and thrown failures', async () => {
    const seen = [];
    const { run } = setup({
        skills: {
            equip: async (b, value) => {
                seen.push(value);
                b.output += 'Equipped';
                return true;
            },
            consume: async b => {
                b.output += 'No food';
                return false;
            },
            look: async () => {
                throw new Error('Not spawned');
            },
        },
    });
    assert.equal((await run('equip', { item: 'stone' })).details.log, 'Equipped');
    assert.deepEqual(seen, ['stone']);
    assert.match((await run('eat', { item: 'apple' })).details.error, /No food/);
    assert.match((await run('look', { yaw: 0, pitch: 0 })).details.error, /Not spawned/);
});

test('body work serializes while mailbox tools do not wait for it', async () => {
    let release;
    const gate = new Promise(resolve => {
        release = resolve;
    });
    const order = [];
    const { run } = setup({
        mailbox: { summary: () => 'one DM' },
        skills: {
            equip: async () => {
                order.push('start');
                await gate;
                order.push('finish');
                return true;
            },
        },
    });
    const first = run('equip', { item: 'stone' });
    const second = run('equip', { item: 'dirt' });
    await delay(5);
    assert.deepEqual(order, ['start']);
    assert.equal((await run('message_status')).details, 'one DM');
    release();
    await Promise.all([first, second]);
    assert.deepEqual(order, ['start', 'finish', 'start', 'finish']);
});

test('abort stops all controllers, guards resumed mutation and preserves body lock', async () => {
    const b = installSkillCompatibility(bot());
    const runner = createActionRunner(b, { settleTimeoutMs: 100 });
    const controller = new AbortController();
    const order = [];
    let staleError;
    const first = runner.run(
        'slow',
        async ({ bot: active }) => {
            order.push('start');
            await delay(30);
            try {
                active.dig();
            } catch (error) {
                staleError = error;
            }
            order.push('finish');
        },
        { signal: controller.signal },
    );
    await delay(5);
    controller.abort();
    const cancelled = assert.rejects(first, /cancelled/);
    const second = runner.run('next', async () => {
        order.push('next');
    });
    await delay(5);
    assert.deepEqual(order, ['start']);
    await cancelled;
    await second;
    assert.deepEqual(order, ['start', 'finish', 'next']);
    assert.ok(staleError);
    assert.ok(!b.calls.includes('dig'));
    for (const stop of ['goalStop', 'pathStop', 'pvpStop', 'collectStop', 'digStop', 'itemStop', 'clear'])
        assert.ok(b.calls.includes(stop));
});

test('deadline on uncooperative action disconnects and permanently blocks bodies', async () => {
    const b = installSkillCompatibility(bot());
    let fatal;
    const runner = createActionRunner(b, {
        defaultTimeoutMs: 10,
        settleTimeoutMs: 10,
        onFatal: e => {
            fatal = e;
        },
    });
    await assert.rejects(
        runner.run('stuck', () => new Promise(() => {})),
        /deadline/,
    );
    await delay(25);
    assert.equal(runner.status.blocked, true);
    assert.match(fatal.message, /reconnect required/);
    assert.ok(b.calls.some(c => Array.isArray(c) && c[0] === 'quit'));
    await assert.rejects(
        runner.run('later', () => {}),
        /reconnect required/,
    );
});

test('already aborted or timed-out queued work never runs and does not stop current body', async () => {
    const b = installSkillCompatibility(bot());
    const runner = createActionRunner(b);
    const controller = new AbortController();
    controller.abort();
    let invoked = false;
    await assert.rejects(
        runner.run(
            'none',
            () => {
                invoked = true;
            },
            { signal: controller.signal },
        ),
        /cancelled/,
    );
    assert.equal(invoked, false);
    assert.deepEqual(b.calls, []);
    let release;
    const first = runner.run(
        'first',
        () =>
            new Promise(r => {
                release = r;
            }),
    );
    await delay(2);
    const second = runner.run(
        'expired',
        () => {
            invoked = true;
        },
        { timeoutMs: 5 },
    );
    await assert.rejects(second, /deadline/);
    assert.deepEqual(b.calls, []);
    release();
    await first;
    await delay(2);
    assert.equal(invoked, false);
});

test('explicit stop cancels queued bodies as well as active action', async () => {
    const b = installSkillCompatibility(bot());
    const runner = createActionRunner(b);
    const first = runner.run('first', async () => delay(15));
    let invoked = false;
    const second = runner.run('second', () => {
        invoked = true;
    });
    await delay(2);
    await runner.stop();
    await assert.rejects(first, /Stopped/);
    await assert.rejects(second, /Queued action cancelled/);
    assert.equal(invoked, false);
});

test('LOS observations remove hidden blocks/entities, return fresh images and never DM text', async () => {
    const b = bot();
    b.entities = {
        1: { id: 1, name: 'zombie', position: vector(1), visible: true },
        2: { id: 2, name: 'cow', position: vector(2), visible: false },
    };
    const blocks = [
        { name: 'stone', position: vector(), visible: true },
        { name: 'diamond_ore', position: vector(), visible: false },
    ];
    let captures = 0;
    const observe = createObservation({
        bot: b,
        perception: { isBlockVisible: (_, v) => v.visible, isEntityVisible: (_, v) => v.visible },
        world: { getNearestBlocks: () => blocks },
        captureFrame: async () => ({ data: `frame-${++captures}`, mimeType: 'image/png', limitations: 'approximate' }),
        mailbox: {
            summary: () => 'DMs: 1',
            recentChat: () => ({ messages: [{ text: 'public' }] }),
            readDMs: () => {
                throw new Error('Must not read DM bodies');
            },
        },
    });
    const a = await observe();
    const c = await observe();
    assert.equal(a.frame.data, 'frame-1');
    assert.equal(c.frame.data, 'frame-2');
    assert.deepEqual(
        a.state.blocks.map(b => b.name),
        ['stone'],
    );
    assert.deepEqual(
        a.state.entities.map(e => e.name),
        ['zombie'],
    );
    assert.ok(!JSON.stringify(a.state).includes('frame-1'));
    assert.equal(a.state.messaging, 'DMs: 1');
    await observe({ image: false });
    assert.equal(captures, 2);
});

test('Pi image output is native image content; camera failure is explicit not stale', async () => {
    const { run } = setup({
        observe: async () => ({ state: { camera: 'fresh' }, frame: { data: 'YWJj', mimeType: 'image/png' } }),
    });
    const response = await run('observe_world');
    assert.deepEqual(response.content[1], { type: 'image', data: 'YWJj', mimeType: 'image/png' });
    const observe = createObservation({
        bot: bot(),
        perception: { isBlockVisible: () => false, isEntityVisible: () => false },
        world: { getNearestBlocks: () => [] },
        captureFrame: async () => {
            throw new Error('offline');
        },
    });
    const output = await observe();
    assert.equal(output.frame, undefined);
    assert.equal(output.state.imageError, 'offline');
});

test('mailbox fixed actor, registered-recipient restriction, paging and public speech guards', async () => {
    const sent = [];
    const { b, run } = setup({
        peers: ['Peer'],
        mailbox: {
            sendDM: (...args) => {
                sent.push(args);
                return 42;
            },
            readDMs: (...args) => args,
            readChat: (...args) => args,
        },
    });
    assert.equal((await run('send_dm', { to: 'Peer', text: 'private' })).details.id, 42);
    assert.deepEqual(sent, [['Peer', 'private', {}]]);
    assert.equal((await run('send_dm', { to: 'Human', text: 'hi' })).isError, true);
    assert.equal((await run('send_dm', { to: 'Peer', text: 'hi', actor: 'Peer' })).isError, true);
    assert.deepEqual((await run('read_chat')).details, [-2, 20]);
    assert.deepEqual((await run('read_dms', { peer: 'Peer', after: 41, limit: 5 })).details, ['Peer', 41, 5]);
    for (const text of ['/op Test', ' /tp 1 2 3', 'hello\n/op me', '!goTo(1,2,3)', '  '])
        assert.equal((await run('post_chat', { text })).isError, true);
    assert.equal((await run('post_chat', { text: 'Hello crew.' })).details.posted, true);
    assert.deepEqual(b.calls, [['chat', 'Hello crew.']]);
});

test('craft uses ordinary recipes with reachable table, no armor plugin or automatic construction', async () => {
    const b = bot();
    b.registry = { itemsByName: { stick: { id: 1 } } };
    b.recipesFor = (...args) => {
        b.calls.push(['recipes', ...args]);
        return [{ result: { id: 1 } }];
    };
    const made = [];
    b.inventory.items = () => made;
    b.craft = (...args) => {
        b.calls.push(['craft', ...args]);
        made.push({ name: 'stick', count: 1, type: 1 });
    };
    const { run } = setup({
        bot: b,
        world: { getNearestBlocks: () => [] },
        perception: { isBlockVisible: () => false },
    });
    const output = await run('craft', { item: 'stick', count: 2 });
    assert.equal(output.isError, undefined);
    assert.ok(b.calls.some(c => Array.isArray(c) && c[0] === 'craft' && c[2] === 1 && c[3] === null));
    assert.equal(b.armorManager, undefined);
});

test('plan callback is host-bound and cannot take paths or rewrite entries', async () => {
    const { run } = setup({ plan: { read: a => a, append: text => ({ appended: text }) } });
    assert.deepEqual((await run('read_plan', { query: 'arch' })).details, { query: 'arch', before: 0 });
    assert.deepEqual((await run('append_plan', { text: 'A proposal' })).details, { appended: 'A proposal' });
    assert.equal((await run('read_plan', { path: '/etc/passwd' })).isError, true);
});

test('async controller cleanup completes before next body starts', async () => {
    const b = installSkillCompatibility(bot());
    let cleanupDone = false;
    b.pvp.stop = async () => {
        await delay(20);
        cleanupDone = true;
    };
    const runner = createActionRunner(b, { settleTimeoutMs: 100 });
    const first = runner.run('first', () => 1);
    const second = runner.run('second', () => {
        assert.equal(cleanupDone, true);
    });
    await Promise.all([first, second]);
});

test('cleanup failure or hang fails the action and poisons runner', async () => {
    for (const stop of [
        () => {
            throw new Error('broken stop');
        },
        () => new Promise(() => {}),
    ]) {
        const b = installSkillCompatibility(bot());
        b.pvp.stop = stop;
        const runner = createActionRunner(b, { settleTimeoutMs: 10 });
        await assert.rejects(
            runner.run('first', () => true),
            /reconnect required/,
        );
        assert.equal(runner.status.blocked, true);
    }
});

test('late container mutation is guarded after cancellation, but closing remains allowed', async () => {
    const b = installSkillCompatibility(bot());
    const calls = [];
    b.openFurnace = async () => ({ putInput: () => calls.push('input'), close: () => calls.push('close') });
    const runner = createActionRunner(b, { settleTimeoutMs: 100 });
    const abort = new AbortController();
    const work = runner.run(
        'furnace',
        async ({ bot: active }) => {
            const f = await active.openFurnace({});
            await delay(20);
            try {
                f.putInput();
            } finally {
                f.close();
            }
        },
        { signal: abort.signal },
    );
    await delay(3);
    abort.abort();
    await assert.rejects(work, /cancelled/);
    await delay(30);
    assert.deepEqual(calls, ['close']);
});

test('gather walks to a block it can see, skips failing ones (remembered across calls) and reports real inventory delta', async () => {
    const { createRequire } = await import('node:module');
    const b = bot();
    let held = [];
    const dug = [];
    b.registry = createRequire(import.meta.url)('minecraft-data')('1.21.6');
    b.inventory.items = () => held;
    const blocked = {
        name: 'oak_log',
        position: new Vec3(1, 64, 0),
        diggable: true,
        visible: false,
        canHarvest: () => true,
    };
    const open = {
        name: 'oak_log',
        position: new Vec3(2, 64, 0),
        diggable: true,
        visible: true,
        canHarvest: () => true,
    };
    const live = new Map([
        [1, blocked],
        [2, open],
    ]);
    b.blockAt = p => live.get(p.x) ?? { name: 'air', position: p };
    b.entity.position = new Vec3(0, 64, 0);
    b.pathfinder.goto = async goal => {
        assert.equal(goal.constructor.name, 'GoalLookAtBlock');
    };
    b.dig = async block => {
        dug.push(block.position.x);
        live.delete(block.position.x);
        held = [{ name: 'oak_log', count: dug.length }];
    };
    const { run } = setup({
        bot: b,
        world: { getNearestBlocks: () => [...live.values()] },
        perception: { isBlockVisible: (_, x) => x.visible },
    });
    const output = await run('gather', { block: 'oak_log', count: 3 });
    assert.equal(output.details.result.mined, 1);
    assert.deepEqual(dug, [2]);
    assert.deepEqual(output.details.result.inventoryDelta, { oak_log: 1 });
    assert.equal(output.details.result.skipped[0].code, 'not_visible_or_range');
    const again = await run('gather', { block: 'oak_log', count: 1 });
    assert.equal(again.isError, true);
    assert.equal(failureCode(again), 'not_found');
    assert.deepEqual(dug, [2]);
});

test('gather yields between blocks with truthful partial counts and collected inventory', async () => {
    const { createRequire } = await import('node:module');
    const b = bot();
    b.username = 'CheckpointBot';
    let mined = 0;
    b.registry = createRequire(import.meta.url)('minecraft-data')('1.21.6');
    b.entity.position = new Vec3(0, 64, 0);
    const block = { name: 'oak_log', position: new Vec3(1, 64, 0), diggable: true, canHarvest: () => true };
    b.blockAt = () => block;
    b.inventory.items = () => (mined ? [{ name: 'oak_log', count: mined }] : []);
    b.dig = async () => {
        mined++;
    };
    const { run } = setup({
        bot: b,
        world: { getNearestBlocks: () => [block] },
        perception: { isBlockVisible: () => true },
        shouldYield: () => mined > 0,
    });
    const output = await run('gather', { block: 'oak_log', count: 10 });
    assert.equal(output.isError, undefined);
    assert.equal(output.details.result.yielded, true);
    assert.equal(output.details.result.mined, 1);
    assert.equal(output.details.result.requested, 10);
    assert.deepEqual(output.details.result.inventoryDelta, { oak_log: 1 });
    const again = await run('gather', { block: 'oak_log', count: 9 });
    assert.equal(again.details.result.yielded, true);
    assert.equal(again.details.result.mined, 0);
    assert.equal(mined, 1);
});

test('gather with nothing around reports not_found and the nearest far block', async () => {
    const b = bot();
    b.entity.position = new Vec3(0, 64, 0);
    const far = { name: 'oak_log', position: new Vec3(100, 64, 0) };
    const { run } = setup({
        bot: b,
        world: { getNearestBlocks: (_b, _t, range) => (range > 64 ? [far] : []) },
        perception: { isBlockVisible: () => true },
    });
    const out = await run('gather', { block: 'oak_log', count: 2 });
    assert.equal(out.isError, true);
    assert.equal(failureCode(out), 'not_found');
    assert.match(out.details.error, /100,64,0 \(100 blocks away\)/);
});

test('gather near walks to the spot first and only mines blocks around it', async () => {
    const { createRequire } = await import('node:module');
    const b = bot();
    let held = [];
    const dug = [],
        walks = [];
    b.registry = createRequire(import.meta.url)('minecraft-data')('1.21.6');
    b.inventory.items = () => held;
    b.entity.position = new Vec3(0, 64, 0);
    const log = x => ({ name: 'oak_log', position: new Vec3(x, 64, 0), diggable: true, canHarvest: () => true });
    const live = new Map([
        [3, log(3)],
        [100, log(100)],
        [102, log(102)],
    ]);
    b.blockAt = p => live.get(p.x) ?? { name: 'air', position: p };
    b.pathfinder.goto = async () => {};
    b.dig = async block => {
        dug.push(block.position.x);
        live.delete(block.position.x);
        held = [{ name: 'oak_log', count: dug.length }];
    };
    const me = () => b.entity.position;
    const { run } = setup({
        bot: b,
        skills: {
            goToPosition: async (_b, x, y, z, r) => {
                walks.push([x, y, z, r]);
                b.entity.position = new Vec3(x - 3, y, z);
                return true;
            },
        },
        world: {
            getNearestBlocks: () =>
                [...live.values()].sort((p, q) => p.position.distanceTo(me()) - q.position.distanceTo(me())),
        },
        perception: { isBlockVisible: (_, x) => x.position.distanceTo(me()) < 6 },
    });
    const out = await run('gather', { block: 'oak_log', count: 5, near: { x: 101, y: 64, z: 0 } });
    assert.ok(!out.isError, out.content[0].text);
    assert.deepEqual(walks, [[101, 64, 0, 8]]);
    assert.deepEqual(
        dug.sort((p, q) => p - q),
        [100, 102],
    );
    assert.ok(live.has(3));
});

test('gather near with nothing there says so and names the spot', async () => {
    const b = bot();
    b.entity.position = new Vec3(0, 64, 0);
    const { run } = setup({
        bot: b,
        world: { getNearestBlocks: () => [{ name: 'oak_log', position: new Vec3(-30, 64, 0) }] },
        perception: { isBlockVisible: () => true },
    });
    const out = await run('gather', { block: 'oak_log', count: 1, near: { x: 10, y: 64, z: 0 } });
    assert.equal(failureCode(out), 'not_found');
    assert.match(out.details.error, /within 24 blocks of 10,64,0/);
    assert.match(out.details.error, /-30,64,0/);
    assert.equal(failureCode(await run('gather', { block: 'oak_log', count: 1, near: { x: 10, z: 0 } })), 'validation');
});

test('gather stops with missing_item when the tool cannot harvest', async () => {
    const { createRequire } = await import('node:module');
    const b = bot();
    b.registry = createRequire(import.meta.url)('minecraft-data')('1.21.6');
    b.entity.position = new Vec3(0, 64, 0);
    const stone = { name: 'stone', position: new Vec3(1, 64, 0), diggable: true, canHarvest: () => false };
    b.blockAt = () => stone;
    b.pathfinder.goto = async () => {};
    const { run } = setup({
        bot: b,
        world: { getNearestBlocks: () => [stone] },
        perception: { isBlockVisible: () => true },
    });
    const out = await run('gather', { block: 'cobblestone', count: 2 });
    assert.equal(failureCode(out), 'missing_item');
    assert.match(out.details.error, /better tool/);
});

test('craft count means items, not recipe repetitions', async () => {
    const b = bot();
    b.registry = { itemsByName: { oak_planks: { id: 7 } }, items: {} };
    b.recipesFor = () => [{ result: { id: 7, count: 4 } }];
    let crafts = 0;
    const made = [];
    b.inventory.items = () => made;
    b.craft = () => {
        crafts++;
        made.push({ name: 'oak_planks', count: 4, type: 7 });
    };
    const { run } = setup({
        bot: b,
        world: { getNearestBlocks: () => [] },
        perception: { isBlockVisible: () => false },
    });
    const out = await run('craft', { item: 'oak_planks', count: 8 });
    assert.equal(crafts, 2);
    assert.equal(out.details.result.crafted, 8);
    b.recipesFor = (_id, _m, _n, table) => (table === true ? [{ result: { id: 7, count: 1 } }] : []);
    const needTable = await run('craft', { item: 'oak_planks', count: 1 });
    assert.equal(failureCode(needTable), 'missing_support');
    assert.match(needTable.details.error, /crafting table/);
});

test('combat uses direct attack only, with LOS and ordinary reach', async () => {
    const b = bot();
    b.entities = {
        1: { id: 1, position: vector(1), visible: true },
        2: { id: 2, position: vector(2), visible: false },
    };
    const hits = [];
    b.attack = entity => {
        hits.push(entity.id);
        if (hits.length >= 2) delete b.entities[1];
    };
    b.lookAt = async () => {};
    b.pvp.attack = () => {
        throw new Error('Must not start pvp background loop');
    };
    const { run } = setup({
        bot: b,
        perception: {
            isEntityVisible: (_b, e, range) => Boolean(e?.visible && e.position.distanceTo(b.entity.position) <= range),
        },
    });
    assert.equal((await run('attack', { id: 2 })).isError, true);
    assert.equal((await run('attack', { id: 1, swings: 1 })).details.result.swings, 1);
    const fight = (await run('attack', { id: 1 })).details.result;
    assert.equal(fight.stoppedBecause, 'killed');
    assert.equal(fight.swings, 1);
    assert.deepEqual(hits, [1, 1]);
});

test('attack has no health back-off and stops when something else hits', async () => {
    const b = bot();
    b.entities = { 1: { id: 1, position: vector(1), visible: true } };
    b.attack = () => {};
    b.lookAt = async () => {};
    const controls = [];
    b.setControlState = (k, v) => controls.push(`${k}:${v}`);
    const { run } = setup({
        bot: b,
        perception: {
            isEntityVisible: (_b, e, range) => Boolean(e?.visible && e.position.distanceTo(b.entity.position) <= range),
        },
    });
    b.health = 3;
    const low = (await run('attack', { id: 1, swings: 2 })).details.result;
    assert.equal(low.stoppedBecause, 'swings');
    assert.equal(low.swings, 2);
    assert.ok(!controls.includes('back:true'));
    b.health = 20;
    const p = run('attack', { id: 1, seconds: 5 });
    await new Promise(r => setTimeout(r, 120));
    assert.equal(b.pi_attackTargetId, 1);
    b.pi_attackStop = 'hit_by_other: skeleton (id 9)';
    const other = (await p).details.result;
    assert.equal(other.stoppedBecause, 'hit_by_other: skeleton (id 9)');
    assert.equal(b.pi_attackTargetId, null);
});

test('furnace validates visible target and closes window when a transfer fails', async () => {
    const b = bot();
    let closed = 0;
    b.blockAt = () => ({ name: 'furnace', position: vector(), visible: true });
    b.inventory.items = () => [{ name: 'coal', count: 10, type: 1 }];
    b.openFurnace = async () => ({
        putFuel: async () => {
            throw new Error('transfer rejected');
        },
        close: () => {
            closed++;
        },
    });
    const { run } = setup({ bot: b, perception: { isBlockVisible: (_, b) => b.visible } });
    const response = await run('furnace', { x: 0, y: 64, z: 0, operation: 'fuel', item: 'coal', count: 1 });
    assert.equal(response.isError, true);
    assert.match(response.details.error, /transfer rejected/);
    assert.equal(closed, 1);
});

test('missing skill is explicit unavailable, never a successful no-op', async () => {
    const { run } = setup();
    assert.match(
        (await run('move', { controls: ['forward'], seconds: 1 })).details.error,
        /Capability unavailable: move/,
    );
});

async function nativeFixture() {
    const { EventEmitter } = await import('node:events');
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const { Vec3 } = require('vec3');
    const b = Object.assign(new EventEmitter(), bot());
    const packets = [];
    b._client = Object.assign(new EventEmitter(), { write: (name, data) => packets.push({ name, ...data }) });
    b.entity.position = new Vec3(0, 64, 0);
    b.registry = require('minecraft-data')('1.21.6');
    b.version = '1.21.6';
    b.supportFeature = feature => b.registry.supportFeature(feature);
    return { b, packets, require, Vec3 };
}

test('actual digging plugin: abort during raw look cannot start/finish digging or speculate block removal', async () => {
    for (const abort of [true, false]) {
        const { b, packets, require, Vec3 } = await nativeFixture();
        let releaseLook;
        let updates = 0;
        b.lookAt = () =>
            new Promise(resolve => {
                releaseLook = resolve;
            });
        b.swingArm = () => b._client.write('arm_animation', { hand: 0 });
        require('mineflayer/lib/plugins/digging.js')(b);
        b.digTime = () => 20;
        const block = { position: new Vec3(1, 64, 0) };
        b._updateBlockState = position => {
            updates++;
            b.emit(`blockUpdate:${position}`, block, { type: 0, position });
        };
        installSkillCompatibility(b);
        const runner = createActionRunner(b, { settleTimeoutMs: 200 });
        const controller = new AbortController();
        const pending = runner.run('real-dig', ({ bot: active }) => active.dig(block, true), {
            signal: controller.signal,
        });
        await new Promise(resolve => setImmediate(resolve));
        const rejected = abort ? assert.rejects(pending, /cancelled/) : null;
        if (abort) controller.abort();
        releaseLook();
        if (abort) await rejected;
        else await pending;
        await delay(40);
        assert.deepEqual(
            packets.filter(p => p.name === 'block_dig').map(p => p.status),
            abort ? [] : [0, 2],
        );
        assert.equal(updates, abort ? 0 : 1);
        assert.equal(runner.status.active, null);
        assert.equal(runner.status.blocked, false);
    }
});

test('actual genericPlace plugin: cancellation during its internal look blocks placement packet', async () => {
    for (const abort of [true, false]) {
        const { b, packets, require, Vec3 } = await nativeFixture();
        let releaseLook;
        b.lookAt = () =>
            new Promise(resolve => {
                releaseLook = resolve;
            });
        b.heldItem = { type: b.registry.itemsByName.cobblestone.id, count: 1 };
        require('mineflayer/lib/plugins/generic_place.js')(b);
        installSkillCompatibility(b);
        const runner = createActionRunner(b, { settleTimeoutMs: 200 });
        const controller = new AbortController();
        const pending = runner.run(
            'real-place',
            ({ bot: active }) => active._genericPlace({ position: new Vec3(1, 63, 0) }, new Vec3(0, 1, 0), {}),
            { signal: controller.signal },
        );
        await new Promise(resolve => setImmediate(resolve));
        const rejected = abort ? assert.rejects(pending, /cancelled/) : null;
        if (abort) controller.abort();
        releaseLook();
        if (abort) await rejected;
        else await pending;
        await delay(10);
        assert.equal(packets.filter(p => p.name === 'block_place').length, abort ? 0 : 1);
        assert.equal(runner.status.blocked, false);
    }
});

test('actual inventory plugin: deferred hotbar click abort prevents both packet and optimistic local inventory change', async () => {
    const { b, packets, require } = await nativeFixture();
    b.QUICK_BAR_START = 36;
    require('mineflayer/lib/plugins/inventory.js')(b, { hideErrors: true });
    const Item = require('prismarine-item')(b.registry);
    b.inventory.updateSlot(36, new Item(b.registry.itemsByName.stone.id, 1));
    b.lastDigTime = Date.now();
    installSkillCompatibility(b);
    const runner = createActionRunner(b, { settleTimeoutMs: 1000 });
    const controller = new AbortController();
    const pending = runner.run('real-click', ({ bot: active }) => active.clickWindow(36, 0, 0), {
        signal: controller.signal,
    });
    await delay(5);
    controller.abort();
    await assert.rejects(pending, /cancelled/);
    await delay(520);
    assert.equal(packets.filter(p => p.name === 'window_click').length, 0);
    assert.equal(b.inventory.slots[36]?.name, 'stone');
    assert.equal(b.inventory.selectedItem, null);
    await runner.run('fresh-click', ({ bot: active }) => active.clickWindow(36, 0, 0));
    assert.equal(packets.filter(p => p.name === 'window_click').length, 1);
    assert.equal(b.inventory.slots[36], null);
    assert.equal(b.inventory.selectedItem?.name, 'stone');
});

test('old action async descendants never inherit next action authority; completed tokens expire too', async () => {
    const b = installSkillCompatibility(bot());
    const packets = [];
    b._client = { write: (name, data) => packets.push({ name, ...data }) };
    const runner = createActionRunner(b);
    let late;
    let lateError;
    const deferred = new Promise(resolve => {
        late = resolve;
    });
    await runner.run('old', async () => {
        deferred.then(() => {
            try {
                b._client.write('use_item', { hand: 0 });
            } catch (error) {
                lateError = error;
            }
        });
    });
    await runner.run('new', async () => {
        late();
        await delay(5);
        b._client.write('block_place', { hand: 0 });
    });
    assert.match(lateError.message, /originating action/);
    assert.deepEqual(
        packets.map(p => p.name),
        ['block_place'],
    );
    assert.throws(() => b._client.write('window_click', {}), /originating action/);
});

test('cancelled owner keeps cleanup and transport/physics packets available, rejects other mutations', async () => {
    const b = installSkillCompatibility(bot());
    const packets = [];
    b._client = { write: (name, data) => packets.push({ name, ...data }) };
    const runner = createActionRunner(b);
    const controller = new AbortController();
    let release;
    const pending = runner.run(
        'old',
        async () => {
            await new Promise(resolve => {
                release = resolve;
            });
            for (const status of [1, 5]) b._client.write('block_dig', { status });
            for (const name of ['close_window', 'transaction', 'position', 'look', 'keep_alive', 'teleport_confirm'])
                b._client.write(name, {});
            for (const [name, data] of [
                ['block_dig', { status: 0 }],
                ['block_dig', { status: 2 }],
                ['block_dig', { status: 3 }],
                ['use_entity', {}],
                ['window_click', {}],
                ['held_item_slot', {}],
            ]) {
                assert.throws(() => b._client.write(name, data), /originating action/);
            }
        },
        { signal: controller.signal },
    );
    await delay(2);
    controller.abort();
    await assert.rejects(pending, /cancelled/);
    release();
    await delay(10);
    assert.deepEqual(
        packets.filter(p => p.name === 'block_dig').map(p => p.status),
        [1, 5],
    );
    assert.equal(packets.length, 8);
});

test('send_dm canonicalizes peer casing to registered roster name', async () => {
    const calls = [];
    const { run } = setup({
        peers: ['Peer'],
        mailbox: {
            sendDM: (...args) => {
                calls.push(args);
                return 1;
            },
        },
    });
    const response = await run('send_dm', { to: 'peer', text: 'hello' });
    assert.equal(response.details.recipient, 'Peer');
    assert.deepEqual(calls, [['Peer', 'hello', {}]]);
});

test('private coordination uses the mailbox for offline teammates and whispers only to humans', async () => {
    const b = bot();
    const privateMessages = [];
    b.players = { Human: {} };
    b.whisper = (to, text) => b.calls.push(['whisper', to, text]);
    const tools = createGameTools({
        bot: b,
        peers: ['Peer'],
        whisperPlayers: true,
        mailbox: {
            sendDM: (to, text) => {
                privateMessages.push({ to, text });
                return privateMessages.length;
            },
        },
        observe: async () => ({ state: {} }),
    });
    const send = tools.find(t => t.name === 'send_dm');
    assert.equal((await send.execute('test', { to: 'peer', text: 'Collect 16 logs' })).isError, undefined);
    assert.equal(b.calls.length, 0);
    assert.equal((await send.execute('test', { to: 'human', text: 'On my way' })).isError, undefined);
    assert.deepEqual(b.calls, [['whisper', 'Human', 'On my way']]);
    assert.deepEqual(
        privateMessages.map(m => m.to),
        ['Peer', 'Human'],
    );
});

test('actual native inventory server held-slot echo is allowed once, only in its synchronous authoritative event', async () => {
    const { b, packets, require } = await nativeFixture();
    require('mineflayer/lib/plugins/inventory.js')(b, { hideErrors: true });
    require('mineflayer/lib/plugins/simple_inventory.js')(b);
    installSkillCompatibility(b);
    const runner = createActionRunner(b);
    assert.doesNotThrow(() => b._client.emit('held_item_slot', { slot: 2 }));
    assert.equal(b.quickBarSlot, 2);
    assert.deepEqual(packets, [{ name: 'held_item_slot', slotId: 2 }]);
    assert.throws(() => b._client.write('held_item_slot', { slotId: 2 }), /originating action/);
    b._client.prependListener('held_item_slot', packet => {
        assert.throws(() => b._client.write('held_item_slot', { slotId: (packet.slot + 1) % 9 }), /originating action/);
        assert.throws(() => b._client.write('use_item', {}), /originating action/);
    });
    b._client.on('held_item_slot', packet => {
        assert.throws(() => b._client.write('held_item_slot', { slotId: packet.slot }), /originating action/);
        assert.throws(() => b._client.write('held_item_slot', { slotId: (packet.slot + 1) % 9 }), /originating action/);
    });
    b._client.emit('held_item_slot', { slot: 3 });
    assert.deepEqual(packets.slice(1), [{ name: 'held_item_slot', slotId: 3 }]);
    b._client.removeAllListeners('held_item_slot');
    b._client.emit('held_item_slot', { slot: 4 });
    assert.throws(() => b._client.write('held_item_slot', { slotId: 4 }), /originating action/);
    await runner.run('active-slot', ({ bot: active }) => active.setQuickBarSlot(5));
    assert.equal(b.quickBarSlot, 5);
});

test('incoming held-slot event cannot mint echo authority for cancelled/completed action descendants', async () => {
    const { b, packets, require } = await nativeFixture();
    require('mineflayer/lib/plugins/inventory.js')(b, { hideErrors: true });
    require('mineflayer/lib/plugins/simple_inventory.js')(b);
    installSkillCompatibility(b);
    const runner = createActionRunner(b);
    let release;
    let observed;
    const deferred = new Promise(resolve => {
        release = resolve;
    });
    await runner.run('old', () => {
        observed = deferred.then(() =>
            assert.throws(() => b._client.emit('held_item_slot', { slot: 7 }), /originating action/),
        );
    });
    await runner.run('new', async () => {
        release();
        await observed;
    });
    assert.deepEqual(
        packets.filter(p => p.name === 'held_item_slot'),
        [],
    );
    const controller = new AbortController();
    let proceed;
    const pending = runner.run(
        'cancel',
        async () => {
            await new Promise(resolve => {
                proceed = resolve;
            });
            assert.throws(() => b._client.emit('held_item_slot', { slot: 8 }), /originating action/);
        },
        { signal: controller.signal },
    );
    await delay(2);
    controller.abort();
    await assert.rejects(pending, /cancelled/);
    proceed();
    await delay(5);
    assert.equal(packets.filter(p => p.name === 'held_item_slot').length, 0);
});

test('actual Mineflayer loader: compatibility must follow asynchronous plugin injection', async () => {
    const { EventEmitter } = await import('node:events');
    const { createRequire } = await import('node:module');
    const injectLoader = createRequire(import.meta.url)('mineflayer/lib/plugin_loader.js');
    const build = early => {
        const b = new EventEmitter();
        injectLoader(b, {});
        b.loadPlugin(target => {
            target.pathfinder = { setMovements: value => value };
        });
        if (early) installSkillCompatibility(b);
        assert.equal(b.pathfinder, undefined);
        b.emit('inject_allowed');
        if (!early) installSkillCompatibility(b);
        const movements = { canDig: true, allow1by1towers: true, scafoldingBlocks: [1] };
        b.pathfinder.setMovements(movements);
        return movements;
    };
    assert.equal(build(true).allowFreeMotion, undefined, 'reproduces pre-spawn compatibility missing the late plugin');
    const fixed = build(false);
    assert.equal(typeof fixed.allowFreeMotion, 'boolean');
    assert.equal(fixed.canDig, true);
});

test('coordinate schemas stay isolated across factories; deadlines remain optional', async () => {
    for (let i = 0; i < 5; i++) {
        let inspected = 0;
        const { tools, run } = setup({
            skills: {
                inspect: (_bot, ...xyz) => {
                    inspected++;
                    return xyz;
                },
            },
        });
        const inspect = tools.find(t => t.name === 'inspect_block');
        assert.deepEqual(inspect.parameters.required, ['x', 'y', 'z']);
        assert.equal('timeout_ms' in inspect.parameters.properties, false);
        for (const tool of tools) assert.equal(tool.parameters.required.includes('timeout_ms'), false, tool.name);
        for (const tool of tools.filter(t =>
            ['break_block', 'interact_block', 'open_container', 'sleep'].includes(t.name),
        )) {
            assert.deepEqual(tool.parameters.required, ['x', 'y', 'z']);
            assert.equal(tool.parameters.properties.timeout_ms.maximum, 120000);
            assert.notEqual(tool.parameters.properties, inspect.parameters.properties);
        }
        assert.deepEqual((await run('inspect_block', { x: -3, y: 64, z: 2 })).details, [-3, 64, 2]);
        assert.equal(inspected, 1);
        assert.equal((await run('inspect_block', { x: 0, y: 320, z: 0 })).isError, true);
        assert.equal((await run('inspect_block', { x: 0, y: 64, z: 0, timeout_ms: 1000 })).isError, true);
    }
});

test('native failure codes stay out of model-visible results and preserve successes', async () => {
    const { run } = setup({ skills: { equip: async () => true } });
    const success = await run('equip', { item: 'stone' });
    assert.deepEqual(success, {
        content: [{ type: 'text', text: '{"completed":true,"result":true,"log":""}' }],
        details: { completed: true, result: true, log: '' },
    });
    const invalid = await run('equip', {});
    assert.equal(failureCode(invalid), 'validation');
    assert.deepEqual(invalid, {
        content: [{ type: 'text', text: '{"error":"arguments.item is required","cancelled":false}' }],
        details: { error: 'arguments.item is required', cancelled: false },
        isError: true,
    });
    assert.equal(JSON.stringify(invalid).includes('failureCode'), false);
});

test('actual inherited inspection visibility error is classified without changing the error', async () => {
    const { b, run } = setup({ skills: survival });
    b.blockAt = () => null;
    const failed = await run('inspect_block', { x: 1, y: 64, z: 2 });
    assert.equal(failureCode(failed), 'not_visible_or_range');
    assert.equal(failed.details.error, 'Block at 1, 64, 2 is not visible within 8 blocks. Move or look around first.');
});

test('native cancellation and action deadline remain distinct, errors are not serialized as codes', async () => {
    const controller = new AbortController();
    controller.abort('PRIVATE_ABORT_SENTINEL');
    const { run } = setup({
        skills: {
            equip: async () => {
                await delay(15);
                return true;
            },
        },
    });
    const cancelled = await run('equip', { item: 'stone' }, controller.signal);
    assert.equal(failureCode(cancelled), 'cancellation');
    const timedOut = await run('equip', { item: 'stone', timeout_ms: 2 });
    assert.equal(failureCode(timedOut), 'timeout');
    assert.equal(timedOut.details.cancelled, true);
    await delay(20);
    for (const code of ['PRIVATE_CODE_SENTINEL', 'missing_item']) {
        const f = setup({
            skills: {
                inspect: () => {
                    throw Object.assign(new Error('PRIVATE_ERROR_SENTINEL'), { code });
                },
            },
        });
        assert.equal(failureCode(await f.run('inspect_block', { x: 1, y: 64, z: 2 })), 'unknown');
    }
});

test('creative profile permits creative gamemode and inventory provisioning only', async () => {
    let slots = 0;
    const { b, run } = setup({
        skills: {
            equip: async bot => {
                await bot.creative.setInventorySlot(36, {});
                return true;
            },
        },
    });
    b.pi_game_mode = 'creative';
    b.creative = {
        setInventorySlot: async () => {
            slots++;
        },
        startFlying: () => {
            throw new Error('flew');
        },
    };
    b.game.gameMode = 'survival';
    assert.equal((await run('equip', { item: 'stone' })).isError, true);
    b.game.gameMode = 'creative';
    assert.notEqual((await run('equip', { item: 'stone' })).isError, true);
    assert.equal(slots, 1);
});

test('inherited survival helpers accept creative when the profile asks for it', async () => {
    const survival = await import('../../src/skills/survival.js');
    const bot = {
        pi_game_mode: 'creative',
        game: { gameMode: 'creative' },
        modes: { isOn: () => false },
        entity: { position: { x: 0, y: 64, z: 0 } },
        blockAt: () => null,
    };
    await assert.rejects(survival.placeAt(bot, 'stone', 1, 64, 0), /not loaded/);
    bot.pi_game_mode = undefined;
    await assert.rejects(survival.placeAt(bot, 'stone', 1, 64, 0), /requires survival mode/);
});

test('fly_to flies in creative in cooperative steps, lands on request, refuses survival', async () => {
    const calls = [];
    const { b, run } = setup({});
    b.pi_game_mode = 'creative';
    b.game.gameMode = 'creative';
    b.entity.position = new Vec3(0, 64, 0);
    b.physics = { gravity: 0.08 };
    b.creative = {
        setInventorySlot: async () => {},
        startFlying: () => {
            calls.push('start');
            b.physics.gravity = 0;
        },
        stopFlying: () => {
            calls.push('stop');
            b.physics.gravity = 0.08;
        },
    };
    const r = await run('fly_to', { x: 3, y: 68, z: -1 });
    assert.equal(r.isError, undefined, JSON.stringify(r));
    assert.deepEqual(r.details.result.position, { x: 3, y: 68, z: -1 });
    assert.equal(r.details.result.flying, true);
    assert.equal(b.physics.gravity, 0);
    await run('fly_to', { x: 1, y: 66, z: 1, land: true });
    assert.deepEqual(calls, ['start', 'start', 'stop']);
    assert.deepEqual([b.entity.position.x, b.entity.position.y, b.entity.position.z], [1, 66, 1]);
    assert.equal(b.physics.gravity, 0.08);
    b.game.gameMode = 'survival';
    assert.equal((await run('fly_to', { x: 0, y: 64, z: 0 })).isError, true);
});

test('fly_to that never converges fails or times out without poisoning the runner or disconnecting', async () => {
    const b = bot();
    const runner = createActionRunner(b, { settleTimeoutMs: 200 });
    const tools = createGameTools({
        bot: b,
        actionRunner: runner,
        observe: async () => ({ state: { visible: true }, frame: null }),
    });
    const run = (name, args) => tools.find(t => t.name === name).execute('call-id', args);
    b.pi_game_mode = 'creative';
    b.game.gameMode = 'creative';
    b.physics = { gravity: 0.08 };
    b.creative = {
        setInventorySlot: async () => {},
        startFlying: () => {
            b.physics.gravity = 0;
        },
        stopFlying: () => {
            b.physics.gravity = 0.08;
        },
    };
    const stuck = new Vec3(0, 64, 0);
    stuck.add = () => stuck;
    b.entity.position = stuck;
    const deadline = await run('fly_to', { x: 0, y: 90, z: 0, timeout_ms: 300 });
    assert.equal(deadline.isError, true);
    assert.match(deadline.details.error, /deadline exceeded/);
    assert.equal(deadline.details.cancelled, true);
    assert.equal(failureCode(deadline), 'timeout');
    assert.equal(runner.status.blocked, false);
    assert.equal(
        b.calls.some(c => c[0] === 'quit'),
        false,
    );
    assert.equal(b.physics.gravity, 0.08);
    const stalled = await run('fly_to', { x: 0, y: 90, z: 0 });
    assert.equal(stalled.isError, true);
    assert.match(stalled.details.error, /stalled 26\.0 blocks/);
    assert.equal(failureCode(stalled), 'action_failed');
    assert.equal(runner.status.blocked, false);
    assert.equal(
        b.calls.some(c => c[0] === 'quit'),
        false,
    );
    b.entity.position = new Vec3(0, 64, 0);
    const ok = await run('fly_to', { x: 0, y: 66, z: 0 });
    assert.equal(ok.isError, undefined, JSON.stringify(ok));
    assert.deepEqual(ok.details.result.position, { x: 0, y: 66, z: 0 });
});

test('window round trips that never settle (craft, open_container) time out without poisoning the runner or disconnecting', async () => {
    const b = bot();
    b.registry = { itemsByName: { stick: { id: 1 } } };
    b.recipesFor = () => [{ result: { id: 1 } }];
    b.craft = () => new Promise(() => {});
    const chest = { name: 'chest', position: vector(1) };
    b.blockAt = () => chest;
    b.openContainer = () => new Promise(() => {});
    b.closeWindow = () => b.calls.push('closeWindow');
    const runner = createActionRunner(b, { settleTimeoutMs: 200 });
    const tools = createGameTools({
        bot: b,
        actionRunner: runner,
        observe: async () => ({ state: { visible: true }, frame: null }),
        world: { getNearestBlocks: () => [] },
        perception: { isBlockVisible: () => true },
    });
    const run = (name, args) => tools.find(t => t.name === name).execute('call-id', args);
    const craft = await run('craft', { item: 'stick', count: 1, timeout_ms: 300 });
    assert.equal(craft.isError, true);
    assert.match(craft.details.error, /deadline exceeded/);
    assert.equal(craft.details.cancelled, true);
    assert.equal(failureCode(craft), 'timeout');
    assert.equal(runner.status.blocked, false);
    assert.equal(
        b.calls.some(c => c[0] === 'quit'),
        false,
    );
    const open = await run('open_container', { x: 1, y: 64, z: 1, timeout_ms: 300 });
    assert.equal(open.isError, true);
    assert.match(open.details.error, /deadline exceeded/);
    assert.equal(failureCode(open), 'timeout');
    assert.equal(runner.status.blocked, false);
    assert.equal(
        b.calls.some(c => c[0] === 'quit'),
        false,
    );
    const made = [];
    b.inventory.items = () => made;
    b.craft = async () => {
        made.push({ name: 'stick', count: 1, type: 1 });
    };
    const ok = await run('craft', { item: 'stick', count: 2 });
    assert.equal(ok.isError, undefined, JSON.stringify(ok));
    assert.equal(ok.details.result.repetitions, 2);
});

test('eat interrupted mid-consume settles on abort without poisoning the runner or disconnecting', async () => {
    const b = bot();
    let consumeCalls = 0;
    const consume = async (active, item) => {
        consumeCalls++;
        assert.equal(item, 'bread');
        await active.consume();
        return true;
    };
    b.consume = () => new Promise(() => {});
    const runner = createActionRunner(b, { settleTimeoutMs: 200 });
    const tools = createGameTools({
        bot: b,
        actionRunner: runner,
        skills: { consume },
        observe: async () => ({ state: { visible: true }, frame: null }),
        world: { getNearestBlocks: () => [] },
        perception: { isBlockVisible: () => true },
    });
    const run = (name, args, signal) => tools.find(t => t.name === name).execute('call-id', args, signal);
    const controller = new AbortController();
    const pending = run('eat', { item: 'bread' }, controller.signal);
    await delay(50);
    controller.abort();
    const eat = await pending;
    assert.equal(eat.isError, true);
    assert.equal(eat.details.cancelled, true);
    assert.equal(failureCode(eat), 'cancellation');
    assert.equal(runner.status.blocked, false);
    assert.equal(
        b.calls.some(c => c[0] === 'quit'),
        false,
    );
    assert.ok(b.calls.includes('itemStop'));
    b.consume = async () => {};
    const ok = await run('eat', { item: 'bread' });
    assert.equal(ok.isError, undefined, JSON.stringify(ok));
    assert.equal(ok.details.result, true);
    assert.equal(consumeCalls, 2);
});

test('un-awaited Mineflayer write refused after abort (openBlock -> activateBlock) is a tagged AbortError, not a poison', async () => {
    const b = installSkillCompatibility(bot());
    const packets = [];
    b._client = { write: (name, data) => packets.push({ name, ...data }) };
    const chest = { name: 'chest', position: vector(1) };
    b.blockAt = () => chest;
    b.lookAt = async () => {
        await delay(40);
    };
    let late;
    b.activateBlock = async block => {
        await b.lookAt(block.position);
        b._client.write('block_place', { location: block.position });
    };
    b.openContainer = block => {
        b.activateBlock(block).catch(error => {
            late = error;
        });
        return new Promise(() => {});
    };
    b.closeWindow = () => b.calls.push('closeWindow');
    const runner = createActionRunner(b, { settleTimeoutMs: 200 });
    const tools = createGameTools({
        bot: b,
        actionRunner: runner,
        observe: async () => ({ state: { visible: true }, frame: null }),
        world: { getNearestBlocks: () => [] },
        perception: { isBlockVisible: () => true },
    });
    const controller = new AbortController();
    const pending = tools
        .find(t => t.name === 'open_container')
        .execute('call-id', { x: 1, y: 64, z: 1 }, controller.signal);
    await delay(10);
    controller.abort();
    const open = await pending;
    assert.equal(open.isError, true);
    assert.equal(failureCode(open), 'cancellation');
    await delay(80);
    assert.equal(
        packets.some(p => p.name === 'block_place'),
        false,
        'late packet must not reach the server',
    );
    assert.equal(late?.name, 'AbortError');
    assert.equal(late?.code, LATE_MUTATION_REFUSED);
    assert.equal(runner.status.blocked, false);
    assert.equal(
        b.calls.some(c => c[0] === 'quit'),
        false,
    );
    b.openContainer = async () => ({ slots: [] });
    const ok = await tools.find(t => t.name === 'open_container').execute('call-id', { x: 1, y: 64, z: 1 });
    assert.equal(ok.isError, undefined, JSON.stringify(ok));
});

test('craft reports a failure instead of success when the server never hands over the item', async () => {
    const b = bot();
    b.registry = { itemsByName: { wooden_sword: { id: 9 } }, items: {} };
    b.recipesFor = () => [{ result: { id: 9, count: 1 } }];
    let crafts = 0;
    b.craft = () => {
        crafts++;
    };
    const { run } = setup({
        bot: b,
        world: { getNearestBlocks: () => [] },
        perception: { isBlockVisible: () => false },
    });
    const out = await run('craft', { item: 'wooden_sword', count: 1 });
    assert.equal(crafts, 2);
    assert.equal(failureCode(out), 'action_failed');
    assert.match(out.details.error, /did not hand over the wooden_sword/);
});
