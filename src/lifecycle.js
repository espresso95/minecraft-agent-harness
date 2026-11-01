import path from 'node:path';
export function validateAgentConfig(settings, now = Date.now()) {
    const p = settings.profile;
    if (!/^[A-Za-z0-9_]{1,16}$/.test(p?.name ?? ''))
        throw new Error('Agent name must be 1-16 letters, digits or underscores');
    const c = p.pi;
    if (
        !c ||
        !['stateRoot', 'sharedRoot', 'mailboxPath', 'planPath'].every(
            k => typeof c[k] === 'string' && path.isAbsolute(c[k]),
        )
    )
        throw new Error('Explicit absolute state paths required');
    const deadline = c.deadlineAt == null ? Infinity : Date.parse(c.deadlineAt);
    if (Number.isNaN(deadline) || deadline <= now) throw new Error('Deadline is invalid or already passed');
    if (!p.objective?.trim()) throw new Error('An objective is required');
    if (!settings.host || !Number.isInteger(settings.port)) throw new Error('Server host and port are required');
    return { ...c, deadline };
}
export function isRefusedLateMutation(error) {
    return error?.name === 'AbortError' && error?.code === 'LATE_MUTATION_REFUSED';
}
export function safeError(error) {
    const identifier = value => (typeof value === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(value) ? value : undefined);
    return {
        errorName: identifier(error?.name),
        errorCode: identifier(error?.code),
        ...(Number.isInteger(error?.status) ? { httpStatus: error.status } : {}),
    };
}

export function runtimeStatus(runner, actionRunner, bot, now = Date.now()) {
    const pos = bot.entity?.position;
    return {
        at: new Date(now).toISOString(),
        activeCycle: Boolean(runner?.active),
        nextWakeAt:
            !runner?.paused && !runner?.closed && Number.isFinite(runner?.nextWakeAt) ? runner.nextWakeAt : null,
        paused: Boolean(runner?.paused),
        standby: Boolean(runner?.standby),
        waitReason: runner?.waitReason ?? null,
        action: actionRunner.status.active,
        blocked: actionRunner.status.blocked,
        health: bot.health,
        food: bot.food,
        oxygen: bot.oxygenLevel,
        timeOfDay: bot.time?.timeOfDay,
        position: pos ? { x: pos.x, y: pos.y, z: pos.z } : null,
    };
}
