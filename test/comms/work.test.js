import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MailboxStore, MailboxObserver } from '../../src/comms/mailbox-store.js';

function fixture(t) {
    const root = mkdtempSync(join(tmpdir(), 'shared-work-')),
        file = join(root, 'mail.sqlite');
    const human = new MailboxStore(file, 'Human'),
        first = new MailboxStore(file, 'First'),
        second = new MailboxStore(file, 'Second');
    t.after(() => {
        human.close();
        first.close();
        second.close();
        rmSync(root, { recursive: true, force: true });
    });
    return { file, human, first, second };
}

test('broadcasts share one goal; teammates can edit agreed facts without author permissions or claims', t => {
    const { human, first, second } = fixture(t);
    const [a, b] = human.sendMany(['First', 'Second'], 'Build a base', 'a-human-broadcast-0001');
    const goal = first.setGoal({ title: 'Base', scope: 'At (10,65,20)', sourceMessageId: a });
    assert.equal(second.setGoal({ title: 'Base', scope: 'Another interpretation', sourceMessageId: b }).id, goal.id);
    second.setGoal({ id: goal.id, scope: 'Fixed bounds x10..19, z20..29; floor65' });
    first.setGoal({ id: goal.id, title: 'Shared base' });
    assert.equal(second.work().goals[0].scope, 'Fixed bounds x10..19, z20..29; floor65');
    assert.equal(first.work().goals[0].title, 'Shared base');
    assert.equal(first.unreadMessages().length, 1);
});

test('personal reports replace stale blockers, preserve stable client IDs and never create unread mail', t => {
    const { file, first, second } = fixture(t);
    const goal = first.setGoal({ title: 'Base', scope: 'Fixed site (10,65,20)' });
    const blocked = first.reportWork({
        goalId: goal.id,
        status: 'blocked',
        activity: 'Looking for stone',
        blocker: 'No source visible',
    });
    const mining = first.reportWork({ goalId: goal.id, status: 'working', activity: 'Mining visible stone' });
    assert.equal(mining.id, blocked.id);
    assert.equal(mining.blocker, undefined);
    second.reportWork({ status: 'idle', activity: 'Waiting for a human request' });
    assert.equal(first.work().activities.length, 2);
    assert.equal(first.unreadMessages().length, 0);
    assert.equal(second.unreadMessages().length, 0);
    const observer = new MailboxObserver(file);
    t.after(() => observer.close());
    const before = observer.workRevision();
    first.reportWork({ goalId: goal.id, status: 'working', activity: 'Mining visible stone' });
    assert.equal(observer.workRevision(), before);
    assert.equal(observer.messages().messages.length, 0);
    assert.equal(observer.work().activities.find(a => a.agent === 'First').activity, 'Mining visible stone');
    assert.throws(() => first.reportWork({ status: 'blocked', activity: 'Waiting' }), /blocker/);
    assert.equal(first.work().activities.find(a => a.agent === 'First').status, 'working');
});

test('goal closure is informational and does not require children, checks or an author; public-chat dedup survives closure', t => {
    const { first, second } = fixture(t);
    const a = first.receiveChat('Human', 'Build a base'),
        b = second.receiveChat('Human', 'Build a base');
    const goal = first.setGoal({ title: 'Base', scope: 'Fixed site', sourceChatId: a });
    assert.equal(second.setGoal({ title: 'Base', scope: 'Fixed site', sourceChatId: b }).id, goal.id);
    second.setGoal({ id: goal.id, state: 'completed' });
    assert.equal(first.setGoal({ title: 'Base', scope: 'Fixed site', sourceChatId: a }).state, 'completed');
    first.reportWork({ goalId: goal.id, status: 'working', activity: 'Adding an agreed door' });
    assert.equal(first.work().activities.find(a => a.agent === 'First').status, 'working');
    assert.throws(() => first.setGoal({ id: 999, scope: 'Wrong ID' }), /Unknown goal/);
});

test('stopping a worker records its real blocker without assigning or rescheduling work; stockpiles remain observable', t => {
    const { first, second, file } = fixture(t);
    first.reportWork({ status: 'working', activity: 'Building the west wall', evidence: 'First row placed' });
    first.recoverWork('Disconnected; inspect before resuming');
    const report = second.work().activities[0];
    assert.equal(report.status, 'blocked');
    assert.equal(report.evidence, 'First row placed');
    first.observeContainer({ dimension: 'overworld', chest: { x: 1, y: 65, z: 2 }, contents: { cobblestone: 26 } });
    const reopened = new MailboxStore(file, 'Reader');
    t.after(() => reopened.close());
    assert.equal(reopened.work().resources[0].contents.cobblestone, 26);
    assert.equal(reopened.work().activities[0].blocker, 'Disconnected; inspect before resuming');
    assert.equal(reopened.unreadMessages().length, 0);
});

test('bounded observations disclose omitted context while the full board stays available', async t => {
    const { first } = fixture(t);
    for (let i = 0; i < 7; i++) first.setGoal({ title: `Project ${i}`, scope: `Fixed site ${i}` });
    const { workContext } = await import('../../src/comms/work.js');
    const context = workContext(first.work());
    assert.equal(context.goals.length, 5);
    assert.match(context.more, /work_status/);
    assert.equal(first.work().goals.length, 7);
});
