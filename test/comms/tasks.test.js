import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { MailboxStore, MailboxObserver } from '../../src/comms/mailbox-store.js';

function fixture(t) {
    const dir = mkdtempSync(join(tmpdir(), 'shared-work-')),
        file = join(dir, 'mailbox.sqlite'),
        stores = [];
    t.after(() => {
        for (const s of stores) s.close();
        rmSync(dir, { recursive: true, force: true });
    });
    const open = name => {
        const store = new MailboxStore(file, name);
        stores.push(store);
        return store;
    };
    return { file, open, planner: open('Planner'), first: open('First'), second: open('Second') };
}
const update = (store, task, state, extra = {}) =>
    store.updateTask(task.id, { revision: task.revision, state, note: state, ...extra });

test('shared dependencies, atomic ownership, checkpoints and ready handoff use one durable record', t => {
    const f = fixture(t),
        goal = f.planner.createTask({ kind: 'goal', title: 'A human project' });
    const first = f.planner.createTask({ goalId: goal.id, title: 'First independent step' });
    const next = f.planner.createTask({ goalId: goal.id, title: 'Use its result', dependencies: [first.id] });
    assert.deepEqual(
        f.first.work().ready.map(t => t.id),
        [first.id],
    );
    assert.equal(f.second.tasks().find(t => t.id === next.id).state, 'waiting');
    const claimed = update(f.first, first, 'claimed');
    assert.throws(() => update(f.second, first, 'claimed'), /changed|claimed/);
    assert.throws(() => update(f.planner, claimed, 'ready'), /owner/);
    assert.throws(() => update(f.second, claimed, 'working'), /Claim/);
    const progress = update(f.first, claimed, 'working', { checkpoint: 'Three verified steps completed' });
    const done = update(f.first, progress, 'completed', { evidence: 'Observed result' });
    assert.equal(done.checkpoint, 'Three verified steps completed');
    assert.equal(f.second.work().ready[0].id, next.id);
    const observer = new MailboxObserver(f.file);
    assert.deepEqual(observer.work('Second'), f.second.work());
    observer.close();
    assert.equal(
        f
            .open('First')
            .tasks()
            .find(t => t.id === first.id).state,
        'completed',
    );
});

test('cycles, stale edits, cross-goal dependencies and premature goal completion are rejected', t => {
    const f = fixture(t),
        goal = f.planner.createTask({ kind: 'goal', title: 'Project' });
    let a = f.planner.createTask({ goalId: goal.id, title: 'A' });
    const b = f.planner.createTask({ goalId: goal.id, title: 'B', dependencies: [a.id] });
    assert.throws(() => update(f.planner, a, 'revised', { dependencies: [b.id] }), /cycle/);
    a = update(f.planner, a, 'revised', { title: 'Revised A' });
    assert.equal(a.title, 'Revised A');
    assert.throws(
        () => f.planner.updateTask(a.id, { state: 'cancelled', revision: a.id, note: 'stale edit' }),
        /changed/,
    );
    assert.throws(() => update(f.planner, goal, 'completed'), /Finish/);
    const other = f.planner.createTask({ kind: 'goal', title: 'Other' });
    assert.throws(
        () => f.planner.createTask({ goalId: other.id, title: 'Wrong graph', dependencies: [a.id] }),
        /same goal/,
    );
    const cancelled = update(f.planner, goal, 'cancelled');
    assert.equal(cancelled.state, 'cancelled');
    assert.ok(
        f.first
            .tasks()
            .filter(t => t.goalId === goal.id)
            .every(t => t.state === 'cancelled'),
    );
    assert.equal(f.first.work().readyCount, 0);
});

test('a human broadcast resolves to one goal across agents without replay or parsing the instruction', t => {
    const f = fixture(t),
        human = f.open('Human');
    const [a, b] = human.sendMany(['First', 'Second'], 'Build something useful', 'broadcast_submission_123');
    const first = f.first.createTask({ kind: 'goal', title: 'My proposed title', sourceMessageId: a });
    const second = f.second.createTask({ kind: 'goal', title: 'A different proposed title', sourceMessageId: b });
    assert.equal(first.id, second.id);
    assert.equal(f.first.tasks().filter(t => t.kind === 'goal').length, 1);
    assert.throws(
        () => f.second.createTask({ kind: 'goal', title: 'Cannot read another mailbox', sourceMessageId: a }),
        /addressed/,
    );
});

test('closed status retries are idempotent and conflicting updates remain errors', t => {
    const f = fixture(t),
        id = f.planner.sendDM('First', 'An assignment', { type: 'request' });
    const message = f.first.sendDM('Planner', 'Done', { type: 'completed', taskId: id });
    assert.equal(f.first.sendDM('Planner', 'Done', { type: 'completed', taskId: id }), message);
    assert.throws(() => f.first.sendDM('Planner', 'Different outcome', { type: 'cancelled', taskId: id }), /closed/);
    const observer = new MailboxObserver(f.file);
    assert.equal(observer.messages().messages.length, 2);
    observer.close();
});

test('stopped workers release into blocked recovery with checkpoint preserved, never automatic replay', t => {
    const f = fixture(t),
        goal = f.planner.createTask({ kind: 'goal', title: 'Project' });
    const task = f.planner.createTask({ goalId: goal.id, title: 'A mutable action' });
    let current = update(f.first, task, 'claimed');
    current = update(f.first, current, 'working', { checkpoint: 'Partially completed; verify before resuming' });
    f.first.recoverTasks('Disconnected');
    current = f.second.tasks().find(t => t.id === task.id);
    assert.equal(current.state, 'blocked');
    assert.equal(current.owner, null);
    assert.equal(f.second.work().readyCount, 0);
    assert.match(current.checkpoint, /Partially/);
    const released = update(f.second, current, 'ready', { note: 'Verified current world; ready to resume' });
    assert.equal(update(f.second, released, 'claimed').owner, 'Second');
});

test('separate processes racing a shared task produce exactly one owner', async t => {
    const f = fixture(t),
        goal = f.planner.createTask({ kind: 'goal', title: 'Race' });
    const task = f.planner.createTask({ goalId: goal.id, title: 'Exclusive mutation' });
    const source = `import {MailboxStore} from ${JSON.stringify(new URL('../../src/comms/mailbox-store.js', import.meta.url).href)}; const s=new MailboxStore(process.argv[1],process.argv[2]); try {s.updateTask(Number(process.argv[3]),{state:'claimed',revision:Number(process.argv[3]),note:'claim'});console.log('won')}catch{console.log('lost')}finally{s.close()}`;
    const run = name =>
        new Promise((resolve, reject) => {
            const p = spawn(process.execPath, ['--input-type=module', '-e', source, f.file, name, String(task.id)], {
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            let out = '';
            p.stdout.on('data', c => (out += c));
            p.on('error', reject);
            p.on('exit', code => (code ? reject(new Error('Claim child failed')) : resolve(out.trim())));
        });
    assert.deepEqual((await Promise.all([run('First'), run('Second')])).sort(), ['lost', 'won']);
    assert.ok(['First', 'Second'].includes(f.planner.tasks().find(t => t.id === task.id).owner));
});

test('one atomic plan resolves forward dependency keys and can begin useful work without status calls', t => {
    const f = fixture(t);
    const plan = f.first.planWork({
        title: 'Project',
        tasks: [
            { key: 'finish', title: 'Use the materials', after: ['materials'], claim: true },
            { key: 'materials', title: 'Collect materials', claim: true },
        ],
    });
    const materials = plan.tasks.find(t => t.key === 'materials'),
        finish = plan.tasks.find(t => t.key === 'finish');
    assert.equal(materials.state, 'working');
    assert.equal(materials.owner, 'First');
    assert.equal(finish.state, 'waiting');
    assert.deepEqual(finish.dependencies, [materials.id]);
    const done = update(f.first, materials, 'completed', { evidence: 'Observed materials' });
    assert.equal(done.state, 'completed');
    assert.equal(f.second.work().ready[0].id, finish.id);
    const count = f.first.tasks().length;
    assert.throws(
        () =>
            f.first.planWork({
                goalId: plan.goal.id,
                tasks: [
                    { key: 'a', title: 'A', after: ['b'] },
                    { key: 'b', title: 'B', after: ['a'] },
                ],
            }),
        /cycle/,
    );
    assert.equal(f.first.tasks().length, count);
    const replay = f.first.planWork({
        goalId: plan.goal.id,
        tasks: [{ key: 'finish', title: 'Use the materials', after: ['materials'] }],
    });
    assert.equal(replay.tasks[0].id, finish.id);
    assert.equal(f.first.tasks().length, count);
});

test('public game-chat copies share one plan; an old delivery cannot resurrect a closed goal', t => {
    const f = fixture(t),
        a = f.first.receiveChat('Human', 'Build a project'),
        b = f.second.receiveChat('Human', 'Build a project');
    const one = f.first.planWork({
        title: 'Shared project',
        sourceChatId: a,
        tasks: [{ key: 'work', title: 'Do useful work' }],
    });
    const two = f.second.planWork({
        title: 'Different proposal',
        sourceChatId: b,
        tasks: [{ key: 'other', title: 'Another plan' }],
    });
    assert.equal(one.goal.id, two.goal.id);
    assert.deepEqual(
        one.tasks.map(t => t.id),
        two.tasks.map(t => t.id),
    );
    update(f.first, one.goal, 'cancelled');
    assert.equal(
        f.second.planWork({
            title: 'Stale delivery',
            sourceChatId: b,
            tasks: [{ key: 'stale', title: 'Must not restart' }],
        }).goal.state,
        'cancelled',
    );
    const fresh = f.first.receiveChat('Human', 'Build a project');
    const next = f.first.planWork({
        title: 'New request after cancellation',
        sourceChatId: fresh,
        tasks: [{ key: 'new', title: 'New work' }],
    });
    assert.notEqual(next.goal.id, one.goal.id);
});
