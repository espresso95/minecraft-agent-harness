import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const quotaHeader =
    /^(x-ratelimit-|x-(?:codex|subscription|usage)-.*(?:used|remaining|limit|reset|credit|balance|window)|retry-after$|x-request-id$)/i;
const terminals = new Set(['response.completed', 'response.incomplete', 'response.failed']);

export function observeOpenAIUsage(fetchImpl, emit, now = () => new Date().toISOString()) {
    return async (input, init) => {
        const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
        if (url.origin !== 'https://api.openai.com' || url.pathname !== '/v1/responses') return fetchImpl(input, init);
        const id = randomUUID();
        let request = {};
        try {
            request = JSON.parse(init?.body ?? '{}');
        } catch {}
        emit({ event: 'request_start', id, at: now(), model: request.model, thinking: request.reasoning?.effort });
        let response;
        try {
            response = await fetchImpl(input, init);
        } catch (error) {
            emit({ event: 'request_error', id, at: now(), error: error.name });
            throw error;
        }
        const headers = Object.fromEntries([...response.headers].filter(([name]) => quotaHeader.test(name)));
        emit({ event: 'response_headers', id, at: now(), status: response.status, headers });
        const copy = response.clone();
        void (async () => {
            let pending = '';
            let terminal = false;
            const decoder = new TextDecoder();
            const line = text => {
                if (!text.startsWith('data: ')) return;
                let data;
                try {
                    data = JSON.parse(text.slice(6));
                } catch {
                    return;
                }
                if (terminals.has(data.type) && !terminal) {
                    terminal = true;
                    emit({
                        event: 'response_usage',
                        id,
                        at: now(),
                        terminal: data.type,
                        responseId: data.response?.id,
                        model: data.response?.model,
                        status: data.response?.status,
                        usage: data.response?.usage ?? null,
                    });
                }
            };
            try {
                for await (const chunk of copy.body) {
                    pending += decoder.decode(chunk, { stream: true });
                    const lines = pending.split('\n');
                    pending = lines.pop();
                    for (const value of lines) line(value.trimEnd());
                }
                line(pending + decoder.decode());
                if (!terminal) emit({ event: 'usage_unavailable', id, at: now(), reason: 'no terminal usage event' });
            } catch (error) {
                if (!terminal) emit({ event: 'usage_unavailable', id, at: now(), reason: error.name });
            }
        })();
        return response;
    };
}

if (process.env.AGENT_USAGE_FILE) {
    const file = process.env.AGENT_USAGE_FILE;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    globalThis.fetch = observeOpenAIUsage(globalThis.fetch, event => {
        appendFileSync(file, JSON.stringify({ pid: process.pid, ...event }) + '\n', { mode: 0o600 });
    });
}
