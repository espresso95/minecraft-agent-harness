const LABELS = {
    thinking: 'Thinking…',
    working: 'Working',
    waiting: 'Waiting',
    standby: 'Standby',
    paused: 'Paused',
    blocked: 'Blocked',
    starting: 'Joining',
    reconnecting: 'Reconnecting',
    stopped: 'Stopped',
    failed: 'Failed',
    dead: 'Dead',
};

export function agentStatus(state, runtime, usage) {
    const phase =
        state === 'running'
            ? runtime?.blocked
                ? 'blocked'
                : usage.pending > 0
                  ? 'thinking'
                  : runtime?.action
                    ? 'working'
                    : 'waiting'
            : state;
    return { phase, label: LABELS[phase] ?? phase };
}
