import { choice, coords, integer, name, object, validate } from '../tools/game/schema.js';
import { SIGHT_RANGE } from '../skills/perception.js';

const cellKey = check => `${check.x},${check.y},${check.z}`;
const region = Object.fromEntries(
    [1, 2].flatMap(n => Object.entries(coords).map(([axis, schema]) => [axis + n, schema])),
);
const isSpatial = check => ['block', 'blocks'].includes(check.kind);
const verdict = results =>
    results.some(r => r.passed === false)
        ? false
        : results.length && results.every(r => r.passed === true)
          ? true
          : null;
function* cells(check) {
    if (check.kind === 'block') {
        yield check;
        return;
    }
    for (let x = Math.min(check.x1, check.x2); x <= Math.max(check.x1, check.x2); x++)
        for (let y = Math.min(check.y1, check.y2); y <= Math.max(check.y1, check.y2); y++)
            for (let z = Math.min(check.z1, check.z2); z <= Math.max(check.z1, check.z2); z++) yield { x, y, z };
}

// Definitions, validation, evaluation and descriptions share this registry.
const quantity = properties => ({
    anyOf: [
        object({ ...properties, count: integer(1, 100000), comparison: choice(['at_least']) }, [
            ...Object.keys(properties),
            'count',
        ]),
        object({ ...properties, count: integer(0, 100000), comparison: choice(['equal']) }),
    ],
});
const matches = (observed, check) =>
    check.comparison === 'equal' ? observed === check.count : observed >= check.count;
const amount = check => `${check.comparison === 'equal' ? 'exactly' : 'at least'} ${check.count} ${check.name}`;
const kinds = {
    inventory: {
        schema: quantity({ kind: choice(['inventory']), name }),
        describe: check => `Inventory: ${amount(check)}`,
        evaluate(bot, _perception, check) {
            const observed = bot.inventory
                .items()
                .filter(i => i.name === check.name)
                .reduce((n, i) => n + i.count, 0);
            return { observed, passed: matches(observed, check) };
        },
    },
    block: {
        schema: object({ kind: choice(['block']), name, ...coords }),
        describe: check => `Block: ${check.name} at ${check.x}, ${check.y}, ${check.z}`,
        evaluate(bot, perception, check) {
            const at = bot.entity.position;
            const block = bot.blockAt(at.offset(check.x - at.x, check.y - at.y, check.z - at.z));
            const visible = Boolean(block && perception?.isBlockVisible?.(bot, block, SIGHT_RANGE));
            return { observed: visible ? block.name : null, passed: visible ? block.name === check.name : null };
        },
    },
    blocks: {
        schema: object({ kind: choice(['blocks']), name, ...region }),
        describe: check =>
            `Every block: ${check.name} from ${check.x1},${check.y1},${check.z1} to ${check.x2},${check.y2},${check.z2}`,
        evaluate(bot, perception, check) {
            const results = [...cells(check)].map(cell =>
                kinds.block.evaluate(bot, perception, { ...cell, name: check.name }),
            );
            return { passed: verdict(results) };
        },
    },
    container: {
        schema: quantity({ kind: choice(['container']), name, ...coords }),
        describe: check => `Container at ${check.x}, ${check.y}, ${check.z}: ${amount(check)}`,
        async evaluate(_bot, _perception, check, { inspectContainer, signal }) {
            if (!inspectContainer) throw Error('Container verification requires the guarded container inspector');
            signal?.throwIfAborted();
            const inspected = await inspectContainer(check, signal);
            const observed = inspected.contents[check.name] ?? 0;
            return { observed, passed: matches(observed, check), contents: inspected.contents, chest: inspected.chest };
        },
    },
};
export const workChecks = {
    type: 'array',
    minItems: 0,
    maxItems: 128,
    items: { anyOf: Object.values(kinds).map(k => k.schema) },
};
export function describeWorkCheck(check) {
    return kinds[check.kind]?.describe(check) ?? `${check.kind}: ${check.name}`;
}
export function validateWorkChecks(checks) {
    validate(workChecks, checks, 'checks');
    let count = 0;
    for (const check of checks) {
        if (!isSpatial(check)) continue;
        count +=
            check.kind === 'block'
                ? 1
                : ['x', 'y', 'z'].reduce((n, axis) => n * (Math.abs(check[axis + 2] - check[axis + 1]) + 1), 1);
        if (count > 4096) throw new Error('Verify at most 4096 block cells per bounded batch');
    }
}
export async function verifyWork(bot, perception, task, context = {}) {
    validateWorkChecks(task.checks ?? []);
    const targets = new Map(
        (task.checks ?? []).filter(isSpatial).flatMap(check => [...cells(check)].map(cell => [cellKey(cell), cell])),
    );
    const observed = new Map(),
        attempted = new Set();
    const changed = (_old, block) => {
        if (block?.position) observed.delete(cellKey(block.position));
    };
    bot.on?.('blockUpdate', changed);
    const scan = () => {
        for (const [key, cell] of targets) {
            const r = kinds.block.evaluate(bot, perception, { ...cell, name: '' });
            if (r.observed !== null) observed.set(key, r.observed);
        }
    };
    const spatialResult = check => {
        const entries = [...cells(check)].map(cell => ({ ...cell, observed: observed.get(cellKey(cell)) ?? null }));
        const mismatched = entries.filter(e => e.observed !== null && e.observed !== check.name);
        const unseen = entries.filter(e => e.observed === null);
        return {
            ...check,
            passed: mismatched.length ? false : unseen.length ? null : true,
            ...(check.kind === 'block'
                ? { observed: entries[0].observed }
                : {
                      total: entries.length,
                      matched: entries.length - mismatched.length - unseen.length,
                      mismatched: mismatched.length,
                      unobserved: unseen.length,
                      ...(mismatched.length || unseen.length
                          ? { examples: [...mismatched, ...unseen].slice(0, 8) }
                          : {}),
                  }),
            ...(unseen.length ? { reason: 'unobserved' } : {}),
        };
    };
    try {
        for (;;) {
            context.signal?.throwIfAborted();
            scan();
            const remaining = [...targets].filter(([key]) => !observed.has(key) && !attempted.has(key));
            if (
                !remaining.length ||
                !context.inspectBlock ||
                context.shouldYield?.() ||
                Date.now() >= (context.deadline ?? Infinity)
            )
                break;
            const p = bot.entity.position;
            remaining.sort(
                ([, a], [, b]) =>
                    Math.hypot(a.x - p.x, a.y - p.y, a.z - p.z) - Math.hypot(b.x - p.x, b.y - p.y, b.z - p.z),
            );
            const [key, cell] = remaining[0];
            attempted.add(key);
            try {
                await context.inspectBlock(cell, context.signal);
            } catch (error) {
                if (context.signal?.aborted || error.name === 'AbortError') throw error;
                // An inaccessible viewpoint is unobserved, never proof of a missing block.
                break;
            }
        }
        scan();
        const results = [];
        const stores = new Map();
        for (const check of task.checks ?? []) {
            context.signal?.throwIfAborted();
            if (isSpatial(check)) {
                results.push(spatialResult(check));
            } else {
                try {
                    results.push({
                        ...check,
                        ...(await kinds[check.kind].evaluate(bot, perception, check, {
                            ...context,
                            inspectContainer:
                                context.inspectContainer &&
                                (async (cell, signal) => {
                                    const key = cellKey(cell);
                                    if (!stores.has(key)) stores.set(key, await context.inspectContainer(cell, signal));
                                    return stores.get(key);
                                }),
                        })),
                    });
                } catch (error) {
                    if (context.signal?.aborted || error.name === 'AbortError') throw error;
                    results.push({
                        ...check,
                        observed: null,
                        passed: null,
                        reason: 'unobserved',
                        detail: error.message,
                    });
                }
            }
        }
        scan();
        for (let i = 0; i < results.length; i++) if (isSpatial(results[i])) results[i] = spatialResult(task.checks[i]);
        return {
            at: new Date().toISOString(),
            revision: task.revision,
            passed: verdict(results),
            checks: results,
            position: { ...bot.entity.position },
            inventory: bot.inventory.items().map(i => ({ name: i.name, count: i.count })),
        };
    } finally {
        bot.removeListener?.('blockUpdate', changed);
    }
}

// These are wake hints from known observations, never completion evidence.
export function knownChecksMet(bot, perception, checks, resources = []) {
    validateWorkChecks(checks);
    return (
        checks.length > 0 &&
        checks.every(check => {
            if (check.kind !== 'container') return kinds[check.kind].evaluate(bot, perception, check).passed === true;
            const resource = resources.find(
                r =>
                    r.dimension === (bot.game?.dimension ?? 'overworld') &&
                    ['x', 'y', 'z'].every(k => r.location[k] === check[k]),
            );
            return Boolean(resource && matches(resource.contents[check.name] ?? 0, check));
        })
    );
}
export function waitConditionMet(watch, tasks, checksMet) {
    return Boolean(
        watch &&
        (Object.entries(watch.tasks ?? {}).some(
            ([id, revision]) => tasks.find(t => t.id === Number(id))?.attentionRevision !== revision,
        ) ||
            checksMet(watch.checks ?? [])),
    );
}

export function selfWaitTasks(condition, tasks, self, activeAction = false) {
    if (activeAction || condition?.checks?.length || !condition?.tasks?.length) return [];
    const watched = condition.tasks.map(id => tasks.find(t => t.id === id));
    return watched.every(
        t => t?.state === 'working' && t.owner?.toLowerCase() === self.toLowerCase() && !t.unmetDependencies?.length,
    )
        ? watched.map(t => t.id)
        : [];
}
