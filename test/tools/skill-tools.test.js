import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vec3 } from 'vec3';
import { MailboxStore } from '../../src/comms/mailbox-store.js';
import { createSkillTools } from '../../src/tools/skill-tools.js';
import { createShellTools } from '../../src/tools/shell-tools.js';
import { createLocalBackend } from '../../src/sandbox/shell-sandbox.js';

test('agents reuse immutable program versions through their own relay; only observed outcomes establish verification', async t => {
    const root = mkdtempSync(join(tmpdir(), 'learned-programs-')),
        stores = [],
        shells = [];
    t.after(async () => {
        for (const shell of shells) await shell.close();
        for (const store of stores) store.close();
        rmSync(root, { recursive: true, force: true });
    });
    let source = 'from agent_tools import call, parameters\np=parameters()\nprint(call("inventory"), p["tag"])\n';
    const setup = name => {
        const store = new MailboxStore(join(root, 'mail.sqlite'), name);
        stores.push(store);
        const [shell] = createShellTools({
            backend: createLocalBackend({ workdir: join(root, name), sharedDir: join(root, 'shared') }),
            invoke: async () => ({ actor: name }),
            toolList: () => [],
        });
        shells.push(shell);
        const tools = createSkillTools({
            store: store.skills,
            runShell: shell,
            workspaceRead: {
                execute: async () => ({
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                text: source,
                                totalBytes: Buffer.byteLength(source),
                                truncated: false,
                            }),
                        },
                    ],
                }),
            },
            bot: {
                version: '1.21.6',
                entity: { position: new Vec3(1, 65, 1) },
                inventory: { items: () => [{ name: 'oak_log', count: 2 }] },
            },
            perception: {},
        });
        return async (name, args) => tools.find(t => t.name === name).execute('test', args);
    };
    const first = setup('First'),
        second = setup('Second');
    const saved = await first('skill_library', {
        action: 'save',
        name: 'inventory_report',
        path: 'tools/report.py',
        description: 'A parameterized report',
        parameters: JSON.stringify({ type: 'object', properties: { tag: { type: 'string' } }, required: ['tag'] }),
    });
    assert.equal(saved.isError, undefined);
    const id = saved.details.id;
    assert.equal(saved.details.status, 'candidate');
    assert.equal((await second('skill_library', { action: 'search' })).details.skills.length, 0);
    const args = { id, args: JSON.stringify({ tag: 'hello $(this is literal)' }) };
    const unverified = await first('run_skill', args);
    assert.equal(unverified.isError, undefined);
    assert.equal(unverified.details.skill.status, 'candidate');
    source = 'raise RuntimeError("the mutable draft changed")';
    const verified = await second('run_skill', { ...args, checks: [{ kind: 'inventory', name: 'oak_log', count: 2 }] });
    assert.equal(verified.isError, undefined);
    assert.match(verified.details.execution[0].text, /Second/);
    assert.equal(verified.details.skill.status, 'verified');
    assert.match(unverified.details.execution[0].text, /First/);
    assert.equal((await first('skill_library', { action: 'search', query: 'parameterized' })).details.skills.length, 1);
    const failed = await second('run_skill', { ...args, checks: [{ kind: 'inventory', name: 'oak_log', count: 99 }] });
    assert.equal(failed.isError, true);
    assert.equal(failed.details.skill.verifiedRuns, 1);
    assert.equal((await second('run_skill', { id, args: '{}' })).isError, true);
    assert.equal((await second('skill_library', { action: 'retire', id })).isError, true);
    assert.equal((await first('skill_library', { action: 'retire', id })).isError, undefined);
    assert.equal((await second('run_skill', args)).isError, true);
});

test('losing or timing out a program stops pending body actions and never replays execution', async () => {
    let runs = 0,
        stops = 0;
    const [shell] = createShellTools({
        backend: {
            kind: 'fake',
            start: async () => {},
            close: async () => {},
            run: async () => {
                runs++;
                return { exitCode: 124, timedOut: true, stdout: 'partial verified work', stderr: '' };
            },
        },
        invoke: async () => {},
        toolList: () => [],
        stopActions: async () => {
            stops++;
        },
    });
    const result = await shell.execute('test', { cmd: 'a long program' });
    assert.equal(result.isError, true);
    assert.equal(runs, 1);
    assert.equal(stops, 1);
    assert.match(result.content[0].text, /partial verified/);
    await shell.close();
});
