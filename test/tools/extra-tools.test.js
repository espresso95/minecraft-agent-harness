import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createGameTools } from '../../src/tools/game-tools.js';
import { loadToolsModule, schema } from '../../src/tools/extra-tools.js';
import { resolveConfig, toAgentOptions } from '../../src/config.js';

function fakeBot() {
    const position = { x: 0, y: 64, z: 0, offset: () => position, distanceTo: () => 0 };
    return {
        username: 'Test',
        game: { gameMode: 'survival' },
        entity: { id: 0, position, yaw: 0, pitch: 0 },
        entities: {},
        inventory: { items: () => [], slots: new Array(46).fill(null) },
        pathfinder: { setMovements: () => {}, setGoal: () => {}, stop: () => {} },
        clearControlStates: () => {},
        pi_no_flight: true,
    };
}

test('extra tools are validated, appended after the built-in tools and run with the bot', async () => {
    const calls = [];
    const tools = createGameTools({
        bot: fakeBot(),
        observe: async () => ({ state: {} }),
        extraTools: [
            {
                name: 'buy',
                description: 'Buy things',
                properties: { item: schema.choice(['wool']), quantity: schema.integer(1, 8) },
                required: ['item'],
                run: (args, { bot }) => {
                    calls.push([args, bot.username]);
                    return { bought: args.item };
                },
            },
        ],
    });
    assert.equal(tools.at(-1).name, 'buy');
    assert.equal(tools.at(-1).idle, false);
    const ok = await tools.at(-1).execute('id', { item: 'wool' });
    assert.deepEqual(ok.details, { bought: 'wool', outcome: 'success' });
    assert.deepEqual(calls, [[{ item: 'wool' }, 'Test']]);
    const bad = await tools.at(-1).execute('id', { item: 'diamonds' });
    assert.equal(bad.isError, true);
    assert.throws(
        () => createGameTools({ bot: fakeBot(), extraTools: [{ name: 'go_to', run: () => 1 }] }),
        /clashes with a built-in tool/,
    );
    assert.throws(
        () => createGameTools({ bot: fakeBot(), extraTools: [{ name: 'Bad Name', run: () => 1 }] }),
        /snake_case/,
    );
});

test('extension status tools can declare idle behavior without changing the scheduler', () => {
    const tools = createGameTools({
        bot: fakeBot(),
        observe: async () => ({ state: {} }),
        extraTools: [{ name: 'crew_status', idle: true, properties: {}, run: () => ({ ready: true }) }],
    });
    assert.equal(tools.at(-1).name, 'crew_status');
    assert.equal(tools.at(-1).idle, true);
});

test('a tools module is loaded from the configured path with the bot, options and schema helpers', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tools-module-'));
    const file = path.join(dir, 'tools.mjs');
    writeFileSync(
        file,
        "export default ({ bot, options, schema }) => [{ name: 'hello', description: options.greeting, properties: { who: schema.text(16) }, run: a => `${options.greeting} ${a.who} from ${bot.username}` }];\n",
    );
    const config = resolveConfig(
        [{ objective: 'x', toolsModule: file, toolOptions: { greeting: 'hi' }, sandbox: 'none' }],
        {
            cwd: dir,
        },
    );
    const options = toAgentOptions(config);
    assert.equal(options.toolsModule, file);
    const specs = await loadToolsModule(options.toolsModule, {
        bot: { username: 'Ada' },
        options: options.toolOptions,
    });
    assert.equal(specs[0].name, 'hello');
    assert.equal(await specs[0].run({ who: 'Bram' }), 'hi Bram from Ada');
    writeFileSync(path.join(dir, 'bad.mjs'), 'export const nothing = 1;\n');
    await assert.rejects(loadToolsModule(path.join(dir, 'bad.mjs'), {}), /must export a default function/);
});

test('the Bed Wars example tools describe the shop and talk to the referee', async () => {
    const { default: create } = await import('../../examples/bedwars/tools.mjs');
    const specs = create({ bot: { username: 'Red1' }, schema, options: { referee: 'http://127.0.0.1:1' } });
    assert.deepEqual(
        specs.map(s => s.name),
        ['buy', 'bedwars_status'],
    );
    assert.match(specs[0].description, /wool=4 iron_ingot/);
    assert.ok(specs[0].properties.item.enum.includes('sharpness'));
    await assert.rejects(specs[0].run({ item: 'wool' }));
});
