import { resolveConfig } from '../config.js';

export const validName = name => typeof name === 'string' && /^[A-Za-z0-9_]{1,16}$/.test(name);
export const defaultProfile = Object.freeze({
    model: 'openai/gpt-6-luna',
    thinking: 'xhigh',
    personality: '',
    skin: '',
    objective:
        'Assist the human player, cooperate with the other companions, and protect existing builds. Read new messages and reply briefly. When there is no useful task, wait 60 seconds.',
});
const fields = ['name', 'model', 'thinking', 'personality', 'objective', 'skin'];

export function profile(input, catalog) {
    if (
        !input ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        Object.keys(input).some(k => !fields.includes(k))
    )
        throw new Error('Unknown agent setting');
    const value = { ...defaultProfile, ...input };
    if (!validName(value.name)) throw new Error('Name must contain 1–16 letters, digits or underscores');
    if (value.skin !== '' && !validName(value.skin))
        throw new Error('Skin must be a Minecraft username, or blank for the default skin');
    for (const field of fields)
        if (typeof value[field] !== 'string' || value[field].length > 4000)
            throw new Error('Agent settings must be text, up to 4,000 characters');
    if (!value.objective.trim()) throw new Error('Give the companion a task or standing objective');
    const config = resolveConfig([{ ...value, sandbox: 'docker' }], { env: {}, probeDocker: () => true });
    catalog.validate(config);
    return value;
}
