import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionHistoryTool } from '../../src/model/session-history.js';
const msg = (role, content, extra = {}) => ({ type: 'message', message: { role, content, ...extra } });
const read = async (tool, params = {}) => JSON.parse((await tool.execute('id', params)).content[0].text);

test('retrieves old messages and tool results across compaction, excludes records/reasoning/images', async () => {
    const entries = [
        msg('user', 'old CASTLE plan'),
        msg('assistant', [
            { type: 'thinking', thinking: 'HIDDEN_REASONING' },
            { type: 'image', data: 'HIDDEN_IMAGE' },
            { type: 'toolCall', name: 'private', arguments: { secret: 'HIDDEN_ARGS' } },
            { type: 'text', text: 'castle answer' },
        ]),
        msg('toolResult', [{ type: 'text', text: 'castle receipt' }], {
            toolName: 'receipt',
            details: 'HIDDEN_DETAILS',
        }),
        { type: 'compaction', summary: 'HIDDEN_COMPACTION' },
        { type: 'custom', customType: 'minecraft-scheduler-v1', data: 'HIDDEN_SCHEDULER' },
    ];
    const tool = createSessionHistoryTool(() => entries);
    const page = await read(tool, { query: 'castle' });
    assert.deepEqual(
        page.entries.map(e => e.index),
        [2, 1, 0],
    );
    assert.equal(page.entries[0].tool, 'receipt');
    assert.equal(JSON.stringify(await read(tool)).includes('HIDDEN'), false);
    entries.push(msg('user', 'current castle text'));
    assert.equal((await read(tool)).entries[0].text, 'current castle text');
    assert.equal((await read(tool, { query: '.*' })).entries.length, 0);
});

test('stable exclusive before cursor paginates despite appended entries', async () => {
    const entries = Array.from({ length: 6 }, (_, i) => msg('user', `item ${i}`));
    const tool = createSessionHistoryTool(() => entries);
    const a = await read(tool, { limit: 2, before: 0 });
    assert.deepEqual(a, await read(tool, { limit: 2 }));
    assert.ok(a.nextBefore > 0);
    entries.push(msg('user', 'new'));
    const b = await read(tool, { before: a.nextBefore, limit: 2 });
    assert.ok(b.nextBefore > 0 && b.nextBefore < a.nextBefore);
    const c = await read(tool, { before: b.nextBefore, limit: 2 });
    assert.deepEqual(
        [...a.entries, ...b.entries, ...c.entries].map(e => e.index),
        [5, 4, 3, 2, 1, 0],
    );
    assert.equal(c.nextBefore, null);
    assert.deepEqual(await read(tool, { before: 0 }), await read(tool));
});

test('bounds escaped output and places excerpt around literal hit', async () => {
    const entries = Array.from({ length: 30 }, () =>
        msg('user', '\u0000'.repeat(20000) + 'NEEDLE' + '\u0000'.repeat(20000)),
    );
    const tool = createSessionHistoryTool(() => entries);
    const raw = (await tool.execute('id', { query: 'needle', limit: 20 })).content[0].text;
    assert.ok(raw.length <= 12000);
    const page = JSON.parse(raw);
    assert.ok(page.entries.length > 0 && page.entries.length <= 20);
    assert.ok(page.entries.every(e => e.truncated && e.text.length <= 2000 && e.text.includes('NEEDLE')));
    assert.ok(page.nextBefore < entries.length);
});

test('no path or agent selection, invalid args rejected before access, separate capabilities isolated', async () => {
    let reads = 0;
    const own = createSessionHistoryTool(() => {
        reads++;
        return [msg('user', 'own')];
    });
    const other = createSessionHistoryTool(() => [msg('user', 'other')]);
    for (const params of [
        { path: '/etc/passwd' },
        { agentId: 'other' },
        { before: '../other' },
        { limit: 21 },
        { limit: 0 },
        { query: 'x'.repeat(201) },
    ]) {
        await assert.rejects(read(own, params), /Invalid/);
    }
    assert.equal(reads, 0);
    assert.equal((await read(own, { query: 'other' })).entries.length, 0);
    assert.equal((await read(other)).entries[0].text, 'other');
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(own.execute('id', {}, abort.signal));
});

test('zero and omitted cursor both start at newest page; null output is terminal', async () => {
    const tool = createSessionHistoryTool(() => [msg('user', 'receipt')]);
    assert.match(tool.parameters.properties.before.description, /Omit or use 0/);
    assert.match(tool.parameters.properties.before.description, /exclusive upper-bound/);
    assert.match(tool.parameters.properties.before.description, /Stop when nextBefore is null/);
    assert.match(tool.parameters.properties.query.description, /not a regex/);
    assert.match(tool.parameters.properties.limit.description, /default 10/);
    assert.equal((await read(tool, { query: 'receipt' })).entries.length, 1);
    const page = await read(tool, { query: 'receipt', before: 0 });
    assert.deepEqual(page, await read(tool, { query: 'receipt' }));
    assert.equal(page.entries[0].text, 'receipt');
    assert.equal(page.nextBefore, null);
    const empty = createSessionHistoryTool(() => []);
    assert.deepEqual(await read(empty, { before: 0 }), { entries: [], nextBefore: null });
});

test('native inbox entries remain searchable with their original sender and source ID after compaction', async () => {
    const entries = [
        {
            type: 'custom_message',
            customType: 'minecraft_inbox',
            content: 'Human: preserve parcel x=7; sourceKind=mailbox sourceId=42',
            details: { messages: [{ sourceId: 42 }] },
        },
        { type: 'compaction', summary: 'A summary' },
    ];
    const result = await read(
        createSessionHistoryTool(() => entries),
        { query: 'parcel' },
    );
    assert.equal(result.entries.length, 1);
    assert.match(result.entries[0].text, /Human.*sourceId=42/);
});
