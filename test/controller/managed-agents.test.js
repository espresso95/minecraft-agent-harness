import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManagedAgents } from '../../src/controller/managed-agents.js';
import { UsageLedger } from '../../src/controller/usage-ledger.js';

test('unsupported compaction connections preserve profiles paused without launching or retrying workers', async t => {
    const dir = mkdtempSync(join(tmpdir(), 'native-policy-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const config = { name: 'SavedClaude', model: 'claude-code/test', thinking: 'xhigh' };
    const manager = new ManagedAgents({
        agents: [config],
        stateDir: dir,
        modelProblem: () => 'Provider-native compaction unavailable',
        spawnWorker: () => {
            throw Error('Must not launch');
        },
    });
    assert.equal(manager.start(config.name, { paused: true }), false);
    const entry = manager.entries.get(config.name);
    assert.equal(entry.state, 'paused');
    assert.equal(entry.desiredPaused, true);
    assert.equal(entry.config, config);
    await assert.rejects(manager.command(config.name, 'resume'), /Provider-native compaction unavailable/);
    assert.equal(entry.child, null);
    await manager.close();
});

test('managed lifecycle handles immediate exits and recovers split UTF-8 usage without double counting', async t => {
    const dir = mkdtempSync(join(tmpdir(), 'managed-agents-'));
    const ledger = new UsageLedger(join(dir, 'usage.sqlite'));
    t.after(() => {
        ledger.close();
        rmSync(dir, { recursive: true, force: true });
    });
    let child, launched;
    const options = {
        agents: [{ name: 'Ada', model: 'openai/gpt-6-luna', thinking: 'xhigh', objective: 'Help' }],
        stateDir: dir,
        authFile: join(dir, 'auth.json'),
        host: '127.0.0.1',
        port: 25565,
        ledger,
        session: 'play1',
        spawnWorker(command, args, settings) {
            launched = { args, settings };
            child = new EventEmitter();
            child.stdout = new PassThrough();
            child.stderr = new PassThrough();
            child.kill = () => {
                queueMicrotask(() => child.emit('exit', 0));
                return true;
            };
            child.send = (message, callback) => {
                queueMicrotask(() => {
                    child.emit('message', { type: 'companion_ack', id: message.id, ok: true });
                    if (message.action === 'stop') child.emit('exit', 0);
                });
                callback?.();
            };
            return child;
        },
    };
    const manager = new ManagedAgents(options);
    manager.start('Ada');
    child.emit('message', { type: 'companion_ready' });
    const entry = manager.entries.get('Ada');
    const config = JSON.parse(readFileSync(launched.args.at(-1), 'utf8'));
    assert.equal(config.team, true);
    assert.equal(config.modelAuthFile, options.authFile);
    assert.equal(config.respawn, true);
    const start =
        JSON.stringify({ event: 'request_start', id: 'one', at: new Date().toISOString(), model: 'gpt-6-luna' }) + '\n';
    appendFileSync(entry.cursor.file, start.slice(0, 12));
    manager.snapshot();
    assert.equal(ledger.totals('Ada').pending, 0);
    appendFileSync(entry.cursor.file, start.slice(12));
    manager.snapshot();
    assert.equal(ledger.totals('Ada').pending, 1);
    appendFileSync(
        entry.cursor.file,
        JSON.stringify({
            event: 'response_usage',
            id: 'one',
            responseId: 'unique',
            at: new Date().toISOString(),
            usage: {
                input_tokens: 10,
                input_tokens_details: { cached_tokens: 2 },
                output_tokens: 5,
                output_tokens_details: { reasoning_tokens: 3 },
                total_tokens: 15,
            },
        }) + '\n',
    );
    manager.snapshot();
    await manager.command('Ada', 'pause');
    assert.equal(entry.state, 'paused');
    await manager.close();
    assert.equal(entry.state, 'stopped');
    assert.equal(ledger.totals('Ada').total, 15);
    const recovered = new ManagedAgents({ ...options, session: 'play2' });
    assert.equal(ledger.totals('Ada').total, 15);
    assert.equal(ledger.totals('Ada', 'play2').total, 0);
    recovered.start('Ada');
    child.emit('message', {
        type: 'companion_stopping',
        reason: 'model_error',
        message: 'Model request failed: invalid_grant. Sign in again.',
    });
    child.emit('exit', 7);
    await recovered.entries.get('Ada').exited;
    assert.equal(recovered.entries.get('Ada').state, 'failed');
    assert.match(recovered.entries.get('Ada').error, /invalid_grant/);
    await recovered.close();
});

test('throttled connections retry with the paused state and Stop cancels future retries', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const dir = mkdtempSync(join(tmpdir(), 'managed-retry-'));
    const ledger = new UsageLedger(join(dir, 'usage.sqlite'));
    const children = [];
    const manager = new ManagedAgents({
        agents: [{ name: 'Ada', model: 'openai/gpt-6-luna', thinking: 'xhigh' }],
        stateDir: dir,
        authFile: join(dir, 'auth.json'),
        host: '127.0.0.1',
        port: 25565,
        ledger,
        session: 'retry-test',
        spawnWorker(command, args, options) {
            const child = new EventEmitter();
            child.config = JSON.parse(readFileSync(args.at(-1), 'utf8'));
            child.attempt = options.env.MINECRAFT_AGENT_ATTEMPT;
            children.push(child);
            return child;
        },
    });
    t.after(async () => {
        await manager.close();
        ledger.close();
        rmSync(dir, { recursive: true, force: true });
    });
    manager.start('Ada', { paused: true });
    children[0].emit('exit', 75);
    assert.equal(manager.entries.get('Ada').state, 'reconnecting');
    t.mock.timers.tick(5000);
    assert.equal(children.length, 2);
    assert.equal(children[1].config.startPaused, true);
    assert.equal(children[1].attempt, '1');
    children[1].emit('exit', 75);
    await manager.command('Ada', 'stop');
    t.mock.timers.tick(60000);
    assert.equal(children.length, 2);
    assert.equal(manager.entries.get('Ada').state, 'stopped');
});

test('permanent-death workers disable respawn and dead identities cannot restart after disabling the mode', async t => {
    const dir = mkdtempSync(join(tmpdir(), 'managed-death-'));
    const ledger = new UsageLedger(join(dir, 'usage.sqlite'));
    const rules = { available: true, permanentDeath: true, deadPlayers: [] };
    let child,
        spawned = 0;
    const manager = new ManagedAgents({
        agents: [{ name: 'Ada', model: 'openai/gpt-6-luna', thinking: 'xhigh' }],
        stateDir: dir,
        authFile: join(dir, 'auth.json'),
        host: '127.0.0.1',
        port: 25565,
        ledger,
        session: 'death-test',
        worldRules: () => rules,
        spawnWorker(command, args) {
            spawned++;
            assert.equal(JSON.parse(readFileSync(args.at(-1), 'utf8')).respawn, false);
            child = new EventEmitter();
            return child;
        },
    });
    t.after(async () => {
        await manager.close();
        ledger.close();
        rmSync(dir, { recursive: true, force: true });
    });
    manager.start('Ada', { paused: true });
    rules.deadPlayers.push({ name: 'Ada', uuid: 'test-uuid' });
    child.emit('exit', 0);
    assert.equal(manager.snapshot()[0].state, 'dead');
    await assert.rejects(manager.command('Ada', 'resume'), /permanent death/);
    rules.permanentDeath = false;
    await assert.rejects(manager.command('Ada', 'resume'), /permanent death/);
    assert.equal(spawned, 1);
});
