import { setTimeout as delay } from 'node:timers/promises';
import { failWith } from './failures.js';
import { number, peer } from './schema.js';

export function createFollowing({ add, bot, runner, pathfinderModule, progressWatch, stallWatch }) {
    add(
        'follow_player',
        'Keep following a moving, loaded player in the background while you wait or communicate. Returns after following starts. No teleporting, digging or pillaring. Stops on stop_action, another physical action, cancellation, a lost player or an unreachable route; inspect action in observations. Do not replace it with repeated go_to calls.',
        { player: peer, distance: number(1, 8) },
        async a => {
            const player = Object.keys(bot.players ?? {}).find(p => p.toLowerCase() === a.player.toLowerCase());
            const entity = () => bot.players?.[player]?.entity;
            if (!player || player.toLowerCase() === bot.username.toLowerCase() || !entity()?.position)
                throw failWith('not_found', 'Choose another player currently loaded nearby.');
            const distance = a.distance ?? 3;
            const { Movements, goals } = await pathfinderModule();
            await runner.start('follow_player', async ({ bot: active, signal, ready }) => {
                let target = entity();
                const movements = new Movements(active);
                movements.canDig = false;
                movements.allow1by1towers = false;
                active.pathfinder.setMovements(movements);
                const follow = () => active.pathfinder.setGoal(new goals.GoalFollow(target, distance), true);
                const progress = progressWatch(active, () => target.position, {
                    ...active.pi_goWatch,
                    within: distance + 1,
                });
                const jumps = stallWatch(active);
                let noPathAt = null;
                const pathUpdate = path => {
                    if (path.status === 'noPath') noPathAt ??= Date.now();
                    else if (path.status === 'success') noPathAt = null;
                };
                active.on('path_update', pathUpdate);
                try {
                    follow();
                    ready();
                    for (;;) {
                        await delay(250, undefined, { signal });
                        const current = entity();
                        if (!current?.position)
                            throw failWith(
                                'not_found',
                                `Lost sight of ${player}; following stopped. Ask them to return nearby.`,
                            );
                        if (current !== target) {
                            target = current;
                            noPathAt = null;
                            follow();
                        }
                        const gap = active.entity.position.distanceTo(target.position);
                        if (gap <= distance + 1) noPathAt = null;
                        if (jumps.stalled || progress.stalled || (noPathAt && Date.now() - noPathAt >= 2000))
                            throw failWith(
                                'no_path',
                                `Following ${player} stopped: no safe progress, ${gap.toFixed(1)} blocks away. Inspect the route and choose reachable ground before following again.`,
                            );
                    }
                } finally {
                    active.removeListener('path_update', pathUpdate);
                    progress.stop();
                    jumps.stop();
                }
            });
            return { following: player, distance, background: true };
        },
        { required: ['player'] },
    );
}
