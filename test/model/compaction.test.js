import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    NativeCompaction,
    nativeCompactionPolicy,
    nativeCompactionProblem,
} from '../../src/model/native-compaction.js';
import { createMinecraftSession, createPiSession } from '../../src/model/session.js';

const model = {
    provider: 'openai',
    api: 'openai-responses',
    id: 'test-model',
    baseUrl: 'https://api.openai.com/v1',
    contextWindow: 128000,
    maxTokens: 8192,
};
const assistant = (id = 'one') => ({
    role: 'assistant',
    api: model.api,
    provider: model.provider,
    model: model.id,
    timestamp: 10,
    stopReason: 'toolUse',
    content: [{ type: 'toolCall', id, name: 'inventory', arguments: {} }],
});
const checkpoint = id => ({ type: 'compaction', id: 'cmp_' + id, encrypted_content: 'OPAQUE_' + id });
const call = id => ({ type: 'function_call', id: 'fc_' + id, call_id: id, name: 'inventory', arguments: '{}' });
function manager() {
    const entries = [];
    return {
        entries,
        getEntries: () => entries,
        appendCustomEntry: (customType, data) => entries.push({ type: 'custom', customType, data }),
    };
}
function sse(events) {
    const bytes = new TextEncoder().encode(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''));
    return new Response(
        new ReadableStream({
            start(controller) {
                for (let i = 0; i < bytes.length; i += 17) controller.enqueue(bytes.slice(i, i + 17));
                controller.close();
            },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
    );
}
async function capture(native, output, type = 'response.completed') {
    await (
        await native.fetch(async () => sse([{ type, response: { output, usage: { input_tokens: 123 } } }]))(
            'https://api.openai.com/v1/responses',
            {},
        )
    ).text();
}

test('native policy is explicit, capacity-aware and rejects unsupported provider connections without a text fallback', () => {
    for (const window of [32768, 128000, 272000, 1000000])
        assert.deepEqual(nativeCompactionPolicy({ ...model, contextWindow: window }), {
            type: 'compaction',
            compact_threshold: Math.min(64000, Math.floor(window * 0.75)),
        });
    assert.match(nativeCompactionProblem({ provider: 'claude-code' }), /cannot relay signed/);
    assert.throws(() => nativeCompactionPolicy({ provider: 'claude-code' }), /no Pi summary fallback/);
    assert.throws(() => nativeCompactionPolicy({ ...model, provider: 'other' }), /not supported/);
    assert.throws(() => nativeCompactionPolicy({ ...model, contextWindow: 0 }), /metadata/);
    assert.throws(() => nativeCompactionPolicy({ ...model, contextWindow: 32768, maxTokens: 32768 }), /headroom/);
});

test('canonical native output replaces the old prefix, retains real tool results and survives resume and repeated compaction', async () => {
    const store = manager(),
        native = new NativeCompaction(model, store),
        diagnostics = [];
    native.diagnose = event => diagnostics.push(event);
    const old = { role: 'user', content: 'Do not replay this completed action', timestamp: 1 };
    const system = { role: 'system', content: 'Preserve the house', toolsAdded: [{ name: 'inventory' }] };
    const a = assistant();
    await capture(native, [{ type: 'message', id: 'before', content: [] }, checkpoint('one'), call('one')]);
    assert.equal(native.commit(a), true);
    assert.deepEqual(
        native
            .context([system, old, a, { role: 'toolResult', content: 'Real inventory: 21 cobblestone' }])
            .map(x => x.role),
        ['system', 'assistant', 'toolResult'],
    );
    const input = [
        { role: 'developer', content: 'Preserve the house' },
        call('one'),
        { type: 'function_call_output', call_id: 'one', output: 'Real inventory: 21 cobblestone' },
        { role: 'user', content: 'NEW HUMAN INSTRUCTION' },
    ];
    const expected = [input[0], checkpoint('one'), ...input.slice(1)];
    assert.deepEqual(native.payload({ input }).input, expected);
    const resumed = new NativeCompaction(model, store);
    assert.deepEqual(resumed.payload({ input }).input, expected);
    const b = assistant('two');
    await capture(resumed, [checkpoint('two'), call('two')]);
    resumed.commit(b);
    assert.deepEqual(resumed.payload({ input: [input[0], call('two')] }).input, [
        input[0],
        checkpoint('two'),
        call('two'),
    ]);
    assert.equal(new NativeCompaction({ ...model, id: 'other-model' }, store).checkpoint, undefined);
    assert.equal(store.entries.length, 2);
    assert.equal(diagnostics[0].tokensAfter, null);
    assert.equal(diagnostics[0].separateCompactionUsage, 'not_exposed');
    assert.doesNotMatch(JSON.stringify(diagnostics), /OPAQUE|Do not replay/);
    assert.throws(() => native.context([old]), /does not match/);
    assert.throws(() => native.payload({ input: [old] }), /boundary is missing/);
});

test('cancelled, incomplete and failed checkpoints cannot replace saved state; persistence errors stop subsequent requests', async () => {
    const store = manager(),
        native = new NativeCompaction(model, store);
    await capture(native, [checkpoint('one'), call('one')]);
    native.commit(assistant());
    for (const stopReason of ['aborted', 'error']) {
        await capture(native, [checkpoint('two'), call('two')]);
        assert.equal(native.commit({ ...assistant('two'), stopReason }), false);
    }
    await capture(native, [checkpoint('two'), call('two')], 'response.incomplete');
    assert.equal(native.commit(assistant('two')), false);
    assert.equal(store.entries.length, 1);
    await assert.rejects(capture(native, [{ type: 'compaction', id: 'bad' }, call('bad')]), /incomplete checkpoint/);
    await capture(native, [checkpoint('two'), call('two')]);
    store.appendCustomEntry = () => {
        throw Error('disk full');
    };
    assert.throws(() => native.commit(assistant('two')), /could not be saved/);
    assert.throws(() => native.context([assistant()]), /could not be saved/);
});

test('a checkpoint emitted after the assistant reply replaces that reply too and keeps the newer instruction', async () => {
    const store = manager(),
        native = new NativeCompaction(model, store);
    const reply = {
        type: 'message',
        id: 'msg_reply',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Done', annotations: [] }],
    };
    await capture(native, [reply, checkpoint('tail')]);
    native.commit({ ...assistant(), stopReason: 'stop' });
    const next = { role: 'user', content: 'A newer instruction' };
    assert.deepEqual(native.payload({ input: [reply, next] }).input, [checkpoint('tail'), next]);
});

test(
    'real Pi loop uses server checkpoints without invoking Pi summaries or replaying actions, and resumes from the saved checkpoint',
    { timeout: 15000 },
    async () => {
        const dir = await mkdtemp(join(tmpdir(), 'minecraft-native-context-'));
        const payloads = [],
            diagnostics = [];
        let actions = 0,
            runner,
            round = 0;
        const providerFetch = async (_url, init) => {
            const payload = JSON.parse(init.body);
            payloads.push(payload);
            assert.deepEqual(payload.context_management, [{ type: 'compaction', compact_threshold: 64000 }]);
            if (++round === 1) {
                const item = call('one');
                return sse([
                    { type: 'response.output_item.added', output_index: 0, item: checkpoint('one') },
                    { type: 'response.output_item.done', output_index: 0, item: checkpoint('one') },
                    { type: 'response.output_item.added', output_index: 1, item },
                    { type: 'response.output_item.done', output_index: 1, item },
                    {
                        type: 'response.completed',
                        response: {
                            id: 'r1',
                            status: 'completed',
                            output: [],
                            usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
                        },
                    },
                ]);
            }
            assert.equal(payload.input.filter(x => x.type === 'compaction').length, 1);
            assert.equal(payload.input.find(x => x.type === 'compaction').encrypted_content, 'OPAQUE_one');
            assert.equal(payload.input.filter(x => x.type === 'function_call').length, 1);
            assert.equal(payload.input.filter(x => x.type === 'function_call_output').length, 1);
            assert.match(JSON.stringify(payload.input), /Real inventory: 21 cobblestone/);
            assert.match(JSON.stringify(payload.input), /FRESH observation/);
            const item = {
                id: 'msg_done_' + round,
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text: 'Done', annotations: [] }],
            };
            return sse([
                { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
                {
                    type: 'response.content_part.added',
                    output_index: 0,
                    content_index: 0,
                    part: { type: 'output_text', text: '', annotations: [] },
                },
                { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Done' },
                { type: 'response.output_item.done', output_index: 0, item },
                {
                    type: 'response.completed',
                    response: {
                        id: 'r' + round,
                        status: 'completed',
                        output: [item],
                        usage: { input_tokens: 150, output_tokens: 10, total_tokens: 160 },
                    },
                },
            ]);
        };
        const make = () =>
            createMinecraftSession(
                {
                    agentId: 'NativeTest',
                    cwd: dir,
                    sessionDir: dir,
                    systemPrompt: 'Protect the house',
                    model: {
                        provider: 'openai',
                        id: model.id,
                        baseUrl: model.baseUrl,
                        contextWindow: model.contextWindow,
                    },
                    apiKey: 'SYNTHETIC',
                    maxWallMs: 5000,
                    observe: async () => ({ text: 'FRESH observation: preserve the chest' }),
                    diagnostics: e => diagnostics.push(e),
                    tools: [
                        {
                            name: 'inventory',
                            label: 'Inventory',
                            description: 'Read inventory',
                            parameters: { type: 'object', properties: {}, additionalProperties: false },
                            execute: async () => {
                                actions++;
                                return { content: [{ type: 'text', text: 'Real inventory: 21 cobblestone' }] };
                            },
                        },
                    ],
                },
                { createSession: options => createPiSession(options, { fetch: providerFetch }) },
            );
        try {
            runner = await make();
            const completed = new Promise(resolve => {
                runner.options.onCycleEnd = resolve;
            });
            runner.start();
            const outcome = await completed;
            assert.equal(actions, 1, JSON.stringify({ outcome, diagnostics, requests: payloads.length }));
            assert.equal(payloads.length, 2);
            assert.equal(runner.manager.getEntries().filter(x => x.type === 'compaction').length, 0);
            assert.equal(
                runner.manager.getEntries().filter(x => x.type === 'message' && x.message.role === 'toolResult').length,
                1,
            );
            assert.equal(diagnostics.filter(x => x.mechanism === 'provider-native').length, 1);
            await runner.close();
            runner = await make();
            const resumed = new Promise(resolve => {
                runner.options.onCycleEnd = resolve;
            });
            runner.start();
            await resumed;
            assert.equal(actions, 1);
            assert.equal(payloads.length, 3);
        } finally {
            await runner?.close();
            await rm(dir, { recursive: true, force: true });
        }
    },
);
