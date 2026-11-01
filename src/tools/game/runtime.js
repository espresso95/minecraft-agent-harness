import { AsyncLocalStorage } from 'node:async_hooks';
import { abortError, withFailureCode } from './failures.js';
import { guardBuiltBlocks, installEdgeGuard, installSwimGuard } from './guards.js';

const compatibility = Symbol('piSkillCompatibility');

const MAX_LOG = 12000;

export const LATE_MUTATION_REFUSED = 'LATE_MUTATION_REFUSED';

export const requireFunction = (object, name) => {
    if (typeof object?.[name] !== 'function') throw new Error(`Capability unavailable: ${name}`);
    return object[name].bind(object);
};

export const allowedGameMode = bot => (bot.pi_game_mode === 'creative' ? 'creative' : 'survival');

export const assertSurvival = bot => {
    if (!bot.entity?.position || bot.game?.gameMode !== allowedGameMode(bot) || bot.modes?.isOn('cheat')) {
        throw new Error(`A spawned ${allowedGameMode(bot)} player with cheats disabled is required.`);
    }
};

export function installSkillCompatibility(bot) {
    if (bot[compatibility]) return bot;
    if (bot.modes) throw new Error('Refusing a bot with an existing modes controller. Use a fresh Pi bot.');
    const paused = new Set();
    bot.modes = Object.freeze({
        isOn: () => false,
        pause: name => {
            paused.add(name);
        },
        unpause: name => {
            paused.delete(name);
        },
        getPaused: () => [...paused],
    });
    let output = '';
    Object.defineProperty(bot, 'output', {
        configurable: true,
        get: () => output,
        set: value => {
            output = String(value).slice(-MAX_LOG);
        },
    });
    bot.interrupt_code = false;
    bot.restrict_to_inventory = allowedGameMode(bot) !== 'creative';
    bot.pi_terrainGuard = movements => guardBuiltBlocks(bot, movements);
    if (bot.pathfinder?.setMovements) {
        const setMovements = bot.pathfinder.setMovements.bind(bot.pathfinder);
        bot.pathfinder.setMovements = movements => {
            guardBuiltBlocks(bot, movements);
            movements.allowFreeMotion = allowedGameMode(bot) === 'creative' && !bot.pi_no_flight;
            return setMovements(movements);
        };
    }
    installEdgeGuard(bot);
    installSwimGuard(bot);
    bot[compatibility] = true;
    return bot;
}

export function settleInventory(bot, { quietMs = 250, maxMs = 1500 } = {}) {
    const inv = bot?.inventory;
    if (!inv?.on) return Promise.resolve();
    return new Promise(resolve => {
        let quiet;
        const done = () => {
            clearTimeout(quiet);
            clearTimeout(cap);
            inv.removeListener('updateSlot', bump);
            resolve();
        };
        const bump = () => {
            clearTimeout(quiet);
            quiet = setTimeout(done, quietMs);
        };
        const cap = setTimeout(done, maxMs);
        inv.on('updateSlot', bump);
        bump();
    });
}

export async function stopBody(bot, { closeWindow = false } = {}) {
    bot.interrupt_code = true;
    const calls = [
        () => bot.pathfinder?.setGoal(null),
        () => bot.pathfinder?.stop(),
        () => bot.pvp?.stop(),
        () => bot.collectBlock?.cancelTask(),
        () => bot.stopDigging?.(),
        () => bot.deactivateItem?.(),
        () => bot.clearControlStates?.(),
        () => closeWindow && bot.currentWindow && bot.closeWindow?.(bot.currentWindow),
    ];
    const outcomes = await Promise.allSettled(
        calls.map(call => {
            try {
                return Promise.resolve(call());
            } catch (error) {
                return Promise.reject(error);
            }
        }),
    );
    if (outcomes.some(outcome => outcome.status === 'rejected')) throw new Error('A body controller failed to stop.');
}

function actionBot(bot, signal) {
    const cleanup = new Set([
        'clearControlStates',
        'stopDigging',
        'deactivateItem',
        'closeWindow',
        'stop',
        'cancelTask',
        'close',
    ]);
    const mutators = new Set([
        'look',
        'lookAt',
        'setControlState',
        'setQuickBarSlot',
        'equip',
        'unequip',
        'dig',
        'placeBlock',
        'activateBlock',
        'activateEntity',
        'activateItem',
        'useOn',
        'consume',
        'attack',
        'craft',
        'toss',
        'sleep',
        'wake',
        'clickWindow',
        'trade',
        'openContainer',
        'openFurnace',
        'openVillager',
        'goto',
        'setGoal',
        'setMovements',
        'collect',
        'equipForBlock',
        'deposit',
        'withdraw',
        'putFuel',
        'putInput',
        'takeFuel',
        'takeInput',
        'takeOutput',
    ]);
    const plugins = new Set(['pathfinder', 'collectBlock', 'pvp', 'tool']);
    const wrap = object =>
        new Proxy(object, {
            get(target, key) {
                if (target === bot && key === 'interrupt_code') return signal.aborted || bot.interrupt_code;
                if (key === '_client') throw new Error('Not available to skills.');
                if (key === 'creative') {
                    if (allowedGameMode(bot) !== 'creative') throw new Error('Not available to survival skills.');
                    assertSurvival(bot);
                    const creative = Reflect.get(target, key, target);
                    return { setInventorySlot: (...args) => creative.setInventorySlot(...args) };
                }
                const value = Reflect.get(target, key, target);
                if (plugins.has(key) && value) return wrap(value);
                if (typeof value !== 'function') return value;
                if (key === 'chat')
                    return () => {
                        throw new Error('Skills cannot send chat. Use post_chat.');
                    };
                return (...args) => {
                    if (mutators.has(key) && !cleanup.has(key)) {
                        if (signal.aborted) throw signal.reason ?? abortError('Action cancelled');
                        assertSurvival(bot);
                    }
                    const result = value.apply(target, args);
                    if (['openContainer', 'openFurnace', 'openVillager'].includes(key)) {
                        return Promise.resolve(result).then(window => wrap(window));
                    }
                    return result;
                };
            },
        });
    return wrap(bot);
}

export const actionBoundaries = new WeakMap();

const mutationPackets = new Set([
    'block_dig',
    'block_place',
    'use_item',
    'use_entity',
    'window_click',
    'held_item_slot',
    'arm_animation',
    'enchant_item',
    'select_trade',
    'name_item',
    'update_sign',
    'edit_book',
    'set_creative_slot',
    'update_command_block',
]);

function installActionBoundary(bot) {
    if (actionBoundaries.has(bot)) return actionBoundaries.get(bot);
    const context = new AsyncLocalStorage();
    const boundary = { context, blocked: false };
    if (typeof bot.emit === 'function') {
        const emit = bot.emit;
        bot.emit = function (event, ...args) {
            const owner = boundary.owner;
            // Native pathfinding runs on external physics ticks. Give those ticks
            // the current action's authority, but never replace a stale owner.
            if (event === 'physicsTick' && !context.getStore() && owner?.active && !owner.signal.aborted)
                return context.run(owner, () => emit.call(this, event, ...args));
            return emit.call(this, event, ...args);
        };
    }
    const assertCurrent = (allowUnscoped = false) => {
        const owner = context.getStore();
        if (!owner && allowUnscoped) return;
        if (boundary.blocked || !owner || !owner.active || owner.signal.aborted) {
            throw Object.assign(abortError('Native mutation refused: originating action is cancelled or completed.'), {
                code: LATE_MUTATION_REFUSED,
            });
        }
    };
    const clients = new WeakSet();
    const windows = new WeakSet();
    const guardWindow = window => {
        if (!window || typeof window.acceptClick !== 'function' || windows.has(window)) return window;
        const acceptClick = window.acceptClick;
        window.acceptClick = function (...args) {
            assertCurrent(true);
            return acceptClick.apply(this, args);
        };
        windows.add(window);
        return window;
    };
    for (const property of ['inventory', 'currentWindow']) {
        const descriptor = Object.getOwnPropertyDescriptor(bot, property);
        if (descriptor && !descriptor.configurable) continue;
        if (descriptor?.get || descriptor?.set) continue;
        let value = guardWindow(bot[property]);
        Object.defineProperty(bot, property, {
            configurable: true,
            enumerable: true,
            get: () => value,
            set: next => {
                value = guardWindow(next);
            },
        });
    }
    boundary.ensure = () => {
        const client = bot._client;
        if (!client?.write || clients.has(client)) return;
        const write = client.write;
        let slotEcho = null;
        if (typeof client.emit === 'function') {
            const emit = client.emit;
            client.emit = function (name, packet, ...rest) {
                if (name !== 'held_item_slot') return emit.call(this, name, packet, ...rest);
                const previous = slotEcho;
                slotEcho =
                    !context.getStore() && Number.isInteger(packet?.slot) && packet.slot >= 0 && packet.slot < 9
                        ? { slot: packet.slot, used: false }
                        : null;
                try {
                    return emit.call(this, name, packet, ...rest);
                } finally {
                    slotEcho = previous;
                }
            };
        }
        client.write = function (name, data, ...rest) {
            const cleanup = name === 'block_dig' && [1, 5].includes(data?.status);
            const authoritativeEcho =
                name === 'held_item_slot' &&
                !boundary.blocked &&
                !context.getStore() &&
                slotEcho &&
                !slotEcho.used &&
                data?.slotId === slotEcho.slot;
            if (authoritativeEcho) slotEcho.used = true;
            if (mutationPackets.has(name) && !cleanup && !authoritativeEcho) assertCurrent();
            return write.call(this, name, data, ...rest);
        };
        clients.add(client);
    };
    boundary.ensure();
    actionBoundaries.set(bot, boundary);
    return boundary;
}

export function untilAbort(promise, signal) {
    if (signal.aborted) return Promise.reject(signal.reason ?? abortError('Action cancelled'));
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(signal.reason ?? abortError('Action cancelled'));
        signal.addEventListener('abort', onAbort, { once: true });
        Promise.resolve(promise)
            .then(resolve, reject)
            .finally(() => signal.removeEventListener('abort', onAbort));
    });
}

const FLY_STEP = 0.5,
    FLY_TICK_MS = 50,
    FLY_STALL_STEPS = 40;

export async function flyCooperatively(bot, creative, target, signal) {
    const { Vec3 } = await import('vec3');
    if (signal.aborted) throw signal.reason ?? abortError('Flight cancelled');
    creative.startFlying();
    const abort = () => {
        try {
            creative.stopFlying();
        } catch {}
        throw signal.reason ?? abortError('Flight cancelled');
    };
    let best = Infinity,
        stalled = 0;
    for (;;) {
        if (signal.aborted) abort();
        const vector = target.minus(bot.entity.position);
        const magnitude = vector.norm();
        if (magnitude <= FLY_STEP) break;
        if (magnitude < best - FLY_STEP / 5) {
            best = magnitude;
            stalled = 0;
        } else if (++stalled >= FLY_STALL_STEPS) {
            throw withFailureCode(
                new Error(
                    `Flight stalled ${magnitude.toFixed(1)} blocks from the target; the straight-line path is probably blocked. Fly a clear path or a nearer waypoint.`,
                ),
                'action_failed',
            );
        }
        bot.physics.gravity = 0;
        bot.entity.velocity = new Vec3(0, 0, 0);
        bot.entity.position.add(vector.scaled(FLY_STEP / magnitude));
        await new Promise(resolve => setTimeout(resolve, FLY_TICK_MS));
    }
    if (signal.aborted) abort();
    bot.entity.position = target.clone();
    await new Promise(resolve => setTimeout(resolve, FLY_TICK_MS));
}

export const PLACE_MS = 60000,
    PLACE_LINE_MS = 120000,
    GATHER_MS = 120000,
    CRAFT_MS = 60000,
    SMELT_MS = 120000,
    CHEST_MS = 90000;

export const gatherSkips = new Map();

export const posKey = p => `${p.x},${p.y},${p.z}`;

export function createActionRunner(
    bot,
    {
        defaultTimeoutMs = 30000,
        maxTimeoutMs = 120000,
        settleTimeoutMs = 1500,
        onFatal = () => {},
        onBackgroundError = () => {},
    } = {},
) {
    if (
        ![defaultTimeoutMs, maxTimeoutMs, settleTimeoutMs].every(n => Number.isFinite(n) && n > 0) ||
        defaultTimeoutMs > maxTimeoutMs
    ) {
        throw new Error('Action deadlines must be finite positive milliseconds.');
    }
    const boundary = installActionBoundary(bot);
    let tail = Promise.resolve();
    let current = null;
    let fatal = null;
    let stopGeneration = 0;
    const poison = error => {
        if (fatal) return;
        fatal = error;
        boundary.blocked = true;
        void stopBody(bot, { closeWindow: true }).catch(() => {});
        try {
            bot.quit?.('Pi action did not stop safely');
        } catch {}
        try {
            Promise.resolve(onFatal(error)).catch(() => {});
        } catch {}
    };
    const runner = {
        get status() {
            return {
                active: current?.name ?? null,
                background: current?.background ?? false,
                blocked: Boolean(fatal),
            };
        },
        async start(name, fn) {
            let ready,
                running = false;
            const started = new Promise(resolve => {
                ready = () => {
                    running = true;
                    resolve();
                };
            });
            const work = runner.run(name, context => fn({ ...context, ready }), { background: true });
            void work.catch(error => {
                if (running && error.name !== 'AbortError') {
                    try {
                        onBackgroundError(name, error);
                    } catch {}
                }
            });
            await Promise.race([
                started,
                work.then(() => {
                    throw new Error(`${name} ended before starting`);
                }),
            ]);
            return runner.status;
        },
        interrupt(reason) {
            current?.controller.abort(abortError(reason || 'Interrupted: you were hit'));
        },
        async stop() {
            stopGeneration++;
            current?.controller.abort(abortError('Stopped by explicit request'));
            let timer;
            try {
                await Promise.race([
                    stopBody(bot, { closeWindow: true }),
                    new Promise((_, reject) => {
                        timer = setTimeout(
                            () => reject(new Error('Body stop did not settle; reconnect required.')),
                            settleTimeoutMs,
                        );
                    }),
                ]);
            } catch (error) {
                poison(error);
            } finally {
                clearTimeout(timer);
            }
            return { stopped: !fatal, blocked: Boolean(fatal) };
        },
        async run(name, fn, { signal, timeoutMs = defaultTimeoutMs, background = false } = {}) {
            if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > maxTimeoutMs)
                throw new Error('Invalid action deadline.');
            if (fatal) throw fatal;
            if (current?.background) await runner.stop();
            const generation = stopGeneration;
            const controller = new AbortController();
            const forward = () => controller.abort(abortError('Action cancelled'));
            if (signal?.aborted) forward();
            else signal?.addEventListener('abort', forward, { once: true });
            const deadline = background ? Infinity : Date.now() + timeoutMs;
            const timer = background
                ? null
                : setTimeout(
                      () =>
                          controller.abort(
                              withFailureCode(abortError(`Action deadline exceeded (${timeoutMs}ms)`), 'timeout'),
                          ),
                      timeoutMs,
                  );
            let rejectAbort;
            const cancelled = new Promise((_, reject) => {
                rejectAbort = reject;
            });
            cancelled.catch(() => {});
            const onAbort = () => rejectAbort(controller.signal.reason);
            controller.signal.addEventListener('abort', onAbort, { once: true });
            if (controller.signal.aborted) onAbort();
            let started = false;
            const job = tail.then(async () => {
                if (fatal) throw fatal;
                if (controller.signal.aborted) throw controller.signal.reason;
                if (generation !== stopGeneration) throw abortError('Queued action cancelled by stop');
                assertSurvival(bot);
                boundary.ensure();
                const owner = { signal: controller.signal, active: true };
                boundary.owner = owner;
                started = true;
                current = { name, controller, background };
                bot.interrupt_code = false;
                let stopping;
                const stop = () => {
                    stopping ??= stopBody(bot, { closeWindow: true });
                    stopping.catch(() => {});
                };
                controller.signal.addEventListener('abort', stop, { once: true });
                const work = Promise.resolve().then(() => {
                    if (controller.signal.aborted) throw controller.signal.reason;
                    return boundary.context.run(owner, () =>
                        fn({ bot: actionBot(bot, controller.signal), signal: controller.signal, deadline }),
                    );
                });
                let outcome,
                    slotChanges = 0;
                const onSlot = () => slotChanges++;
                const inv = bot.inventory;
                inv?.on?.('updateSlot', onSlot);
                try {
                    outcome = { value: await Promise.race([work, cancelled]) };
                } catch (error) {
                    outcome = { error };
                } finally {
                    inv?.removeListener?.('updateSlot', onSlot);
                }
                if (slotChanges && !controller.signal.aborted) await settleInventory(bot);
                owner.active = false;
                boundary.owner = null;
                if (controller.signal.aborted) stop();
                stopping ??= stopBody(bot);
                let grace;
                const settled = await Promise.race([
                    Promise.all([work.catch(() => {}), stopping]).then(
                        () => true,
                        () => false,
                    ),
                    new Promise(resolve => {
                        grace = setTimeout(() => resolve(false), settleTimeoutMs);
                    }),
                ]);
                clearTimeout(grace);
                if (!settled)
                    poison(new Error(`Action ${name} or its stop did not settle safely; reconnect required.`));
                controller.signal.removeEventListener('abort', stop);
                current = null;
                if (fatal) throw fatal;
                if (Object.hasOwn(outcome, 'error')) throw outcome.error;
                return outcome.value;
            });
            tail = job.catch(() => {});
            try {
                return await Promise.race([job, cancelled]);
            } catch (error) {
                if (started) await job.catch(() => {});
                throw error;
            } finally {
                clearTimeout(timer);
                signal?.removeEventListener('abort', forward);
                controller.signal.removeEventListener('abort', onAbort);
            }
        },
    };
    return runner;
}
