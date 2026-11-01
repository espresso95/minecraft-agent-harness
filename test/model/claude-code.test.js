import test from 'node:test';
import assert from 'node:assert/strict';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import { claudeModels, claudeStream } from '../../src/model/claude-code.js';
import { completeClaude, conversation } from '../../scripts/lib/claude-code.js';

const entry = {
    value: 'sonnet',
    resolvedModel: 'discovered-model',
    displayName: 'Discovered model',
    supportsEffort: true,
    supportedEffortLevels: ['medium', 'xhigh'],
    supportsThinkingOff: false,
    contextWindow: 1000000,
    maxTokens: 128000,
};
test('native Claude metadata supplies model IDs and exact effort choices without defaults or aliases', () => {
    const models = claudeModels([{ ...entry, value: 'default' }, entry, { ...entry, value: 'alias' }]);
    assert.equal(models.length, 1);
    assert.equal(models[0].id, entry.resolvedModel);
    assert.deepEqual(getSupportedThinkingLevels(models[0]), ['medium', 'xhigh']);
});
test('Claude tool intents and cache usage reach the existing runtime without executing tools', async () => {
    let options,
        closed = false;
    const result = await completeClaude(
        {
            model: 'discovered-model',
            context: {
                systemPrompt: 'Stay in the game',
                messages: [],
                tools: [{ name: 'gather', description: 'Gather', parameters: { type: 'object', properties: {} } }],
            },
            effort: 'medium',
        },
        null,
        {
            query(input) {
                options = input.options;
                return {
                    close() {
                        closed = true;
                    },
                    async *[Symbol.asyncIterator]() {
                        yield {
                            type: 'assistant',
                            message: {
                                id: 'message-id',
                                content: [
                                    {
                                        type: 'tool_use',
                                        id: 'tool-id',
                                        name: 'mcp__minecraft__gather',
                                        input: { count: 2 },
                                    },
                                ],
                                usage: {
                                    input_tokens: 5,
                                    cache_read_input_tokens: 100,
                                    cache_creation_input_tokens: 20,
                                    output_tokens: 9,
                                },
                            },
                        };
                        throw Error('Claude Code returned an error result: Reached maximum number of turns (1)');
                    },
                };
            },
        },
    );
    assert.equal(options.maxTurns, 1);
    assert.deepEqual(options.tools, []);
    assert.equal(options.persistSession, false);
    assert.deepEqual(result.content, [{ type: 'toolCall', id: 'tool-id', name: 'gather', arguments: { count: 2 } }]);
    assert.equal(closed, true);
    const events = [];
    const message = await claudeStream(
        async () => result,
        event => events.push(event),
    )(claudeModels([entry])[0], { messages: [] }, {}).result();
    assert.equal(message.stopReason, 'toolUse');
    assert.equal(message.usage.totalTokens, 134);
    assert.deepEqual(events[1].usage, {
        input_tokens: 125,
        output_tokens: 9,
        total_tokens: 134,
        input_tokens_details: { cached_tokens: 100 },
    });
    assert.equal(events[1].usage.output_tokens_details, undefined);
});
test('Claude conversation preserves real tool results and instructions without provider reasoning signatures', () => {
    const text = conversation({
        messages: [
            { role: 'user', content: 'Build here' },
            {
                role: 'assistant',
                content: [
                    { type: 'thinking', thinking: 'private', thinkingSignature: 'signature' },
                    { type: 'toolCall', name: 'inventory' },
                ],
            },
            { role: 'toolResult', content: [{ type: 'text', text: 'actual inventory' }] },
        ],
    });
    assert.match(text, /Build here/);
    assert.match(text, /actual inventory/);
    assert.doesNotMatch(text, /signature|private/);
});
test('Pi transcript system messages provide the actual current tool declarations and governing prompt', async () => {
    let received;
    const stream = claudeStream(
        async (_method, params) => {
            received = params.context;
            return {
                id: 'test',
                content: [{ type: 'text', text: 'Done' }],
                usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
            };
        },
        () => {},
    );
    await stream(claudeModels([entry])[0], {
        messages: [
            {
                role: 'system',
                content: 'Respect the human build',
                toolsAdded: [
                    { name: 'inventory', description: 'Inventory', parameters: { type: 'object', properties: {} } },
                ],
            },
            { role: 'user', content: 'Inspect' },
        ],
    }).result();
    assert.match(received.systemPrompt, /Respect the human build/);
    assert.equal(received.tools[0].name, 'inventory');
    assert.deepEqual(
        received.messages.map(m => m.role),
        ['user'],
    );
});

test('both clients receive a refreshed catalog signature when native model choices change', async () => {
    const { modelCatalog } = await import('../../src/controller/model-catalog.js');
    const catalog = modelCatalog([]);
    const before = catalog.snapshot().version;
    catalog.setClaude([entry]);
    assert.notEqual(catalog.snapshot().version, before);
    const unchanged = catalog.snapshot().version;
    catalog.setClaude([entry]);
    assert.equal(catalog.snapshot().version, unchanged);
    assert.equal(catalog.snapshot().models[0].compaction.supported, false);
    catalog.validate({ model: { provider: 'claude-code', id: entry.resolvedModel }, thinking: 'xhigh' });
    assert.throws(
        () => catalog.validate({ model: { provider: 'claude-code', id: entry.resolvedModel }, thinking: 'high' }),
        /thinking/,
    );
});

test('native short tool names use the same declared catalog and terminal usage replaces partial block counters', async () => {
    const result = await completeClaude(
        {
            model: 'test',
            context: { messages: [], tools: [{ name: 'inventory', parameters: { type: 'object', properties: {} } }] },
        },
        null,
        {
            query() {
                return {
                    close() {},
                    async *[Symbol.asyncIterator]() {
                        yield {
                            type: 'assistant',
                            message: {
                                id: 'short-name',
                                content: [{ type: 'tool_use', name: 'inventory', id: 'tool', input: {} }],
                                usage: { input_tokens: 2, output_tokens: 5 },
                            },
                        };
                        yield {
                            type: 'result',
                            subtype: 'error_max_turns',
                            is_error: true,
                            usage: {
                                input_tokens: 10,
                                cache_read_input_tokens: 20,
                                cache_creation_input_tokens: 30,
                                output_tokens: 40,
                                output_tokens_details: { thinking_tokens: 15 },
                            },
                        };
                    },
                };
            },
        },
    );
    assert.equal(result.content[0].name, 'inventory');
    assert.equal(result.usage.totalTokens, 100);
    assert.equal(result.usage.reasoning, 15);
});
