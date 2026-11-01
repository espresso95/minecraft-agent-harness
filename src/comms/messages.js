import { TASK_UPDATES, taskMetadata } from './tasks.js';

export const MESSAGE_TYPES = Object.freeze({
    message: { wake: true },
    observation: { wake: false },
    request: { wake: true },
    ...Object.fromEntries(
        Object.keys(TASK_UPDATES).map(type => [
            type,
            {
                wake: !['accepted', 'working'].includes(type),
                taskUpdate: true,
                ...(['completed', 'cancelled'].includes(type) ? { terminal: true } : {}),
            },
        ]),
    ),
});

export function messageMetadata(value = {}) {
    if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).some(key => !['type', 'taskId', 'urgent', 'task'].includes(key))
    )
        throw new TypeError('Invalid message metadata');
    const { type = 'message', taskId, urgent = false, task } = value;
    if (
        !Object.hasOwn(MESSAGE_TYPES, type) ||
        type === 'observation' ||
        typeof urgent !== 'boolean' ||
        (taskId !== undefined && (!Number.isSafeInteger(taskId) || taskId < 1))
    )
        throw new TypeError('Invalid message type, task ID or urgency');
    if (type === 'request' && taskId !== undefined) throw new TypeError('New requests create their own task ID');
    if (MESSAGE_TYPES[type].taskUpdate && taskId === undefined)
        throw new TypeError('Task updates require the original request taskId');
    if (task !== undefined && type !== 'request' && !MESSAGE_TYPES[type].taskUpdate)
        throw new TypeError('Task fields need a task message');
    return {
        ...(type !== 'message' ? { type } : {}),
        ...(taskId ? { taskId } : {}),
        ...(urgent ? { urgent } : {}),
        ...(task !== undefined ? { task: taskMetadata(task) } : {}),
    };
}

export function decodeMessage({ metadata = '{}', ...message }) {
    return { ...message, ...JSON.parse(metadata) };
}

export function messagePolicy(message, peers) {
    const human = !peers.some(name => name.toLowerCase() === message.sender.toLowerCase());
    return {
        human,
        wake: human || message.urgent === true || MESSAGE_TYPES[message.type ?? 'message'].wake,
        interrupt: human || message.urgent === true,
        yield: human || message.urgent === true || ['cancelled', 'revised'].includes(message.type),
    };
}
