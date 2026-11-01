import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { agentStatus } from '../../src/controller/agent-status.js';
import { fixture } from './fixtures.js';

test('status distinguishes model requests from body work and gives lifecycle controls precedence', () => {
    assert.equal(agentStatus('running', { action: 'follow_player' }, { pending: 1 }).phase, 'thinking');
    assert.equal(agentStatus('running', { action: 'gather' }, { pending: 0 }).phase, 'working');
    assert.equal(agentStatus('running', { action: null, activeCycle: true }, { pending: 0 }).phase, 'waiting');
    assert.equal(agentStatus('running', { blocked: true }, { pending: 1 }).phase, 'blocked');
    for (const state of ['paused', 'standby', 'starting', 'stopped', 'reconnecting', 'dead', 'failed'])
        assert.equal(agentStatus(state, { action: 'gather' }, { pending: 1 }).phase, state);
});

test('the existing state API owns status labels while controls and token accounting retain their semantics', async t => {
    const { c, dir, call } = await fixture(t);
    c.manager.start('Scout');
    await new Promise(resolve => setImmediate(resolve));
    mkdirSync(join(dir, 'Scout'), { recursive: true });
    writeFileSync(join(dir, 'Scout/runtime-status.json'), JSON.stringify({ action: 'follow_player', standby: false }));
    const status = async () => (await call('/v1/state')).value.agents.find(a => a.name === 'Scout');
    assert.equal((await status()).status.label, 'Working');
    const entry = c.manager.entries.get('Scout');
    c.ledger.ingest(
        { event: 'request_start', id: 'status-request', at: new Date().toISOString() },
        { agent: 'Scout', run: entry.run, session: c.manager.session },
    );
    const thinking = await status();
    assert.equal(thinking.status.label, 'Thinking…');
    assert.equal(thinking.state, 'running');
    assert.ok(thinking.controls.includes('pause'));
    c.ledger.finishRun(entry.run);
    assert.equal((await status()).status.label, 'Working');
    await c.manager.command('Scout', 'pause');
    assert.equal((await status()).status.label, 'Paused');
});
