import { execFile } from 'node:child_process';
import { promisify, stripVTControlCharacters } from 'node:util';
import { readFileSync } from 'node:fs';

export function validateServerRules(value, server) {
    if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).some(k => !['difficulty', 'permanentDeath'].includes(k))
    )
        throw new Error('Unknown host setting');
    if (!server?.available) throw new Error('Server controls are unavailable');
    if (!server.difficulties.includes(value.difficulty) || typeof value.permanentDeath !== 'boolean')
        throw new Error('Choose a server difficulty and permanent-death setting');
    if (server.nativeHardcore && (value.difficulty !== 'hard' || !value.permanentDeath))
        throw new Error('Native Hardcore controls these rules; change the server configuration to disable it');
    return { difficulty: value.difficulty, permanentDeath: value.permanentDeath };
}

export class ServerRules {
    constructor({ stateFile, container = 'minecraft-companions-server-1', execute = promisify(execFile) }) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(container)) throw new Error('Invalid server container');
        Object.assign(this, { stateFile, container, execute });
    }
    snapshot() {
        try {
            return this.parse(readFileSync(this.stateFile, 'utf8'));
        } catch (error) {
            return { available: false, error: String(error.message).slice(0, 200) };
        }
    }
    parse(text) {
        const value = JSON.parse(text);
        if (value.error) throw new Error(value.error);
        if (
            !Array.isArray(value.difficulties) ||
            !value.difficulties.length ||
            value.difficulties.some(d => typeof d !== 'string') ||
            !value.difficulties.includes(value.difficulty) ||
            typeof value.permanentDeath !== 'boolean' ||
            typeof value.nativeHardcore !== 'boolean' ||
            !Array.isArray(value.deadPlayers) ||
            value.deadPlayers.some(p => !/^[A-Za-z0-9_]{1,16}$/.test(p.name) || typeof p.uuid !== 'string')
        )
            throw new Error('Invalid server rules snapshot');
        return { ...value, available: true };
    }
    async command(args) {
        const { stdout } = await this.execute(
            'docker',
            ['exec', this.container, 'rcon-cli', 'companionsrules', ...args],
            { timeout: 8000, maxBuffer: 65536 },
        );
        return this.parse(stripVTControlCharacters(stdout).trim());
    }
    ready() {
        return this.command(['status']);
    }
    async apply(settings) {
        const current = this.snapshot(),
            value = validateServerRules(settings, current);
        if (current.difficulty === value.difficulty && current.permanentDeath === value.permanentDeath) return current;
        return this.command(['set', value.difficulty, String(value.permanentDeath)]);
    }
}
