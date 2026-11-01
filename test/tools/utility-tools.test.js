import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import * as perception from '../../src/skills/perception.js';
import * as survival from '../../src/skills/survival.js';
import { createGameTools, failureCode } from '../../src/tools/game-tools.js';
import minecraftData from 'minecraft-data';
const registry = minecraftData('1.21.4');
const key = p => `${p.x},${p.y},${p.z}`;

function makeWorld(extra = [], inv = {}, { furnace, chest, staleInv, bounce, players } = {}) {
    const cells = new Map();
    for (let x = -8; x <= 8; x++) for (let z = -8; z <= 8; z++) cells.set(key({ x, y: -61, z }), 'grass_block');
    for (const [x, y, z, n] of extra) cells.set(key({ x, y, z }), n);
    const block = p => {
        const n = cells.get(key(p)) ?? 'air';
        return {
            name: n,
            position: new Vec3(p.x, p.y, p.z),
            shapes: n === 'air' ? [] : [[0, 0, 0, 1, 1, 1]],
            boundingBox: n === 'air' ? 'empty' : 'block',
        };
    };
    const counts = { ...inv };
    const items = () =>
        Object.entries(counts)
            .filter(([, c]) => c > 0)
            .map(([name, count], slot) => ({ name, count, slot: 36 + slot, type: registry.itemsByName[name].id }));
    const log = [];
    let held = null;
    const b = {
        username: 'T',
        game: { gameMode: 'survival' },
        pi_game_mode: 'survival',
        version: '1.21.4',
        registry,
        entity: { id: 1, position: new Vec3(0.5, -60, 0.5), eyeHeight: 1.62, yaw: 0, pitch: 0, onGround: true },
        entities: {},
        inventory: {
            items,
            slots: new Array(46).fill(null),
            findInventoryItem: n => items().find(i => i.name === n) ?? null,
        },
        world: { getBlock: p => block(new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))) },
        pathfinder: {
            setMovements() {},
            setGoal() {},
            stop() {},
            getPathTo: () => ({ status: 'success', path: [] }),
            goto: async goal => {
                const g = goal.pos ?? goal;
                log.push(`GOTO ${g.x},${g.y},${g.z}`);
                b.entity.position = new Vec3(g.x - 1.5, g.y, g.z + 0.5);
            },
        },
        players: players ?? {},
        look: async () => {},
        toss: async (type, _m, n) => {
            const nm = registry.items[type].name;
            counts[nm] -= n;
            log.push(`TOSS ${n} ${nm}`);
            if (bounce)
                setTimeout(() => {
                    counts[nm] += bounce;
                }, 200);
        },
        clearControlStates() {},
        stopDigging() {},
        deactivateItem() {},
        setControlState() {},
        chat() {},
        equip: async it => {
            held = typeof it === 'string' ? it : it?.name;
        },
        lookAt: async () => {},
        get heldItem() {
            return held ? { type: registry.itemsByName[held]?.id, name: held } : null;
        },
        placeBlock: async (ref, face) => {
            const t = ref.position.plus(face);
            cells.set(key(t), held);
            counts[held]--;
            log.push(`PLACE ${held} ${key(t)}`);
        },
        dig: async blk => {
            const n = cells.get(key(blk.position));
            cells.delete(key(blk.position));
            log.push(`DIG ${n}`);
            counts[n] = (counts[n] ?? 0) + 1;
        },
        recipesFor: (id, _m, _n, table) => {
            const n = registry.items[id].name;
            if (n === 'crafting_table')
                return (counts.oak_planks ?? 0) >= 4 ? [{ result: { id, count: 1 }, use: { oak_planks: 4 } }] : [];
            if (n === 'furnace')
                return table && (counts.cobblestone ?? 0) >= 8
                    ? [{ result: { id, count: 1 }, use: { cobblestone: 8 } }]
                    : [];
            if (n === 'wooden_pickaxe')
                return table && (counts.oak_planks ?? 0) >= 3 && (counts.stick ?? 0) >= 2
                    ? [{ result: { id, count: 1 }, use: { oak_planks: 3, stick: 2 } }]
                    : [];
            return [];
        },
        craft: async (r, _n, table) => {
            for (const [n, c] of Object.entries(r.use)) counts[n] -= c;
            const n = registry.items[r.result.id].name;
            counts[n] = (counts[n] ?? 0) + 1;
            log.push(`CRAFT ${n} table=${Boolean(table)}`);
        },
    };
    if (furnace) {
        const f = { input: null, fuel: null, output: null };
        b.openFurnace = async () => ({
            fuel: 0,
            inputItem: () => f.input,
            fuelItem: () => f.fuel,
            outputItem: () => {
                if (f.input && f.fuel) {
                    f.output = { name: furnace, count: (f.output?.count ?? 0) + f.input.count };
                    f.input = null;
                    f.fuel.count--;
                    if (!f.fuel.count) f.fuel = null;
                }
                return f.output;
            },
            putInput: async (type, _m, n) => {
                const name = registry.items[type].name;
                counts[name] -= n;
                f.input = { name, count: n };
            },
            putFuel: async (type, _m, n) => {
                const name = registry.items[type].name;
                counts[name] -= n;
                f.fuel = { name, count: n };
            },
            takeOutput: async () => {
                const o = f.output;
                f.output = null;
                counts[o.name] = (counts[o.name] ?? 0) + o.count;
                return o;
            },
            takeInput: async () => {
                const o = f.input;
                f.input = null;
                counts[o.name] += o.count;
                return o;
            },
            takeFuel: async () => {
                const o = f.fuel;
                f.fuel = null;
                counts[o.name] += o.count;
                return o;
            },
            close: () => log.push('CLOSE furnace'),
        });
    }
    if (chest) {
        const box = { ...chest };
        const pending = [];
        const inv = fn => (staleInv ? pending.push(fn) : fn());
        b.openContainer = async () => ({
            containerItems: () =>
                Object.entries(box)
                    .filter(([, c]) => c > 0)
                    .map(([name, count]) => ({ name, count })),
            deposit: async (type, _m, n) => {
                const name = registry.items[type].name;
                inv(() => {
                    counts[name] -= n;
                });
                box[name] = (box[name] ?? 0) + n;
            },
            withdraw: async (type, _m, n) => {
                const name = registry.items[type].name;
                box[name] -= n;
                inv(() => {
                    counts[name] = (counts[name] ?? 0) + n;
                });
            },
            close: () => {
                pending.splice(0).forEach(f => f());
                log.push('CLOSE chest');
            },
        });
    }
    b.blockAt = p => block(p);
    const world = {
        getNearestBlocks: (_b, names, range) =>
            [...cells.entries()]
                .filter(([, n]) => [names].flat().includes(n))
                .map(([k]) => block(Object.fromEntries(k.split(',').map((v, i) => ['xyz'[i], Number(v)]))))
                .filter(bl => bl.position.distanceTo(b.entity.position) <= range)
                .sort((p, q) => p.position.distanceTo(b.entity.position) - q.position.distanceTo(b.entity.position)),
    };
    const tools = createGameTools({
        bot: b,
        perception,
        world,
        skills: survival,
        observe: async () => ({ state: {}, frame: null }),
    });
    return { b, cells, counts, log, run: (n, a) => tools.find(t => t.name === n).execute('id', a), tools };
}

test('craft places a table from inventory when the recipe needs one, crafts, then picks the table back up', async () => {
    const w = makeWorld([], { oak_planks: 3, stick: 2, crafting_table: 1 });
    const r = await w.run('craft', { item: 'wooden_pickaxe', count: 1 });
    assert.equal(r.isError, undefined, JSON.stringify(r.details));
    assert.equal(w.counts.wooden_pickaxe, 1);
    assert.equal(r.details.craftingTable.recovered, true);
    assert.equal(w.counts.crafting_table, 1);
    assert.ok(
        w.log.some(l => l.startsWith('PLACE crafting_table')) && w.log.includes('DIG crafting_table'),
        w.log.join('|'),
    );
    assert.ok(![...w.cells.values()].includes('crafting_table'));
});

test('craft with no table anywhere crafts one from 4 planks first; keep_table leaves it placed', async () => {
    const w = makeWorld([], { oak_planks: 7, stick: 2 });
    const r = await w.run('craft', { item: 'wooden_pickaxe', count: 1, keep_table: true });
    assert.equal(r.isError, undefined, JSON.stringify(r.details));
    assert.equal(w.counts.wooden_pickaxe, 1);
    assert.match(r.details.steps.join(' '), /crafted a crafting_table from 4 planks/);
    assert.ok(r.details.craftingTable.left);
    assert.ok([...w.cells.values()].includes('crafting_table'));
});

test('craft walks to a table within 24 blocks instead of placing one', async () => {
    const w = makeWorld([[6, -60, 6, 'crafting_table']], { oak_planks: 3, stick: 2 });
    const r = await w.run('craft', { item: 'wooden_pickaxe', count: 1 });
    assert.equal(r.isError, undefined, JSON.stringify(r.details));
    assert.match(r.details.steps[0], /walked to the crafting_table at 6,-60,6/);
    assert.ok(!w.log.some(l => l.startsWith('PLACE')));
});

test('craft without table, table item or planks fails missing_support with a next step', async () => {
    const w = makeWorld([], { oak_planks: 3, stick: 2 });
    const r = await w.run('craft', { item: 'wooden_pickaxe', count: 1 });
    assert.equal(failureCode(r), 'missing_support');
    assert.match(r.details.error, /crafting table/);
});

test('smelt loads input and fuel into a nearby furnace, waits and collects the output', async () => {
    const w = makeWorld([[2, -60, 0, 'furnace']], { cobblestone: 8, oak_planks: 10 }, { furnace: 'stone' });
    const r = await w.run('smelt', { input: 'cobblestone', count: 8 });
    assert.equal(r.isError, undefined, JSON.stringify(r.details));
    assert.deepEqual(r.details.collected, { stone: 8 });
    assert.equal(r.details.stillCooking, 0);
    assert.equal(w.counts.stone, 8);
    assert.equal(w.counts.oak_planks, 10 - Math.ceil(8 / 1.5));
    assert.ok(w.log.includes('CLOSE furnace'));
});

test('smelt prefers coal and fails cleanly with no fuel', async () => {
    const w = makeWorld([[2, -60, 0, 'furnace']], { raw_iron: 3, coal: 2, oak_planks: 5 }, { furnace: 'iron_ingot' });
    const r = await w.run('smelt', { input: 'raw_iron', count: 3 });
    assert.equal(r.isError, undefined, JSON.stringify(r.details));
    assert.equal(w.counts.coal, 1);
    assert.equal(w.counts.oak_planks, 5);
    const w2 = makeWorld([[2, -60, 0, 'furnace']], { sand: 4 }, { furnace: 'glass' });
    const r2 = await w2.run('smelt', { input: 'sand', count: 4 });
    assert.equal(failureCode(r2), 'missing_item');
    assert.match(r2.details.error, /No fuel/);
    assert.equal(w2.counts.sand, 4);
});

test('smelt with no furnace crafts one from cobblestone (placing a table), places it and smelts', async () => {
    const w = makeWorld([], { cobblestone: 12, oak_planks: 10 }, { furnace: 'stone' });
    const r = await w.run('smelt', { input: 'cobblestone', count: 4 });
    assert.equal(r.isError, undefined, JSON.stringify(r.details));
    assert.match(r.details.steps.join(' | '), /crafted a furnace \| placed a furnace/);
    assert.equal(w.counts.stone, 4);
    assert.ok([...w.cells.values()].includes('furnace'));
    assert.ok(![...w.cells.values()].includes('crafting_table'));
});

test('deposit and withdraw move items by name and report contents', async () => {
    const w = makeWorld([[2, -60, 0, 'chest']], { cobblestone: 40, oak_log: 5 }, { chest: { oak_planks: 16 } });
    const d = await w.run('deposit', { item: 'cobblestone', count: 30 });
    assert.equal(d.isError, undefined, JSON.stringify(d.details));
    assert.equal(d.details.deposited, 30);
    assert.equal(w.counts.cobblestone, 10);
    assert.deepEqual(d.details.contents, { oak_planks: 16, cobblestone: 30 });
    const all = await w.run('deposit', { item: 'oak_log' });
    assert.equal(all.details.deposited, 5);
    const wd = await w.run('withdraw', { item: 'oak_planks' });
    assert.equal(wd.details.withdrawn, 16);
    assert.equal(w.counts.oak_planks, 16);
    const miss = await w.run('withdraw', { item: 'iron_ingot' });
    assert.equal(failureCode(miss), 'not_found');
    assert.match(miss.details.error, /holds: 30 cobblestone, 5 oak_log/);
    const none = await w.run('deposit', { item: 'diamond' });
    assert.equal(failureCode(none), 'missing_item');
    assert.equal(w.log.filter(l => l === 'CLOSE chest').length, 4);
});

test('deposit with no chest around says so; explicit coords must be a chest', async () => {
    const w = makeWorld([], { cobblestone: 4 }, { chest: {} });
    assert.equal(failureCode(await w.run('deposit', { item: 'cobblestone' })), 'not_found');
    const r = await w.run('deposit', { item: 'cobblestone', x: 1, y: -61, z: 0 });
    assert.equal(failureCode(r), 'validation');
    assert.match(r.details.error, /found grass_block/);
});

test('deposit/withdraw count from the chest when inventory updates lag until the window closes', async () => {
    const w = makeWorld([[2, -60, 0, 'chest']], { cobblestone: 40 }, { chest: { oak_planks: 16 }, staleInv: true });
    const d = await w.run('deposit', { item: 'cobblestone', count: 10 });
    assert.equal(d.isError, undefined, JSON.stringify(d.details));
    assert.equal(d.details.deposited, 10);
    assert.equal(d.details.note, undefined);
    assert.equal(w.counts.cobblestone, 30);
    const wd = await w.run('withdraw', { item: 'oak_planks', count: 16 });
    assert.equal(wd.isError, undefined, JSON.stringify(wd.details));
    assert.equal(wd.details.withdrawn, 16);
    assert.equal(wd.details.note, undefined);
    assert.equal(w.counts.oak_planks, 16);
});

test('drop_item tosses, backs away, and reports items that come back', async () => {
    const w = makeWorld([], { stick: 5 });
    const r = await w.run('drop_item', { item: 'stick', count: 5 });
    assert.equal(r.isError, undefined, JSON.stringify(r.details));
    assert.equal(r.details.dropped, 5);
    assert.equal(r.details.pickedBackUp, undefined);
    assert.equal(w.counts.stick, 0);
    const w2 = makeWorld([], { stick: 5 }, { bounce: 2 });
    const r2 = await w2.run('drop_item', { item: 'stick', count: 5 });
    assert.equal(r2.details.pickedBackUp, 2);
    assert.match(r2.details.note, /landed back/);
});

test('drop_item to: unknown player fails without dropping; nearby player gets a give', async () => {
    const w = makeWorld([], { stick: 3 });
    const r = await w.run('drop_item', { item: 'stick', count: 3, to: 'Ada' });
    assert.equal(failureCode(r), 'not_found');
    assert.equal(w.counts.stick, 3);
    const ada = { username: 'Ada', entity: { position: new Vec3(1.5, -60, 0.5) } };
    const w2 = makeWorld([], { stick: 3 }, { players: { Ada: ada } });
    const r2 = await w2.run('drop_item', { item: 'stick', count: 3, to: 'ada' });
    assert.equal(r2.isError, undefined, JSON.stringify(r2.details));
    assert.equal(r2.details.dropped, 3);
    assert.match(r2.details.status, /picked up/);
    assert.ok(w2.log.includes('TOSS 3 stick'));
});
