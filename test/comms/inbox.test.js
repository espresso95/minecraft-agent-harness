import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MailboxStore, MailboxObserver } from '../../src/comms/mailbox-store.js';
import { AgentInbox } from '../../src/comms/inbox.js';

function fixture(t) {
    const root = mkdtempSync(join(tmpdir(), 'inbox-')),
        file = join(root, 'mail.sqlite');
    const sender = new MailboxStore(file, 'Ada'),
        store = new MailboxStore(file, 'Bram'),
        observer = new MailboxObserver(file);
    const events = [],
        interrupts = [];
    const inbox = new AgentInbox({
        store,
        peers: ['Ada'],
        getRunner: () => ({ enqueue: (event, options) => events.push({ event, options }) }),
        actions: { status: { active: 'gather', background: false }, interrupt: text => interrupts.push(text) },
    });
    t.after(() => {
        sender.close();
        store.close();
        observer.close();
        rmSync(root, { recursive: true, force: true });
    });
    return { file, sender, store, observer, inbox, events, interrupts };
}

test('75 unread messages all notify and drain in full only after successful model responses', t => {
    const f = fixture(t);
    for (let i = 0; i < 75; i++) f.sender.sendDM('Bram', 'x'.repeat(500) + ` TAIL-${i}`);
    f.inbox.notify();
    assert.equal(f.inbox.cursor, 75);
    assert.equal(f.interrupts.length, 0);
    assert.ok(f.observer.messages().messages.every(m => !m.readByRecipient));
    let delivered = 0;
    while (f.store.unreadMessages().length) {
        const note = f.inbox.delivery();
        assert.match(JSON.stringify(note), /TAIL-/);
        assert.ok(JSON.stringify(note).includes('x'.repeat(500)));
        f.inbox.beginRequest(note);
        delivered += f.inbox.inFlight.length;
        f.inbox.finishRequest(true);
    }
    assert.equal(delivered, 75);
    assert.ok(f.observer.messages().messages.every(m => m.readByRecipient));
});

test('checkpoints ignore routine progress and never consume new actionable messages', t => {
    const f = fixture(t);
    f.sender.reportWork({ status: 'working', activity: 'Gathering logs' });
    assert.equal(f.inbox.shouldYield(), false);
    const id = f.sender.sendDM('Bram', 'Where is the chest?');
    assert.equal(f.inbox.shouldYield(), false);
    f.inbox.notify();
    assert.equal(f.events.at(-1).options.wakeWhenIdle, true);
    assert.equal(f.interrupts.length, 0);
    f.store.receiveDM('Human', 'Change the plan', { urgent: true });
    assert.equal(f.inbox.shouldYield(), true);
    assert.equal(f.observer.messages().messages.find(m => m.id === id).readByRecipient, false);
    const pending = f.inbox.delivery();
    f.inbox.beginRequest(pending);
    f.inbox.finishRequest(true);
    assert.equal(f.inbox.shouldYield(), false);
});

test('old unread records never hide newer messages or a human whisper arriving before a poll', t => {
    const f = fixture(t);
    for (let i = 0; i < 25; i++) f.sender.sendDM('Bram', `Old ${i}`);
    f.inbox.notify();
    const peer = f.sender.sendDM('Bram', 'Get stone');
    const human = f.store.receiveDM('Human', 'First, stop and help me', { urgent: true });
    f.inbox.notify();
    assert.equal(f.inbox.cursor, human);
    assert.ok(f.store.unreadMessages({ after: peer - 1 }).some(m => m.id === peer));
    assert.match(JSON.stringify(f.inbox.delivery()), /First, stop and help me/);
    assert.equal(f.interrupts.length, 1);
});

test('UI history and notifications do not acknowledge messages; failure and restart retain delivery', t => {
    const f = fixture(t);
    f.sender.sendDM('Bram', 'A complete task description');
    f.inbox.notify();
    const pending = f.inbox.delivery();
    f.inbox.beginRequest(pending);
    f.inbox.finishRequest(false);
    f.inbox.endCycle({ failed: true });
    assert.equal(f.observer.messages().messages[0].readByRecipient, false);
    const restarted = new AgentInbox({
        store: f.store,
        peers: ['Ada'],
        getRunner: () => null,
        actions: { status: {} },
    });
    const pendingAgain = restarted.delivery();
    assert.match(JSON.stringify(pendingAgain), /A complete task description/);
    restarted.beginRequest(pendingAgain);
    restarted.finishRequest(true);
    assert.equal(f.observer.messages().messages[0].readByRecipient, true);
});

test('activity reports stay outside mail and urgent coordination can interrupt', t => {
    const f = fixture(t);
    f.sender.reportWork({ status: 'working', activity: 'Gathering logs' });
    f.inbox.notify();
    assert.equal(f.events.length, 0);
    assert.equal(f.observer.messages().messages.length, 0);
    f.sender.sendDM('Bram', 'Avoid the lava', { urgent: true });
    f.inbox.notify();
    assert.equal(f.interrupts.length, 1);
});

test('a sender cannot acknowledge another recipient and post-commit observers see complete writes', t => {
    const f = fixture(t);
    const id = f.sender.sendDM('Bram', 'Read me');
    f.sender.acknowledge([id]);
    assert.equal(f.observer.messages().messages[0].readByRecipient, false);
    let notified = 0;
    const writer = new MailboxStore(f.file, 'Writer', {
        onCommit: () => {
            notified++;
            assert.ok(f.observer.latestId() > id);
        },
    });
    try {
        writer.sendMany(['Bram', 'Ada'], 'Hi', 'commit-test-00001');
        assert.equal(notified, 1);
        assert.throws(() => writer.sendDM('Bram', 'Bad task', { type: 'working', taskId: 999 }), /metadata/);
        assert.equal(notified, 1);
    } finally {
        writer.close();
    }
});

test('peer chatter cannot hide a later human checkpoint or cancel message', t => {
    const f = fixture(t);
    for (let i = 0; i < 75; i++) f.sender.sendDM('Bram', `Routine discussion ${i}`);
    assert.equal(f.inbox.shouldYield(), false);
    f.store.receiveDM('Human', 'Stop this batch');
    assert.equal(f.inbox.shouldYield(), true);
});

test('goal edits wake an idle peer once without interrupting; activity reports remain passive', t => {
    const f = fixture(t);
    const goal = f.sender.setGoal({ title: 'Base', scope: 'At spawn' });
    f.inbox.notify();
    assert.equal(f.events.length, 1);
    assert.equal(f.events[0].options.wakeWhenIdle, true);
    assert.equal(f.events[0].options.interrupt, false);
    f.inbox.notify();
    assert.equal(f.events.length, 1);
    f.sender.reportWork({ status: 'working', activity: 'Mining stone', goalId: goal.id });
    f.inbox.notify();
    assert.equal(f.events.length, 1);
    f.sender.setGoal({ id: goal.id, scope: 'Fixed site (10,65,20)' });
    f.inbox.notify();
    assert.equal(f.events.length, 2);
    assert.equal(f.inbox.shouldYield(), false);
});

test('conditional waiting ignores unrelated work, wakes on its condition and still receives human instructions', t => {
    const f = fixture(t);
    const runner = {
        waitFor: { checks: [{ kind: 'inventory', name: 'stone', count: 4 }] },
        enqueue: (event, options) => f.events.push({ event, options }),
    };
    f.inbox.getRunner = () => runner;
    let met = false;
    f.inbox.checkWait = () => met;
    f.inbox.notifyWork();
    assert.equal(f.events.length, 0);
    f.store.receiveDM('Human', 'Come here');
    f.inbox.notify();
    assert.equal(f.events[0].options.urgent, true);
    met = true;
    f.inbox.notifyWork();
    assert.equal(f.events.at(-1).event.kind, 'work');
    assert.equal(f.events.at(-1).options.interrupt, false);
});
