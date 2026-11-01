import { failWith } from './failures.js';
import { untilAbort } from './runtime.js';
import { coords, integer, name } from './schema.js';

export function createContainers(ctx) {
    const { add, at, blockAt, body, call, invCount, nearestBlock, reachBlock, xyz } = ctx;
    add(
        'view_window',
        'Read your open container window or inventory slots.',
        {},
        call('viewWindow', () => []),
    );
    add(
        'click_slot',
        'Ordinary left/right click in your current window, using a slot from view_window.',
        { slot: integer(0, 255), button: integer(0, 1) },
        call('clickSlot', a => [a.slot, a.button]),
        body,
    );
    add(
        'close_window',
        'Close the current container window.',
        {},
        call('closeWindow', () => []),
        body,
    );
    add(
        'open_container',
        'Open a visible chest/barrel/shulker in reach; inspect contents with view_window. To move items by name use deposit/withdraw instead.',
        coords,
        async (a, { bot: active, signal }) => {
            await untilAbort(active.openContainer(blockAt(active, a)), signal);
            return { opened: true };
        },
        body,
    );
    const STORES = ['chest', 'trapped_chest', 'barrel'];
    const contentsOf = items => items.reduce((m, i) => ({ ...m, [i.name]: (m[i.name] ?? 0) + i.count }), {});
    function observed(active, chest, contents) {
        ctx.mailbox?.observeContainer?.({ dimension: active.game?.dimension ?? 'overworld', chest, contents });
        return contents;
    }
    async function openStore(active, a, signal) {
        let block;
        if ([a.x, a.y, a.z].every(Number.isFinite)) {
            block = at(active, a.x, a.y, a.z);
            if (!block || !STORES.includes(block.name))
                throw failWith(
                    'validation',
                    `No chest or barrel at ${a.x},${a.y},${a.z} (found ${block?.name ?? 'unloaded'}).`,
                    {},
                );
        } else {
            block = nearestBlock(active, STORES, 24);
            if (!block)
                throw failWith(
                    'not_found',
                    'No chest or barrel within 24 blocks. Give x,y,z, or craft a chest (8 planks at a crafting table) and place it.',
                    {},
                );
        }
        block = await reachBlock(active, block, signal);
        return { window: await untilAbort(active.openContainer(block), signal), where: xyz(block) };
    }
    const optionalAt = { x: coords.x, y: coords.y, z: coords.z };
    async function inspectStore(active, args, signal) {
        const { window, where } = await openStore(active, args, signal);
        try {
            return { chest: where, contents: observed(active, where, contentsOf(window.containerItems())) };
        } finally {
            try {
                window.close();
            } catch {}
        }
    }
    add(
        'inspect_container',
        'Inspect the fresh contents of a chest or barrel through ordinary movement and reach. Returns its coordinates and item counts, then closes it.',
        coords,
        (args, { bot: active, signal }) => inspectStore(active, args, signal),
        body,
    );
    add(
        'deposit',
        'Put items into a chest or barrel by name. Uses the given x,y,z, or the nearest chest/barrel within 24 blocks (walks to it). count omitted = all you carry. Returns what went in and the chest contents. Good for a shared stockpile.',
        { item: name, count: integer(1, 2304), ...optionalAt },
        async (a, { bot: active, signal }) => {
            const id = active.registry?.itemsByName[a.item]?.id;
            if (id === undefined) throw failWith('validation', `Unknown item ${a.item}.`, {});
            const have = invCount(active, a.item);
            if (!have) throw failWith('missing_item', `You carry no ${a.item}.`, {});
            const want = Math.min(a.count ?? have, have);
            const { window, where } = await openStore(active, a, signal);
            try {
                const inBox = () => contentsOf(window.containerItems())[a.item] ?? 0;
                const boxBefore = inBox();
                let full = null;
                try {
                    await untilAbort(window.deposit(id, null, want), signal);
                } catch (error) {
                    if (signal?.aborted || error?.name === 'AbortError') throw error;
                    full = String(error?.message ?? error).slice(0, 80);
                }
                const moved = Math.max(inBox() - boxBefore, have - invCount(active, a.item));
                if (!moved && full)
                    throw failWith(
                        'action_failed',
                        `Could not deposit ${a.item}: ${full}. The chest is probably full.`,
                        { chest: where, contents: observed(active, where, contentsOf(window.containerItems())) },
                    );
                return {
                    deposited: moved,
                    item: a.item,
                    chest: where,
                    ...(moved < want ? { note: `only ${moved} of ${want} fit (${full ?? 'chest full'})` } : {}),
                    contents: observed(active, where, contentsOf(window.containerItems())),
                };
            } finally {
                try {
                    window.close();
                } catch {}
            }
        },
        { ...body, required: ['item'] },
    );
    add(
        'withdraw',
        'Take items out of a chest or barrel by name. Uses the given x,y,z, or the nearest chest/barrel within 24 blocks (walks to it). count omitted = all of that item in the chest. Returns what you got and what is left.',
        { item: name, count: integer(1, 2304), ...optionalAt },
        async (a, { bot: active, signal }) => {
            const id = active.registry?.itemsByName[a.item]?.id;
            if (id === undefined) throw failWith('validation', `Unknown item ${a.item}.`, {});
            const { window, where } = await openStore(active, a, signal);
            try {
                const contents = contentsOf(window.containerItems());
                const available = contents[a.item] ?? 0;
                if (!available)
                    throw failWith(
                        'not_found',
                        `No ${a.item} in the chest at ${where.x},${where.y},${where.z}. It holds: ${
                            Object.entries(contents)
                                .map(([n, c]) => `${c} ${n}`)
                                .join(', ') || 'nothing'
                        }.`,
                        { chest: where, contents },
                    );
                const want = Math.min(a.count ?? available, available);
                const before = invCount(active, a.item);
                let full = null;
                try {
                    await untilAbort(window.withdraw(id, null, want), signal);
                } catch (error) {
                    if (signal?.aborted || error?.name === 'AbortError') throw error;
                    full = String(error?.message ?? error).slice(0, 80);
                }
                const after = observed(active, where, contentsOf(window.containerItems()));
                const left = after[a.item] ?? 0;
                const got = Math.max(available - left, invCount(active, a.item) - before);
                const freeSlots =
                    typeof active.inventory?.emptySlotCount === 'function' ? active.inventory.emptySlotCount() : null;
                const why =
                    left === 0 && got < available
                        ? `the chest ran out of ${a.item}; someone else probably took it`
                        : freeSlots === 0
                          ? 'your inventory is full'
                          : (full ?? 'unknown reason');
                if (!got && (full || left === 0))
                    throw failWith('action_failed', `Could not withdraw ${a.item}: ${why}.`, {
                        chest: where,
                        contents: after,
                        freeSlots,
                    });
                return {
                    withdrawn: got,
                    item: a.item,
                    chest: where,
                    ...(got < want ? { note: `only ${got} of ${want} (${why})` } : {}),
                    contents: after,
                };
            } finally {
                try {
                    window.close();
                } catch {}
            }
        },
        { ...body, required: ['item'] },
    );
    return { inspectStore };
}
