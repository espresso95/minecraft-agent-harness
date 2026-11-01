import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLocalBackend } from '../../src/sandbox/shell-sandbox.js';
import { createShellTools } from '../../src/tools/shell-tools.js';

async function setup(invokeImpl) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shell-'));
    const shared = path.join(root, 'shared');
    await fs.mkdir(path.join(shared, 'tools'), { recursive: true });
    const calls = [];
    const invoke = async (name, args) => {
        calls.push({ name, args });
        return invokeImpl(name, args);
    };
    const backend = createLocalBackend({ workdir: path.join(root, 'home'), sharedDir: shared });
    const [tool] = createShellTools({
        backend,
        invoke,
        toolList: () => [
            { name: 'place_block', description: 'Place a block', parameters: { type: 'object' } },
            { name: 'run_code', description: 'blocked', parameters: {} },
        ],
        limits: { timeoutMs: 5000 },
    });
    const run = (cmd, extra = {}) => tool.execute('t', { cmd, ...extra });
    return { tool, run, calls, root, shared };
}

test('runs bash, persists files across calls, non-zero exit reported', async () => {
    const s = await setup(async () => ({}));
    const a = await s.run('echo hello > note.txt; cat note.txt');
    assert.ok(!a.isError);
    assert.match(a.content[0].text, /hello/);
    const b = await s.run('cat note.txt && exit 3');
    assert.match(b.content[0].text, /hello/);
    assert.match(b.content[0].text, /\[exit 3\]/);
    assert.equal(b.details.result.exitCode, 3);
    await s.tool.close();
});

test('tool CLI reaches harness tools through the relay and returns JSON', async () => {
    const s = await setup(async (name, args) => ({ placed: true, got: args }));
    const r = await s.run(`tool place_block '{"x":1,"y":2,"z":3,"block":"stone"}'`);
    assert.equal(r.details.ok, true, r.content[0].text);
    assert.deepEqual(JSON.parse(r.content[0].text.trim()), { placed: true, got: { x: 1, y: 2, z: 3, block: 'stone' } });
    assert.deepEqual(s.calls, [{ name: 'place_block', args: { x: 1, y: 2, z: 3, block: 'stone' } }]);
    await s.tool.close();
});

test('loops of tool calls all route through invoke; tool errors exit 1 with stderr', async () => {
    const s = await setup(async (name, args) => {
        if (args.y > 2) throw new Error('air removal rejected');
        return 'ok';
    });
    const r = await s.run('for y in 1 2 3; do tool place_block "{\\"y\\":$y}" || echo "failed $y"; done');
    assert.equal(s.calls.length, 3);
    assert.match(r.content[0].text, /"ok"\n"ok"\nfailed 3/);
    assert.match(r.content[0].text, /air removal rejected/);
    await s.tool.close();
});

test('a checked script batch stops on the first failed game action and preserves partial output', async () => {
    const s = await setup(async (_name, args) => {
        if (args.y === 2) throw new Error('occupied target');
        return { placed: 1 };
    });
    try {
        const result = await s.run('set -e; for y in 1 2 3; do tool place_block "{\\"y\\":$y}"; done');
        assert.deepEqual(
            s.calls.map(c => c.args.y),
            [1, 2],
        );
        assert.equal(result.isError, true);
        assert.equal(result.details.ok, false);
        assert.match(result.content[0].text, /placed/);
        assert.match(result.content[0].text, /occupied target/);
    } finally {
        await s.tool.close();
    }
});

test('Python checkpoints use the current task revision and preserve progress between batches', async () => {
    let revision = 4;
    const notes = [];
    const s = await setup(async (name, args) => {
        if (name === 'work_tasks') return { tasks: [{ id: args.id, revision }] };
        assert.equal(name, 'work_update');
        assert.equal(args.taskId, 7);
        assert.equal(args.revision, revision);
        assert.equal(args.state, 'checkpoint');
        assert.equal(args.checkpoint, args.note);
        notes.push(args.note);
        return { id: 7, revision: ++revision };
    });
    try {
        const r = await s.run(
            `python3 - <<'PY'\nfrom agent_tools import checkpoint\ncheckpoint(7, 'First section verified')\ncheckpoint(task_id=7, note='Second section verified')\nPY`,
        );
        assert.equal(r.isError, false, r.content[0].text);
        assert.deepEqual(notes, ['First section verified', 'Second section verified']);
        assert.deepEqual(
            s.calls.map(c => c.name),
            ['work_tasks', 'work_update', 'work_tasks', 'work_update'],
        );
    } finally {
        await s.tool.close();
    }
});

test('Python batches stop on a partial action and retain its progress data', async () => {
    const s = await setup(async () => ({ outcome: 'partial', placedCount: 1, requested: 3 }));
    try {
        const r = await s.run(
            `python3 - <<'PY'\nfrom agent_tools import call\ncall('place_line', {})\ncall('place_line', {})\nPY`,
        );
        assert.equal(r.isError, true);
        assert.equal(s.calls.length, 1);
        assert.match(r.content[0].text, /BatchIncomplete/);
        assert.match(r.content[0].text, /"placedCount": 1/);
        s.calls.length = 0;
        const cli = await s.run("set -e; tool place_line '{}'; tool place_line '{}'");
        assert.equal(cli.isError, true);
        assert.equal(s.calls.length, 1);
        assert.match(cli.content[0].text, /partial progress/);
    } finally {
        await s.tool.close();
    }
});

test('two agents reuse the same script library through their own tool relays', async () => {
    const first = await setup(async () => ({ agent: 'first' }));
    const backend = createLocalBackend({ workdir: path.join(first.root, 'second-home'), sharedDir: first.shared });
    const [second] = createShellTools({ backend, invoke: async () => ({ agent: 'second' }), toolList: () => [] });
    try {
        await first.run(
            'printf \'#!/bin/bash\\ntool inventory\\n\' > "$SHARED_TOOLS/who"; chmod +x "$SHARED_TOOLS/who"',
        );
        assert.match((await first.run('who')).content[0].text, /"agent":"first"/);
        assert.match((await second.execute('test', { cmd: 'who' })).content[0].text, /"agent":"second"/);
    } finally {
        await first.tool.close();
        await second.close();
    }
});

test('blocked tools cannot be reached from the shell; --list hides them', async () => {
    const s = await setup(async () => 'x');
    const r = await s.run(`tool run_code '{"code":"1"}'; echo "rc=$?"; tool --list`);
    assert.match(r.content[0].text, /cannot be called from the shell/);
    assert.match(r.content[0].text, /rc=1/);
    assert.match(r.content[0].text, /place_block/);
    assert.doesNotMatch(r.content[0].text, /run_code\s+blocked/);
    assert.equal(s.calls.length, 0);
    await s.tool.close();
});

test('saved scripts in ~/bin and $SHARED_TOOLS are runnable by name', async () => {
    const s = await setup(async (name, args) => args);
    await s.run('cat > ~/bin/stack <<\'X\'\n#!/bin/bash\ntool place_block "{\\"n\\":$1}"\nX\nchmod +x ~/bin/stack');
    await s.run("cat > $SHARED_TOOLS/wave <<'X'\n#!/bin/bash\necho shared-$1\nX\nchmod +x $SHARED_TOOLS/wave");
    const r = await s.run('stack 7 && wave hi');
    assert.match(r.content[0].text, /\{"n":7\}\nshared-hi/);
    assert.ok((await fs.stat(path.join(s.shared, 'tools', 'wave'))).isFile());
    await s.tool.close();
});

test('timeouts kill the command and report exit 124', async () => {
    const s = await setup(async () => 'x');
    const r = await s.run('sleep 30', { timeoutSec: 1 });
    assert.equal(r.details.result.exitCode, 124);
    assert.equal(r.details.result.timedOut, true);
    await s.tool.close();
});

test('abort signal kills the running command', async () => {
    const s = await setup(async () => 'x');
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const start = Date.now();
    const r = await s.tool.execute('t', { cmd: 'sleep 20' }, ac.signal);
    assert.ok(Date.now() - start < 5000);
    assert.notEqual(r.details.result.exitCode, 0);
    await s.tool.close();
});

test('output is capped', async () => {
    const s = await setup(async () => 'x');
    const r = await s.run('head -c 100000 /dev/zero | tr "\\0" a');
    assert.ok(r.content[0].text.length < 40000);
    assert.match(r.content[0].text, /truncated/);
    await s.tool.close();
});

test('a failure after execution starts never replays a potentially mutating script', async () => {
    let starts = 0,
        runs = 0;
    const backend = {
        kind: 'fake',
        async start() {
            starts++;
        },
        async run(cmd) {
            runs++;
            if (runs === 1) throw new Error('sandbox not found');
            return { exitCode: 0, timedOut: false, stdout: `ok ${cmd}`, stderr: '' };
        },
        async close() {},
    };
    const [tool] = createShellTools({ backend, invoke: async () => 1, toolList: () => [] });
    const r = await tool.execute('t', { cmd: 'echo hi' });
    assert.equal(starts, 1);
    assert.equal(runs, 1);
    assert.match(r.content[0].text, /sandbox not found/);
    assert.equal(r.details.ok, false);
    assert.equal(r.isError, true);
});
