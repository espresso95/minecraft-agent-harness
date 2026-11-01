import test from 'node:test';
import assert from 'node:assert/strict';
import { activityLine, checkModel, connectionMessage, isFatalKick, kickText, summarizeResult } from '../src/startup.js';
import { reconnectDelay, MAX_RECONNECTS } from '../src/startup.js';
import { resolveConfig, toSettings } from '../src/config.js';

test('kick reasons become readable text and only bans or auth problems stop reconnecting', () => {
    assert.equal(kickText('{"translate":"multiplayer.disconnect.flying"}'), 'Flying is not enabled on this server');
    assert.equal(kickText({ text: 'Kicked by an operator' }), 'Kicked by an operator');
    assert.equal(
        kickText({ type: 'compound', value: { text: { type: 'string', value: 'Server restarting' } } }),
        'Server restarting',
    );
    assert.equal(kickText('plain words'), 'plain words');
    assert.equal(kickText({ type: 'string', value: 'Testing reconnect' }), 'Testing reconnect');
    assert.equal(
        kickText({
            type: 'compound',
            name: '',
            value: { translate: { type: 'string', value: 'multiplayer.disconnect.flying' } },
        }),
        'Flying is not enabled on this server',
    );
    assert.equal(isFatalKick('Flying is not enabled on this server'), false);
    assert.equal(isFatalKick('Kicked by an operator'), false);
    assert.equal(isFatalKick('You are banned from this server'), true);
    assert.equal(isFatalKick('Game over: RED TEAM WINS (last team standing)'), true);
    assert.equal(isFatalKick('You are not white-listed on this server'), true);
});

test('connection failures produce one friendly line', () => {
    assert.match(
        connectionMessage({ code: 'ECONNREFUSED' }, 'localhost', 25565),
        /Is the server running\?.*npm run server/,
    );
    assert.match(connectionMessage({ code: 'ENOTFOUND' }, 'nope.invalid', 25565), /Cannot resolve host "nope.invalid"/);
    assert.equal(connectionMessage({ message: 'boom\n  at x' }, 'h', 1), 'Connection to h:1 failed: boom');
});

test('activity lines show tool, short args, outcome and a short result', () => {
    assert.equal(
        activityLine({
            tool: 'gather',
            args: '{"block":"oak_log","count":4}',
            success: true,
            timeMs: 21300,
            result: '{"completed":true,"result":{"mined":4,"inventoryDelta":{"oak_log":4},"note":"x"},"log":""}',
        }),
        '> gather {"block":"oak_log","count":4} ok 21.3s: {"mined":4,"inventoryDelta":{"oak_log":4}}',
    );
    assert.match(
        activityLine({
            tool: 'go_to',
            args: '{}',
            success: false,
            failureCode: 'no_path',
            timeMs: 900,
            result: 'No route',
        }),
        /^x go_to failed \(no_path\) 0\.9s: No route$/,
    );
    assert.ok(summarizeResult('y'.repeat(500)).length <= 140);
});

test('reconnect backoff grows and is bounded', () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6].map(reconnectDelay), [5000, 10000, 20000, 40000, 60000, 60000]);
    assert.ok(MAX_RECONNECTS >= 5);
});

function fakeSdk({ providers = ['anthropic'], models = { anthropic: ['claude-sonnet-4-6'] }, auth = [] } = {}) {
    return {
        ModelRuntime: {
            create: async () => ({
                getProviders: () => providers.map(id => ({ id })),
                getModel: (p, id) => (models[p]?.includes(id) ? { id } : undefined),
                hasConfiguredAuth: p => auth.includes(p),
            }),
        },
    };
}

test('model preflight names the missing key, unknown models and unknown providers', async () => {
    const base = { model: { provider: 'anthropic', id: 'claude-sonnet-4-6' } };
    assert.match(await checkModel(base, { sdk: fakeSdk() }), /No API key for anthropic\. Set ANTHROPIC_API_KEY/);
    assert.equal(await checkModel(base, { sdk: fakeSdk({ auth: ['anthropic'] }) }), null);
    assert.match(
        await checkModel({ model: { provider: 'anthropic', id: 'nope' } }, { sdk: fakeSdk({ auth: ['anthropic'] }) }),
        /Unknown model anthropic\/nope/,
    );
    assert.match(
        await checkModel({ model: { provider: 'zzz', id: 'x' } }, { sdk: fakeSdk() }),
        /Unknown provider "zzz"/,
    );
});

test('single agents keep their own mailbox and plan; teams share them', () => {
    const solo = toSettings(resolveConfig([{ objective: 'x', name: 'Ada' }], { env: {}, probeDocker: () => false }));
    assert.match(solo.profile.pi.mailboxPath, /Ada\/mailbox\.sqlite$/);
    assert.match(solo.profile.pi.planPath, /Ada\/plan\.md$/);
    const team = toSettings({
        ...resolveConfig([{ objective: 'x', name: 'Ada' }], { env: {}, probeDocker: () => false }),
        team: true,
    });
    assert.match(team.profile.pi.mailboxPath, /shared\/mailbox\.sqlite$/);
});
