import { terminalTask, workOverview } from '../comms/tasks.js';
import { describeWorkCheck } from '../work/checks.js';

// Both clients render these fields verbatim; task policy stays in the backend.
export function workView(tasks, name, waitReason = null) {
    const overview = name ? workOverview(tasks, name) : null;
    const open = tasks.filter(t => !terminalTask(t));
    const summary = overview
        ? [
              { label: 'Current', value: overview.current.map(t => `#${t.id} ${t.title}`).join('; ') || 'None' },
              {
                  label: 'Next ready',
                  value: overview.ready[0] ? `#${overview.ready[0].id} ${overview.ready[0].title}` : 'None',
              },
              { label: 'Blocker', value: overview.blocked.map(t => t.blocker).join('; ') || 'None recorded' },
              { label: 'Status', value: waitReason || overview.waitingReason || 'Executing claimed work' },
          ]
        : [
              { label: 'Active goals', value: String(open.filter(t => t.kind === 'goal').length) },
              {
                  label: 'Ready tasks',
                  value: String(open.filter(t => t.kind === 'task' && t.state === 'ready').length),
              },
              { label: 'Blocked tasks', value: String(open.filter(t => t.state === 'blocked').length) },
          ];
    const relevant = name
        ? tasks.filter(
              t =>
                  t.kind === 'goal' ||
                  t.owner?.toLowerCase() === name.toLowerCase() ||
                  t.assignedTo?.toLowerCase() === name.toLowerCase() ||
                  (t.shared && !terminalTask(t)),
          )
        : tasks;
    return {
        ...(overview
            ? {
                  availability: {
                      ready: overview.readyCount,
                      claimed: overview.current.length,
                      blocked: overview.blocked.length,
                      waitReason: waitReason || overview.waitingReason,
                  },
              }
            : {}),
        summary,
        items: [...relevant].reverse().map(t => ({
            id: t.id,
            state: t.state,
            title: `${t.kind === 'goal' ? 'Goal' : 'Task'} #${t.id}: ${t.title}`,
            detail: `${t.kind === 'goal' && t.state === 'ready' ? 'active' : t.state} · ${t.completedBy ?? t.owner ?? t.assignedTo ?? 'Unclaimed'}${t.state === 'completed' ? (t.verification?.passed ? ' · checks passed' : ' · reported completion') : ''}`,
            fields: Object.entries({
                State: t.state,
                Goal: t.goalId,
                Owner: t.owner,
                'Completion reported by': t.completedBy,
                Assignee: t.assignedTo,
                Scope: t.scope,
                Dependencies: t.dependencies.join(', ') || 'None',
                'Unmet dependencies': t.unmetDependencies.join(', ') || 'None',
                'Completion checks': t.checks?.length
                    ? t.checks.map(describeWorkCheck).join('; ')
                    : 'No independent checks defined',
                Checkpoint: t.checkpoint,
                Blocker: t.blocker,
                Evidence: t.evidence,
                Verification: t.verification
                    ? t.verification.checks
                          ?.map(
                              check =>
                                  `${check.passed ? 'Passed' : 'Failed'}: ${describeWorkCheck(check)} (observed: ${check.observed ?? 'not visible'})`,
                          )
                          .join('; ') || 'No independent checks defined'
                    : null,
            })
                .filter(([, v]) => v !== undefined && v !== null && v !== '')
                .map(([label, value]) => ({ label, value: String(value) })),
        })),
    };
}
