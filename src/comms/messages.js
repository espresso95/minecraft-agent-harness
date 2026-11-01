export function messageMetadata(value = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'urgent'))
        throw new TypeError('Invalid message metadata');
    const { urgent = false } = value;
    if (typeof urgent !== 'boolean') throw new TypeError('Invalid message urgency');
    return urgent ? { urgent: true } : {};
}

export function decodeMessage({ metadata = '{}', ...message }) {
    return { ...message, ...JSON.parse(metadata) };
}

export function messagePolicy(message, peers) {
    const human = !peers.some(name => name.toLowerCase() === message.sender.toLowerCase());
    return {
        human,
        wake: true,
        interrupt: human || message.urgent === true,
        yield: human || message.urgent === true,
    };
}
