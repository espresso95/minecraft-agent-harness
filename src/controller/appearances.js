import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { validName } from './profiles.js';

export async function minecraftSkin(username, request = fetch) {
    if (!validName(username)) throw new Error('Choose a Minecraft username for the skin');
    const get = async url => {
        let response;
        for (let attempt = 0; attempt < 3; attempt++) {
            response = await request(url, { signal: AbortSignal.timeout(5000), redirect: 'error' });
            if (response.status !== 429 && response.status < 500) break;
            if (attempt < 2) await delay(500 * 2 ** attempt);
        }
        if (!response.ok || response.status === 204)
            throw new Error(
                response.status === 404 || response.status === 204
                    ? 'Minecraft skin account not found'
                    : `Minecraft skin service is unavailable (${response.status}); try again shortly`,
            );
        return response.json();
    };
    const account = await get('https://api.mojang.com/users/profiles/minecraft/' + username);
    if (!/^[a-f0-9]{32}$/i.test(account.id)) throw new Error('Invalid Minecraft account response');
    const profile = await get(
        'https://sessionserver.mojang.com/session/minecraft/profile/' + account.id + '?unsigned=false',
    );
    const texture = profile.properties?.find(p => p.name === 'textures');
    if (!texture?.value || !texture.signature) throw new Error('This account has no signed skin');
    const data = JSON.parse(Buffer.from(texture.value, 'base64').toString('utf8'));
    if (!data.textures?.SKIN?.url)
        throw new Error(
            'That account uses a default skin; leave the field blank or choose an account with a custom skin',
        );
    const url = new URL(data.textures.SKIN.url);
    if (url.hostname !== 'textures.minecraft.net' || !/^\/texture\/[a-f0-9]+$/i.test(url.pathname))
        throw new Error('Invalid Minecraft skin texture');
    url.protocol = 'https:';
    return { username: account.name, value: texture.value, signature: texture.signature, url: url.href };
}

export class Appearances {
    constructor({ file, serverRules, resolve = minecraftSkin }) {
        Object.assign(this, { file, serverRules, resolve });
        this.data = { cache: {}, agents: {} };
        this.pending = new Map();
        try {
            this.data = JSON.parse(readFileSync(file, 'utf8'));
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        this.data.cache = Object.assign(Object.create(null), this.data.cache);
    }
    async prepare(username) {
        if (!username) return;
        const key = username.toLowerCase();
        if (this.data.cache[key]) return;
        if (!this.pending.has(key))
            this.pending.set(
                key,
                this.resolve(username)
                    .then(value => {
                        this.data.cache[key] = value;
                    })
                    .finally(() => this.pending.delete(key)),
            );
        await this.pending.get(key);
    }
    async sync(profiles) {
        await Promise.all(profiles.map(p => this.prepare(p.skin)));
        this.data.agents = Object.fromEntries(profiles.map(p => [p.name.toLowerCase(), p.skin.toLowerCase()]));
        writeFileSync(this.file + '.tmp', JSON.stringify(this.data), { mode: 0o600 });
        renameSync(this.file + '.tmp', this.file);
        await this.serverRules.command(['skins']);
    }
    url(profile) {
        return this.data.cache[profile.skin?.toLowerCase()]?.url ?? null;
    }
}
