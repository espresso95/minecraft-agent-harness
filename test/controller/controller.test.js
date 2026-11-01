import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { MailboxStore } from '../../src/comms/mailbox-store.js';
import { UsageLedger } from '../../src/controller/usage-ledger.js';
import { installAgentControl } from '../../src/controller/agent-control.js';

import { fixture } from './fixtures.js';

test('both clients receive one canonical work view without consuming private messages', async t => {
    const { dir, call } = await fixture(t);
    const store = new MailboxStore(join(dir, 'shared/mailbox.sqlite'), 'Scout');
    t.after(() => store.close());
    const goal = store.createTask({ kind: 'goal', title: 'Human project' });
    let task = store.createTask({
        goalId: goal.id,
        title: 'Collect supplies',
        checks: [{ kind: 'inventory', name: 'birch_log', count: 6 }],
    });
    task = store.updateTask(task.id, { state: 'claimed', revision: task.revision, note: 'Started' });
    task = store.updateTask(task.id, {
        state: 'blocked',
        revision: task.revision,
        note: 'Need a reachable tree',
        checkpoint: 'Two logs collected',
    });
    const human = new MailboxStore(join(dir, 'shared/mailbox.sqlite'), 'Player');
    human.sendDM('Scout', 'Preserve the garden');
    human.close();
    const { value: state } = await call('/v1/state');
    const { value: raw } = await call('/v1/tasks');
    assert.equal(raw.tasks.find(t => t.id === task.id).state, 'blocked');
    const teamItem = state.work.items.find(t => t.id === task.id);
    assert.deepEqual(
        state.agents.find(a => a.name === 'Scout').work.items.find(t => t.id === task.id),
        teamItem,
    );
    const fields = Object.fromEntries(teamItem.fields.map(f => [f.label, f.value]));
    assert.equal(fields.Checkpoint, 'Two logs collected');
    assert.equal(fields.Blocker, 'Need a reachable tree');
    assert.equal(fields['Completion checks'], 'Inventory: at least 6 birch_log');
    assert.equal(store.unreadMessages().length, 1);
});

test('local API requires pairing, rejects foreign origins and agent impersonation', async t => {
    const { call } = await fixture(t);
    assert.equal((await call('/v1/state', null, 'wrong')).status, 401);
    assert.equal((await call('/v1/state', null, undefined, { origin: 'https://example.org' })).status, 403);
    assert.equal((await call('/v1/state')).status, 200);
    const body = { player: 'Scout', recipients: ['Builder'], text: 'forged', submissionId: 'test-message-0001' };
    assert.equal((await call('/v1/messages', body)).status, 400);
});

test('panel history never consumes agent unread receipts; retries do not duplicate broadcasts', async t => {
    const { dir, call } = await fixture(t);
    const body = {
        player: 'LocalPlayer',
        recipients: ['Scout', 'Builder'],
        text: 'Meet me at spawn',
        submissionId: 'test-message-0002',
    };
    const first = await call('/v1/messages', body),
        retry = await call('/v1/messages', body);
    assert.equal(first.status, 200);
    assert.deepEqual(first.value.ids, retry.value.ids);
    const history = await call('/v1/messages');
    assert.equal(history.value.messages.length, 2);
    assert.ok(history.value.messages.every(m => !m.readByRecipient));
    const ada = new MailboxStore(join(dir, 'shared/mailbox.sqlite'), 'Scout');
    assert.equal(ada.unreadMessages().length, 1);
    ada.readDMs();
    ada.close();
    const after = await call('/v1/messages?participants=LocalPlayer,Scout');
    assert.equal(after.value.messages[0].readByRecipient, true);
    assert.equal((await call('/v1/messages', { ...body, text: 'different' })).status, 400);
    assert.equal(
        (await call('/v1/messages', { ...body, submissionId: 'test-message-0003', recipients: ['NoSuchBot'] })).status,
        400,
    );
});

test('committed mail pushes targeted wake hints immediately and the existing poll repairs missed hints', async t => {
    const { c, dir, call, launches, notifications, commands } = await fixture(t);
    for (const name of ['Scout', 'Builder']) c.manager.start(name, { paused: true });
    await new Promise(resolve => setImmediate(resolve));
    const controlsBefore = commands.length;
    const sent = await call('/v1/messages', {
        player: 'Player',
        recipients: ['Builder'],
        text: 'Help me',
        submissionId: 'mailbox-push-test-01',
    });
    assert.equal(sent.status, 200);
    assert.deepEqual(notifications, ['Builder']);
    assert.equal(commands.length, controlsBefore);
    const mail = new MailboxStore(join(dir, 'shared/mailbox.sqlite'), 'Scout');
    try {
        mail.sendDM('bUiLdEr', 'Private peer message');
        launches.find(l => l.config.name === 'Scout').child.emit('message', { type: 'mailbox_committed' });
        assert.deepEqual(notifications, ['Builder', 'Builder']);
        // No IPC hint: the controller's existing periodic scan repairs delivery.
        for (let i = 0; i < 205; i++) mail.sendDM('Builder', 'Backlog ' + i);
        const deadline = Date.now() + 2500;
        while (notifications.length < 3 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
        assert.ok(notifications.length >= 3);
        assert.ok(notifications.every(name => name === 'Builder'));
        const history = await call('/v1/messages?limit=200');
        assert.ok(history.value.messages.every(m => !m.readByRecipient));
        assert.ok(
            c.manager
                .snapshot()
                .filter(a => a.name !== 'Watcher')
                .every(a => a.state === 'paused'),
        );
        assert.equal(c.ledger.totals().total, 0);
    } finally {
        mail.close();
    }
});

test('mailbox hints bypass pending controls and never acknowledge or resume a paused worker', async () => {
    const channel = new EventEmitter(),
        replies = [];
    channel.send = message => replies.push(message);
    let received = 0,
        release;
    const pending = new Promise(resolve => {
        release = resolve;
    });
    const remove = installAgentControl({
        channel,
        runner: { cancel: () => pending },
        actionRunner: { stop() {} },
        setStatus() {},
        record() {},
        onMailbox: () => received++,
    });
    try {
        channel.emit('message', { type: 'companion_control', id: 'pause-1', action: 'pause' });
        await Promise.resolve();
        channel.emit('message', { type: 'mailbox_available' });
        assert.equal(received, 1);
        assert.deepEqual(replies, []);
        release();
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(replies, [{ type: 'companion_ack', id: 'pause-1', ok: true }]);
    } finally {
        release();
        remove();
    }
});

test('roster is dynamic, models validate centrally, peer changes and rules do not restart paused workers', async t => {
    const { c, call, commands, launches } = await fixture(t);
    c.manager.start('Scout', { paused: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(launches.length, 1);
    assert.equal((await call('/v1/agents', { player: 'Player', agent: { name: 'Fourth' } })).status, 201);
    assert.equal(c.manager.entries.get('Fourth').state, 'stopped');
    assert.deepEqual(commands.at(-1)[1].configuration.peers, ['Builder', 'Watcher', 'Fourth']);
    assert.equal(
        (
            await call(
                '/v1/server',
                { player: 'Player', settings: { difficulty: 'normal', permanentDeath: true } },
                undefined,
                {},
                'PATCH',
            )
        ).status,
        200,
    );
    assert.equal(commands.at(-1)[1].configuration.permanentDeath, true);
    assert.equal(launches.length, 1);
    assert.equal(c.manager.entries.get('Scout').state, 'paused');
    for (const agent of [
        { authFile: 'secret' },
        { model: 'google/test' },
        { thinking: 'made-up' },
        { name: 'renamed' },
    ])
        assert.equal((await call('/v1/agents/Scout', { player: 'Player', agent }, undefined, {}, 'PATCH')).status, 400);
    assert.equal((await call('/v1/agents/scout', { player: 'Player' }, undefined, {}, 'DELETE')).status, 200);
    assert.equal(c.manager.entries.has('Scout'), false);
    assert.equal((await call('/v1/agents', { player: 'Player', agent: { name: 'Scout' } })).status, 201);
    assert.equal(c.manager.entries.get('Scout').child, null);
    assert.equal((await call('/v1/state')).value.usage.total, 0);
});

test('empty roster is valid and concurrent additions cannot bypass identity uniqueness', async t => {
    const { c, call } = await fixture(t, { agents: [] });
    assert.equal((await call('/v1/state')).value.agents.length, 0);
    const results = await Promise.all(
        ['Fresh', 'fresh'].map(name => call('/v1/agents', { player: 'Player', agent: { name } })),
    );
    assert.deepEqual(results.map(r => r.status).sort(), [201, 400]);
    assert.equal(c.manager.entries.size, 1);
    assert.equal((await call('/v1/agents', { player: 'Player', agent: { name: 'Player' } })).status, 400);
    assert.equal((await call('/v1/agents', { player: 'Player', agent: { name: 'bad name' } })).status, 400);
});

test('paired devices are bound to their player and revocation leaves host access intact', async t => {
    const { c, call } = await fixture(t);
    const code = c.access.snapshot().pairingCode;
    assert.equal(c.access.snapshot().lanEnabled, false);
    assert.equal((await call('/v1/pair', { player: 'Absent', code, kind: 'minecraft' }, '')).status, 400);
    const paired = await call('/v1/pair', { player: 'Player', code, kind: 'minecraft' }, '');
    assert.equal(paired.status, 200);
    const token = paired.value.token;
    assert.equal((await call('/v1/state', null, token)).status, 200);
    assert.equal((await call('/v1/agents', { player: 'Other', agent: { name: 'New' } }, token)).status, 400);
    assert.equal((await call('/v1/agents', { player: 'Player', agent: { name: 'New' } }, token)).status, 201);
    await call('/v1/access', { player: 'Player', access: { rotateCode: true } }, undefined, {}, 'PATCH');
    assert.equal((await call('/v1/state', null, token)).status, 401);
    assert.equal((await call('/v1/state')).status, 200);
    for (let i = 0; i < 5; i++) await call('/v1/pair', { player: 'Player', code: 'wrong' }, '');
    assert.match(
        (await call('/v1/pair', { player: 'Player', code: c.access.snapshot().pairingCode }, '')).value.error,
        /Too many/,
    );
    const html = await fetch(c.endpoint + '/');
    assert.match(html.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.match(await html.text(), /Companions/);
    assert.equal((await call('/auth.json')).status, 404);
});

test('usage includes cached input once, reasoning once, remains deduplicated and survives reopening', t => {
    const dir = mkdtempSync(join(tmpdir(), 'usage-ledger-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, 'usage.sqlite');
    let ledger = new UsageLedger(file);
    const context = { agent: 'Scout', run: 'run1', session: 'play1' };
    const at = new Date().toISOString();
    ledger.ingest({ event: 'request_start', id: 'one', at, model: 'gpt-6-luna', thinking: 'xhigh' }, context);
    const terminal = {
        event: 'response_usage',
        id: 'one',
        responseId: 'response1',
        at,
        usage: {
            input_tokens: 100,
            input_tokens_details: { cached_tokens: 80 },
            output_tokens: 20,
            output_tokens_details: { reasoning_tokens: 12 },
            total_tokens: 120,
        },
    };
    ledger.ingest(terminal, context);
    ledger.ingest(terminal, context);
    ledger.ingest({ event: 'request_start', id: 'two', at }, context);
    assert.equal(ledger.totals('Scout').pending, 1);
    ledger.finishRun('run1');
    assert.deepEqual(
        Object.fromEntries(
            ['input', 'cached', 'output', 'reasoning', 'total', 'reported', 'pending', 'unknown'].map(k => [
                k,
                ledger.totals('Scout')[k],
            ]),
        ),
        { input: 100, cached: 80, output: 20, reasoning: 12, total: 120, reported: 1, pending: 0, unknown: 1 },
    );
    ledger.close();
    ledger = new UsageLedger(file);
    assert.equal(ledger.totals('Scout').total, 120);
    ledger.close();
});

test('pause drains work and stops the body; resume and stop acknowledge separately', async () => {
    const channel = new EventEmitter(),
        calls = [],
        replies = [];
    channel.send = value => replies.push(value);
    const remove = installAgentControl({
        channel,
        runner: {
            async cancel() {
                calls.push('cancel');
            },
            enqueue() {
                calls.push('event');
            },
            start() {
                calls.push('resume');
            },
        },
        actionRunner: {
            async stop() {
                calls.push('body-stop');
            },
        },
        setStatus: s => calls.push(s),
        record() {},
        stop: async () => calls.push('stop'),
    });
    for (const action of ['pause', 'resume', 'stop'])
        channel.emit('message', { type: 'companion_control', id: action, action });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, ['cancel', 'body-stop', 'paused', 'event', 'resume', 'running', 'stop']);
    assert.equal(replies.filter(r => r.ok).length, 3);
    remove();
});

test('team filters include a third agent and removed identities retain mail and usage', async t => {
    const { c, dir, call } = await fixture(t);
    const mail = new MailboxStore(join(dir, 'shared/mailbox.sqlite'), 'Watcher');
    mail.sendMany(['Builder'], 'Coordinate here', 'third-agent-message');
    mail.close();
    let history = await call('/v1/messages?sender=Watcher&recipient=Builder');
    assert.equal(history.value.messages.length, 1);
    assert.equal(history.value.messages[0].text, 'Coordinate here');
    c.ledger.ingest(
        {
            event: 'response_usage',
            id: 'retained',
            at: new Date().toISOString(),
            usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
        },
        { agent: 'Watcher', run: 'saved-run', session: 'previous' },
    );
    await call('/v1/agents/Watcher', { player: 'Player' }, undefined, {}, 'DELETE');
    assert.ok((await call('/v1/state')).value.participants.includes('Watcher'));
    assert.equal((await call('/v1/messages?sender=Watcher')).value.messages.length, 1);
    await call('/v1/agents', { player: 'Player', agent: { name: 'Watcher' } });
    const snapshot = (await call('/v1/state')).value;
    assert.equal(snapshot.agents.find(a => a.name === 'Watcher').lifetimeUsage.total, 25);
    assert.equal(snapshot.usage.total, 0);
    assert.equal(snapshot.lifetimeUsage.total, 25);
    assert.equal((await call('/v1/messages?limit=0')).status, 400);
});

test('agents-only history uses the roster for both directions and never consumes receipts', async t => {
    const { dir, call, c } = await fixture(t);
    const watcher = new MailboxStore(join(dir, 'shared/mailbox.sqlite'), 'wAtChEr');
    watcher.sendMany(['Builder'], 'Gather wood', 'agent-filter-0001');
    watcher.sendMany(['Player'], 'I will gather wood', 'agent-filter-0002');
    const builder = new MailboxStore(join(dir, 'shared/mailbox.sqlite'), 'Builder');
    builder.sendMany(['Watcher'], 'I will build', 'agent-filter-0003');
    await call('/v1/messages', {
        player: 'Player',
        recipients: ['Watcher'],
        text: 'Hello',
        submissionId: 'agent-filter-0004',
    });
    const filtered = (await call('/v1/messages?agentsOnly=true')).value;
    assert.deepEqual(
        filtered.messages.map(m => m.text),
        ['Gather wood', 'I will build'],
    );
    assert.ok(filtered.messages.every(m => m.agentConversation && !m.readByRecipient));
    assert.equal((await call('/v1/messages?agentsOnly=true&sender=Builder')).value.messages.length, 1);
    assert.equal((await call('/v1/messages?agentsOnly=true&recipient=Player')).value.messages.length, 0);
    assert.equal((await call('/v1/messages')).value.messages.filter(m => m.agentConversation).length, 2);
    assert.equal(builder.unreadMessages().length, 1);
    assert.equal(watcher.unreadMessages().length, 2);
    builder.close();
    watcher.close();
    await call('/v1/agents/Watcher', { player: 'Player' }, undefined, {}, 'DELETE');
    assert.equal((await call('/v1/messages?agentsOnly=true')).value.messages.length, 0);
    assert.equal((await call('/v1/messages')).value.messages.length, 4);
    assert.equal(c.ledger.totals().total, 0);
});

test('forward message cursor catches a busy feed exactly once and latest skips old history', async t => {
    const { dir, call } = await fixture(t);
    const mailbox = new MailboxStore(join(dir, 'shared/mailbox.sqlite'), 'Watcher');
    mailbox.sendMany(['Builder'], 'Old history', 'stream-history-0001');
    const baseline = (await call('/v1/messages?after=latest')).value;
    assert.deepEqual(baseline.messages, []);
    assert.equal(baseline.hasMore, false);
    for (let i = 0; i < 125; i++)
        mailbox.sendMany(['Builder'], 'Live ' + i, 'stream-message-' + String(i).padStart(4, '0'));
    let cursor = baseline.nextAfter;
    const seen = [];
    for (;;) {
        const page = (await call('/v1/messages?after=' + cursor + '&limit=17')).value;
        assert.equal(page.hasOlder, false);
        assert.equal(page.session, baseline.session);
        seen.push(...page.messages);
        cursor = page.nextAfter;
        if (!page.hasMore) break;
    }
    assert.equal(seen.length, 125);
    assert.equal(new Set(seen.map(m => m.id)).size, 125);
    assert.deepEqual(
        seen.map(m => m.text),
        Array.from({ length: 125 }, (_, i) => 'Live ' + i),
    );
    assert.ok(seen.every(m => !m.readByRecipient));
    assert.deepEqual((await call('/v1/messages?after=' + cursor)).value.messages, []);
    assert.equal((await call('/v1/messages?after=latest')).value.nextAfter, cursor);
    for (const query of ['after=-1', 'after=no', 'after=0&before=1', 'agentsOnly=yes'])
        assert.equal((await call('/v1/messages?' + query)).status, 400);
    mailbox.close();
});
