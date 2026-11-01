import { choice, coords, integer, name, object, validate } from '../tools/game/schema.js';

// One registry owns each check's schema and fresh-world evaluation.
const kinds = {
    inventory: {
        schema: object({ kind: choice(['inventory']), name, count: integer(0, 100000) }),
        describe: check => `Inventory: at least ${check.count} ${check.name}`,
        evaluate(bot, _perception, check) {
            const observed = bot.inventory
                .items()
                .filter(i => i.name === check.name)
                .reduce((n, i) => n + i.count, 0);
            return { observed, passed: observed >= check.count };
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
};
export function describeWorkCheck(check) {
    return kinds[check.kind]?.describe(check) ?? `${check.kind}: ${check.name}`;
}
export const workChecks = {
    type: 'array',
    minItems: 0,
    maxItems: 128,
    items: object(
        {
            ...Object.assign({}, ...Object.values(kinds).map(k => k.schema.properties)),
            kind: choice(Object.keys(kinds)),
        },
        ['kind', 'name'],
    ),
};
export function validateWorkChecks(checks) {
    validate(workChecks, checks);
    for (const check of checks) validate(kinds[check.kind].schema, check);
}
export function verifyWork(bot, perception, task) {
    validateWorkChecks(task.checks ?? []);
    const results = (task.checks ?? []).map(check => ({
        ...check,
        ...kinds[check.kind].evaluate(bot, perception, check),
    }));
    return {
        at: new Date().toISOString(),
        revision: task.revision,
        passed: results.length ? results.every(r => r.passed) : null,
        checks: results,
        position: { ...bot.entity.position },
        inventory: bot.inventory.items().map(i => ({ name: i.name, count: i.count })),
    };
}
