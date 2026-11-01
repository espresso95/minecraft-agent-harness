import { abortError, failWith } from './failures.js';
import { tossPitchFor } from './guards.js';
import { inventory } from './observation.js';
import { requireFunction, untilAbort } from './runtime.js';
import { coords, count, integer, name, number } from './schema.js';

export function createItems(ctx) {
    const {
        add,
        blockAt,
        body,
        bot,
        call,
        invCount,
        leaveBed,
        pathfinderModule,
        progressWatch,
        skills,
        stallWatch,
        sleepAbortable,
        withDeadline,
    } = ctx;
    add('inventory', 'Inspect your own inventory and equipped items.', {}, () => inventory(bot), { idle: true });
    add(
        'interact_block',
        'Use a visible block within ordinary reach, such as a lever, button or workbench (for doors and gates prefer door / go_through_door, which know whether it is open).',
        coords,
        call('interact', a => [a.x, a.y, a.z]),
        body,
    );
    add(
        'interact_entity',
        'Right-click a visible entity within ordinary reach.',
        { id: integer(0, Number.MAX_SAFE_INTEGER) },
        call('interactEntity', a => [a.id]),
        body,
    );
    add(
        'equip',
        'Equip an item you possess (hand empties your hand). No automatic armor management.',
        { item: name },
        call('equip', a => [a.item]),
        body,
    );
    add(
        'eat',
        'Eat or drink one named inventory item.',
        { item: name },
        (a, { bot: active, signal }) => untilAbort(requireFunction(skills, 'consume')(active, a.item), signal),
        body,
    );
    add(
        'use_item',
        'Hold and release the selected item for a finite duration.',
        { seconds: number(0.05, 5) },
        call('useItem', a => [a.seconds]),
        body,
    );
    add(
        'select_hotbar',
        'Select one of your nine hotbar slots.',
        { slot: integer(0, 8) },
        call('selectHotbar', a => [a.slot]),
        body,
    );
    add(
        'drop_item',
        'Drop items. Without `to`: tosses them a little in front of you and steps back so you do not pick them straight up again. With `to` (another agent or player name): walks next to them, tosses the items at them, and reports whether the items were picked up. Items can be picked up by anyone standing nearby.',
        { item: name, count, to: { type: 'string', minLength: 1, maxLength: 32 } },
        async (a, { bot: active, signal }) => {
            const have = invCount(active, a.item);
            if (!have) throw failWith('missing_item', `You carry no ${a.item}.`, {});
            const n = Math.min(a.count ?? have, have);
            let target = null;
            if (a.to) {
                const want = a.to.toLowerCase();
                const pl = Object.values(active.players ?? {}).find(
                    p => p?.username && p.username.toLowerCase() === want,
                );
                if (pl?.username === active.username)
                    throw failWith('validation', 'You cannot give items to yourself.', {});
                target = pl?.entity ?? null;
                if (!target)
                    throw failWith(
                        'not_found',
                        `${a.to} is not within view range. Ask them where they are, go there, then try again.`,
                        {},
                    );
                if (active.entity.position.distanceTo(target.position) > 1.8) {
                    const { Movements, goals } = await pathfinderModule();
                    const watch = progressWatch(active, () => target.position, { within: 1.8 });
                    const jumps = stallWatch(active);
                    const onAbort = () => {
                        try {
                            active.pathfinder.setGoal(null);
                            active.pathfinder.stop();
                        } catch {}
                    };
                    signal?.addEventListener('abort', onAbort, { once: true });
                    try {
                        active.pathfinder.setMovements(new Movements(active));
                        await withDeadline(active, active.pathfinder.goto(new goals.GoalFollow(target, 1)), 30000);
                    } catch (error) {
                        if (signal?.aborted) throw signal.reason ?? abortError('Tool cancelled');
                        throw failWith(
                            'no_path',
                            `Could not walk next to ${a.to} (${String(error?.message ?? error).slice(0, 60)}). Nothing was dropped.`,
                            {},
                        );
                    } finally {
                        watch.stop();
                        jumps.stop();
                        signal?.removeEventListener('abort', onAbort);
                    }
                    if (watch.stalled || jumps.stalled || active.entity.position.distanceTo(target.position) > 2.8)
                        throw failWith(
                            'no_path',
                            `Could not get close enough to ${a.to}. Nothing was dropped. Ask them to stand on reachable ground, then retry.`,
                            {},
                        );
                    target = active.players?.[pl.username]?.entity ?? target;
                }
                const dx = target.position.x - active.entity.position.x,
                    dz = target.position.z - active.entity.position.z;
                const dy = target.position.y - active.entity.position.y,
                    dist = Math.hypot(dx, dz);
                const landAt = dy > 0.5 ? Math.max(dist, 0.9) : Math.min(Math.max(dist + 0.5, 1.7), 4);
                try {
                    await active.look(
                        Math.atan2(-dx, -dz),
                        tossPitchFor(landAt, dy > 0.5 ? dy : Math.min(dy, 0)),
                        true,
                    );
                } catch {}
            } else {
                const yaw = active.entity.yaw;
                try {
                    await active.look(yaw, -0.35, true);
                } catch {}
            }
            try {
                active.clearControlStates();
            } catch {}
            await sleepAbortable(300, signal);
            const dropAt = active.entity.position.clone?.() ?? active.entity.position;
            let tossed = 0;
            for (const it of active.inventory.items().filter(i => i.name === a.item)) {
                if (tossed >= n) break;
                const c = Math.min(n - tossed, it.count);
                await untilAbort(active.toss(it.type, null, c), signal);
                tossed += c;
            }
            const t0 = Date.now();
            try {
                active.setControlState('back', true);
                await sleepAbortable(600, signal);
            } finally {
                try {
                    active.setControlState('back', false);
                } catch {}
            }
            const movedAway =
                Math.round(Math.hypot(active.entity.position.x - dropAt.x, active.entity.position.z - dropAt.z) * 10) /
                10;
            const ours = () => Math.max(0, invCount(active, a.item) - (have - tossed));
            const onGround = () =>
                Object.values(active.entities ?? {}).filter(
                    e =>
                        e?.name === 'item' &&
                        e.position?.distanceTo?.(dropAt) <= 6 &&
                        (e.getDroppedItem?.()?.name ?? null) === a.item,
                ).length;
            while (Date.now() - t0 < 4000 && !signal?.aborted) {
                if (ours() > 0 || (Date.now() - t0 > 2500 && !onGround())) break;
                await sleepAbortable(250, signal);
            }
            const back = ours(),
                lying = onGround();
            const out = { dropped: tossed, item: a.item };
            if (a.to) out.to = a.to;
            if (back) out.pickedBackUp = back;
            if (a.to) {
                const them = active.players?.[target?.username ?? '']?.entity ?? target;
                const gap = them ? Math.round(them.position.distanceTo(active.entity.position) * 10) / 10 : null;
                out.status = back
                    ? `${back} came back to you: you were still within reach of the items when they became collectable (you only got ${movedAway} blocks away; ${a.to} was ${gap} blocks from you). Whoever is in reach first gets them. Try from a spot with room to step back, or drop them without \`to\` and walk off so ${a.to} can collect them.`
                    : lying
                      ? `${tossed} still on the ground near ${a.to}; they can walk over it to pick it up`
                      : `picked up (${a.to} was the nearest player)`;
            } else if (back) out.note = `${back} landed back in your inventory`;
            return out;
        },
        { ...body, required: ['item'] },
    );
    add(
        'sleep',
        'Sleep in a visible bed within reach. Ordinary server sleep rules still apply.',
        coords,
        async (a, { bot: active, signal }) => {
            if (active.isSleeping)
                return {
                    sleeping: true,
                    note: 'Already in bed. Night passes once enough of the players online are asleep. Any other action gets you out of bed first.',
                };
            await untilAbort(active.sleep(blockAt(active, a, 3)), signal);
            return { sleeping: active.isSleeping };
        },
        body,
    );
    add(
        'wake',
        'Get out of bed.',
        {},
        async () => {
            if (!bot.isSleeping) return { awake: true, note: 'already awake' };
            await leaveBed(bot);
            return { awake: !bot.isSleeping };
        },
        body,
    );
}
