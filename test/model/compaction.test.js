import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MailboxStore } from '../../src/comms/mailbox-store.js';
import { contextCompaction, createMinecraftSession, createPiSession } from '../../src/model/session.js';

test(
    'a long real Pi tool loop compacts through the public SDK and retains its complete original history',
    { timeout: 15000 },
    async () => {
        const dir = await mkdtemp(join(tmpdir(), 'minecraft-context-'));
        const errors = [],
            summaryInputs = [];
        const inbox = new MailboxStore(join(dir, 'mail.sqlite'), 'ContextTest');
        const human = new MailboxStore(join(dir, 'mail.sqlite'), 'Human');
        const { AgentInbox } = await import('../../src/comms/inbox.js');
        const delivery = new AgentInbox({ store: inbox, peers: [], getRunner: () => runner, actions: { status: {} } });
        const restriction = 'Preserve the parcel beyond x=7. Deliver exactly 16 logs to (8,65,-4); do not dig there.';
        let runner,
            actions = 0,
            summaries = 0,
            ended;
        const finished = new Promise(resolve => {
            ended = resolve;
        });
        const usage = input => ({
            input,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: input + 1,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        });
        try {
            runner = await createMinecraftSession(
                {
                    agentId: 'ContextTest',
                    cwd: dir,
                    sessionDir: dir,
                    systemPrompt: 'Preserve the human settlement.',
                    model: { provider: 'claude-code', id: 'test-model' },
                    thinkingLevel: 'medium',
                    maxWallMs: 10000,
                    observe: async () => ({ text: 'Current work remains within the human boundary.' }),
                    tools: [
                        {
                            name: 'inventory',
                            label: 'Inventory',
                            description: 'Read inventory',
                            parameters: { type: 'object', properties: {}, additionalProperties: false },
                            execute: async () => {
                                actions++;
                                human.sendDM('ContextTest', restriction);
                                return { content: [{ type: 'text', text: 'Long actual tool result. '.repeat(300) }] };
                            },
                        },
                    ],
                    inboxDelivery: () => delivery.delivery(),
                    beforeRequest: records => delivery.beginRequest(records),
                    onResponse: success => delivery.finishRequest(success),
                    onCompaction: () => delivery.resetDelivery(),
                    onCycleEnd: ended,
                    onModelError: message => errors.push(message),
                },
                {
                    createSession: async options => {
                        const result = await createPiSession(options, {
                            modelRequest: async (method, params) => {
                                if (method === 'catalog')
                                    return [
                                        {
                                            value: 'test',
                                            resolvedModel: 'test-model',
                                            contextWindow: 1000000,
                                            maxTokens: 128000,
                                            displayName: 'Test',
                                            supportsEffort: true,
                                            supportedEffortLevels: ['medium'],
                                        },
                                    ];
                                if (!params.context.tools.length) {
                                    summaries++;
                                    summaryInputs.push(JSON.stringify(params.context));
                                    assert.equal(
                                        inbox.unreadMessages().length,
                                        1,
                                        'summary requests never acknowledge incoming mail',
                                    );
                                    return {
                                        id: 'summary',
                                        content: [
                                            {
                                                type: 'text',
                                                text:
                                                    'Human goal: preserve the settlement. ' +
                                                    restriction +
                                                    ' Inventory was inspected and has 17 logs. Continue without replaying the inspection.',
                                            },
                                        ],
                                        usage: usage(1000),
                                    };
                                }
                                if (summaries) {
                                    assert.match(JSON.stringify(params.context), /Preserve the parcel beyond x=7/);
                                    return {
                                        id: 'after-summary',
                                        content: [
                                            {
                                                type: 'text',
                                                text: 'Inventory contains 17 logs; the completed inspection will not be replayed.',
                                            },
                                        ],
                                        usage: usage(1000),
                                    };
                                }
                                return {
                                    id: 'decision',
                                    content: [
                                        { type: 'toolCall', id: 'inspect-once', name: 'inventory', arguments: {} },
                                    ],
                                    usage: usage(66000),
                                };
                            },
                        });
                        for (let i = 0; i < 60; i++) {
                            result.sessionManager.appendMessage({
                                role: 'user',
                                content: [
                                    {
                                        type: 'text',
                                        text: `Historical instruction ${i}: ` + 'preserve observed facts. '.repeat(80),
                                    },
                                ],
                                timestamp: i * 2,
                            });
                            result.sessionManager.appendMessage({
                                role: 'assistant',
                                content: [
                                    {
                                        type: 'text',
                                        text:
                                            `Historical verified progress ${i}: ` +
                                            'already completed action. '.repeat(80),
                                    },
                                ],
                                api: 'claude-code',
                                provider: 'claude-code',
                                model: 'test-model',
                                usage: usage(30000),
                                stopReason: 'stop',
                                timestamp: i * 2 + 1,
                            });
                        }
                        result.session.agent.state.messages = result.sessionManager.buildSessionContext().messages;
                        return result;
                    },
                },
            );
            runner.start();
            const outcome = await finished;
            assert.equal(outcome.failed, false, JSON.stringify({ errors, actions, summaries }));
            assert.equal(actions, 1);
            assert.equal(inbox.unreadMessages().length, 0, 'only the successful decision acknowledges the instruction');
            assert.ok(summaries >= 1);
            const firstSummaryRequests = summaries;
            assert.equal(runner.manager.getEntries().filter(entry => entry.type === 'compaction').length, 1);
            assert.ok(
                runner.manager
                    .getEntries()
                    .some(
                        entry =>
                            entry.type === 'message' &&
                            JSON.stringify(entry.message).includes('Historical instruction 0:'),
                    ),
            );
            assert.ok(runner.session.getContextUsage().tokens < 64000);
            await runner.cancel();
            human.sendDM('ContextTest', 'New priority remains unread during summary generation');
            await runner.deliverInbox();
            for (let i = 0; i < 55; i++)
                await runner.session.sendCustomMessage({
                    customType: 'test_history',
                    display: false,
                    content: 'Later verified observation ' + i + ': ' + 'historical facts. '.repeat(150),
                });
            await runner.session.compact();
            assert.ok(summaries > firstSummaryRequests);
            assert.match(summaryInputs.slice(firstSummaryRequests).join('\n'), /Preserve the parcel beyond x=7/);
            assert.match(summaryInputs.slice(firstSummaryRequests).join('\n'), /sourceId/);
            assert.equal(inbox.unreadMessages().length, 1);
            assert.equal(actions, 1);
            assert.equal(runner.manager.getEntries().filter(entry => entry.type === 'compaction').length, 2);
        } finally {
            await runner?.close();
            inbox.close();
            human.close();
            await rm(dir, { recursive: true, force: true });
        }
    },
);

test('one shared compaction budget validates selected capacity and preserves output headroom across model sizes', () => {
    for (const window of [32768, 128000, 272000, 1000000]) {
        const model = { contextWindow: window, maxTokens: 8192 };
        const policy = contextCompaction(model);
        const target = Math.min(64000, Math.floor(window * 0.75));
        assert.equal(window - policy.reserveTokens, target);
        assert.equal(policy.keepRecentTokens, Math.min(24000, Math.floor(target / 2)));
        assert.ok(policy.reserveTokens >= model.maxTokens);
    }
    assert.throws(() => contextCompaction({}), /metadata/);
    assert.throws(() => contextCompaction({ contextWindow: 0 }), /metadata/);
    assert.throws(() => contextCompaction({ contextWindow: 32768, maxTokens: 32768 }), /headroom/);
});
