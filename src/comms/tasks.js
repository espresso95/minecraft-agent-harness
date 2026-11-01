import { validateWorkChecks } from '../work/checks.js';
// Task state is a projection of the durable mailbox log, never a second queue.
export const TASK_UPDATES = Object.freeze({
    accepted: 'working',
    working: 'working',
    blocked: 'blocked',
    completed: 'completed',
    cancelled: 'cancelled',
    released: 'ready',
    revised: null,
});
export const terminalTask = task => ['completed', 'cancelled'].includes(task?.state);
export const TASK_ROWS =
    "json_extract(metadata, '$.type') = 'request' OR json_extract(metadata, '$.taskId') IS NOT NULL";

export class TaskProjection {
    constructor(db) {
        this.db = db;
    }
    invalidate() {
        this.revision = undefined;
    }
    snapshot() {
        const revision = this.db
            .prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM mailbox_dm WHERE ${TASK_ROWS}`)
            .get().id;
        if (revision !== this.revision) {
            this.tasks = projectTasks(
                this.db
                    .prepare(`SELECT * FROM mailbox_dm WHERE ${TASK_ROWS} ORDER BY id`)
                    .all()
                    .map(({ metadata, ...row }) => ({ ...row, ...JSON.parse(metadata) })),
            );
            this.revision = revision;
        }
        return structuredClone(this.tasks ?? []);
    }
}
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const fields = new Set([
    'key',
    'shared',
    'kind',
    'goalId',
    'source',
    'dependencies',
    'assignedTo',
    'scope',
    'checks',
    'priority',
    'title',
    'checkpoint',
    'evidence',
    'verification',
    'release',
]);

export function taskMetadata(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !fields.has(k)))
        throw new TypeError('Invalid task fields');
    for (const key of ['key', 'scope', 'title', 'source', 'checkpoint', 'evidence'])
        if (value[key] !== undefined && (typeof value[key] !== 'string' || value[key].length > 2000))
            throw new TypeError(`Invalid task ${key}`);
    for (const key of ['shared', 'release'])
        if (value[key] !== undefined && typeof value[key] !== 'boolean') throw new TypeError(`Invalid task ${key}`);
    if (value.kind !== undefined && !['goal', 'task'].includes(value.kind)) throw new TypeError('Invalid task kind');
    if (value.goalId !== undefined && (!Number.isSafeInteger(value.goalId) || value.goalId < 1))
        throw new TypeError('Invalid goal ID');
    if (value.priority !== undefined && (!Number.isSafeInteger(value.priority) || Math.abs(value.priority) > 100))
        throw new TypeError('Invalid task priority');
    if (value.assignedTo !== undefined && value.assignedTo !== null && !/^[A-Za-z0-9_]{1,16}$/.test(value.assignedTo))
        throw new TypeError('Invalid task assignee');
    if (
        value.dependencies !== undefined &&
        (!Array.isArray(value.dependencies) ||
            value.dependencies.length > 64 ||
            value.dependencies.some(id => !Number.isSafeInteger(id) || id < 1) ||
            new Set(value.dependencies).size !== value.dependencies.length)
    )
        throw new TypeError('Dependencies must be unique task IDs');
    if (value.checks !== undefined) validateWorkChecks(value.checks);
    if (
        value.verification !== undefined &&
        (!value.verification ||
            typeof value.verification !== 'object' ||
            JSON.stringify(value.verification).length > 32000)
    )
        throw new TypeError('Invalid task verification');
    return value;
}

export function projectTasks(messages) {
    const tasks = new Map();
    for (const m of messages) {
        if (m.type === 'request') {
            const d = m.task ?? {};
            tasks.set(m.id, {
                id: m.id,
                creator: m.sender,
                recipient: m.recipient,
                title: m.text,
                kind: 'task',
                shared: false,
                assignedTo: m.recipient,
                dependencies: [],
                priority: 0,
                ...d,
                owner: null,
                state: 'ready',
                createdAt: m.createdAt,
                updatedAt: m.createdAt,
                revision: m.id,
                attentionRevision: m.id,
            });
        } else if (m.taskId && Object.hasOwn(TASK_UPDATES, m.type)) {
            const task = tasks.get(m.taskId);
            if (!task) continue;
            Object.assign(task, m.task ?? {}, { updatedAt: m.createdAt, revision: m.id, lastMessage: m.text });
            const state = TASK_UPDATES[m.type];
            if (!['accepted', 'working'].includes(m.type)) task.attentionRevision = m.id;
            if (state) task.state = state;
            if (m.type === 'accepted' || m.type === 'working') task.owner = task.shared ? m.sender : task.assignedTo;
            if (m.type === 'released' || m.task?.release || terminalTask(task)) task.owner = null;
            if (m.type === 'completed') task.completedBy = m.sender;
            if (m.type === 'blocked') task.blocker = m.text;
            else if (state) delete task.blocker;
        }
    }
    for (const task of tasks.values()) {
        const goal = tasks.get(task.goalId);
        task.unmetDependencies = task.dependencies.filter(id => tasks.get(id)?.state !== 'completed');
        task.goalActive = !task.goalId || (goal?.kind === 'goal' && !terminalTask(goal) && goal.state !== 'blocked');
        if (task.state === 'ready' && (task.unmetDependencies.length || !task.goalActive)) task.state = 'waiting';
    }
    return [...tasks.values()];
}

export function eligibleTask(task, self) {
    return (
        task.kind === 'task' &&
        task.state === 'ready' &&
        !task.owner &&
        task.goalActive &&
        (!task.assignedTo || same(task.assignedTo, self)) &&
        (task.shared || same(task.recipient, self))
    );
}

export function workOverview(tasks, self) {
    const open = tasks.filter(t => !terminalTask(t));
    const current = open.filter(t => same(t.owner, self));
    const ready = open.filter(t => eligibleTask(t, self)).sort((a, b) => b.priority - a.priority || a.id - b.id);
    const blocked = open.filter(t => t.state === 'blocked' && (t.shared || same(t.assignedTo, self)));
    const brief = t => ({
        id: t.id,
        goalId: t.goalId ?? null,
        title: t.title,
        state: t.state,
        owner: t.owner,
        revision: t.revision,
        ...(t.blocker ? { blocker: t.blocker } : {}),
        ...(t.checkpoint ? { checkpoint: t.checkpoint } : {}),
    });
    return {
        attentionRevision: Math.max(
            0,
            ...tasks
                .filter(t => t.shared && (t.kind === 'goal' ? !terminalTask(t) : t.goalActive))
                .map(t => t.attentionRevision),
        ),
        goals: open
            .filter(t => t.kind === 'goal' && t.shared)
            .slice(-5)
            .map(brief),
        current: current.map(brief),
        ready: ready.slice(0, 5).map(brief),
        readyCount: ready.length,
        blocked: blocked.slice(0, 5).map(brief),
        waitingReason: current.length
            ? null
            : ready.length
              ? 'Ready work available'
              : blocked.length
                ? 'Work is blocked; inspect blockers or revise the plan'
                : open.some(t => t.kind === 'goal')
                  ? 'Active goal has no ready work; review dependencies or propose the next task'
                  : 'No active shared goal or assigned work',
    };
}

export function validateTaskChange(tasks, task, type, actor, patch = {}) {
    if (!task) throw new TypeError('Unknown task ID; ordinary message IDs are not task IDs');
    if (terminalTask(task)) throw new TypeError('This task is already closed; create a new request for new work');
    if (!task.shared && !same(actor, task.creator) && !same(actor, task.recipient))
        throw new TypeError('Task belongs to different participants');
    const goal = tasks.find(t => t.id === task.goalId);
    const author = same(actor, task.creator) || same(actor, goal?.creator);
    const owner = same(actor, task.owner);
    if ((type === 'released' || patch.release) && task.owner && !owner)
        throw new TypeError('Only the owner can release a live claim');
    if (type === 'working' && task.shared && !owner) throw new TypeError('Claim the task before executing it');
    if (type === 'accepted') {
        if (owner && task.goalActive && !task.unmetDependencies.length) return;
        if (!eligibleTask(task, actor))
            throw new TypeError('Task is not ready, is assigned elsewhere, or is already claimed');
    } else if (
        !author &&
        !owner &&
        !(type === 'working' && eligibleTask(task, actor)) &&
        !(task.shared && task.kind === 'task' && task.state === 'blocked' && !task.owner && type === 'released') &&
        !(!task.shared && same(actor, task.recipient))
    ) {
        throw new TypeError('Only the owner or task author can change this task');
    }
    if (['shared', 'kind', 'goalId', 'source', 'key'].some(k => k in patch))
        throw new TypeError('Task identity and goal cannot be changed');
    if (['checks', 'assignedTo', 'scope', 'title', 'dependencies', 'priority'].some(k => k in patch) && !author)
        throw new TypeError('Only the task author can revise its definition');
    if (type === 'completed' && task.unmetDependencies.length)
        throw new TypeError('Complete the task dependencies first');
    if (
        type === 'completed' &&
        task.kind === 'goal' &&
        tasks.some(t => t.goalId === task.id && t.state !== 'completed' && t.state !== 'cancelled')
    )
        throw new TypeError('Finish or cancel the goal tasks first');
    if (
        type === 'completed' &&
        task.checks?.length &&
        (!patch.verification?.passed || patch.verification.revision !== task.revision)
    )
        throw new TypeError('Use work_update to verify the current completion checks before completing this task');
    validateDependencies(tasks, task.id, patch.dependencies ?? task.dependencies, task.goalId);
}

export function validateDependencies(tasks, id, dependencies, goalId) {
    const byId = new Map(tasks.map(t => [t.id, t]));
    const visit = (next, seen) => {
        if (next === id) throw new TypeError('Task dependencies must not contain a cycle');
        if (seen.has(next)) return;
        seen.add(next);
        const task = byId.get(next);
        if (!task || task.kind !== 'task' || (goalId && task.goalId !== goalId))
            throw new TypeError('Dependencies must refer to tasks in the same goal');
        for (const child of task.dependencies) visit(child, seen);
    };
    for (const dependency of dependencies) visit(dependency, new Set());
}
