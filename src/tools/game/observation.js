import { abortError } from './failures.js';
import { DOORISH, doorOpen } from './guards.js';
import { requireFunction } from './runtime.js';

const position = v => v && { x: v.x, y: v.y, z: v.z };

export const item = i => i && { name: i.name, count: i.count, slot: i.slot };

export function inventory(bot) {
    return {
        items: bot.inventory.items().map(item),
        heldItem: item(bot.heldItem),
        equipment: bot.inventory.slots.slice(5, 9).map(item),
        offHand: item(bot.inventory.slots[45]),
    };
}

// Full snapshots, with repeated field names written once. Only rectangular
// collections are packed; mixed shapes and small collections stay ordinary JSON.
function observationTable(records) {
    if (!Array.isArray(records) || records.length < 2) return records;
    const flatten = (value, path = [], cells = []) => {
        if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length)
            for (const [key, child] of Object.entries(value)) flatten(child, [...path, key], cells);
        else cells.push([path, value]);
        return cells;
    };
    if (!records.every(record => record && typeof record === 'object' && !Array.isArray(record))) return records;
    const flattened = records.map(record => flatten(record));
    const columns = flattened[0].map(([path]) => path);
    const schema = JSON.stringify(columns);
    if (!flattened.every(cells => JSON.stringify(cells.map(([path]) => path)) === schema)) return records;
    const table = { columns, rows: flattened.map(cells => cells.map(([, value]) => value)) };
    return Buffer.byteLength(JSON.stringify(table)) < Buffer.byteLength(JSON.stringify(records)) ? table : records;
}

export function serializeObservation(state) {
    // Match the existing JSON semantics for undefined values, numbers and dates.
    // Do not mutate the live snapshot used by tools, scripts or telemetry.
    const snapshot = JSON.parse(JSON.stringify(state));
    for (const [parent, key] of [
        [snapshot, 'blocks'],
        [snapshot, 'entities'],
        [snapshot.inventory, 'items'],
        [snapshot.recentPublicChat, 'messages'],
        ...['goals', 'current', 'ready', 'blocked'].map(key => [snapshot.work, key]),
    ])
        if (parent && Object.hasOwn(parent, key)) parent[key] = observationTable(parent[key]);
    return JSON.stringify(snapshot);
}

export function createObservation({ bot, perception, world, captureFrame, mailbox, actionRunner }) {
    return async ({ image = true, range = 16, block = '', signal } = {}) => {
        if (signal?.aborted) throw abortError('Observation cancelled');
        if (!bot.entity?.position) throw new Error('Player has not spawned.');
        if (!Number.isFinite(range) || range < 1 || range > 64) throw new Error('Observation range must be 1..64.');
        const visibleBlock = requireFunction(perception, 'isBlockVisible');
        const visibleEntity = requireFunction(perception, 'isEntityVisible');
        const blocks = requireFunction(world, 'getNearestBlocks')(bot, block || null, range, 128)
            .filter(b => visibleBlock(bot, b, range))
            .slice(0, 64)
            .map(b => ({
                name: b.name,
                position: position(b.position),
                ...(DOORISH.test(b.name) ? { open: doorOpen(b) } : {}),
            }));
        const entities = Object.values(bot.entities)
            .filter(e => visibleEntity(bot, e, range))
            .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
            .slice(0, 40)
            .map(e => ({ id: e.id, name: e.name, username: e.username, position: position(e.position) }));
        const state = {
            capturedAt: new Date().toISOString(),
            player: bot.username,
            position: position(bot.entity.position),
            yaw: bot.entity.yaw,
            pitch: bot.entity.pitch,
            health: bot.health,
            food: bot.food,
            ...(actionRunner ? { action: actionRunner.status } : {}),
            oxygen: bot.oxygenLevel,
            ...(bot.isSleeping ? { inBed: true } : {}),
            gameMode: bot.game?.gameMode,
            timeOfDay: bot.time?.timeOfDay,
            raining: bot.isRaining,
            inventory: inventory(bot),
            blocks,
            entities,
            visibility: '360-degree local line-of-sight survey; not a chunk or hidden-entity scan.',
            ...(mailbox
                ? {
                      messaging: mailbox.summary(),
                      recentPublicChat: mailbox.recentChat(),
                      ...(mailbox.work ? { work: mailbox.work() } : {}),
                  }
                : {}),
        };
        let frame;
        if (image) {
            if (!captureFrame) state.imageError = 'Fresh first-person camera unavailable.';
            else {
                try {
                    frame = await captureFrame({ signal });
                    if (!frame?.data || !['image/png', 'image/jpeg', 'image/webp'].includes(frame.mimeType))
                        throw new Error('Camera returned no usable image.');
                    const { data, ...metadata } = frame;
                    state.camera = metadata;
                } catch (error) {
                    state.imageError = String(error.message);
                    frame = undefined;
                }
            }
        }
        if (signal?.aborted) throw abortError('Observation cancelled');
        return { state, frame };
    };
}
