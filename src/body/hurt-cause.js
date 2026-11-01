const LABELS = {
    lava: 'lava',
    in_fire: 'standing in fire',
    on_fire: 'burning (you are on fire)',
    campfire: 'campfire',
    hot_floor: 'magma block',
    drown: 'drowning (out of air)',
    in_wall: 'suffocating inside a block',
    fall: 'fall damage',
    starve: 'starvation (food bar is empty)',
    cactus: 'cactus',
    sweet_berry_bush: 'berry bush',
    freeze: 'freezing in powder snow',
    lightning_bolt: 'lightning',
    out_of_world: 'fell out of the world',
    wither: 'wither effect',
    magic: 'magic (potion/effect)',
    indirect_magic: 'magic (potion/effect)',
    cramming: 'too many entities in one spot',
    fly_into_wall: 'flew into a wall',
    stalagmite: 'landed on a stalagmite',
    falling_block: 'falling block',
    falling_anvil: 'falling anvil',
    falling_stalactite: 'falling stalactite',
    dragon_breath: 'dragon breath',
    explosion: 'explosion',
    player_explosion: 'explosion',
    bad_respawn_point: 'bed/anchor explosion',
    generic: 'generic damage',
    generic_kill: 'killed by command',
    outside_border: 'outside the world border',
    dry_out: 'dried out',
};
export const causeLabel = type => (type ? (LABELS[type] ?? type.replace(/_/g, ' ')) : 'unknown cause');
export function attackDamageStop(source, cause, targetId, description) {
    if (!source) return cause === 'starve' ? null : 'environment_damage';
    return source.id === targetId ? null : `hit_by_other: ${description}`;
}
export function installDamageTypes(bot) {
    const client = bot?._client;
    if (!client?.prependListener || bot.pi_damageTypesInstalled) return;
    bot.pi_damageTypesInstalled = true;
    bot.pi_damageTypes = [];
    client.on('registry_data', p => {
        if (p?.id?.replace('minecraft:', '') !== 'damage_type' || !Array.isArray(p.entries)) return;
        bot.pi_damageTypes = p.entries.map(e => String(e.key ?? '').replace('minecraft:', ''));
    });
    client.prependListener('damage_event', p => {
        if (p?.entityId !== bot.entity?.id) return;
        bot.pi_lastDamageType = bot.pi_damageTypes[p.sourceTypeId] ?? null;
        bot.pi_recentDamage = { type: bot.pi_lastDamageType, at: Date.now() };
    });
}
export function isStarvationDamage(bot, now = Date.now()) {
    const recent = bot?.pi_recentDamage;
    if (recent && now - recent.at <= 1500) return recent.type === 'starve';
    return !bot?.pi_damageTypes?.length && bot?.food === 0;
}
const evText = ev =>
    ev.id != null
        ? `${ev.by} (entity id ${ev.id}${ev.kind ? `, ${ev.kind}` : ''}${ev.at ? `, at ${ev.at.x},${ev.at.y},${ev.at.z}` : ''})${ev.offset ? `, ${ev.offset.distance} blocks away (dx ${ev.offset.dx}, dy ${ev.offset.dy}, dz ${ev.offset.dz})` : ''}`
        : ev.by;
export function formatHitAlert(unseen, health) {
    const groups = new Map();
    for (const ev of unseen) {
        const key = ev.id != null ? `e${ev.id}` : `c${ev.cause ?? ev.by}`;
        const g = groups.get(key);
        groups.set(key, { ev, n: (g?.n ?? 0) + 1 });
    }
    const parts = [...groups.values()].map(({ ev, n }) => `${evText(ev)}${n > 1 ? ` x${n}` : ''}`);
    const fight = unseen.some(ev => ev.id != null)
        ? ' You can fight back with attack(id) or get away with flee(id).'
        : '';
    return `YOU WERE HIT ${unseen.length}x since your last look: ${parts.join('; ')}. Health now ${Math.round(health)}/20.${fight}`;
}
