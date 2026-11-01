import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServerRules, validateServerRules } from '../../src/controller/server-rules.js';
import { initialRules } from './fixtures.js';

test('difficulty choices come from the server; native Hardcore remains native', () => {
    for (const difficulty of initialRules.difficulties)
        for (const permanentDeath of [true, false])
            assert.deepEqual(validateServerRules({ difficulty, permanentDeath }, initialRules), {
                difficulty,
                permanentDeath,
            });
    for (const value of [
        null,
        [],
        {},
        { difficulty: 'hard; stop', permanentDeath: false },
        { difficulty: 'normal', permanentDeath: false, deathMode: 'hardcore' },
    ])
        assert.throws(() => validateServerRules(value, initialRules));
    assert.throws(() =>
        validateServerRules({ difficulty: 'normal', permanentDeath: true }, { ...initialRules, nativeHardcore: true }),
    );
});
test('bridge uses fixed RCON arguments and unchanged rules are a no-op', async t => {
    const dir = mkdtempSync(join(tmpdir(), 'rules-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, 'state.json'),
        calls = [];
    const bridge = new ServerRules({
        stateFile: file,
        execute: async (...args) => {
            calls.push(args);
            return {
                stdout: JSON.stringify({ ...initialRules, difficulty: 'normal', permanentDeath: true }) + '\n\x1b[0m',
            };
        },
    });
    assert.equal(bridge.snapshot().available, false);
    writeFileSync(file, JSON.stringify(initialRules));
    await bridge.apply({ difficulty: 'peaceful', permanentDeath: false });
    assert.equal(calls.length, 0);
    assert.equal((await bridge.apply({ difficulty: 'normal', permanentDeath: true })).permanentDeath, true);
    assert.deepEqual(calls[0].slice(0, 2), [
        'docker',
        ['exec', 'minecraft-companions-server-1', 'rcon-cli', 'companionsrules', 'set', 'normal', 'true'],
    ]);
});
