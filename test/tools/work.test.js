import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vec3 } from 'vec3';
import { MailboxStore } from '../../src/comms/mailbox-store.js';
import { createGameTools } from '../../src/tools/game-tools.js';
import { canClearTerrain } from '../../src/tools/game/guards.js';
import { installAsciiChat } from '../../src/body/chat.js';

test('standalone verification distinguishes missing, invisible and satisfied work without task bookkeeping', async t => {
    const dir = mkdtempSync(join(tmpdir(), 'work-tools-')),
        mailbox = new MailboxStore(join(dir, 'mail.sqlite'), 'Worker');
    t.after(() => {
        mailbox.close();
        rmSync(dir, { recursive: true, force: true });
    });
    let blockName = 'air',
        visible = true,
        count = 0;
    const position = new Vec3(0, 65, 0),
        bot = {
            username: 'Worker',
            entity: { position },
            game: { gameMode: 'survival' },
            inventory: { items: () => [{ name: 'oak_log', count }], slots: [] },
            blockAt: () => ({ name: blockName, position: new Vec3(1, 65, 1) }),
            clearControlStates() {},
        };
    const tools = createGameTools({ bot, mailbox, peers: ['Peer'], perception: { isBlockVisible: () => visible } });
    const verify = async () =>
        (
            await tools
                .find(t => t.name === 'verify')
                .execute('test', {
                    checks: [
                        { kind: 'block', name: 'oak_planks', x: 1, y: 65, z: 1 },
                        { kind: 'inventory', name: 'oak_log', count: 2 },
                    ],
                })
        ).details;
    assert.equal((await verify()).passed, false);
    blockName = 'oak_planks';
    count = 2;
    visible = false;
    const hidden = await verify();
    assert.equal(hidden.passed, null);
    assert.equal(hidden.checks[0].observed, null);
    visible = true;
    assert.equal((await verify()).passed, true);
    assert.deepEqual(mailbox.work(), { goals: [], activities: [], resources: [] });
});

test('shared goals and status are optional and any teammate can update the agreed specification', async t => {
    const dir = mkdtempSync(join(tmpdir(), 'work-tools-')),
        file = join(dir, 'mail.sqlite');
    const first = new MailboxStore(file, 'First'),
        second = new MailboxStore(file, 'Second');
    t.after(() => {
        first.close();
        second.close();
        rmSync(dir, { recursive: true, force: true });
    });
    const make = (name, mailbox) => createGameTools({ bot: { username: name }, mailbox, peers: ['First', 'Second'] });
    const run = async (tools, name, args) => {
        const result = await tools.find(t => t.name === name).execute('test', args);
        assert.equal(result.isError, undefined, result.content[0].text);
        return result.details;
    };
    const tools = make('First', first),
        peerTools = make('Second', second);
    const goal = await run(tools, 'shared_goal', { title: 'Base', scope: 'x10..19,z20..29,y65' });
    await run(peerTools, 'shared_goal', { id: goal.id, scope: 'x10..19,z20..29,y65; oak walls' });
    await run(peerTools, 'work_status', { status: 'working', activity: 'Gathering wood', goalId: goal.id });
    const view = await run(tools, 'work_status', {});
    assert.match(view.goals[0].scope, /oak walls/);
    assert.equal(view.activities[0].agent, 'Second');
    assert.equal(Object.hasOwn(view, 'ready'), false);
});

test('terrain policy protects constructed and unknown materials and persistent leaves without claiming ownership', () => {
    assert.equal(canClearTerrain({ name: 'leaf_litter' }), true);
    assert.equal(canClearTerrain({ name: 'oak_leaves', getProperties: () => ({ persistent: true }) }), false);
    assert.equal(canClearTerrain({ name: 'oak_leaves', getProperties: () => ({ persistent: false }) }), true);
    for (const name of ['oak_planks', 'redstone_wire', 'modded_unknown_block'])
        assert.equal(canClearTerrain({ name }), false);
});

test('long human whispers preserve mailbox text and fit after wire normalization', async () => {
    const messages = [],
        whispers = [],
        original = 'A long report\n' + '… → café '.repeat(80);
    const bot = {
        username: 'Worker',
        entity: { position: new Vec3(0, 65, 0) },
        game: { gameMode: 'survival' },
        players: { Human: {} },
        chat: () => assert.fail('A DM must not use public chat'),
        whisper: (...args) => whispers.push(args),
    };
    installAsciiChat(bot);
    const send = createGameTools({
        bot,
        whisperPlayers: true,
        mailbox: {
            sendDM: (to, text) => {
                messages.push({ to, text });
                return 7;
            },
        },
    }).find(t => t.name === 'send_dm');
    const result = await send.execute('test', { to: 'human', text: original });
    assert.equal(result.isError, undefined);
    assert.equal(messages[0].text, original);
    assert.equal(whispers.length, 1);
    assert.equal(whispers[0][0], 'Human');
    assert.ok(whispers[0][1].length + '/tell Human '.length <= 256);
    assert.match(whispers[0][1], /full message in mailbox/);
    bot.supportFeature = () => true;
    await send.execute('test', { to: 'human', text: original });
    assert.ok(whispers[1][1].length + '/tell Human '.length <= 100);
    assert.equal(messages[1].text, original);
    assert.equal(
        (await send.execute('test', { to: 'human', text: 'duplicate task API', type: 'request' })).isError,
        true,
    );
});

test('recipe alternatives and totals come from the active registry without crafting', async () => {
    let crafted = 0;
    const bot = {
        username: 'Worker',
        registry: {
            itemsByName: { some_output: { id: 7 } },
            items: { 7: { name: 'some_output' }, 9: { name: 'some_input' } },
        },
        inventory: { items: () => [] },
        recipesAll: () => [
            {
                result: { id: 7, count: 4 },
                delta: [
                    { id: 9, count: -2 },
                    { id: 7, count: 4 },
                ],
                requiresTable: true,
            },
        ],
        craft: () => crafted++,
    };
    const tool = createGameTools({ bot }).find(t => t.name === 'recipes');
    const r = await tool.execute('test', { item: 'some_output', count: 17 });
    assert.equal(r.isError, undefined);
    assert.equal(r.details.recipes[0].repetitions, 5);
    assert.deepEqual(r.details.recipes[0].requiredTotals, [{ id: 9, name: 'some_input', count: 10 }]);
    assert.equal(crafted, 0);
});

test('recipe discovery and missing-material feedback prefer the agents actual inventory', async () => {
    const bot = {
        username: 'Worker',
        game: { gameMode: 'survival' },
        entity: { position: new Vec3(0, 65, 0) },
        inventory: {
            items: () => [
                { name: 'oak_planks', count: 2 },
                { name: 'stick', count: 4 },
            ],
            slots: [],
        },
        registry: {
            itemsByName: { wooden_pickaxe: { id: 4 } },
            items: {
                1: { name: 'cherry_planks' },
                2: { name: 'oak_planks' },
                3: { name: 'stick' },
                4: { name: 'wooden_pickaxe' },
            },
        },
        recipesFor: () => [],
        recipesAll: () =>
            [1, 2].map(id => ({
                result: { id: 4, count: 1 },
                requiresTable: true,
                delta: [
                    { id, count: -3 },
                    { id: 3, count: -2 },
                    { id: 4, count: 1 },
                ],
            })),
        clearControlStates() {},
    };
    const tools = createGameTools({ bot, world: { getNearestBlocks: () => [] } });
    const recipes = await tools.find(t => t.name === 'recipes').execute('test', { item: 'wooden_pickaxe' });
    assert.equal(recipes.details.recipes[0].ingredients[0].name, 'oak_planks');
    const craft = await tools.find(t => t.name === 'craft').execute('test', { item: 'wooden_pickaxe', count: 1 });
    assert.equal(craft.isError, true);
    assert.match(craft.details.error, /3 oak_planks \(you have 2\)/);
    assert.doesNotMatch(craft.details.error, /3 cherry_planks/);
});
