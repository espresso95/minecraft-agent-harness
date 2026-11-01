import { abortError, failWith, failureCode, failureFacts, withFailureCode } from './failures.js';
import { canClearTerrain, guardBuiltBlocks } from './guards.js';
import { PLACE_LINE_MS, PLACE_MS, untilAbort } from './runtime.js';
import { choice, coords, integer, name } from './schema.js';

export function createBuilding(ctx) {
    const {
        SCAFFOLD,
        add,
        at,
        body,
        bridgeApproach,
        bridgeClick,
        cellKey,
        fmt,
        missingSupport,
        passable,
        pathfinderModule,
        placeFailures,
        placeOne,
        placementPlan,
        r2,
        reachBlock,
        removeScaffold,
        replaceable,
        solidSupport,
        standCandidates,
        tooCloseToPlace,
        tower,
        walkTo,
    } = ctx;
    async function placeBlock(active, a, signal) {
        if (['air', 'cave_air', 'void_air'].includes(a.block))
            throw failWith('validation', 'Removing a block requires explicit break_block.', {
                reason: 'place cannot remove blocks',
                next: `break_block(${a.x},${a.y},${a.z})`,
                repeat: false,
            });
        const cell = { x: a.x, y: a.y, z: a.z },
            k = cellKey(cell);
        const pos = () => {
            const p = active.entity.position;
            return { x: r2(p.x), y: r2(p.y), z: r2(p.z) };
        };
        const start = pos();
        let movement = { mode: 'none', from: start };
        const fail = (code, reason, next, extra = {}) => {
            const repeat = (placeFailures.get(k) ?? 0) > 0;
            placeFailures.set(k, (placeFailures.get(k) ?? 0) + 1);
            return failWith(
                code,
                `${reason}${repeat ? ' (This cell already failed before; do not repeat the same call.)' : ''} Next: ${next}`,
                { target: cell, reason, next, repeat, movement, ...extra },
            );
        };
        let target = at(active, a.x, a.y, a.z),
            cleared = null;
        if (!target)
            throw fail(
                'not_visible_or_range',
                'Target cell is not loaded.',
                'go_to a point nearer the target, then place again',
            );
        if (!replaceable.includes(target.name) && target.name !== a.block && canClearTerrain(target)) {
            try {
                const b = await reachBlock(active, target, signal);
                await untilAbort(active.dig(b, true), signal);
            } catch (error) {
                if (signal?.aborted || error?.name === 'AbortError') throw error;
                throw fail(
                    'occupied_target',
                    `Target holds natural ${target.name} and clearing it failed: ${String(error?.message ?? error).slice(0, 120)}.`,
                    `break_block(${a.x},${a.y},${a.z}), then place again`,
                    { observed: target.name },
                );
            }
            cleared = target.name;
            target = at(active, a.x, a.y, a.z) ?? target;
        }
        if (!replaceable.includes(target.name)) {
            if (target.name === a.block) {
                placeFailures.delete(k);
                return { placed: cell, alreadyPresent: true, movement };
            }
            throw fail(
                'occupied_target',
                `Target is occupied by ${target.name}.`,
                `choose another cell, or break_block(${a.x},${a.y},${a.z}) only if it is your own block`,
                { observed: target.name },
            );
        }
        let ready = null;
        if (!tooCloseToPlace(active.entity.position, cell)) {
            try {
                ready = placementPlan(active, a);
            } catch {
                ready = null;
            }
        }
        const scaffolded = [];
        let bridgeTried = null;
        const bridge = async () => {
            let b;
            try {
                b = await bridgeApproach(active, cell, signal);
            } catch (error) {
                active.setControlState('sneak', false);
                if (signal?.aborted || error?.name === 'AbortError') throw error;
                movement = { mode: 'bridge', from: start, stoppedAt: pos() };
                throw fail(
                    'approach_failed',
                    `Moving onto the block beside the target to bridge from failed: ${String(error?.message ?? error).slice(0, 160)}.`,
                    'observe_world, then place again from where you are',
                );
            }
            bridgeTried = b;
            if (!b.chosen) return null;
            movement = {
                mode: 'bridge',
                from: start,
                stand: b.chosen.stand,
                face: b.chosen.side,
                walkMs: b.walkMs,
                fromEdge: b.fromEdge,
                stoppedAt: pos(),
            };
            let placed;
            try {
                placed = await bridgeClick(active, a, b.chosen);
            } catch (error) {
                if (signal?.aborted || error?.name === 'AbortError') throw error;
                const code = failureCode(error);
                throw fail(
                    code === 'unknown' ? 'action_failed' : code,
                    String(error?.message ?? error),
                    code === 'missing_item' ? 'use a block name you can place' : 'observe_world, then place again',
                );
            }
            placeFailures.delete(k);
            return { ...placed, movement, ...(cleared ? { cleared } : {}) };
        };
        if (!ready) {
            const { supports, candidates } = standCandidates(active, cell);
            if (!supports) {
                const ms = missingSupport(active, cell);
                throw fail(
                    'no_support',
                    `No solid block touches ${k}, so it needs a support block placed first: ${fmt(a.block, ms.placeFirst)}.`,
                    fmt(a.block, ms.placeFirst),
                    { missingSupport: ms },
                );
            }
            const overDrop = ![1, 2, 3].some(dy => solidSupport(at(active, cell.x, cell.y - dy, cell.z)));
            if (overDrop || !candidates.length) {
                const done = await bridge();
                if (done) return done;
            }
            if (!candidates.length)
                throw fail(
                    'no_stand_spot',
                    'No spot within 5 blocks has a clear, in-reach view of a support face of this cell, and there is no block beside it at the same level that you can walk onto to bridge from.',
                    `place a support on another side of the target, e.g. ${fmt(a.block, missingSupport(active, cell).placeFirst)}`,
                );
            const { Movements, goals } = await pathfinderModule();
            const plain = new Movements(active);
            guardBuiltBlocks(active, plain);
            plain.allowFreeMotion = false;
            const scafId = active.registry?.itemsByName?.[SCAFFOLD]?.id;
            const checked = [];
            let chosen = null,
                moves = null,
                mode = null;
            const pick = (list, m, label) => {
                for (const c of list) {
                    if (signal?.aborted) throw abortError('Tool cancelled');
                    const r = active.pathfinder.getPathTo(m, new goals.GoalBlock(c.stand.x, c.stand.y, c.stand.z), 250);
                    checked.push({ stand: c.stand, via: label, status: r?.status });
                    if (r?.status === 'success')
                        return {
                            ...c,
                            pathLength: r.path?.length ?? null,
                            placesScaffold: (r.path ?? []).reduce((n, s) => n + (s.toPlace?.length ?? 0), 0),
                        };
                }
                return null;
            };
            chosen = pick(candidates.filter(c => c.standable).slice(0, 6), plain, 'walk');
            if (chosen) {
                moves = plain;
                mode = chosen.stand.y > Math.floor(start.y) ? 'climb' : 'walk';
            } else if (scafId != null) {
                const towers = [];
                for (const c of candidates.filter(c => !c.standable)) {
                    let g = c.stand.y - 1,
                        clear = true;
                    while (g > c.stand.y - 8 && passable(at(active, c.stand.x, g, c.stand.z))) g--;
                    const ground = at(active, c.stand.x, g, c.stand.z);
                    if (!solidSupport(ground)) continue;
                    for (let yy = g + 1; yy <= c.stand.y + 1; yy++)
                        if (!passable(at(active, c.stand.x, yy, c.stand.z))) clear = false;
                    if (clear)
                        towers.push({
                            ...c,
                            base: { x: c.stand.x, y: g + 1, z: c.stand.z },
                            height: c.stand.y - g - 1,
                        });
                }
                towers.sort((x, y) => x.height - y.height || x.move - y.move);
                const base = pick(
                    towers.slice(0, 6).map(t => ({ ...t, stand: t.base, tower: t })),
                    plain,
                    'scaffold',
                );
                if (base) {
                    chosen = { ...base.tower, pathLength: base.pathLength, towerBase: base.tower.base };
                    moves = plain;
                    mode = 'scaffold';
                }
            }
            if (!chosen && !bridgeTried) {
                const done = await bridge();
                if (done) return done;
            }
            if (!chosen) {
                const c = candidates[0];
                const why = checked.length
                    ? `none of the ${checked.length} nearest could be reached by walking or by a dirt scaffold tower`
                    : 'all of them are in mid-air with no ground within 8 blocks below to stand on or tower up from';
                const br = bridgeTried?.unreachable
                    ? `; bridging from the block beside it also failed (no walkable route onto it)`
                    : '';
                throw fail(
                    'no_path',
                    `Found ${candidates.length} spot(s) with a clear view of a support face, but ${why}${br}. Built blocks are never broken.`,
                    `go_to(${c.stand.x},${c.stand.y},${c.stand.z}) to get closer, or place a step block near the target`,
                    { checked: checked.slice(0, 6) },
                );
            }
            const t0 = Date.now();
            try {
                if (mode === 'scaffold') {
                    if (
                        active.game?.gameMode === 'creative' &&
                        !active.inventory.findInventoryItem(SCAFFOLD) &&
                        active.creative?.setInventorySlot
                    ) {
                        const Item = (await import('prismarine-item')).default(active.registry ?? active.version);
                        await active.creative.setInventorySlot(43, new Item(scafId, 64));
                    }
                    await walkTo(active, { stand: chosen.towerBase }, plain, signal);
                    await tower(active, chosen, signal, scaffolded);
                } else await walkTo(active, chosen, moves, signal);
            } catch (error) {
                if (signal?.aborted) {
                    throw signal.reason ?? abortError('Tool cancelled');
                }
                movement = {
                    mode,
                    from: start,
                    stand: chosen.stand,
                    stoppedAt: pos(),
                    walkMs: Date.now() - t0,
                    scaffoldPlaced: scaffolded.length,
                };
                const cleanup = scaffolded.length ? await removeScaffold(active, scaffolded, cell) : null;
                if (cleanup) ((movement.scaffoldRemoved = cleanup.removed), (movement.scaffoldLeft = cleanup.left));
                throw fail(
                    'approach_failed',
                    `Moving (${mode}) to ${cellKey(chosen.stand)} failed: ${String(error?.message ?? error).slice(0, 160)}.`,
                    'observe_world, then place again from where you are',
                );
            }
            movement = {
                mode,
                from: start,
                stand: chosen.stand,
                face: chosen.face,
                faceDistance: chosen.faceDistance,
                pathLength: chosen.pathLength,
                walkMs: Date.now() - t0,
                stoppedAt: pos(),
                scaffoldPlaced: scaffolded.length,
            };
        }
        let placed, placeError;
        try {
            placed = await placeOne(active, a);
            if (placed === false) {
                const tail = (active.output || 'Placement failed.').trim().split('\n').pop();
                placeError = withFailureCode(
                    new Error(tail),
                    /^Don't have any [a-z0-9_]+ to place\.$/.test(tail) ? 'missing_item' : 'action_failed',
                );
            }
        } catch (error) {
            placeError = error;
        }
        if (scaffolded.length) {
            const cleanup = signal?.aborted
                ? { removed: 0, left: scaffolded.map(c => ({ ...c, reason: 'action aborted' })) }
                : await removeScaffold(active, scaffolded, cell);
            movement.scaffoldRemoved = cleanup.removed;
            movement.scaffoldLeft = cleanup.left;
        }
        if (placeError) {
            if (signal?.aborted || placeError?.name === 'AbortError') throw placeError;
            const code = failureCode(placeError);
            const facts = failureFacts.get(placeError) ?? {};
            const next =
                code === 'no_support'
                    ? fmt(a.block, missingSupport(active, cell).placeFirst)
                    : code === 'placement_unconfirmed'
                      ? 'observe_world to check the cell before placing again'
                      : code === 'missing_item'
                        ? 'use a block name you can place'
                        : 'observe_world, then place again';
            throw fail(
                code === 'unknown' ? 'action_failed' : code,
                String(placeError.message).split(' Suggested spot')[0],
                next,
                { ...facts, ...(code === 'no_support' ? { missingSupport: missingSupport(active, cell) } : {}) },
            );
        }
        placeFailures.delete(k);
        return { ...placed, movement, ...(cleared ? { cleared } : {}) };
    }
    add(
        'place',
        'Place one block at (x,y,z). Moves you first if needed: walks or climbs, or builds temporary dirt scaffolding, to a spot within reach with a clear view of a solid neighbouring face; over a drop (e.g. building a bridge out from an edge) it stands on the block beside the target, sneaks to its edge and places against its side, like a player bridging; then makes ONE placement attempt and removes the scaffolding it built. If the cell holds natural terrain (grass, dirt, stone, sand, leaves...) it mines that out first; built blocks are never removed. Result reports the movement taken (none/walk/climb/scaffold). Failures return code, reason, next (a suggested call), repeat (this cell failed before) and, for no_support, missingSupport (which block to place first).',
        { ...coords, block: name },
        (a, { bot: active, signal }) => placeBlock(active, a, signal),
        { ...body, required: ['x', 'y', 'z', 'block'] },
    );
    add(
        'place_line',
        'Batch of place calls: up to 64 identical blocks in a straight line from (x,y,z) stepping +1 along axis (negative count steps -1). Each cell is one place() (same movement and scaffolding rules); cells already holding this block are skipped; a cell that fails is skipped and the line continues (stops after 6 failures in a row). Failures are listed with reason and next step.',
        { block: name, ...coords, axis: choice(['x', 'y', 'z']), count: integer(-64, 64) },
        async (a, { bot: active, signal, deadline }) => {
            const n = Math.abs(a.count),
                step = Math.sign(a.count) || 1;
            if (!n) throw withFailureCode(new Error('count must be non-zero.'), 'validation');
            const placed = [],
                skipped = [],
                moves = {},
                failures = [];
            let failure = null,
                stoppedEarly = null,
                streak = 0;
            const end = Number.isFinite(deadline) ? deadline : Date.now() + PLACE_LINE_MS;
            const softEnd = end - Math.min(PLACE_MS, (end - Date.now()) / 2);
            for (let i = 0; i < n; i++) {
                if (signal?.aborted) throw signal.reason ?? abortError('Tool cancelled');
                if (i > 0 && Date.now() > softEnd) {
                    stoppedEarly = 'deadline_margin';
                    break;
                }
                const pos = { x: a.x, y: a.y, z: a.z, [a.axis]: a[a.axis] + i * step };
                try {
                    const r = await placeBlock(active, { block: a.block, ...pos }, signal);
                    if (r.alreadyPresent) skipped.push(pos);
                    else placed.push(pos);
                    moves[r.movement.mode] = (moves[r.movement.mode] ?? 0) + 1;
                } catch (error) {
                    if (signal?.aborted || error?.name === 'AbortError') throw error;
                    const f = {
                        at: pos,
                        code: failureCode(error),
                        ...(failureFacts.get(error) ?? { reason: String(error?.message ?? error) }),
                    };
                    failures.push(f);
                    failure ??= f;
                    if (++streak >= 6) {
                        stoppedEarly = 'six_failures_in_a_row';
                        break;
                    }
                    continue;
                }
                streak = 0;
            }
            const brief = f => ({
                at: f.at,
                code: f.code,
                reason: f.reason,
                next: f.next,
                ...(f.missingSupport ? { missingSupport: f.missingSupport } : {}),
            });
            const summary = {
                placed,
                placedCount: placed.length,
                skipped,
                requested: n,
                movements: moves,
                failedCount: failures.length,
                ...(failures.length ? { failures: failures.slice(0, 10).map(brief), firstFailure: failure } : {}),
                notAttempted: n - placed.length - skipped.length - failures.length,
                ...(stoppedEarly ? { stoppedEarly, next: 'call place_line again for the remaining cells' } : {}),
            };
            if (!placed.length && failure)
                throw failWith(
                    failure.code === 'unknown' ? 'action_failed' : failure.code,
                    `No blocks placed; ${failures.length} cell(s) failed. First at ${cellKey(failure.at)}: ${failure.reason} Next: ${failure.next}`,
                    summary,
                );
            return summary;
        },
        { ...body, required: ['block', 'x', 'y', 'z', 'axis', 'count'] },
    );
    return { placeBlock };
}
