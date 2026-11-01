// Model responses omit internal projection fields and do not echo submitted data.
export function taskView(task, details = false, tasks = []) {
    const keys = details
        ? [
              'id',
              'key',
              'creator',
              'kind',
              'goalId',
              'title',
              'state',
              'owner',
              'assignedTo',
              'dependencies',
              'unmetDependencies',
              'revision',
              'scope',
              'checks',
              'checkpoint',
              'blocker',
              'evidence',
              'verification',
              'completedBy',
          ]
        : [
              'id',
              'key',
              'creator',
              'kind',
              'goalId',
              'title',
              'state',
              'owner',
              'assignedTo',
              'dependencies',
              'unmetDependencies',
              'revision',
              'blocker',
          ];
    const project = details && tasks.find(t => t.id === task.goalId);
    return {
        ...Object.fromEntries(keys.filter(key => task[key] !== undefined).map(key => [key, task[key]])),
        ...(project ? { project: { id: project.id, revision: project.revision, scope: project.scope } } : {}),
    };
}
export function taskReceipt(task) {
    return {
        id: task.id,
        revision: task.revision,
        state: task.state,
        owner: task.owner,
        ...(task.verification ? { verification: task.verification } : {}),
    };
}
