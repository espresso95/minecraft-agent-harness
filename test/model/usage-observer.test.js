import test from 'node:test';
import assert from 'node:assert/strict';
import { observeOpenAIUsage } from '../../scripts/usage-observer.js';

test('records terminal usage across split SSE chunks without persisting prompts, output or secrets', async () => {
    const events = [];
    const usage = {
        input_tokens: 100,
        input_tokens_details: { cached_tokens: 80 },
        output_tokens: 12,
        output_tokens_details: { reasoning_tokens: 9 },
        total_tokens: 112,
    };
    const text =
        'data: ' +
        JSON.stringify({
            type: 'response.completed',
            response: {
                id: 'test-response',
                status: 'completed',
                usage,
                output: ['PRIVATE_OUTPUT'],
            },
        }) +
        '\n\n';
    const stream = new ReadableStream({
        start(controller) {
            for (const part of [text.slice(0, 20), text.slice(20, 53), text.slice(53)])
                controller.enqueue(new TextEncoder().encode(part));
            controller.close();
        },
    });
    const observed = observeOpenAIUsage(
        async () =>
            new Response(stream, {
                headers: {
                    'x-ratelimit-remaining-tokens': '1000',
                    'set-cookie': 'PRIVATE_COOKIE',
                    authorization: 'PRIVATE_TOKEN',
                },
            }),
        event => events.push(event),
    );
    const response = await observed('https://api.openai.com/v1/responses', {
        body: JSON.stringify({ model: 'gpt-6.1-terra', input: 'PRIVATE_PROMPT', reasoning: { effort: 'medium' } }),
    });
    await response.text();
    for (let i = 0; i < 100 && !events.some(e => e.event === 'response_usage'); i++)
        await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(events.find(e => e.event === 'response_usage').usage, usage);
    assert.deepEqual(events.find(e => e.event === 'response_headers').headers, {
        'x-ratelimit-remaining-tokens': '1000',
    });
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE/);
    assert.equal(events.filter(e => e.event === 'response_usage').length, 1);
});

test('an interrupted stream leaves usage unknown rather than inventing zero tokens', async () => {
    const events = [];
    const observed = observeOpenAIUsage(
        async () => new Response('data: {"type":"response.created"}\n\n'),
        e => events.push(e),
    );
    await (await observed('https://api.openai.com/v1/responses')).text();
    for (let i = 0; i < 100 && !events.some(e => e.event === 'usage_unavailable'); i++)
        await new Promise(resolve => setImmediate(resolve));
    assert.equal(
        events.some(e => e.event === 'usage_unavailable'),
        true,
    );
    assert.equal(
        events.some(e => e.event === 'response_usage'),
        false,
    );
});
