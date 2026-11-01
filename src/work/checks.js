import { choice, coords, integer, name, object, validate } from '../tools/game/schema.js';

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
            const visible = Boolean(block && perception?.isBlockVisible?.(bot, block, 64));
            return { observed: visible ? block.name : null, passed: visible && block.name === check.name };
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
}
export async function verifyWork(bot, perception, task, context = {}) {
    validateWorkChecks(task.checks ?? []);
    const results = [];
    for (const check of task.checks ?? []) {
        context.signal?.throwIfAborted();
        results.push({ ...check, ...(await kinds[check.kind].evaluate(bot, perception, check, context)) });
    }
    return {
        at: new Date().toISOString(),
        revision: task.revision,
        passed: results.length ? results.every(r => r.passed) : null,
        checks: results,
        position: { ...bot.entity.position },
        inventory: bot.inventory.items().map(i => ({ name: i.name, count: i.count })),
    };
}

// These are wake hints from known observations, never completion evidence.
export function knownChecksMet(bot, perception, checks, resources = []) {
    return (
        checks.length > 0 &&
        checks.every(check => {
            if (check.kind !== 'container') return kinds[check.kind].evaluate(bot, perception, check).passed;
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
