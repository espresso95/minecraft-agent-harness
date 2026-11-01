import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Appearances, minecraftSkin } from '../../src/controller/appearances.js';
import { fixture } from './fixtures.js';

test('signed Minecraft textures use official endpoints and reject arbitrary URLs', async () => {
    const texture = url => Buffer.from(JSON.stringify({ textures: { SKIN: { url } } })).toString('base64');
    const urls = [];
    const request = async url => {
        urls.push(url);
        return {
            ok: true,
            status: 200,
            json: async () =>
                urls.length % 2 === 1
                    ? { id: 'a'.repeat(32), name: 'SkinOwner' }
                    : {
                          properties: [
                              {
                                  name: 'textures',
                                  value: texture('http://textures.minecraft.net/texture/abcdef'),
                                  signature: 'signed',
                              },
                          ],
                      },
        };
    };
    const value = await minecraftSkin('SkinOwner', request);
    assert.equal(value.url, 'https://textures.minecraft.net/texture/abcdef');
    assert.equal(value.signature, 'signed');
    assert.match(urls[0], /^https:\/\/api.mojang.com/);
    assert.match(urls[1], /unsigned=false$/);
    await assert.rejects(minecraftSkin('../bad', request));
    await assert.rejects(
        minecraftSkin('Absent', async () => ({ ok: false, status: 404 })),
        /not found/,
    );
    let n = 0;
    await assert.rejects(
        minecraftSkin('Malicious', async () => ({
            ok: true,
            json: async () =>
                ++n === 1
                    ? { id: 'a'.repeat(32) }
                    : {
                          properties: [
                              {
                                  name: 'textures',
                                  value: texture('http://evil.test/texture/abcdef'),
                                  signature: 'signed',
                              },
                          ],
                      },
        })),
        /Invalid Minecraft skin/,
    );
});
test('skin cache coalesces lookups and live skin changes do not restart paused workers', async t => {
    const dir = mkdtempSync(join(tmpdir(), 'skins-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    let lookups = 0,
        reloads = 0;
    const skins = new Appearances({
        file: join(dir, 'appearances.json'),
        serverRules: {
            command: async () => {
                reloads++;
            },
        },
        resolve: async name => {
            lookups++;
            if (name === 'Missing') throw new Error('not found');
            return {
                username: name,
                value: 'texture',
                signature: 'signed',
                url: 'https://textures.minecraft.net/texture/abc',
            };
        },
    });
    const { c, call, launches } = await fixture(t, { appearances: skins });
    c.manager.start('Scout', { paused: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(
        (await call('/v1/agents/Scout', { player: 'Player', agent: { skin: 'SkinOwner' } }, undefined, {}, 'PATCH'))
            .status,
        200,
    );
    assert.equal(launches.length, 1);
    assert.equal(c.manager.entries.get('Scout').state, 'paused');
    assert.equal(
        (await call('/v1/agents/Scout', { player: 'Player', agent: { skin: 'Missing' } }, undefined, {}, 'PATCH'))
            .status,
        400,
    );
    assert.equal(c.manager.entries.get('Scout').config.skin, 'SkinOwner');
    await Promise.all([skins.prepare('skinowner'), skins.prepare('SkinOwner')]);
    assert.equal(lookups, 2);
    assert.equal(reloads, 2);
    assert.match((await call('/v1/state')).value.agents[0].skinUrl, /textures.minecraft.net/);
    assert.equal(
        (await call('/v1/agents/Scout', { player: 'Player', agent: { skin: '' } }, undefined, {}, 'PATCH')).status,
        200,
    );
    assert.equal(skins.data.agents.scout, '');
});
