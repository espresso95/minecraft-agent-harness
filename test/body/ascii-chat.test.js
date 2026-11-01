import test from 'node:test';
import assert from 'node:assert/strict';
import { asciiSafe, installAsciiChat } from '../../src/body/chat.js';

test('outgoing chat is made ASCII safe so servers do not show question marks', () => {
    assert.equal(
        asciiSafe('Wood first \u2014 then a \u201ccozy\u201d caf\u00e9\u2026 \u2192 go'),
        'Wood first - then a "cozy" cafe... -> go',
    );
    assert.equal(asciiSafe('ok \ud83d\ude00 done'), 'ok done');
});

test('chat and whisper both pass through the sanitizer', () => {
    const sent = [];
    const bot = { chat: m => sent.push(['chat', m]), whisper: (u, m) => sent.push(['whisper', u, m]) };
    installAsciiChat(bot);
    installAsciiChat(bot);
    bot.chat('hi \u2014 there');
    bot.whisper('Steve', 'it\u2019s fine');
    assert.deepEqual(sent, [
        ['chat', 'hi - there'],
        ['whisper', 'Steve', "it's fine"],
    ]);
});
