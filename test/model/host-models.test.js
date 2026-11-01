import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import WebSocket from 'ws';
import { HostModels } from '../../src/controller/host-models.js';

test('host model transport rejects paired clients, correlates responses and cancels disconnected requests', async t => {
    const server = createServer();
    const bridge = new HostModels();
    const catalogs = [];
    bridge.attach(
        server,
        { authenticate: auth => (auth === 'Bearer owner' ? { host: true } : { player: 'Player' }) },
        { setClaude: models => catalogs.push(models) },
    );
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => {
        bridge.close();
        server.close();
    });
    const endpoint = `ws://127.0.0.1:${server.address().port}/internal/models`;
    const denied = new WebSocket(endpoint, { headers: { authorization: 'Bearer paired' } });
    await assert.rejects(once(denied, 'open'));
    const host = new WebSocket(endpoint, { headers: { authorization: 'Bearer owner' } });
    await once(host, 'open');
    host.send(JSON.stringify({ type: 'catalog', models: [{ value: 'discovered' }] }));
    const request = bridge.request('complete', { question: 'Minecraft' });
    const [bytes] = await once(host, 'message');
    const frame = JSON.parse(bytes);
    assert.equal(frame.params.question, 'Minecraft');
    host.send(JSON.stringify({ id: frame.id, result: { answer: 'tool intent' } }));
    assert.deepEqual(await request, { answer: 'tool intent' });
    assert.equal(catalogs.length, 1);
    const abort = new AbortController();
    const cancelled = bridge.request('complete', {}, abort.signal);
    await once(host, 'message');
    abort.abort(new Error('Paused'));
    await assert.rejects(cancelled, /Paused/);
    assert.equal(JSON.parse((await once(host, 'message'))[0]).type, 'cancel');
    const pending = bridge.request('complete', {});
    await once(host, 'message');
    host.close();
    await assert.rejects(pending, /disconnected/);
    await assert.rejects(bridge.request('complete', {}), /offline/);
});
