import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { profile, validName } from './profiles.js';

export class CompanionRoster {
    constructor({ file, catalog, createManager, agents, appearances, onlinePlayers = () => [] }) {
        Object.assign(this, { file, catalog, appearances, onlinePlayers });
        let saved = agents;
        if (saved === undefined) {
            try {
                saved = JSON.parse(readFileSync(file, 'utf8')).agents;
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
                saved = [];
            }
        }
        if (!Array.isArray(saved) || saved.length > 16) throw new Error('Configure up to 16 companions');
        const profiles = saved.map(p => profile(p, catalog));
        if (new Set(profiles.map(p => p.name.toLowerCase())).size !== profiles.length)
            throw new Error('Agent names must be unique');
        this.manager = createManager(profiles);
        this.save();
    }
    names() {
        return [...this.manager.entries.keys()];
    }
    profiles() {
        return [...this.manager.entries.values()].map(e => e.config);
    }
    snapshot() {
        return this.manager.snapshot().map(a => ({ ...a, skinUrl: this.appearances?.url(a) ?? null }));
    }
    syncSkins() {
        return this.appearances?.sync(this.profiles());
    }
    exact(name) {
        const match = this.names().find(n => n.toLowerCase() === String(name).toLowerCase());
        if (!match) throw new Error('Unknown agent');
        return match;
    }
    human(name) {
        if (!validName(name) || this.names().some(n => n.toLowerCase() === name.toLowerCase()))
            throw new Error('Use your Minecraft player name, not an agent identity');
        return name;
    }
    save() {
        const value = { agents: this.profiles() };
        writeFileSync(this.file + '.tmp', JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
        renameSync(this.file + '.tmp', this.file);
    }
    async add(input, human) {
        const config = profile(input, this.catalog);
        if (config.name.toLowerCase() === human.toLowerCase())
            throw new Error('The agent needs a different name from your player');
        const existing = this.names().find(n => n.toLowerCase() === config.name.toLowerCase());
        if (existing) {
            if (!Object.keys(config).every(k => config[k] === this.manager.entries.get(existing).config[k]))
                throw new Error('That agent name already exists');
            await this.syncSkins();
            return this.manager.entries.get(existing).config;
        }
        if (this.onlinePlayers().some(n => n.toLowerCase() === config.name.toLowerCase()))
            throw new Error('That name is already being used by an online player');
        if (this.names().length >= 16) throw new Error('The roster supports up to 16 companions');
        await this.appearances?.prepare(config.skin);
        this.manager.add(config);
        try {
            this.save();
        } catch (error) {
            this.manager.entries.delete(config.name);
            throw error;
        }
        await this.manager.configure();
        await this.syncSkins();
        // Adding an agent never starts a model request; Start is an explicit action.
        return config;
    }
    async update(name, input) {
        name = this.exact(name);
        const entry = this.manager.entries.get(name);
        if (!input || Object.hasOwn(input, 'name')) throw new Error('An existing agent identity cannot be renamed');
        const next = profile({ ...entry.config, ...input }, this.catalog),
            previous = entry.config;
        await this.appearances?.prepare(next.skin);
        const changed = ['model', 'thinking', 'personality', 'objective'].some(k => next[k] !== previous[k]);
        const active = changed && Boolean(entry.child || entry.retryTimer),
            paused = entry.desiredPaused ?? true;
        if (active) await this.manager.command(name, 'stop');
        entry.config = next;
        try {
            this.save();
        } catch (error) {
            entry.config = previous;
            if (active) this.manager.start(name, { paused });
            throw error;
        }
        if (active) this.manager.start(name, { paused });
        await this.syncSkins();
        return next;
    }
    async remove(name) {
        const found = this.names().find(n => n.toLowerCase() === String(name).toLowerCase());
        if (!found) return;
        name = found;
        const entries = new Map(this.manager.entries);
        const entry = this.manager.entries.get(name);
        const active = Boolean(entry.child || entry.retryTimer),
            paused = entry.desiredPaused ?? true;
        await this.manager.command(name, 'stop');
        this.manager.entries.delete(name);
        try {
            this.save();
        } catch (error) {
            this.manager.entries = entries;
            if (active) this.manager.start(name, { paused });
            throw error;
        }
        await this.manager.configure();
        await this.syncSkins();
    }
}
