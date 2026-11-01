import { abortError, failureCode, failureFacts, withFailureCode } from './failures.js';
import { CHEST_MS, CRAFT_MS, GATHER_MS, PLACE_LINE_MS, PLACE_MS, SMELT_MS, requireFunction } from './runtime.js';
import { integer, object, result, validate } from './schema.js';

export function createCore(ctx) {
    const { bot, goToHint, perception, runner, skills, tools } = ctx;
    const leaveBed = async active => {
        let woke = false;
        const done = new Promise(r => {
            const t = setTimeout(r, 3000);
            active.once?.('wake', () => {
                woke = true;
                clearTimeout(t);
                r();
            });
        });
        const stopSleeping = active.registry?.version?.['>=']?.('1.21.6') ? 0 : 2;
        active._client.write('entity_action', { entityId: active.entity.id, actionId: stopSleeping, jumpBoost: 0 });
        await done;
        if (!woke) active.isSleeping = false;
    };
    const add = (
        toolName,
        description,
        properties,
        fn,
        { body = false, required, idle = false, allowDuringYield } = {},
    ) => {
        const parameters = object(properties, required);
        if (body) parameters.properties.timeout_ms = integer(1, 120000);
        tools.push({
            name: toolName,
            label: toolName.replaceAll('_', ' '),
            description,
            parameters,
            idle,
            body,
            allowDuringYield,
            async execute(_id, args, signal) {
                let code = 'validation';
                try {
                    validate(parameters, args);
                    code = 'unknown';
                    if (signal?.aborted) throw abortError('Tool cancelled');
                    const invoke = async context => {
                        if (body) context.bot.output = '';
                        let leftBed = false;
                        if (body && toolName !== 'sleep' && toolName !== 'wake' && bot.isSleeping) {
                            await leaveBed(bot);
                            leftBed = true;
                        }
                        const value = await fn(args, context);
                        if (value === false) {
                            const missingItem =
                                ['place_block', 'place'].includes(toolName) &&
                                /^Don't have any [a-z0-9_]+ to place\.\n$/.test(context.bot.output);
                            throw withFailureCode(
                                new Error(context.bot.output || 'Action failed; inspect the world before retrying.'),
                                missingItem ? 'missing_item' : 'action_failed',
                            );
                        }
                        return body
                            ? {
                                  completed: true,
                                  result: value ?? null,
                                  log: context.bot.output,
                                  ...(leftBed ? { leftBed: 'You were in bed; got up first.' } : {}),
                              }
                            : value;
                    };
                    const hits = [];
                    const onHit = ev => hits.push(ev);
                    if (body) bot.on?.('pi_hit', onHit);
                    let value;
                    try {
                        value = body
                            ? await runner.run(toolName, invoke, {
                                  signal,
                                  timeoutMs:
                                      args.timeout_ms ??
                                      {
                                          go_to: 90000,
                                          place: PLACE_MS,
                                          place_line: PLACE_LINE_MS,
                                          gather: GATHER_MS,
                                          return_to_surface: 120000,
                                          flee: 65000,
                                          door: 30000,
                                          go_through_door: 45000,
                                          craft: CRAFT_MS,
                                          smelt: SMELT_MS,
                                          deposit: CHEST_MS,
                                          withdraw: CHEST_MS,
                                      }[toolName],
                              })
                            : await invoke({ bot, signal });
                    } finally {
                        if (body) bot.off?.('pi_hit', onHit);
                    }
                    if (hits.length && value && typeof value === 'object' && value.completed) {
                        value.hitsDuring = hits.map(h => ({
                            by: h.by,
                            ...(h.id != null ? { id: h.id } : {}),
                            ...(h.distance != null ? { distance: h.distance } : {}),
                            health: h.health,
                        }));
                        value.healthNow = Math.round(bot.health ?? 0);
                    }
                    if (value?.state && 'frame' in value) {
                        const output = result(value.state);
                        if (value.frame)
                            output.content.push({
                                type: 'image',
                                data: value.frame.data,
                                mimeType: value.frame.mimeType,
                            });
                        return output;
                    }
                    return result(value);
                } catch (error) {
                    if (code !== 'validation') {
                        code = failureCode(error, signal);
                        const reach = { inspect_block: 8, place: 64, break_block: 64, interact_block: 4.5 }[toolName];
                        if (
                            code === 'unknown' &&
                            reach &&
                            String(error.message).startsWith(
                                `Block at ${args.x}, ${args.y}, ${args.z} is not visible within ${reach} blocks.`,
                            )
                        ) {
                            code = 'not_visible_or_range';
                        }
                    }
                    let facts = failureFacts.get(error);
                    if (toolName === 'go_to' && code === 'timeout') {
                        try {
                            const p = bot.entity.position,
                                d = Math.round(Math.hypot(p.x - args.x, p.y - args.y, p.z - args.z));
                            const here = `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`;
                            const hint = goToHint(bot, args);
                            error = new Error(
                                `go_to ran out of time; you stopped at ${here}, ${d} blocks from ${args.x},${args.y},${args.z}. ${hint ?? 'Progress is kept: call go_to again to continue, or pick a closer waypoint.'}`,
                            );
                            facts = {
                                stoppedAt: { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) },
                                distanceToTarget: d,
                            };
                        } catch {}
                    }
                    return withFailureCode(
                        {
                            ...result({
                                error: String(error.message),
                                cancelled: error.name === 'AbortError',
                                ...(facts ? { code, facts } : {}),
                            }),
                            isError: true,
                        },
                        code,
                    );
                }
            },
        });
    };
    const call =
        (method, args) =>
        (_a, { bot: active }) =>
            requireFunction(skills, method)(active, ...args(_a));
    const body = { body: true };
    const blockAt = (active, a, reach = 4.5) => {
        const pos = active.entity.position.offset(
            a.x - active.entity.position.x,
            a.y - active.entity.position.y,
            a.z - active.entity.position.z,
        );
        const block = active.blockAt(pos);
        if (!requireFunction(perception, 'isBlockVisible')(active, block, reach))
            throw withFailureCode(new Error('Block is not currently visible and in reach.'), 'not_visible_or_range');
        return block;
    };
    return { add, blockAt, body, call, leaveBed };
}
