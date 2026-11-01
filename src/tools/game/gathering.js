import { abortError, failWith } from './failures.js';
import { canClearTerrain, SAFE_DROP, fmtDrop, openDropBelow } from './guards.js';
import { gatherSkips, posKey, requireFunction, settleInventory, untilAbort } from './runtime.js';
import { coords, count, name, object } from './schema.js';
import { SIGHT_RANGE } from '../../skills/perception.js';

const NEAR_R = 24;

export function createGathering(ctx) {
    const {
        add,
        at,
        body,
        call,
        pathfinderModule,
        perception,
        pickupDrops,
        progressWatch,
        skills,
        shouldYield,
        stallWatch,
        withDeadline,
        world,
    } = ctx;
    add(
        'gather',
        `Collect up to count blocks of a type (oak_log, dirt, cobblestone, ...). Walks to a visible block, mines it with your best tool and picks up the drop, then the next. Unreachable blocks are skipped. Searches visible blocks within ${SIGHT_RANGE} blocks; buried or occluded resources are unknown. May dig through natural terrain or pillar up to reach a visible target. Up to ~2 minutes; returns actual progress.` +
            ` Pass near {x,y,z} to gather around a known spot: walks there first, then only collects within ${NEAR_R} blocks of it.`,
        { block: name, count, near: object(coords) },
        async (a, { bot: active, signal }) => {
            const counts = () =>
                Object.fromEntries(
                    [...new Set(active.inventory.items().map(i => i.name))].map(n => [
                        n,
                        active.inventory
                            .items()
                            .filter(i => i.name === n)
                            .reduce((sum, i) => sum + i.count, 0),
                    ]),
                );
            const before = counts();
            const types =
                a.block === 'cobblestone'
                    ? ['cobblestone', 'stone']
                    : a.block === 'dirt'
                      ? ['dirt', 'grass_block']
                      : [a.block];
            const { Movements, goals } = await pathfinderModule();
            let skip = gatherSkips.get(active.username);
            if (!skip) gatherSkips.set(active.username, (skip = new Map()));
            const started = Date.now(),
                skipped = [],
                minedAt = [];
            let mined = 0,
                misses = 0,
                stopCode = null,
                yielded = false,
                visible = [];
            const onAbort = () => {
                try {
                    active.pathfinder.setGoal(null);
                    active.pathfinder.stop();
                } catch {}
            };
            signal?.addEventListener('abort', onAbort, { once: true });
            const near = a.near;
            const dNear = p => Math.hypot(p.x - near.x, p.y - near.y, p.z - near.z);
            try {
                if (near && dNear(active.entity.position) > 16) {
                    const watch = stallWatch(active),
                        prog = progressWatch(active, near);
                    try {
                        await untilAbort(
                            requireFunction(skills, 'goToPosition')(active, near.x, near.y, near.z, 8),
                            signal,
                        );
                    } catch {
                        if (signal?.aborted) throw signal.reason ?? abortError('Tool cancelled');
                    } finally {
                        watch.stop();
                        prog.stop();
                    }
                    if (signal?.aborted) throw signal.reason ?? abortError('Tool cancelled');
                    const p = active.entity.position,
                        d = Math.round(dNear(p));
                    if (d > NEAR_R + 8)
                        throw failWith(
                            'no_path',
                            `Could not get near ${near.x},${near.y},${near.z}: stopped at ${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}, ${d} blocks away. go_to a waypoint toward it, then gather again.`,
                            { near, stoppedAt: { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) } },
                        );
                }
                while (mined < a.count && misses < 5 && Date.now() - started < 100000) {
                    if (signal?.aborted) throw signal.reason ?? abortError('Tool cancelled');
                    if (shouldYield()) {
                        yielded = true;
                        break;
                    }
                    const now = Date.now();
                    visible = requireFunction(world, 'getNearestBlocks')(active, types, SIGHT_RANGE, near ? 256 : 64);
                    const target = visible.find(
                        b =>
                            b.diggable !== false &&
                            (!near || dNear(b.position) <= NEAR_R) &&
                            !((skip.get(`${b.name}@${posKey(b.position)}`) ?? 0) > now),
                    );
                    if (!target) break;
                    const outcome = await mineOne(active, target, Movements, goals, signal);
                    if (outcome === true) {
                        minedAt.push(target.position.clone());
                        mined++;
                        misses = 0;
                        continue;
                    }
                    if (signal?.aborted) throw signal.reason ?? abortError('Tool cancelled');
                    const { x, y, z } = target.position;
                    skip.set(`${target.name}@${posKey(target.position)}`, now + 600000);
                    skipped.push({ at: { x, y, z }, block: target.name, code: outcome.code, reason: outcome.reason });
                    misses++;
                    if (outcome.code === 'missing_item') {
                        stopCode = 'missing_item';
                        break;
                    }
                }
            } finally {
                signal?.removeEventListener('abort', onAbort);
            }
            if (!mined && !yielded) {
                if (skipped.length) {
                    const code = stopCode ?? skipped[skipped.length - 1].code;
                    throw failWith(
                        code,
                        `Mined no ${a.block}. Tried ${skipped.length} block(s): ${skipped.map(s => `${s.at.x},${s.at.y},${s.at.z} ${s.reason}`).join('; ')}.` +
                            (code === 'missing_item'
                                ? ''
                                : ' Those are skipped for 10 minutes; call gather again to try others, or go_to a different area first.'),
                        { tried: skipped.slice(0, 6) },
                    );
                }
                const nearest = visible[0],
                    area = near
                        ? `within ${NEAR_R} blocks of ${near.x},${near.y},${near.z}`
                        : `within ${SIGHT_RANGE} blocks of you`;
                throw failWith(
                    'not_found',
                    `No eligible visible ${a.block} ${area}. Search covers line-of-sight within ${SIGHT_RANGE} blocks; buried, occluded and unvisited resources are unknown.` +
                        (nearest
                            ? ` Nearest visible ${nearest.name} is at ${nearest.position.x},${nearest.position.y},${nearest.position.z}; candidates may be outside the requested area or temporarily skipped after earlier failures.`
                            : '') +
                        ' Inspect nearby natural terrain or explore reachable ground before trying again.',
                    {
                        searchRadius: SIGHT_RANGE,
                        visibleOnly: true,
                        ...(near ? { near, radius: NEAR_R } : {}),
                        ...(nearest ? { nearest: { ...nearest.position } } : {}),
                    },
                );
            }
            if (!signal?.aborted) await sweepDrops(active, minedAt, goals, signal);
            await settleInventory(active);
            const after = counts();
            const gained = Object.keys(after).some(n => (after[n] ?? 0) > (before[n] ?? 0));
            return {
                mined,
                requested: a.count,
                ...(gained || !mined
                    ? {}
                    : {
                          dropsMissed:
                              'Mined blocks but no drops reached your inventory; they may be stuck in leaves, water or out of reach. Look nearby with observe_world or gather again.',
                      }),
                inventoryDelta: Object.fromEntries(
                    [...new Set([...Object.keys(before), ...Object.keys(after)])]
                        .map(n => [n, (after[n] ?? 0) - (before[n] ?? 0)])
                        .filter(([, delta]) => delta),
                ),
                ...(skipped.length ? { skipped: skipped.slice(0, 5) } : {}),
                ...(yielded
                    ? {
                          yielded: true,
                          reason: 'New instructions need review. Keep this progress and resume the remaining count after reviewing messages.',
                      }
                    : {}),
                note: 'Mined count is not pickup count; inspect inventory delta. May partially complete.',
            };
        },
        { ...body, required: ['block', 'count'], complete: value => !value.yielded && value.mined >= value.requested },
    );
    async function mineOne(active, block, Movements, goals, signal) {
        const pos = block.position;
        const inReach = b =>
            active.entity.position.distanceTo(pos) <= 5 &&
            requireFunction(perception, 'isBlockVisible')(active, b, 4.5);
        if (!inReach(block)) {
            try {
                active.pathfinder.setMovements(new Movements(active));
                await withDeadline(
                    active,
                    active.pathfinder.goto(new goals.GoalLookAtBlock(pos, active.world, { reach: 4 })),
                    20000,
                );
            } catch (error) {
                if (signal?.aborted) throw signal.reason ?? abortError('Tool cancelled');
                return {
                    code: 'no_path',
                    reason: `no walkable spot with a view of it (${String(error?.message ?? error).slice(0, 60)})`,
                };
            }
        }
        const fresh = active.blockAt(pos);
        if (!fresh || fresh.name !== block.name)
            return { code: 'action_failed', reason: `changed to ${fresh?.name ?? 'unloaded'} before mining` };
        if (!inReach(fresh))
            return {
                code: 'not_visible_or_range',
                reason: 'still not visible within reach after walking (leaves or blocks in the way)',
            };
        const tool = active.pathfinder?.bestHarvestTool?.(fresh);
        if (tool) await active.equip(tool, 'hand');
        if (fresh.canHarvest && !fresh.canHarvest(active.heldItem ? active.heldItem.type : null)) {
            return {
                code: 'missing_item',
                reason: `needs a better tool to harvest ${fresh.name} (e.g. a wooden pickaxe for stone)`,
            };
        }
        await untilAbort(active.dig(fresh, true), signal);
        await pickupDrops(active, pos, goals, signal);
        return true;
    }
    async function sweepDrops(active, positions, goals, signal, { ms = 10000, max = 12 } = {}) {
        if (!positions.length) return;
        await new Promise(r => setTimeout(r, 600));
        const until = Date.now() + ms,
            tried = new Set();
        for (let i = 0; i < max && Date.now() < until && !signal?.aborted; i++) {
            const me = active.entity.position;
            const drop = Object.values(active.entities ?? {})
                .filter(
                    e =>
                        e.name === 'item' &&
                        !tried.has(e.id) &&
                        e.position &&
                        e.position.y > me.y - SAFE_DROP - 0.5 &&
                        (e.position.distanceTo(me) < 5 || positions.some(p => e.position.distanceTo(p) < 8)),
                )
                .sort((p, q) => p.position.distanceTo(me) - q.position.distanceTo(me))[0];
            if (!drop) return;
            tried.add(drop.id);
            const d = drop.position;
            try {
                await withDeadline(
                    active,
                    active.pathfinder.goto(new goals.GoalBlock(Math.floor(d.x), Math.floor(d.y), Math.floor(d.z))),
                    Math.max(500, Math.min(3000, until - Date.now())),
                );
            } catch {
                continue;
            }
            await new Promise(r => setTimeout(r, 250));
        }
    }
    add(
        'break_block',
        "Break one visible block with your best tool and pick up what it drops. Do not modify another player's build.",
        coords,
        async (a, ctx) => {
            const active = ctx.bot;
            try {
                const target = at(active, a.x, a.y, a.z);
                const seen = b =>
                    b &&
                    active.entity.position.distanceTo(b.position) <= 5 &&
                    (perception.isBlockFaceVisible ?? requireFunction(perception, 'isBlockVisible'))(active, b, 4.5);
                if (target && target.name !== 'air' && !seen(target)) {
                    const { goals, Movements } = await pathfinderModule();
                    active.pathfinder.setMovements(new Movements(active));
                    await withDeadline(
                        active,
                        active.pathfinder.goto(new goals.GoalLookAtBlock(target.position, active.world, { reach: 4 })),
                        20000,
                    );
                }
            } catch (error) {
                if (ctx.signal?.aborted || error?.name === 'AbortError') throw error;
            }
            const hold = holdsYouUp(active, a.x, a.y, a.z);
            if (hold)
                throw failWith(
                    'would_fall',
                    `Not breaking ${a.x},${a.y},${a.z}: it is the block holding you up, with an open drop of ${fmtDrop(hold)} blocks under it, so you would fall. Stand on solid ground beside it and break it from there, or go down by digging a staircase (break_area one step lower and one block forward each time).`,
                    { drop: fmtDrop(hold) },
                );
            const r = await call('breakAt', b => [b.x, b.y, b.z])(a, ctx);
            if (r !== false) {
                try {
                    const { goals, Movements } = await pathfinderModule();
                    active.pathfinder?.setMovements?.(new Movements(active));
                    await pickupDrops(
                        active,
                        active.entity.position.offset(
                            a.x + 0.5 - active.entity.position.x,
                            a.y + 0.5 - active.entity.position.y,
                            a.z + 0.5 - active.entity.position.z,
                        ),
                        goals,
                        ctx.signal,
                    );
                } catch (error) {
                    if (ctx.signal?.aborted || error?.name === 'AbortError') throw error;
                }
            }
            return r;
        },
        body,
    );
    function holdsYouUp(active, x, y, z) {
        const p = active.entity.position,
            fy = Math.floor(p.y + 0.01);
        if (y !== fy - 1) return 0;
        let under = false,
            other = false;
        for (const cx of new Set([Math.floor(p.x - 0.3), Math.floor(p.x + 0.3)]))
            for (const cz of new Set([Math.floor(p.z - 0.3), Math.floor(p.z + 0.3)])) {
                if (cx === x && cz === z) under = true;
                else if (at(active, cx, fy - 1, cz)?.boundingBox === 'block') other = true;
            }
        if (!under || other) return 0;
        const d = 1 + openDropBelow(active, x, fy - 1, z);
        return d > SAFE_DROP ? d : 0;
    }
    async function approachToBreak(active, c, ctx) {
        try {
            const target = at(active, c.x, c.y, c.z);
            const seen = b =>
                b &&
                active.entity.position.distanceTo(b.position) <= 5 &&
                (perception.isBlockFaceVisible ?? requireFunction(perception, 'isBlockVisible'))(active, b, 4.5);
            if (target && target.name !== 'air' && !seen(target)) {
                const { goals, Movements } = await pathfinderModule();
                active.pathfinder.setMovements(new Movements(active));
                await withDeadline(
                    active,
                    active.pathfinder.goto(new goals.GoalLookAtBlock(target.position, active.world, { reach: 4 })),
                    20000,
                );
            }
        } catch (error) {
            if (ctx.signal?.aborted || error?.name === 'AbortError') throw error;
        }
    }
    const AREA_MAX = 96;
    add(
        'break_area',
        'Break every block in a box from (x1,y1,z1) to (x2,y2,z2), up to 96 blocks, e.g. a 1x2x16 tunnel, a 3x3x3 room, or one step of a staircase. Works the nearest column first, top block down, walking within reach as needed (it never steps off a drop of more than 3 blocks), then picks up the drops. Skips air, liquids, unbreakable blocks, blocks you lack the tool to harvest, and the block holding you up over a drop; also skips built blocks (planks, bricks, glass, redstone...) unless include_built is true. Up to ~3 minutes per call; reports what it broke, what it picked up and why anything was skipped. Safe way down: a staircase, breaking the 1-wide, 3-high slice one block forward and one block lower each step, then stepping into it.',
        {
            x1: coords.x,
            y1: coords.y,
            z1: coords.z,
            x2: coords.x,
            y2: coords.y,
            z2: coords.z,
            include_built: { type: 'boolean' },
        },
        async (a, ctx) => {
            const active = ctx.bot,
                signal = ctx.signal;
            const [X0, X1] = [Math.min(a.x1, a.x2), Math.max(a.x1, a.x2)],
                [Y0, Y1] = [Math.min(a.y1, a.y2), Math.max(a.y1, a.y2)],
                [Z0, Z1] = [Math.min(a.z1, a.z2), Math.max(a.z1, a.z2)];
            const volume = (X1 - X0 + 1) * (Y1 - Y0 + 1) * (Z1 - Z0 + 1);
            if (volume > AREA_MAX)
                throw failWith(
                    'too_large',
                    `That box is ${volume} blocks; break_area takes up to ${AREA_MAX} per call (e.g. 2x3x16). Split it into smaller boxes.`,
                    { volume },
                );
            const p0 = active.entity.position,
                mid = { x: (X0 + X1 + 1) / 2, y: (Y0 + Y1 + 1) / 2, z: (Z0 + Z1 + 1) / 2 };
            if (Math.hypot(mid.x - p0.x, mid.y - p0.y, mid.z - p0.z) > 48)
                throw failWith(
                    'too_far',
                    `That box is more than 48 blocks from you (you are at ${Math.round(p0.x)},${Math.round(p0.y)},${Math.round(p0.z)}); go_to near it first.`,
                );
            const counts = () => {
                const m = {};
                for (const it of active.inventory?.items?.() ?? []) m[it.name] = (m[it.name] ?? 0) + it.count;
                return m;
            };
            const empty = n => !n || /^(air|cave_air|void_air)$/.test(n);
            const before = counts(),
                until = Date.now() + 180000,
                todo = [],
                skipped = [],
                byBlock = {};
            for (let x = X0; x <= X1; x++)
                for (let y = Y1; y >= Y0; y--) for (let z = Z0; z <= Z1; z++) todo.push({ x, y, z });
            let broke = 0;
            while (todo.length && Date.now() < until) {
                if (signal?.aborted) throw abortError('break_area cancelled');
                const me = active.entity.position,
                    flat = c => Math.hypot(c.x + 0.5 - me.x, c.z + 0.5 - me.z);
                todo.sort((p, q) => flat(p) - flat(q) || q.y - p.y);
                const c = todo.shift(),
                    b = at(active, c.x, c.y, c.z);
                if (!b || empty(b.name)) continue;
                const skip = reason => skipped.push({ x: c.x, y: c.y, z: c.z, block: b.name, reason });
                if (b.name === 'water' || b.name === 'lava') {
                    skip('liquid');
                    continue;
                }
                if (b.diggable === false || b.name === 'bedrock') {
                    skip('unbreakable');
                    continue;
                }
                if (!a.include_built && !canClearTerrain(b)) {
                    skip(
                        'protected by the clearing policy (possibly a built block); pass include_built:true only with permission',
                    );
                    continue;
                }
                let hold = holdsYouUp(active, c.x, c.y, c.z);
                if (!hold) {
                    await approachToBreak(active, c, ctx);
                    hold = holdsYouUp(active, c.x, c.y, c.z);
                }
                if (hold) {
                    skip(`holds you up over an open drop of ${fmtDrop(hold)} blocks`);
                    continue;
                }
                const mark = String(active.output || '').length;
                let r;
                try {
                    r = await call('breakAt', q => [q.x, q.y, q.z])(c, ctx);
                } catch (error) {
                    if (signal?.aborted || error?.name === 'AbortError') throw error;
                    const m = String(error?.message ?? error);
                    if (/is not visible/.test(m) && !c.retried) {
                        todo.push({ ...c, retried: true });
                        continue;
                    }
                    skip(m.replace(/^Block at [-0-9, ]+ /, '').slice(0, 200));
                    continue;
                }
                if (r === false) {
                    skip(
                        String(active.output || '')
                            .slice(mark)
                            .trim()
                            .split('\n')
                            .filter(Boolean)
                            .pop()
                            ?.slice(0, 160) || 'could not break it',
                    );
                    continue;
                }
                broke++;
                byBlock[b.name] = (byBlock[b.name] ?? 0) + 1;
            }
            const unfinished = todo.filter(c => !empty(at(active, c.x, c.y, c.z)?.name)).length;
            if (broke) {
                try {
                    const { goals } = await pathfinderModule(),
                        p = active.entity.position;
                    await pickupDrops(active, p.offset(mid.x - p.x, mid.y - p.y, mid.z - p.z), goals, signal, {
                        radius: Math.hypot(X1 - X0 + 1, Y1 - Y0 + 1, Z1 - Z0 + 1) / 2 + 4,
                        ms: 15000,
                        max: 24,
                    });
                } catch (error) {
                    if (signal?.aborted || error?.name === 'AbortError') throw error;
                }
            }
            const after = counts(),
                pickedUp = {};
            for (const [k, n] of Object.entries(after)) if (n > (before[k] ?? 0)) pickedUp[k] = n - (before[k] ?? 0);
            const out = {
                broke,
                byBlock,
                pickedUp,
                skipped: skipped.slice(0, 12),
                ...(skipped.length > 12 ? { moreSkipped: skipped.length - 12 } : {}),
                ...(unfinished ? { unfinished, note: 'Stopped at the ~3 minute limit; call again for the rest.' } : {}),
            };
            if (!broke && skipped.length)
                throw failWith(
                    'nothing_broken',
                    `Broke nothing in that box. First skip: ${skipped[0].block} at ${skipped[0].x},${skipped[0].y},${skipped[0].z}: ${skipped[0].reason}.`,
                    out,
                );
            return out;
        },
        { ...body, required: ['x1', 'y1', 'z1', 'x2', 'y2', 'z2'] },
    );
}
