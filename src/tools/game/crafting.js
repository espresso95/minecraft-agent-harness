import { abortError, failWith, withFailureCode } from './failures.js';
import { item } from './observation.js';
import { SMELT_MS, requireFunction, settleInventory, untilAbort } from './runtime.js';
import { choice, coords, count, integer, name } from './schema.js';

function orderedRecipes(bot, recipes, count = 1) {
    const available = new Map();
    for (const i of bot.inventory.items()) available.set(i.name, (available.get(i.name) ?? 0) + i.count);
    const missing = recipe =>
        (recipe.delta ?? [])
            .filter(d => d.count < 0)
            .reduce((total, d) => {
                const have = available.get(bot.registry.items[d.id]?.name) ?? 0;
                return total + Math.max(0, -d.count * Math.ceil(count / (recipe.result?.count ?? 1)) - have);
            }, 0);
    return [...recipes].sort((a, b) => missing(a) - missing(b));
}

export function createCrafting(ctx) {
    ctx.add(
        'recipes',
        'Read actual version-specific crafting recipes without crafting. count is desired output ITEMS. Returns ingredients and required totals for each alternative, plus table requirements and byproducts. Choose based on current inventory instead of guessing material arithmetic.',
        { item: name, count: integer(1, 4096), after: integer(0, 100000) },
        a => {
            const { bot } = ctx,
                entry = bot.registry.itemsByName[a.item];
            if (!entry) throw new Error('Unknown item in this Minecraft registry');
            const choices = orderedRecipes(bot, bot.recipesAll(entry.id, null, true), a.count ?? 1),
                after = a.after ?? 0;
            const describe = d => ({
                id: d.id,
                name: bot.registry.items[d.id]?.name ?? null,
                count: Math.abs(d.count),
                ...(d.metadata != null ? { metadata: d.metadata } : {}),
            });
            const recipes = choices.slice(after, after + 20).map(r => {
                const repetitions = Math.ceil((a.count ?? 1) / r.result.count);
                const ingredients = r.delta.filter(d => d.count < 0).map(describe);
                return {
                    output: describe(r.result),
                    requiresTable: r.requiresTable,
                    repetitions,
                    ingredients,
                    requiredTotals: ingredients.map(i => ({ ...i, count: i.count * repetitions })),
                    byproducts: r.delta.filter(d => d.count > 0 && d.id !== entry.id).map(describe),
                };
            });
            return {
                item: a.item,
                recipes,
                nextAfter: after + recipes.length,
                hasMore: after + recipes.length < choices.length,
            };
        },
        { required: ['item'], idle: true },
    );
    const {
        add,
        at,
        blockAt,
        body,
        invCount,
        nearestBlock,
        pathfinderModule,
        perception,
        pickupDrops,
        placeBlock,
        reachBlock,
        sleepAbortable,
        world,
        xyz,
    } = ctx;
    async function placeBeside(active, blockName, signal) {
        const p = active.entity.position,
            fx = Math.floor(p.x),
            fy = Math.floor(p.y),
            fz = Math.floor(p.z);
        const cells = [];
        for (const dy of [0, -1, 1])
            for (let dx = -2; dx <= 2; dx++)
                for (let dz = -2; dz <= 2; dz++) {
                    if (!dx && !dz) continue;
                    const here = at(active, fx + dx, fy + dy, fz + dz),
                        below = at(active, fx + dx, fy + dy - 1, fz + dz);
                    if (!here || !['air', 'cave_air'].includes(here.name) || below?.boundingBox !== 'block') continue;
                    cells.push({
                        x: fx + dx,
                        y: fy + dy,
                        z: fz + dz,
                        d: Math.abs(dx) + Math.abs(dz) + 2 * Math.abs(dy),
                    });
                }
        cells.sort((a, b) => a.d - b.d);
        let last = null;
        for (const c of cells.slice(0, 4)) {
            if (signal?.aborted) throw signal.reason ?? abortError('Tool cancelled');
            try {
                await placeBlock(active, { block: blockName, x: c.x, y: c.y, z: c.z }, signal);
                if (at(active, c.x, c.y, c.z)?.name === blockName) return { x: c.x, y: c.y, z: c.z };
            } catch (error) {
                if (signal?.aborted || error?.name === 'AbortError') throw error;
                last = error;
            }
        }
        throw failWith(
            'no_support',
            `Could not place a ${blockName} next to you: ${cells.length ? String(last?.message ?? 'placement not confirmed').slice(0, 140) : 'no free floor cell within 2 blocks'}. Stand on open, flat ground and try again.`,
            {},
        );
    }
    async function pickUpBlock(active, cell, blockName, signal) {
        const b = at(active, cell.x, cell.y, cell.z);
        if (b?.name !== blockName) return { recovered: false, at: cell, reason: `now ${b?.name ?? 'unloaded'}` };
        const before = invCount(active, blockName);
        const tool = active.pathfinder?.bestHarvestTool?.(b);
        if (tool) await active.equip(tool, 'hand');
        if (b.canHarvest && !b.canHarvest(active.heldItem ? active.heldItem.type : null))
            return {
                recovered: false,
                at: cell,
                reason: `left in place: ${blockName} only drops when mined with a pickaxe`,
            };
        await untilAbort(active.dig(b, true), signal);
        const { goals } = await pathfinderModule();
        await pickupDrops(active, b.position, goals, signal);
        await settleInventory(active);
        return { recovered: invCount(active, blockName) > before, at: cell };
    }
    async function craftItems(active, itemName, want, signal, { keepTable = false } = {}) {
        const id = active.registry?.itemsByName[itemName]?.id;
        if (id === undefined) throw withFailureCode(new Error(`Unknown item ${itemName}.`), 'validation');
        const visible = b => requireFunction(perception, 'isBlockVisible')(active, b, 4);
        let table = requireFunction(world, 'getNearestBlocks')(active, 'crafting_table', 4, 8).find(visible) ?? null;
        let placedTable = null;
        const steps = [];
        const tableOnly = () =>
            !table && !active.recipesFor(id, null, 1, null).length && active.recipesFor(id, null, 1, true).length > 0;
        if (tableOnly()) {
            const far = nearestBlock(active, 'crafting_table', 24);
            if (far) {
                table = await reachBlock(active, far, signal);
                steps.push(`walked to the crafting_table at ${far.position.x},${far.position.y},${far.position.z}`);
            } else {
                if (!invCount(active, 'crafting_table')) {
                    const tableId = active.registry.itemsByName.crafting_table?.id;
                    const r = tableId === undefined ? null : active.recipesFor(tableId, null, 1, null)[0];
                    if (!r)
                        throw failWith(
                            'missing_support',
                            `${itemName} needs a crafting table: none within 24 blocks, none in your inventory, and not 4 planks of one kind to make one.`,
                            { next: 'gather logs, craft 4 planks, then craft again' },
                        );
                    await untilAbort(active.craft(r, 1, null), signal);
                    steps.push('crafted a crafting_table from 4 planks');
                }
                placedTable = await placeBeside(active, 'crafting_table', signal);
                table = at(active, placedTable.x, placedTable.y, placedTable.z);
                steps.push(`placed a crafting_table at ${placedTable.x},${placedTable.y},${placedTable.z}`);
            }
        }
        const recover = async () =>
            placedTable && !keepTable && !signal?.aborted
                ? pickUpBlock(active, placedTable, 'crafting_table', signal).catch(e => ({
                      recovered: false,
                      at: placedTable,
                      reason: String(e?.message ?? e).slice(0, 100),
                  }))
                : null;
        let crafted = 0,
            repetitions = 0;
        try {
            while (crafted < want) {
                const recipes = active.recipesFor(id, null, 1, table ?? null);
                if (!recipes.length) {
                    let needs = '';
                    try {
                        const r = orderedRecipes(active, active.recipesAll?.(id, null, true) ?? [], want - crafted)[0];
                        const parts = (r?.delta ?? [])
                            .filter(d => d.count < 0)
                            .map(d => {
                                const n = active.registry.items?.[d.id]?.name ?? 'item';
                                const have = active.inventory
                                    .items()
                                    .filter(i => i.name === n)
                                    .reduce((s, i) => s + i.count, 0);
                                return `${-d.count} ${n} (you have ${have})`;
                            });
                        if (parts.length)
                            needs = ` The closest recipe for your inventory takes ${parts.join(', ')} and gives ${r.result?.count ?? 1}. Other alternatives may use different materials; inspect recipes.`;
                    } catch {}
                    const why = `Not enough ingredients for ${itemName}.${needs}`;
                    if (crafted) {
                        active.output += `Stopped: ${why}\n`;
                        break;
                    }
                    throw withFailureCode(new Error(why), 'missing_item');
                }
                const have = invCount(active, itemName);
                await untilAbort(active.craft(recipes[0], 1, table ?? null), signal);
                await settleInventory(active);
                if (invCount(active, itemName) <= have && !signal?.aborted) {
                    await new Promise(r => setTimeout(r, 400));
                    await untilAbort(active.craft(recipes[0], 1, table ?? null), signal);
                    await settleInventory(active);
                }
                if (signal?.aborted) throw signal.reason ?? abortError('Tool cancelled');
                const made = invCount(active, itemName) - have;
                if (made <= 0)
                    throw failWith(
                        'action_failed',
                        `The server did not hand over the ${itemName} (the crafting window got out of sync with the server). Nothing was used up; the materials are still in your inventory. Crafted ${crafted} so far.`,
                        { crafted },
                    );
                repetitions++;
                crafted += made;
                active.output += `Crafted ${itemName} (${crafted}/${want}).\n`;
            }
        } catch (error) {
            await recover();
            throw error;
        }
        const tableResult = placedTable ? (keepTable ? { left: placedTable } : await recover()) : null;
        return {
            item: itemName,
            requested: want,
            crafted,
            repetitions,
            ...(steps.length ? { steps } : {}),
            ...(tableResult ? { craftingTable: tableResult } : {}),
        };
    }
    add(
        'craft',
        'Craft count ITEMS of a named item (count = how many items you want; e.g. oak_planks count 8 = 2 crafts from 2 logs, stick count 4 = 1 craft). If the recipe needs a crafting table and none is in reach, it walks to one within 24 blocks; otherwise it places one from your inventory (crafting one from 4 planks first if needed), crafts, and picks the table back up (keep_table: true leaves it placed). Does not auto-equip.',
        { item: name, count, keep_table: { type: 'boolean' } },
        (a, { bot: active, signal }) =>
            craftItems(active, a.item, a.count, signal, { keepTable: a.keep_table === true }),
        { ...body, required: ['item', 'count'], complete: value => value.crafted >= value.requested },
    );
    add(
        'furnace',
        'Low-level furnace slot control (prefer smelt, which does the whole job). Operate a visible furnace in reach. Explicitly insert input/fuel or take output/input/fuel; no waiting, automatic refueling or block placement.',
        {
            ...coords,
            operation: choice(['input', 'fuel', 'take_output', 'take_input', 'take_fuel']),
            item: name,
            count,
        },
        async (a, { bot: active, signal }) => {
            const block = blockAt(active, a);
            if (!['furnace', 'blast_furnace', 'smoker'].includes(block.name))
                throw new Error('Target is not a furnace.');
            const furnace = await untilAbort(active.openFurnace(block), signal);
            try {
                if (a.operation === 'input' || a.operation === 'fuel') {
                    if (!a.item || !a.count) throw new Error('item and count are required for input/fuel.');
                    const held = active.inventory.items().find(i => i.name === a.item);
                    if (!held || held.count < a.count)
                        throw withFailureCode(new Error('Not enough of the specified inventory item.'), 'missing_item');
                    await furnace[a.operation === 'input' ? 'putInput' : 'putFuel'](held.type, null, a.count);
                    return { inserted: a.count, item: a.item };
                }
                const method = { take_output: 'takeOutput', take_input: 'takeInput', take_fuel: 'takeFuel' }[
                    a.operation
                ];
                return { taken: item(await furnace[method]()) };
            } finally {
                furnace.close();
            }
        },
        { ...body, required: ['x', 'y', 'z', 'operation'] },
    );
    const FUEL_PER_ITEM = { coal: 8, charcoal: 8, coal_block: 80, blaze_rod: 12, dried_kelp_block: 20, stick: 0.5 };
    const fuelValue = n =>
        FUEL_PER_ITEM[n] ?? (/_(planks|log|wood|stem|hyphae)$/.test(n) ? 1.5 : /_slab$/.test(n) ? 0.75 : null);
    const FUEL_ORDER = ['coal', 'charcoal', 'coal_block'];
    add(
        'smelt',
        'Smelt count of an INPUT item in a furnace, in one call: e.g. cobblestone -> stone, stone -> smooth_stone, raw_iron -> iron_ingot, sand -> glass, oak_log -> charcoal. Uses a furnace within 24 blocks (walks to it), or places one from your inventory (crafting one from 8 cobblestone first if needed; the furnace stays placed). Loads input and enough fuel (coal/charcoal preferred, else planks/logs; or give fuel), waits and collects the output. Each item takes ~10 s of game time, longer if the server is slowed: if time runs out the rest keeps cooking and the result says what to call next.',
        { input: name, count, fuel: name },
        async (a, { bot: active, signal, deadline }) => {
            if (a.fuel && fuelValue(a.fuel) === null)
                throw failWith(
                    'validation',
                    `${a.fuel} is not a fuel this tool knows (use coal, charcoal, planks, logs or sticks).`,
                    {},
                );
            const steps = [];
            let block = nearestBlock(active, ['furnace'], 24),
                placedFurnace = null;
            if (block) block = await reachBlock(active, block, signal);
            else {
                if (!invCount(active, 'furnace')) {
                    await craftItems(active, 'furnace', 1, signal);
                    steps.push('crafted a furnace');
                }
                placedFurnace = await placeBeside(active, 'furnace', signal);
                block = at(active, placedFurnace.x, placedFurnace.y, placedFurnace.z);
                steps.push(`placed a furnace at ${placedFurnace.x},${placedFurnace.y},${placedFurnace.z}`);
            }
            const where = xyz(block);
            const furnace = await untilAbort(active.openFurnace(block), signal);
            const collected = {};
            const takeOut = async () => {
                const o = furnace.outputItem();
                if (!o) return;
                const t = await untilAbort(furnace.takeOutput(), signal);
                collected[o.name] = (collected[o.name] ?? 0) + (t?.count ?? o.count);
            };
            try {
                await takeOut();
                const inSlot = furnace.inputItem();
                if (inSlot && inSlot.name !== a.input) {
                    await untilAbort(furnace.takeInput(), signal);
                    steps.push(`took back ${inSlot.count} ${inSlot.name} from the input slot`);
                }
                const already = inSlot?.name === a.input ? inSlot.count : 0;
                const toAdd = Math.max(0, a.count - already);
                if (toAdd && invCount(active, a.input) < toAdd) {
                    throw failWith(
                        'missing_item',
                        `You have ${invCount(active, a.input)} ${a.input}; ${toAdd} needed.`,
                        { next: `gather or craft more ${a.input}, or smelt a smaller count` },
                    );
                }
                let fuelSlot = furnace.fuelItem();
                if (fuelSlot && a.fuel && fuelSlot.name !== a.fuel) {
                    await untilAbort(furnace.takeFuel(), signal);
                    fuelSlot = null;
                }
                const fuelName =
                    a.fuel ??
                    fuelSlot?.name ??
                    FUEL_ORDER.find(n => invCount(active, n)) ??
                    active.inventory
                        .items()
                        .map(i => i.name)
                        .find(n => fuelValue(n) !== null && n !== a.input);
                const total = already + toAdd;
                const burning = (furnace.fuel ?? 0) > 0 ? 1 : 0;
                const per = fuelName ? fuelValue(fuelName) : null;
                const needFuel = per ? Math.max(0, Math.ceil(total / per) - (fuelSlot?.count ?? 0) - burning) : 0;
                if (total && !per && !fuelSlot && !burning)
                    throw failWith('missing_item', 'No fuel: you have no coal, charcoal, planks, logs or sticks.', {
                        next: 'gather oak_log (or coal_ore) and smelt again',
                    });
                const fuelAdd = Math.min(
                    needFuel,
                    fuelName ? invCount(active, fuelName) - (fuelName === a.input ? toAdd : 0) : 0,
                );
                if (toAdd)
                    await untilAbort(furnace.putInput(active.registry.itemsByName[a.input].id, null, toAdd), signal);
                if (fuelAdd > 0)
                    await untilAbort(furnace.putFuel(active.registry.itemsByName[fuelName].id, null, fuelAdd), signal);
                if (toAdd) steps.push(`loaded ${toAdd} ${a.input}`);
                if (fuelAdd > 0) steps.push(`added ${fuelAdd} ${fuelName} as fuel`);
                const end = (Number.isFinite(deadline) ? deadline : Date.now() + SMELT_MS) - 4000;
                let stop = null;
                while (Date.now() < end) {
                    await sleepAbortable(1000, signal);
                    await takeOut();
                    if (!furnace.inputItem() && !furnace.outputItem()) break;
                    if (furnace.inputItem() && !furnace.fuelItem() && !((furnace.fuel ?? 0) > 0)) {
                        stop = 'out_of_fuel';
                        break;
                    }
                }
                const left = furnace.inputItem()?.name === a.input ? furnace.inputItem().count : 0;
                return {
                    input: a.input,
                    collected,
                    stillCooking: left,
                    furnace: where,
                    steps,
                    ...(stop
                        ? {
                              stopped: stop,
                              next: `add fuel: smelt(input: ${a.input}, count: ${left}, fuel: <coal/planks/log>)`,
                          }
                        : left
                          ? {
                                next: `smelt(input: ${a.input}, count: ${left}) later collects the rest (it keeps cooking; it will not add more input)`,
                            }
                          : {}),
                };
            } finally {
                try {
                    furnace.close();
                } catch {}
            }
        },
        { ...body, required: ['input', 'count'] },
    );
}
