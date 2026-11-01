// Shared goals, personal activity and observed stockpiles are views of the mailbox
// event log. They inform agents and both clients; they never schedule game actions.
export const WORK_ROWS =
    "json_extract(metadata, '$.type') IN ('request','revised','completed','cancelled','activity','observation')";

export class WorkProjection {
    constructor(db) {
        this.db = db;
    }
    invalidate() {
        this.revision = undefined;
    }
    snapshot() {
        const revision = this.db
            .prepare(`SELECT COALESCE(MAX(id),0) AS id FROM mailbox_dm WHERE ${WORK_ROWS}`)
            .get().id;
        if (revision !== this.revision) {
            const goals = new Map(),
                activities = new Map(),
                resources = new Map();
            for (const row of this.db.prepare(`SELECT * FROM mailbox_dm WHERE ${WORK_ROWS} ORDER BY id`).all()) {
                const event = JSON.parse(row.metadata);
                if (event.type === 'request' && event.task?.kind === 'goal') {
                    goals.set(row.id, {
                        id: row.id,
                        title: row.text,
                        scope: event.task.scope ?? '',
                        state: event.task.state ?? 'active',
                        source: event.task.source,
                        updatedBy: row.sender,
                        updatedAt: row.createdAt,
                        revision: row.id,
                    });
                } else if (goals.has(event.taskId)) {
                    const goal = goals.get(event.taskId);
                    for (const key of ['title', 'scope', 'state'])
                        if (event.task?.[key] !== undefined) goal[key] = event.task[key];
                    if (['completed', 'cancelled'].includes(event.type)) goal.state = event.type;
                    Object.assign(goal, { updatedBy: row.sender, updatedAt: row.createdAt, revision: row.id });
                } else if (event.type === 'activity') {
                    activities.set(row.sender.toLowerCase(), {
                        id: activities.get(row.sender.toLowerCase())?.id ?? row.id,
                        agent: row.sender,
                        ...event.activity,
                        updatedAt: row.createdAt,
                    });
                } else if (event.type === 'observation') {
                    resources.set(event.resource.key, {
                        ...event.resource,
                        observer: row.sender,
                        observedAt: row.createdAt,
                    });
                }
            }
            this.value = {
                goals: [...goals.values()],
                activities: [...activities.values()].sort((a, b) => b.updatedAt - a.updatedAt),
                resources: [...resources.values()].sort((a, b) => b.observedAt - a.observedAt),
            };
            this.revision = revision;
        }
        return structuredClone(this.value);
    }
}

export function workContext({ goals, activities, resources }) {
    const active = goals.filter(g => g.state === 'active');
    return {
        goals: active.slice(-5).map(({ id, title, scope }) => ({ id, title, scope })),
        activities: activities.slice(0, 20).map(({ id, updatedAt, ...activity }) => activity),
        resources: resources.slice(0, 12),
        ...(active.length > 5 || activities.length > 20 || resources.length > 12
            ? { more: 'Read work_status for the full shared context.' }
            : {}),
    };
}
