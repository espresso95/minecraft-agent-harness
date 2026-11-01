import { authorizeTaskChange } from '../../comms/tasks.js';
import { choice, integer, object, peer, text } from './schema.js';
import { workChecks, verifyWork } from '../../work/checks.js';
import { taskView, taskReceipt } from '../../work/task-view.js';

const id = integer(1, Number.MAX_SAFE_INTEGER);
const dependencies = { type: 'array', items: id, minItems: 0, maxItems: 64 };
const checks = workChecks;
const definition = {
    dependencies,
    assignedTo: { ...peer, description: 'Exact registered agent from directory, never a human. Omit for shared work.' },
    scope: text(2000, 0),
    checks,
    priority: integer(-100, 100),
};

export function createWork(ctx) {
    const { add, bot, mailbox, peers, perception, runner } = ctx;
    if (!mailbox) return;
    const visible = () =>
        mailbox
            .tasks()
            .filter(
                t => t.shared || [t.creator, t.recipient].some(n => n.toLowerCase() === bot.username.toLowerCase()),
            );
    add(
        'work_plan',
        'Reuse the goal in your observation; goalId adds independent work and delegated handoffs to it. Otherwise create a human-authorized goal and task frontier atomically. sourceMessageId/sourceChatId deduplicates the human instruction. Use stable keys; after lists prerequisite keys, dependencies lists existing IDs. Depend only on what the next useful section needs, not all project materials or preparation. Define observable checks for quantities, deliveries and construction. claim:true begins your ready task in this call. Omit assignedTo for shared work; never assign the human. Plan meaningful checked chunks, not status steps.',
        {
            goalId: id,
            title: text(2000),
            sourceMessageId: id,
            sourceChatId: id,
            scope: text(2000, 0),
            checks,
            tasks: {
                type: 'array',
                minItems: 1,
                maxItems: 16,
                items: object(
                    {
                        key: text(64),
                        title: text(2000),
                        after: { type: 'array', items: text(64), minItems: 0, maxItems: 64 },
                        claim: { type: 'boolean' },
                        ...definition,
                    },
                    ['key', 'title'],
                ),
            },
        },
        a => {
            if (!a.goalId && !a.title?.trim()) throw new Error('Give a goal title or an existing goalId');
            const source = a.sourceMessageId
                ? mailbox.taskSource(a.sourceMessageId)
                : a.sourceChatId
                  ? mailbox.chatSource(a.sourceChatId)
                  : null;
            if (source && [bot.username, ...peers].some(n => n.toLowerCase() === source.sender.toLowerCase()))
                throw new Error('Use the human instruction as the goal source');
            const tasks = a.tasks.map(task => {
                if (!task.assignedTo) return task;
                const name = [bot.username, ...peers].find(n => n.toLowerCase() === task.assignedTo.toLowerCase());
                if (!name) throw new Error('Assign to a registered agent, or omit assignedTo');
                return { ...task, assignedTo: name };
            });
            const plan = mailbox.planWork({ ...a, tasks });
            return {
                goal: taskView(plan.goal, true),
                tasks: plan.tasks.map(t => taskView(t, t.owner === bot.username, visible())),
            };
        },
        { required: ['tasks'] },
    );
    add(
        'work_tasks',
        'List compact task records. id returns one full definition/checkpoint. Fresh observations already show current and ready work; do not reread the unchanged board. Claim returns the full definition. Revisions prevent stale decisions.',
        { id, goalId: id, query: text(200, 0), after: integer(0, Number.MAX_SAFE_INTEGER) },
        a => {
            const snapshot = visible();
            const all = snapshot.filter(
                t =>
                    (!a.id || t.id === a.id) &&
                    (!a.goalId || t.goalId === a.goalId || t.id === a.goalId) &&
                    (!a.query || JSON.stringify(t).toLowerCase().includes(a.query.toLowerCase())) &&
                    t.id > (a.after ?? 0),
            );
            const tasks = all.slice(0, 20);
            return {
                tasks: tasks.map(t => taskView(t, Boolean(a.id), snapshot)),
                nextAfter: tasks.at(-1)?.id ?? a.after ?? 0,
                hasMore: all.length > tasks.length,
            };
        },
        { required: [], idle: true, allowDuringYield: a => Number.isSafeInteger(a.id) },
    );
    add(
        'work_claim',
        'Atomically begin a ready task at its current revision and return its full definition/checkpoint. Only one agent can own it. No separate working status call is needed; act, then checkpoint meaningful progress. Verify saved progress before resuming.',
        { taskId: id, revision: id },
        a =>
            taskView(
                mailbox.updateTask(a.taskId, { state: 'claimed', revision: a.revision, note: 'Work started' }),
                true,
                visible(),
            ),
    );
    add(
        'work_update',
        'Checkpoint, report a blocker, release, revise, cancel or complete work at its current revision. Completion runs fresh checks; failed checks leave the task open. Without checks, completion is explicitly reported, not independently verified. Only authors can revise definitions.',
        {
            taskId: id,
            revision: id,
            state: choice(['checkpoint', 'blocked', 'ready', 'revised', 'completed', 'cancelled']),
            note: text(2000),
            checkpoint: text(2000, 0),
            evidence: text(2000, 0),
            title: text(2000),
            ...definition,
        },
        async (a, { bot: active, signal, deadline }) => {
            const { taskId, ...update } = a;
            const task = visible().find(t => t.id === taskId);
            if (!task) throw new Error('Unknown or private task');
            if (a.state === 'checkpoint') {
                if (task.owner?.toLowerCase() !== bot.username.toLowerCase())
                    throw new Error('Only the owner can checkpoint work');
                update.state = task.state === 'blocked' ? 'blocked' : 'working';
                update.checkpoint = a.checkpoint ?? a.note;
                if (task.state === 'blocked') update.note = task.blocker;
            }
            if (a.state === 'ready' && task.owner && runner.status.active)
                throw new Error('Stop the active body action before releasing your claim');
            if (a.state === 'completed' && task.state !== 'completed') {
                if (a.revision !== task.revision)
                    throw new Error('Task changed; read the current revision before acting');
                authorizeTaskChange(mailbox.tasks(), task, 'completed', bot.username, update);
                if (!((a.checks ?? task.checks)?.length || a.evidence?.trim()))
                    throw new Error('Give completion evidence or define observable checks');
                update.verification = await verifyWork(
                    active,
                    perception,
                    { ...task, checks: a.checks ?? task.checks },
                    {
                        signal,
                        deadline,
                        shouldYield: ctx.shouldYield,
                        inspectBlock: (check, signal) => ctx.inspectBlock(active, check, signal),
                        inspectContainer: check => ctx.inspectStore(active, check, signal),
                    },
                );
                if ((a.checks ?? task.checks)?.length && update.verification.passed !== true)
                    return { completed: false, verification: update.verification, task: taskReceipt(task) };
            }
            return taskReceipt(mailbox.updateTask(taskId, update));
        },
        {
            body: a =>
                a.state === 'completed' &&
                Boolean(
                    (a.checks ?? visible().find(t => t.id === a.taskId)?.checks)?.some(c => c.kind !== 'inventory'),
                ),
            complete: value => value.completed !== false,
            required: ['taskId', 'revision', 'state', 'note'],
            allowDuringYield: a =>
                a.state === 'checkpoint' &&
                typeof a.checkpoint === 'string' &&
                Object.keys(a).every(k => ['taskId', 'revision', 'state', 'note', 'checkpoint'].includes(k)),
        },
    );
}
