import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt, difficultyRules } from '../../src/prompt.js';

const base = { name: 'Ada', objective: 'Build a house', gameMode: 'survival' };

test('team prompts use the configured shared directory and distinguish private notes', () => {
    const prompt = buildSystemPrompt({
        ...base,
        team: true,
        sandbox: true,
        sharedMachine: true,
        sharedPath: '/tmp/team-workspace',
    });
    assert.match(prompt, /files under \/tmp\/team-workspace/);
    assert.match(prompt, /run_shell is your private sandbox/);
    assert.match(prompt, /Everyone on the team can read and write those files/);
    assert.ok(!prompt.includes('${sharedPath}'));
    const withoutShell = buildSystemPrompt({ ...base, team: true });
    assert.doesNotMatch(withoutShell, /run_shell|shared_exec|memory\.md/);
});

test('prompts use current observed rules and the shared formatter explains starvation accurately', () => {
    const prompt = buildSystemPrompt(base);
    assert.match(prompt, /rules/);
    assert.equal(prompt, buildSystemPrompt({ ...base, difficulty: 'hard', respawn: false }));
    assert.match(difficultyRules('easy'), /hunger alone cannot kill/);
    assert.match(difficultyRules('hard'), /starve to death/);
    assert.equal(difficultyRules('weird'), '');
});

test('difficulty is read from the packet whether it arrives as a name or an index', async () => {
    const { EventEmitter } = await import('node:events');
    const { installDifficulty, currentDifficulty } = await import('../../src/body/difficulty.js');
    const client = new EventEmitter();
    const bot = { _client: client, game: {} };
    installDifficulty(bot);
    assert.equal(currentDifficulty(bot), undefined);
    client.emit('difficulty', { difficulty: 'easy', difficultyLocked: false });
    assert.equal(currentDifficulty(bot), 'easy');
    client.emit('difficulty', { difficulty: 3 });
    assert.equal(currentDifficulty(bot), 'hard');
    assert.equal(currentDifficulty({ game: { difficulty: 'normal' } }), 'normal');
});

test('short and long personas reach ordinary and team prompts', () => {
    for (const team of [true, false]) {
        const prompt = buildSystemPrompt({ ...base, team, personality: 'CAREFUL_PERSONA', soul: 'LONG_SOUL' });
        assert.match(prompt, /CAREFUL_PERSONA/);
        assert.match(prompt, /LONG_SOUL/);
    }
});

test('team and solo agents receive the same execution, verification and private coordination policy', () => {
    for (const team of [true, false]) {
        const prompt = buildSystemPrompt({ ...base, team, sandbox: true });
        for (const rule of [
            /bounded chunks/,
            /tool --help/,
            /\$SHARED_TOOLS/,
            /Check every tool result/,
            /Use send_dm for targeted/,
            /Use follow_player/,
        ])
            assert.match(prompt, rule);
        assert.equal((prompt.match(/For substantial tasks/g) ?? []).length, 1);
    }
});
