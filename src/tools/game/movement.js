import { abortError, failWith, withFailureCode } from './failures.js';
import { DOORISH, doorOpen, fmtDrop, guardBuiltBlocks } from './guards.js';
import { allowedGameMode, flyCooperatively, requireFunction, untilAbort } from './runtime.js';
import { choice, coords, number } from './schema.js';

export function createMovement(ctx) {
    const {
        add,
        at,
        body,
        bot,
        call,
        goToHint,
        navigationRecovery,
        passable,
        pathfinderModule,
        progressWatch,
        r2,
        runner,
        skills,
        standingTarget,
        stallWatch,
        withDeadline,
    } = ctx;
    add('stop_action', 'Cancel the current body action. Does not interrupt messaging.', {}, () => runner.stop());
    add(
        'go_to',
        'Walk to coordinates. May dig through natural terrain (dirt, stone, sand, leaves...) and pillar up with dirt/cobblestone from your inventory; never breaks built blocks. Stops within `distance` blocks of the target (default 2) and reports where it actually stopped. Failures explain why and suggest a next step.',
        { ...coords, distance: number(0.5, 8) },
        async (a, { bot: active, signal }) => {
            const tolerance = a.distance ?? 2;
            const target = standingTarget(active, a, tolerance);
            const watch = stallWatch(active),
                prog = progressWatch(active, target),
                t0 = Date.now();
            let reached;
            try {
                reached = await requireFunction(skills, 'goToPosition')(
                    active,
                    target.x,
                    target.y,
                    target.z,
                    tolerance,
                );
            } finally {
                watch.stop();
                prog.stop();
            }
            if (watch.stalled || prog.stalled) reached = false;
            const p = active.entity?.position;
            const round = v => Math.round(v * 100) / 100;
            const facts = {
                target: { x: a.x, y: a.y, z: a.z },
                ...(target !== a ? { navigationTarget: target } : {}),
                tolerance,
                acceptedWithin: tolerance + 1,
                stoppedAt: p ? { x: round(p.x), y: round(p.y), z: round(p.z) } : null,
                distanceToTarget: p ? round(Math.hypot(p.x - a.x, p.y - a.y, p.z - a.z)) : null,
                eyeY: p ? round(p.y + (active.entity.eyeHeight ?? 1.62)) : null,
            };
            if (facts.distanceToTarget > facts.acceptedWithin) reached = false;
            if (!reached) {
                const out = String(active.output || '');
                const s = facts.stoppedAt,
                    here = s ? `${Math.round(s.x)},${Math.round(s.y)},${Math.round(s.z)}` : 'your position';
                const tgt = `${a.x},${a.y},${a.z}`,
                    d = facts.distanceToTarget;
                const noRoute = /Path not found|No path to the goal/.test(out),
                    slow = /Took to long/.test(out),
                    short = /Unable to reach/.test(out);
                let code = 'action_failed',
                    msg;
                const edge = active.pi_edgeStop && active.pi_edgeStop.at >= t0 ? active.pi_edgeStop : null;
                if (edge) {
                    code = 'drop_ahead';
                    msg = `Stopped at ${here} so you would not fall: the next step toward ${tgt} was over an open drop of ${fmtDrop(edge.drop)} blocks at ${edge.x},${edge.y},${edge.z} (a shaft, hole or cliff edge). Falls over 3 blocks hurt and long ones kill. Next: go_to a waypoint that goes around it, cover the hole with place, or get down by digging a staircase with break_area.`;
                } else if (watch.stalled) {
                    code = 'stuck';
                    msg = `Stopped: you were jumping in place at ${watch.at} for ~4s without gaining height, so the next step toward ${tgt} is too tall or blocked above you.`;
                } else if (prog.stalled) {
                    code = 'no_progress';
                    msg =
                        prog.stalled.why === 'idle'
                            ? `Stopped: the pathfinder left you standing at ${here} for ${prog.stalled.seconds}s without moving or digging, ${d} blocks from ${tgt}. It has no workable route from here.`
                            : `Stopped: no closer to ${tgt} after ${prog.stalled.seconds}s of walking (you are at ${here}, ${d} blocks away); the route is going in circles.`;
                } else if (slow) {
                    code = 'no_path';
                    msg = `Route search to ${tgt} ran out of planning time (target ${d} blocks away, or complex terrain); you are at ${here}. Next: go_to a waypoint 20-30 blocks toward the target, then continue from there.`;
                } else if (noRoute && !short) {
                    code = 'no_path';
                    msg = `No route to ${tgt} from ${here} (${d} blocks away), even digging through natural terrain and pillaring up. Usual causes: the target cell is inside a solid or built block, hangs in the air with nothing to stand on, or is walled off by built blocks (never broken). Next: target an air cell directly above solid ground, or go_to a nearer waypoint first.`;
                } else if (short)
                    msg = `${noRoute ? 'No complete route exists; ' : ''}stopped ${d} blocks from ${tgt} at ${here}, the closest reachable spot found. Next: if you only need to place or mine there, try it from here; otherwise target a nearby air cell above solid ground.`;
                else msg = (out || 'Could not reach the target.').trim();
                const hint = goToHint(active, a);
                if (hint && !msg.includes(hint)) msg = `${msg} ${hint}`;
                else if (code === 'no_progress')
                    msg +=
                        ' Next: go_to a waypoint that is open ground in a different direction, or break_area your own way through.';
                throw failWith(code, msg, {
                    ...facts,
                    ...(hint ? { hint } : {}),
                    ...(await navigationRecovery(active, target, signal)),
                    pathfinder: out.trim().split('\n').slice(-3).join(' | '),
                });
            }
            return { reached: true, ...facts };
        },
        { ...body, required: ['x', 'y', 'z'] },
    );
    if (!bot.pi_no_flight)
        add(
            'fly_to',
            'Creative only: fly directly to coordinates (through open air, no block breaking). You stay hovering afterwards unless land is true.',
            { ...coords, land: { type: 'boolean' } },
            async (a, { bot: active, signal }) => {
                if (allowedGameMode(active) !== 'creative' || active.game?.gameMode !== 'creative')
                    throw withFailureCode(new Error('fly_to requires Creative mode.'), 'not_creative');
                const creative = bot.creative;
                if (typeof creative?.startFlying !== 'function' || typeof creative?.stopFlying !== 'function')
                    throw new Error('Flight is not available on this client.');
                const { Vec3 } = await import('vec3');
                await flyCooperatively(bot, creative, new Vec3(a.x, a.y, a.z), signal);
                if (a.land) creative.stopFlying();
                const p = active.entity?.position;
                return {
                    arrived: true,
                    position: p
                        ? { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, z: Math.round(p.z * 10) / 10 }
                        : null,
                    flying: !a.land,
                };
            },
            { ...body, required: ['x', 'y', 'z'] },
        );
    add(
        'move',
        'Hold movement keys briefly; always releases at completion or cancellation.',
        {
            controls: {
                type: 'array',
                items: choice(['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']),
                minItems: 1,
                maxItems: 7,
            },
            seconds: number(0.05, 5),
        },
        call('move', a => [a.controls.join('+'), a.seconds]),
        body,
    );
    add(
        'return_to_surface',
        'Get back up to ground level from a hole, pit, shaft or cave. Works out the ground height around you, then walks, digs or climbs to the nearest spot at that height under open sky (it may dig natural blocks such as stone and dirt and place dirt/cobblestone to climb). Never breaks planks, bricks, glass or other built blocks. Does nothing if you are already at ground level.',
        {},
        async (a, { bot: active, signal }) => {
            const natural =
                /^(stone|dirt|grass_block|coarse_dirt|rooted_dirt|podzol|mud|clay|gravel|sand|red_sand|sandstone|red_sandstone|andesite|diorite|granite|deepslate|tuff|calcite|dripstone_block|pointed_dripstone|moss_block|smooth_basalt|short_grass|tall_grass|fern|.*_ore|.*terracotta|snow|snow_block|ice|packed_ice|.*leaves)$/;
            const groundRe =
                /^(stone|dirt|grass_block|coarse_dirt|rooted_dirt|podzol|mycelium|dirt_path|farmland|mud|clay|gravel|sand|red_sand|sandstone|red_sandstone|andesite|diorite|granite|deepslate|tuff|calcite|moss_block|smooth_basalt|.*_ore|.*terracotta|snow_block|ice|packed_ice|water)$/;
            const pillar = [
                'cobblestone',
                'dirt',
                'cobbled_deepslate',
                'netherrack',
                'stone',
                'andesite',
                'diorite',
                'granite',
                'tuff',
            ];
            const V = active.entity.position.constructor;
            const P0 = active.entity.position.clone(),
                x = Math.floor(P0.x),
                z = Math.floor(P0.z),
                y0 = Math.floor(P0.y + 0.01);
            const solid = b => b && !passable(b) && b.name !== 'cave_air' && b.name !== 'water';
            const skyAt = (cx, y, cz) => {
                for (let yy = y; yy < Math.min(320, y + 200); yy++) if (solid(at(active, cx, yy, cz))) return false;
                return true;
            };
            const openSky = y => skyAt(x, y, z);
            const standable = (nx, y, nz) =>
                solid(at(active, nx, y - 1, nz)) && !solid(at(active, nx, y, nz)) && !solid(at(active, nx, y + 1, nz));
            const top = (cx, cz) => {
                for (let yy = Math.min(319, y0 + 96); yy >= Math.max(-64, y0 - 64); yy--) {
                    const b = at(active, cx, yy, cz);
                    if (!b) return null;
                    if (groundRe.test(b.name)) return yy;
                }
                return null;
            };
            const R = 8,
                cols = [];
            for (let dx = -R; dx <= R; dx++)
                for (let dz = -R; dz <= R; dz++) {
                    if (!dx && !dz) continue;
                    const t = top(x + dx, z + dz);
                    if (t != null) cols.push({ cx: x + dx, cz: z + dz, t, d: Math.hypot(dx, dz) });
                }
            const sorted = cols.map(c => c.t).sort((p, q) => p - q);
            const G = sorted.length >= 20 ? sorted[Math.floor(sorted.length / 2)] : null;
            const surfaceY = G == null ? null : G + 1;
            const walksOut = () => {
                const seen = new Set([`${x},${z}`]),
                    q = [[x, y0, z]];
                for (let i = 0; i < q.length && i < 600; i++) {
                    const [cx, cy, cz] = q[i];
                    if (Math.max(Math.abs(cx - x), Math.abs(cz - z)) >= R || (surfaceY != null && cy >= surfaceY))
                        return true;
                    for (const [dx, dz] of [
                        [1, 0],
                        [-1, 0],
                        [0, 1],
                        [0, -1],
                    ]) {
                        const nx = cx + dx,
                            nz = cz + dz;
                        if (seen.has(`${nx},${nz}`)) continue;
                        for (let ny = cy + 1; ny >= cy - 3; ny--)
                            if (standable(nx, ny, nz) && (ny <= cy || !solid(at(active, cx, cy + 2, cz)))) {
                                seen.add(`${nx},${nz}`);
                                q.push([nx, ny, nz]);
                                break;
                            }
                    }
                }
                return false;
            };
            const inHole = fy =>
                surfaceY != null ? fy <= surfaceY - 2 && (!openSky(fy) || !walksOut()) : !openSky(fy);
            const atSurface = () => {
                const fy = Math.floor(active.entity.position.y + 0.01);
                return surfaceY != null
                    ? fy >= surfaceY - 1 &&
                          skyAt(Math.floor(active.entity.position.x), fy, Math.floor(active.entity.position.z))
                    : openSky(fy);
            };
            const groundNote =
                surfaceY == null ? 'ground level unknown here' : `ground level around you is y=${surfaceY}`;
            if (!inHole(y0))
                return {
                    alreadyAtSurface: true,
                    position: { x: r2(P0.x), y: r2(P0.y), z: r2(P0.z) },
                    surfaceY,
                    note: `Already at ground level (${groundNote}). Nothing to do.`,
                };
            const deadline = Date.now() + 112000,
                sleep = ms => new Promise(r => setTimeout(r, ms));
            let method = null,
                why = null,
                dug = 0,
                placed = 0;
            const targets =
                surfaceY == null
                    ? []
                    : cols
                          .filter(
                              c =>
                                  Math.abs(c.t - G) <= 1 &&
                                  standable(c.cx, c.t + 1, c.cz) &&
                                  skyAt(c.cx, c.t + 1, c.cz),
                          )
                          .sort((p, q) => p.d - q.d);
            const tried = [];
            if (targets.length) {
                const { goals, Movements } = await pathfinderModule();
                try {
                    const m = new Movements(active);
                    for (const n of pillar) {
                        const id = active.registry?.itemsByName?.[n]?.id;
                        if (id != null && !m.scafoldingBlocks.includes(id)) m.scafoldingBlocks.push(id);
                    }
                    active.pathfinder.setMovements(m);
                } catch {}
                const pathEnd = Date.now() + 60000;
                for (const c of targets.filter((c, i) => i < 2 || i % 7 === 0).slice(0, 4)) {
                    if (Date.now() > pathEnd) break;
                    if (signal?.aborted) throw signal.reason ?? abortError('Tool cancelled');
                    tried.push(`${c.cx},${c.t + 1},${c.cz}`);
                    try {
                        await withDeadline(
                            active,
                            active.pathfinder.goto(new goals.GoalBlock(c.cx, c.t + 1, c.cz)),
                            Math.max(3000, Math.min(40000, pathEnd - Date.now())),
                        );
                    } catch (e) {
                        why = `no route to ${c.cx},${c.t + 1},${c.cz}: ${String(e?.message ?? e).slice(0, 60)}`;
                    } finally {
                        try {
                            active.pathfinder.setGoal?.(null);
                        } catch {}
                    }
                    if (atSurface() && Math.floor(active.entity.position.y + 0.01) >= surfaceY) {
                        method = 'path';
                        break;
                    }
                }
            } else
                why =
                    surfaceY == null
                        ? 'no ground found around you'
                        : 'no ground-level spot with open sky within 8 blocks';
            const placedYs = [];
            if (!method) {
                const cx = Math.floor(active.entity.position.x),
                    cz = Math.floor(active.entity.position.z),
                    sy = Math.floor(active.entity.position.y + 0.01);
                const done = fy => (surfaceY != null ? fy >= surfaceY : true) && skyAt(cx, fy + 1, cz) && fy >= sy;
                const MAX_CLIMB = Math.min(48, Math.max(16, surfaceY != null ? surfaceY - sy + 2 : 16));
                try {
                    while (Date.now() < deadline) {
                        if (signal?.aborted) throw signal.reason ?? abortError('Tool cancelled');
                        const fy = Math.floor(active.entity.position.y + 0.01);
                        if (done(fy)) break;
                        if (fy - sy >= MAX_CLIMB) {
                            why = `climbed ${MAX_CLIMB} blocks without reaching ground level`;
                            break;
                        }
                        let blocked = null;
                        for (const dy of [1, 2]) {
                            const b = at(active, cx, fy + dy, cz);
                            if (!solid(b)) continue;
                            if (!natural.test(b.name)) {
                                blocked = `blocked by ${b.name} at ${cx},${fy + dy},${cz} (a built block; not breaking it)`;
                                break;
                            }
                            const tool = active.pathfinder?.bestHarvestTool?.(b);
                            if (tool) await active.equip(tool, 'hand');
                            await active.dig(b, true);
                            dug++;
                            for (let i = 0; i < 10 && solid(at(active, cx, fy + dy, cz)); i++) await sleep(100);
                        }
                        if (blocked) {
                            why = blocked;
                            break;
                        }
                        if (solid(at(active, cx, fy + 2, cz))) continue;
                        const item = pillar.map(n => active.inventory.findInventoryItem(n)).find(Boolean);
                        if (!item) {
                            why = 'no dirt/cobblestone in inventory to climb with';
                            break;
                        }
                        await active.equip(item, 'hand');
                        const below = at(active, cx, fy - 1, cz);
                        let ok = false,
                            lastErr = '';
                        for (let attempt = 0; attempt < 3 && !ok; attempt++) {
                            if (signal?.aborted) throw signal.reason ?? abortError('Tool cancelled');
                            for (let i = 0; i < 50 && !active.entity.onGround; i++) await sleep(100);
                            await active.lookAt(new V(cx + 0.5, fy - 0.5, cz + 0.5), true);
                            active.setControlState('jump', true);
                            const t0 = Date.now();
                            while (active.entity.position.y < fy + 1.05 && Date.now() - t0 < 8000) await sleep(25);
                            active.setControlState('jump', false);
                            if (active.entity.position.y < fy + 1.05) {
                                lastErr = `jump did not clear y=${fy + 1}`;
                                continue;
                            }
                            try {
                                await active.placeBlock(below, new V(0, 1, 0));
                            } catch (e) {
                                lastErr = String(e?.message ?? e).slice(0, 80);
                            }
                            for (let i = 0; i < 40 && !solid(at(active, cx, fy, cz)); i++) await sleep(100);
                            ok = solid(at(active, cx, fy, cz));
                        }
                        if (!ok) {
                            why = `block would not place at ${cx},${fy},${cz} (${lastErr})`;
                            break;
                        }
                        placed++;
                        placedYs.push(fy);
                        for (
                            let i = 0;
                            i < 80 && !(active.entity.onGround && active.entity.position.y >= fy + 0.99);
                            i++
                        )
                            await sleep(100);
                    }
                } finally {
                    active.setControlState('jump', false);
                }
                if (atSurface()) {
                    method = 'climb';
                    const fy = Math.floor(active.entity.position.y + 0.01);
                    let off = null;
                    for (let h = fy; h >= fy - 3 && !off; h--)
                        for (const [dx, dz] of [
                            [1, 0],
                            [-1, 0],
                            [0, 1],
                            [0, -1],
                        ])
                            if (standable(cx + dx, h, cz + dz)) {
                                off = [cx + dx, h, cz + dz];
                                break;
                            }
                    if (off && !signal?.aborted) {
                        try {
                            const { goals } = await pathfinderModule();
                            await withDeadline(
                                active,
                                active.pathfinder.goto(new goals.GoalBlock(off[0], off[1], off[2])),
                                5000,
                            );
                        } catch {}
                        const ny = Math.floor(active.entity.position.y + 0.01);
                        if (Math.floor(active.entity.position.x) !== cx || Math.floor(active.entity.position.z) !== cz)
                            for (const py of placedYs.filter(v => v >= ny).sort((p, q) => q - p)) {
                                if (signal?.aborted) break;
                                const b = at(active, cx, py, cz);
                                if (!solid(b) || !pillar.includes(b.name)) continue;
                                try {
                                    await withDeadline(active, active.dig(b, true), 4000);
                                } catch {
                                    break;
                                }
                            }
                    }
                }
            }
            const P = active.entity.position;
            const result = {
                reached: Boolean(method),
                ...(method ? { method } : {}),
                surfaceY,
                from: { x: r2(P0.x), y: r2(P0.y), z: r2(P0.z) },
                position: { x: r2(P.x), y: r2(P.y), z: r2(P.z) },
                climbed: Math.floor(P.y + 0.01) - y0,
                ...(dug ? { blocksBroken: dug } : {}),
                ...(placed ? { blocksPlaced: placed } : {}),
            };
            active.emit?.('pi_tool_result', 'return_to_surface', result);
            if (method) return result;
            if (Math.floor(P.y + 0.01) > y0) return { ...result, stoppedBecause: why ?? 'time limit' };
            throw new Error(`return_to_surface made no progress (${groundNote}): ${why ?? 'time limit'}`);
        },
        body,
    );
    const doorProps = b => b?.getProperties?.() ?? b?._properties ?? {};
    const doorKind = b =>
        /_fence_gate$/.test(b.name) ? 'fence_gate' : /_trapdoor$/.test(b.name) ? 'trapdoor' : 'door';
    function doorAt(active, x, y, z) {
        let b = at(active, x, y, z);
        if (!b || !DOORISH.test(b.name)) {
            const near = [];
            for (let dx = -2; dx <= 2; dx++)
                for (let dy = -1; dy <= 1; dy++)
                    for (let dz = -2; dz <= 2; dz++) {
                        const n = at(active, x + dx, y + dy, z + dz);
                        if (n && DOORISH.test(n.name)) near.push(`${n.name} at ${x + dx},${y + dy},${z + dz}`);
                    }
            throw failWith(
                'not_a_door',
                `${b?.name ?? 'Nothing loaded'} at ${x},${y},${z} is not a door, fence gate or trapdoor.${near.length ? ` Nearby: ${near.slice(0, 4).join('; ')}.` : ' None within 2 blocks.'}`,
            );
        }
        if (doorKind(b) === 'door' && doorProps(b).half === 'upper') {
            const lo = at(active, x, y - 1, z);
            if (lo?.name === b.name) b = lo;
        }
        return b;
    }
    const doorPos = b => ({ x: b.position.x, y: b.position.y, z: b.position.z });
    function doorPartner(active, b) {
        if (doorKind(b) !== 'door') return null;
        const p = doorProps(b);
        for (const [dx, dz] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
        ]) {
            const n = at(active, b.position.x + dx, b.position.y, b.position.z + dz);
            if (
                n?.name === b.name &&
                doorProps(n).facing === p.facing &&
                doorProps(n).hinge !== p.hinge &&
                doorProps(n).half !== 'upper'
            )
                return n;
        }
        return null;
    }
    async function reachDoor(active, b, signal) {
        const seen = () =>
            active.entity.position.offset(0, 1.62, 0).distanceTo(b.position.offset(0.5, 0.5, 0.5)) <= 4.2;
        if (seen()) return;
        try {
            const { goals, Movements } = await pathfinderModule();
            active.pathfinder.setMovements(guardBuiltBlocks(active, new Movements(active)));
            await withDeadline(
                active,
                active.pathfinder.goto(new goals.GoalNear(b.position.x, b.position.y, b.position.z, 2)),
                20000,
            );
        } catch (error) {
            if (signal?.aborted || error?.name === 'AbortError') throw error;
        }
        if (!seen())
            throw failWith(
                'not_visible_or_range',
                `Could not get within reach of the ${b.name} at ${b.position.x},${b.position.y},${b.position.z} (you are ${Math.round(active.entity.position.distanceTo(b.position))} blocks away). go_to a spot beside it first.`,
            );
    }
    async function setDoor(active, b, open, signal) {
        if (doorOpen(b) === open) return false;
        if (/^iron_/.test(b.name))
            throw failWith(
                'needs_redstone',
                `The ${b.name} at ${b.position.x},${b.position.y},${b.position.z} only opens with redstone: use a button or lever next to it (interact_block), or swap it for a wooden ${doorKind(b)}.`,
            );
        await reachDoor(active, b, signal);
        await untilAbort(active.lookAt(b.position.offset(0.5, 0.5, 0.5)), signal);
        await untilAbort(active.activateBlock(b), signal);
        for (let i = 0; i < 20 && doorOpen(at(active, b.position.x, b.position.y, b.position.z)) !== open; i++)
            await new Promise(r => setTimeout(r, 50));
        const now = doorOpen(at(active, b.position.x, b.position.y, b.position.z));
        if (now !== open)
            throw failWith(
                'action_failed',
                `Used the ${b.name} at ${b.position.x},${b.position.y},${b.position.z} but it is still ${now ? 'open' : 'closed'}. Something may be standing in it or holding it; look, then try again.`,
            );
        return true;
    }
    async function setDoorPair(active, b, open, signal) {
        const changed = [];
        if (await setDoor(active, b, open, signal)) changed.push(doorPos(b));
        const partner = doorPartner(active, b);
        if (partner && (await setDoor(active, partner, open, signal))) changed.push(doorPos(partner));
        return { changed, partner: partner ? doorPos(partner) : null };
    }
    add(
        'door',
        'Open or close a door, fence gate or trapdoor at (x,y,z) (either half of a door). Reads its current state and only acts if it differs, so it never closes a door you meant to open; walks within reach first; also opens/closes the other leaf of a double door. Iron doors need redstone. Observations list each door/gate with open: true/false.',
        { ...coords, open: { type: 'boolean' } },
        async (a, { bot: active, signal }) => {
            const b = doorAt(active, a.x, a.y, a.z),
                was = doorOpen(b);
            const r = await setDoorPair(active, b, a.open, signal);
            return {
                door: b.name,
                at: doorPos(b),
                was: was ? 'open' : 'closed',
                now: a.open ? 'open' : 'closed',
                changed: r.changed.length > 0,
                ...(r.partner ? { doubleDoorPartner: r.partner } : {}),
            };
        },
        { ...body, required: ['x', 'y', 'z', 'open'] },
    );
    add(
        'go_through_door',
        'Walk through a door or fence gate at (x,y,z): opens it (and its double-door partner), steps to the cell just past it on the far side from you, then closes it behind you unless close_behind is false. Use it to get in or out of buildings and pens while keeping mobs and animals out.',
        { ...coords, close_behind: { type: 'boolean' } },
        async (a, { bot: active, signal }) => {
            const b = doorAt(active, a.x, a.y, a.z),
                kind = doorKind(b);
            if (kind === 'trapdoor')
                throw failWith(
                    'validation',
                    'go_through_door handles doors and fence gates; for a trapdoor use door to open it, then climb or go_to through.',
                );
            const facing = doorProps(b).facing,
                axis = facing === 'east' || facing === 'west' ? 'x' : 'z';
            const p = active.entity.position,
                c = b.position.offset(0.5, 0, 0.5);
            const side = Math.sign(axis === 'x' ? p.x - c.x : p.z - c.z) || 1;
            const far = {
                x: b.position.x + (axis === 'x' ? -side : 0),
                y: b.position.y,
                z: b.position.z + (axis === 'z' ? -side : 0),
            };
            const feet = at(active, far.x, far.y, far.z),
                head = at(active, far.x, far.y + 1, far.z);
            const solid = x => x && x.boundingBox === 'block' && !DOORISH.test(x.name);
            if (solid(feet) || solid(head))
                throw failWith(
                    'blocked',
                    `The far side of the ${b.name} at ${far.x},${far.y},${far.z} is blocked by ${solid(feet) ? feet.name : head.name}; there is nowhere to step through to.`,
                    { far },
                );
            const opened = await setDoorPair(active, b, true, signal);
            const { goals, Movements } = await pathfinderModule();
            active.pathfinder.setMovements(guardBuiltBlocks(active, new Movements(active)));
            try {
                await withDeadline(active, active.pathfinder.goto(new goals.GoalBlock(far.x, far.y, far.z)), 20000);
            } catch (error) {
                if (signal?.aborted || error?.name === 'AbortError') throw error;
                const q = active.entity.position;
                throw failWith(
                    'no_path',
                    `Opened the ${b.name} but could not step through to ${far.x},${far.y},${far.z} (you are at ${Math.floor(q.x)},${Math.floor(q.y)},${Math.floor(q.z)}). It is left open. Check what is in the way, or go_to a spot past it.`,
                    { far },
                );
            }
            let closed = false;
            if (a.close_behind !== false) {
                await setDoorPair(active, doorAt(active, b.position.x, b.position.y, b.position.z), false, signal);
                closed = true;
            }
            const q = active.entity.position;
            return {
                through: b.name,
                at: doorPos(b),
                now: { x: Math.floor(q.x), y: Math.floor(q.y), z: Math.floor(q.z) },
                opened: opened.changed.length > 0,
                closedBehind: closed,
            };
        },
        { ...body, required: ['x', 'y', 'z'] },
    );
}
