import { allowedGameMode } from './runtime.js';

export const SAFE_DROP = 3;

export const DOORISH = /(_door|_fence_gate|_trapdoor)$/;

export const doorOpen = b => {
    const v = (b?.getProperties?.() ?? b?._properties ?? {}).open;
    return v === true || v === 'true';
};

export const KEEP_MOVING_TOOLS = new Set(['go_to', 'follow_player', 'move', 'flee', 'return_to_surface']);

export function interruptsOnHit(active, hasSource) {
    const act = String(active ?? '');
    return Boolean(hasSource && act && act !== 'attack' && !KEEP_MOVING_TOOLS.has(act));
}

export function tossLandDistance(pitch, dy = 0) {
    let x = 0,
        y = 1.32,
        vx = Math.cos(pitch) * 0.3,
        vy = Math.sin(pitch) * 0.3 + 0.1;
    for (let t = 0; t < 200; t++) {
        vy -= 0.04;
        if (y + vy <= dy && vy < 0) {
            let v = vx * 0.588;
            while (Math.abs(v) > 0.003) {
                x += v;
                v *= 0.588;
            }
            return x;
        }
        y += vy;
        x += vx;
        vx *= 0.98;
        vy *= 0.98;
    }
    return x;
}

export function tossPitchFor(dist, dy = 0) {
    let best = -1.25,
        err = Infinity;
    for (let deg = dy > 0.5 ? 20 : -85; deg <= (dy > 0.5 ? 88 : 15); deg += 1) {
        const p = (deg * Math.PI) / 180,
            e = Math.abs(tossLandDistance(p, dy) - dist);
        if (e < err) {
            err = e;
            best = p;
        }
    }
    return best;
}

const cellAt = (bot, x, y, z) => {
    const p = bot.entity.position;
    return bot.blockAt?.(p.offset(x + 0.5 - p.x, y + 0.5 - p.y, z + 0.5 - p.z));
};

export function openDropBelow(bot, x, feetY, z, limit = 8) {
    for (let d = 1; d <= limit; d++) {
        const b = cellAt(bot, x, feetY - d, z);
        if (!b) return 0;
        if (b.name === 'water') return d - 1;
        if (b.name === 'lava') return Infinity;
        if (b.boundingBox === 'block') return d - 1;
    }
    return Infinity;
}

export const fmtDrop = d => (Number.isFinite(d) ? String(d) : 'more than 8');

export function edgeGuardTick(bot) {
    const e = bot.entity;
    if (!e?.onGround || !e.velocity || allowedGameMode(bot) === 'creative') return false;
    const v = e.velocity,
        sp = Math.hypot(v.x, v.z);
    if (!(sp > 0.03)) return false;
    const p = e.position,
        qx = p.x + (v.x / sp) * 0.7,
        qz = p.z + (v.z / sp) * 0.7,
        fy = Math.floor(p.y + 0.01);
    let worst = null;
    for (const cx of new Set([Math.floor(qx - 0.3), Math.floor(qx + 0.3)]))
        for (const cz of new Set([Math.floor(qz - 0.3), Math.floor(qz + 0.3)])) {
            const feet = cellAt(bot, cx, fy, cz);
            if (!feet || feet.boundingBox === 'block') return false;
            const drop = openDropBelow(bot, cx, fy, cz);
            if (drop <= SAFE_DROP) return false;
            if (!worst || drop < worst.drop) worst = { x: cx, z: cz, drop };
        }
    const drop = worst.drop;
    bot.pi_edgeStop = { at: Date.now(), x: worst.x, y: fy, z: worst.z, drop };
    try {
        bot.pathfinder?.setGoal?.(null);
    } catch {}
    bot.clearControlStates?.();
    v.x = 0;
    v.z = 0;
    return true;
}

export function installEdgeGuard(bot) {
    if (typeof bot?.on !== 'function' || bot.pi_edgeGuardInstalled) return;
    bot.pi_edgeGuardInstalled = true;
    bot.on('physicsTick', () => {
        try {
            edgeGuardTick(bot);
        } catch {}
    });
}

export function swimGuardTick(bot) {
    const e = bot.entity;
    if (!e?.position || bot.isSleeping) return false;
    const p = e.position,
        x = Math.floor(p.x),
        z = Math.floor(p.z);
    const wet = b => b?.name === 'water' || b?.name === 'bubble_column' || b?.getProperties?.()?.waterlogged === true;
    const head = wet(cellAt(bot, x, Math.floor(p.y + 1.5), z)),
        feet = wet(cellAt(bot, x, Math.floor(p.y + 0.2), z));
    const need = head || (feet && !e.onGround);
    if (need && !bot.pathfinder?.isMoving?.()) {
        if (!bot.controlState?.jump) {
            bot.setControlState('jump', true);
            bot.pi_swimHeld = true;
        }
        return true;
    }
    if (bot.pi_swimHeld && !need) {
        bot.pi_swimHeld = false;
        if (!bot.pathfinder?.isMoving?.()) bot.setControlState('jump', false);
    }
    return false;
}

export function installSwimGuard(bot) {
    if (typeof bot?.on !== 'function' || bot.pi_swimGuardInstalled) return;
    bot.pi_swimGuardInstalled = true;
    bot.on('physicsTick', () => {
        try {
            swimGuardTick(bot);
        } catch {}
    });
}

// A conservative clearing policy, not an inference about who placed a block.
// Unknown materials remain protected. Passability and harvestability are separate.
const TERRAIN_MATERIALS =
    /^(stone|dirt|grass_block|coarse_dirt|rooted_dirt|podzol|mycelium|dirt_path|farmland|mud|clay|gravel|sand|red_sand|sandstone|red_sandstone|andesite|diorite|granite|deepslate|tuff|calcite|dripstone_block|pointed_dripstone|moss_block|moss_carpet|smooth_basalt|short_grass|tall_grass|fern|large_fern|dead_bush|leaf_litter|.*_ore|.*terracotta|snow|snow_block|ice|packed_ice|.*leaves|vine|sugar_cane)$/;

export function canClearTerrain(block) {
    const properties = block?.getProperties?.() ?? block?._properties ?? {};
    return (
        TERRAIN_MATERIALS.test(block?.name ?? '') && properties.persistent !== true && properties.persistent !== 'true'
    );
}

const builtBlockIds = new WeakMap();

export function guardBuiltBlocks(bot, movements) {
    if (movements && typeof movements === 'object') {
        movements.maxDropDown = SAFE_DROP;
        movements.allowParkour = false;
    }
    const blocks = bot?.registry?.blocksArray;
    if (!movements?.blocksCantBreak?.add || !Array.isArray(blocks)) return movements;
    let ids = builtBlockIds.get(bot);
    if (!ids)
        builtBlockIds.set(
            bot,
            (ids = blocks
                .filter(b => b.diggable !== false && !/air$/.test(b.name) && !canClearTerrain(b))
                .map(b => b.id)),
        );
    for (const id of ids) movements.blocksCantBreak.add(id);
    return movements;
}
