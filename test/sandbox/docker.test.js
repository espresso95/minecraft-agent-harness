import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { containerName, createDockerBackend, dockerAvailable } from '../../src/sandbox/docker.js';

const RELAY = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src/sandbox/assets/relay.cjs');

function fakeDocker({ initial = 'missing', workdir, sharedDir } = {}) {
    const calls = [];
    let status = initial,
        relay = null;
    const port = 30000 + Math.floor(Math.random() * 20000);
    const exec = async args => {
        calls.push(args);
        const [cmd] = args;
        if (cmd === 'inspect')
            return status === 'missing'
                ? { code: 1, stdout: '', stderr: 'No such object' }
                : {
                      code: 0,
                      stdout: args.includes('{{json .Mounts}}')
                          ? JSON.stringify([
                                { Source: workdir, Destination: '/home/agent' },
                                ...(sharedDir ? [{ Source: sharedDir, Destination: '/opt/shared' }] : []),
                            ])
                          : status === 'running'
                            ? 'true\n'
                            : 'false\n',
                      stderr: '',
                  };
        if (cmd === 'rm') {
            status = 'missing';
            relay?.kill('SIGKILL');
        }
        if (cmd === 'run' || cmd === 'start') {
            status = 'running';
            return { code: 0, stdout: 'id\n', stderr: '' };
        }
        if (cmd === 'exec' && args[1] === '-d') {
            relay?.kill('SIGKILL');
            relay = spawn(process.execPath, [RELAY, String(port), args.at(-1)], { stdio: 'ignore' });
            return { code: 0, stdout: '', stderr: '' };
        }
        if (cmd === 'port') return { code: 0, stdout: `127.0.0.1:${port}\n`, stderr: '' };
        if (cmd === 'stop') {
            status = 'stopped';
            relay?.kill('SIGKILL');
            return { code: 0, stdout: '', stderr: '' };
        }
        if (cmd === 'exec' && args.includes('bash') && args.at(-1).includes('HARNESS_CMD'))
            return { code: 124, stdout: 'partial', stderr: '', killed: false };
        return { code: 0, stdout: '', stderr: '' };
    };
    return { exec, calls, stopRelay: () => relay?.kill('SIGKILL') };
}

test('container names are stable per agent and state dir, and safe for docker', () => {
    const a = containerName('Ada Lovelace!', '/tmp/x');
    assert.equal(a, containerName('Ada Lovelace!', '/tmp/x'));
    assert.notEqual(a, containerName('Ada Lovelace!', '/tmp/y'));
    assert.match(a, /^minecraft-agent-ada-lovelace--[0-9a-f]{8}$/);
});

test('start creates an isolated persistent container with the state dir mounted and a loopback relay port', async () => {
    const workdir = mkdtempSync(path.join(os.tmpdir(), 'dock-'));
    const fake = fakeDocker();
    const backend = createDockerBackend({ agentName: 'Ada', workdir, exec: fake.exec, user: '1000:1000' });
    await backend.start({ invoke: async () => ({}), tools: [{ name: 'inventory', description: 'x' }] });
    const run = fake.calls.find(c => c[0] === 'run');
    assert.ok(run, 'container created');
    assert.ok(run.includes(`${workdir}:/home/agent`));
    assert.ok(run.includes('127.0.0.1::7777'));
    assert.deepEqual(run.slice(run.indexOf('--user'), run.indexOf('--user') + 2), ['--user', '1000:1000']);
    assert.deepEqual(run.slice(-3), ['node:22-bookworm', 'sleep', 'infinity']);
    assert.ok(readFileSync(path.join(workdir, 'bin', 'tool'), 'utf8').includes('/home/agent/.harness/tools.json'));
    assert.ok(existsSync(path.join(workdir, '.harness', 'relay.cjs')));
    assert.equal(backend.env().TOOL_RELAY_URL, 'http://127.0.0.1:7777');
    await backend.close();
    assert.ok(fake.calls.some(c => c[0] === 'stop'));
    assert.ok(!fake.calls.some(c => c[0] === 'rm'), 'container is kept for the next run');
});

test('start reuses an existing container instead of creating a new one', async () => {
    const workdir = mkdtempSync(path.join(os.tmpdir(), 'dock-'));
    const fake = fakeDocker({ initial: 'stopped', workdir });
    const backend = createDockerBackend({ agentName: 'Ada', workdir, exec: fake.exec });
    await backend.start({ invoke: async () => ({}), tools: [] });
    assert.ok(fake.calls.some(c => c[0] === 'start'));
    assert.ok(!fake.calls.some(c => c[0] === 'run'));
    await backend.close();
});

test('changed shared mounts recreate only the disposable container and retain private files', async () => {
    const workdir = mkdtempSync(path.join(os.tmpdir(), 'dock-'));
    const sharedDir = mkdtempSync(path.join(os.tmpdir(), 'dock-shared-'));
    const fake = fakeDocker({ initial: 'running', workdir, sharedDir: '/old-private-shared-dir' });
    const backend = createDockerBackend({ agentName: 'Ada', workdir, sharedDir, exec: fake.exec });
    try {
        await backend.start({ invoke: async () => ({}), tools: [] });
        assert.ok(fake.calls.some(c => c[0] === 'rm' && c.includes('-f')));
        const run = fake.calls.find(c => c[0] === 'run');
        assert.ok(run.includes(`${sharedDir}:/opt/shared`));
        assert.ok(run.includes(`${workdir}:/home/agent`));
        assert.ok(existsSync(path.join(workdir, '.harness', 'tools.json')));
    } finally {
        await backend.close();
    }
});

test('run passes the command through env, bounds it with timeout and reports timeouts', async () => {
    const workdir = mkdtempSync(path.join(os.tmpdir(), 'dock-'));
    const fake = fakeDocker({ initial: 'running', workdir });
    const backend = createDockerBackend({ agentName: 'Ada', workdir, exec: fake.exec });
    await backend.start({ invoke: async () => ({}), tools: [] });
    const r = await backend.run('echo "quoted $HOME"', { timeoutMs: 5000, outputBytes: 1000 });
    const call = fake.calls.find(c => c.at(-1)?.includes?.('HARNESS_CMD'));
    assert.ok(call.includes('HARNESS_CMD=echo "quoted $HOME"'));
    assert.match(call.at(-1), /timeout -k 2 5 bash -c "\$HARNESS_CMD"/);
    assert.equal(r.timedOut, true);
    assert.equal(r.exitCode, 124);
    assert.equal(r.stdout, 'partial');
    await backend.close();
});

test('tool calls from the container reach invoke through the relay', async () => {
    const workdir = mkdtempSync(path.join(os.tmpdir(), 'dock-'));
    const fake = fakeDocker();
    const seen = [];
    const backend = createDockerBackend({
        agentName: 'Ada',
        workdir,
        exec: fake.exec,
    });
    await backend.start({
        invoke: async (name, args) => {
            seen.push([name, args]);
            return { ok: 1 };
        },
        tools: [],
    });
    const port = (await fake.exec(['port'])).stdout.trim().split(':')[1];
    const token = backend.env().TOOL_API_TOKEN;
    const r = await fetch(`http://127.0.0.1:${port}/call`, {
        method: 'POST',
        headers: { 'x-token': token, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'inventory', args: { a: 1 } }),
    });
    assert.deepEqual(await r.json(), { ok: true, result: { ok: 1 } });
    assert.deepEqual(seen, [['inventory', { a: 1 }]]);
    await backend.close();
});

const live = dockerAvailable() && spawnSync('docker', ['image', 'inspect', 'node:22-bookworm']).status === 0;

test(
    'live docker: shell, tool relay and persistence across restarts',
    { skip: !live && 'docker or node:22-bookworm not available' },
    async () => {
        const workdir = mkdtempSync(path.join(os.tmpdir(), 'dock-live-'));
        const tools = [{ name: 'inventory', description: 'Inspect inventory' }];
        const invoke = async name => ({ tool: name, items: [] });
        const first = createDockerBackend({ agentName: 'LiveTest', workdir });
        let second;
        try {
            await first.start({ invoke, tools });
            const r = await first.run('echo hello > ~/note.txt; id -u; tool inventory', {
                timeoutMs: 60000,
                outputBytes: 10000,
            });
            assert.equal(r.exitCode, 0, r.stderr);
            assert.match(r.stdout, new RegExp(`^${process.getuid()}\\n`));
            assert.match(r.stdout, /"tool":"inventory"/);
            const slow = await first.run('sleep 30', { timeoutMs: 2000, outputBytes: 1000 });
            assert.equal(slow.timedOut, true);
            await first.close();
            second = createDockerBackend({ agentName: 'LiveTest', workdir });
            await second.start({ invoke, tools });
            const again = await second.run('cat ~/note.txt; tool inventory', { timeoutMs: 60000, outputBytes: 10000 });
            assert.match(again.stdout, /^hello\n/);
            assert.match(again.stdout, /"tool":"inventory"/);
        } finally {
            await first.close().catch(() => {});
            await second?.close().catch(() => {});
            spawnSync('docker', ['rm', '-f', containerName('LiveTest', workdir)]);
        }
    },
);
