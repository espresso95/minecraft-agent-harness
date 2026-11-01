// One presentation for the Minecraft mod and web UI. Reports are informational;
// only the actual runtime determines whether an agent is thinking or acting.
export function workView({ goals, activities, resources }, name = null, waitReason = null) {
    const activity = activities.find(a => a.agent.toLowerCase() === name?.toLowerCase());
    const summary = name
        ? [
              { label: 'Activity', value: activity?.activity ?? 'No report yet' },
              { label: 'Blocker', value: activity?.blocker ?? 'None reported' },
              ...(waitReason ? [{ label: 'Waiting', value: waitReason }] : []),
          ]
        : [{ label: 'Active goals', value: String(goals.filter(g => g.state === 'active').length) }];
    if (resources.length)
        summary.push({
            label: 'Known stockpiles',
            value: resources
                .slice(0, 5)
                .map(
                    r =>
                        `${r.dimension} (${r.location.x},${r.location.y},${r.location.z}): ${
                            Object.entries(r.contents)
                                .map(([item, count]) => `${count} ${item}`)
                                .join(', ') || 'empty'
                        } · observed by ${r.observer} at ${new Date(r.observedAt).toISOString()}`,
                )
                .join('; '),
        });
    const fields = values =>
        Object.entries(values)
            .filter(([, v]) => v !== undefined && v !== null && v !== '')
            .map(([label, value]) => ({ label, value: String(value) }));
    return {
        summary,
        items: [
            ...goals
                .slice(-30)
                .reverse()
                .map(g => ({
                    id: g.id,
                    state: g.state,
                    title: `Goal #${g.id}: ${g.title}`,
                    detail: `${g.state} · updated by ${g.updatedBy}`,
                    fields: fields({
                        Objective: g.scope,
                        State: g.state,
                        'Updated at': new Date(g.updatedAt).toISOString(),
                    }),
                })),
            ...activities
                .filter(a => !name || a.agent.toLowerCase() === name.toLowerCase())
                .map(a => ({
                    id: a.id,
                    state: a.status,
                    title: `${a.agent}: ${a.activity}`,
                    detail: `${a.status} · reported at ${new Date(a.updatedAt).toISOString()}`,
                    fields: fields({
                        Goal: a.goalId,
                        Activity: a.activity,
                        Blocker: a.blocker,
                        Evidence: a.evidence,
                        'Updated at': new Date(a.updatedAt).toISOString(),
                    }),
                })),
        ],
    };
}
