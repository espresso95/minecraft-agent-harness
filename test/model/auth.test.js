import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig, toAgentOptions } from '../../src/config.js';
import { checkModel } from '../../src/startup.js';
import { createPiSession } from '../../src/model/session.js';
import { modelAuthPath, subscriptionProblem } from '../../src/model/auth.js';

test('subscription mode rejects API credentials and alternate endpoints', () => {
    const model = { provider: 'openai', id: 'gpt-6.1-terra' };
    const oauth = { isUsingOAuth: () => true };
    assert.equal(subscriptionProblem(oauth, model), null);
    assert.match(subscriptionProblem(oauth, model, 'SYNTHETIC'), /API-key billing is disabled/);
    assert.match(subscriptionProblem({ isUsingOAuth: () => false }, model), /API-key billing is disabled/);
    assert.match(subscriptionProblem(oauth, { ...model, baseUrl: 'https://example.invalid' }), /required/);
    assert.match(subscriptionProblem(oauth, { ...model, provider: 'other' }), /required/);
});

test('preflight and a real Pi session share the subscription credential store', async () => {
    const root = await mkdtemp(join(tmpdir(), 'minecraft-auth-'));
    try {
        const config = resolveConfig([{ objective: 'test', stateDir: root, sandbox: 'none', subscriptionOnly: true }], {
            env: {},
        });
        assert.equal(config.authPath, modelAuthPath(root));
        assert.equal(toAgentOptions(config).authPath, config.authPath);
        const save = credential => writeFile(config.authPath, JSON.stringify({ openai: credential }), { mode: 0o600 });
        await save({ type: 'api_key', key: 'SYNTHETIC' });
        assert.match(await checkModel(config), /API-key billing is disabled/);
        await save({
            type: 'oauth',
            access: 'SYNTHETIC',
            refresh: 'SYNTHETIC',
            expires: Date.now() + 3600000,
            clientId: 'SYNTHETIC',
        });
        assert.equal(await checkModel(config), null);
        const { session } = await createPiSession({
            ...toAgentOptions(config),
            agentId: 'test',
            cwd: root,
            sessionDir: join(root, 'sessions'),
            systemPrompt: 'Synthetic test. No inference.',
            tools: [],
        });
        try {
            assert.equal(session.model.id, 'gpt-6.1-terra');
            assert.equal(session.model.provider, 'openai');
        } finally {
            session.dispose();
        }
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('Claude Code uses native host authentication in preflight and rejects API overrides', async () => {
    const model = { provider: 'claude-code', id: 'discovered-model' };
    assert.equal(subscriptionProblem({}, model), null);
    assert.match(subscriptionProblem({}, model, 'SYNTHETIC'), /API keys/);
    assert.match(subscriptionProblem({}, { ...model, baseUrl: 'https://example.invalid' }), /alternate/);
    const root = await mkdtemp(join(tmpdir(), 'native-preflight-'));
    try {
        assert.equal(
            await checkModel(
                { model, authPath: join(root, 'auth.json'), subscriptionOnly: true },
                {
                    modelRequest: async () => [
                        {
                            value: 'model',
                            resolvedModel: 'discovered-model',
                            contextWindow: 1000000,
                            maxTokens: 128000,
                            displayName: 'Model',
                            supportsEffort: true,
                            supportedEffortLevels: ['medium'],
                        },
                    ],
                },
            ),
            null,
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
