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

test('native completion checks observe the world and inventory; failed or invisible checks keep work open', async t => {
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
    const call = async (name, args) => {
        const r = await tools.find(t => t.name === name).execute('test', args);
        assert.equal(r.isError, undefined, r.content[0].text);
        return r.details;
    };
    const plan = await call('work_plan', {
        title: 'A human project',
        tasks: [
            {
                key: 'place_and_keep',
                title: 'Place a block and keep resources',
                checks: [
                    { kind: 'block', name: 'oak_planks', x: 1, y: 65, z: 1 },
                    { kind: 'inventory', name: 'oak_log', count: 2 },
                ],
            },
        ],
    });
    let task = plan.tasks[0];
    task = await call('work_claim', { taskId: task.id, revision: task.revision });
    const attempt = () =>
        call('work_update', {
            taskId: task.id,
            revision: task.revision,
            state: 'completed',
            note: 'Checked the result',
            timeout_ms: 120000,
        });
    assert.equal((await attempt()).completed, false);
    blockName = 'oak_planks';
    count = 2;
    visible = false;
    const hidden = await attempt();
    assert.equal(hidden.completed, false);
    assert.equal(hidden.verification.checks[0].observed, null);
    visible = true;
    const revisedCheck = await call('work_update', {
        taskId: task.id,
        revision: task.revision,
        state: 'completed',
        note: 'Check the submitted definition',
        checks: [{ kind: 'inventory', name: 'oak_log', count: 3 }],
    });
    assert.equal(revisedCheck.completed, false);
    const done = await attempt();
    assert.equal(done.state, 'completed');
    assert.equal(done.verification.passed, true);
    assert.equal((await attempt()).revision, done.revision);
});

test('task details inherit the current project specification without copying it into task state', async t => {
    const dir = mkdtempSync(join(tmpdir(), 'project-scope-'));
    const mailbox = new MailboxStore(join(dir, 'mail.sqlite'), 'Worker');
    t.after(() => {
        mailbox.close();
        rmSync(dir, { recursive: true, force: true });
    });
    const tools = createGameTools({ bot: { username: 'Worker' }, mailbox });
    const run = async (name, args) => (await tools.find(t => t.name === name).execute('test', args)).details;
    const plan = await run('work_plan', {
        title: 'Base',
        scope: 'Floor y65; bounds chosen by the team',
        tasks: [{ key: 'wall', title: 'West wall', claim: true }],
    });
    assert.equal(plan.tasks[0].project.scope, plan.goal.scope);
    await run('work_update', {
        taskId: plan.goal.id,
        revision: plan.goal.revision,
        state: 'revised',
        note: 'Surveyed a stepped site',
        scope: 'Stepped floor y65 and y68 with connecting stairs',
    });
    const task = (await run('work_tasks', { id: plan.tasks[0].id })).tasks[0];
    assert.match(task.project.scope, /Stepped floor/);
    assert.notEqual(task.project.revision, plan.goal.revision);
    assert.equal(mailbox.tasks().find(t => t.id === task.id).project, undefined);
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

test('planning and receipts avoid echoing large task definitions; exact details remain available on demand', async t => {
    const dir = mkdtempSync(join(tmpdir(), 'work-payload-')),
        mailbox = new MailboxStore(join(dir, 'mail.sqlite'), 'Worker');
    t.after(() => {
        mailbox.close();
        rmSync(dir, { recursive: true, force: true });
    });
    const bot = { username: 'Worker' },
        tools = createGameTools({ bot, mailbox, peers: [] });
    const call = async (name, args) => {
        const r = await tools.find(t => t.name === name).execute('test', args);
        assert.equal(r.isError, undefined, r.content[0].text);
        return r.details;
    };
    const tasks = Array.from({ length: 8 }, (_, i) => ({
        key: 'step' + i,
        title: 'Meaningful task ' + i,
        scope: 'An important constraint. '.repeat(70),
        checks: [{ kind: 'inventory', name: 'oak_log', count: i + 1 }],
    }));
    const plan = await call('work_plan', { title: 'Project', tasks });
    const list = await call('work_tasks', { goalId: plan.goal.id });
    assert.ok(JSON.stringify(list).length < JSON.stringify(tasks).length / 2);
    const detail = await call('work_tasks', { id: plan.tasks[0].id });
    assert.equal(detail.tasks[0].scope, tasks[0].scope);
    assert.deepEqual(detail.tasks[0].checks, tasks[0].checks);
    const claimed = await call('work_claim', { taskId: plan.tasks[0].id, revision: plan.tasks[0].revision });
    assert.equal(claimed.state, 'working');
    assert.equal(claimed.scope, tasks[0].scope);
    const receipt = await call('work_update', {
        taskId: claimed.id,
        revision: claimed.revision,
        state: 'checkpoint',
        note: 'Verified partial progress',
        checkpoint: 'Verified partial progress',
    });
    assert.equal(receipt.state, 'working');
    assert.equal('scope' in receipt, false);
});
