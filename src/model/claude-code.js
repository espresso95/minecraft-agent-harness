import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools } from '@earendil-works/pi-ai';

export function claudeModels(entries) {
    const seen = new Set();
    return entries
        .filter(entry => {
            if (entry.value === 'default' || !entry.resolvedModel || seen.has(entry.resolvedModel)) return false;
            if (!Number.isSafeInteger(entry.contextWindow) || !Number.isSafeInteger(entry.maxTokens))
                throw new Error('Claude model needs Pi capacity metadata: ' + entry.resolvedModel);
            seen.add(entry.resolvedModel);
            return true;
        })
        .map(entry => ({
            id: entry.resolvedModel,
            name: `Claude Code · ${entry.displayName}`,
            provider: 'claude-code',
            api: 'claude-code',
            baseUrl: 'local://claude-code',
            reasoning: Boolean(entry.supportsEffort),
            input: ['text', 'image'],
            contextWindow: entry.contextWindow,
            maxTokens: entry.maxTokens,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            thinkingLevelMap: Object.fromEntries(
                ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map(level => [
                    level,
                    (level === 'off' ? entry.supportsThinkingOff : entry.supportedEffortLevels?.includes(level))
                        ? level
                        : null,
                ]),
            ),
        }));
}

// The controller owns transport; the ordinary Pi session still owns every tool execution.
export function controllerModelClient(channel = process) {
    const pending = new Map();
    channel.on('message', message => {
        if (message?.type !== 'model_result') return;
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        request.finish(message.error ? new Error(message.error) : null, message.result);
    });
    channel.on('disconnect', () => {
        for (const request of pending.values()) request.finish(new Error('Controller disconnected'));
        pending.clear();
    });
    return (method, params, signal) =>
        new Promise((resolve, reject) => {
            if (!channel.connected) return reject(new Error('Claude Code requires the local companion controller'));
            const id = randomUUID();
            const abort = () => {
                pending.delete(id);
                channel.send?.({ type: 'model_cancel', id });
                finish(signal.reason ?? new Error('Aborted'));
            };
            const finish = (error, value) => {
                signal?.removeEventListener('abort', abort);
                if (error) reject(error);
                else resolve(value);
            };
            pending.set(id, { finish });
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) return abort();
            channel.send({ type: 'model_request', id, method, params }, error => {
                if (error) {
                    pending.delete(id);
                    finish(error);
                }
            });
        });
}

export function claudeStream(
    request,
    emit = event => {
        if (process.env.AGENT_USAGE_FILE)
            appendFileSync(process.env.AGENT_USAGE_FILE, JSON.stringify({ pid: process.pid, ...event }) + '\n', {
                mode: 0o600,
            });
    },
) {
    return (model, context, options = {}) => {
        const stream = createAssistantMessageEventStream();
        const id = randomUUID();
        const usage = {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        };
        const message = {
            role: 'assistant',
            content: [],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage,
            stopReason: 'stop',
            timestamp: Date.now(),
        };
        stream.push({ type: 'start', partial: message });
        void (async () => {
            emit({
                event: 'request_start',
                id,
                at: new Date().toISOString(),
                model: model.id,
                thinking: options.reasoning,
            });
            try {
                const result = await request(
                    'complete',
                    {
                        model: model.id,
                        context: {
                            systemPrompt: getCurrentSystemPrompt(context.messages),
                            tools: getCurrentTools(context.messages),
                            messages: context.messages.filter(message => message.role !== 'system'),
                        },
                        effort: options.reasoning,
                    },
                    options.signal,
                );
                message.content = result.content;
                Object.assign(usage, result.usage);
                message.stopReason = message.content.some(c => c.type === 'toolCall') ? 'toolUse' : 'stop';
                const input = usage.input + usage.cacheRead + usage.cacheWrite;
                emit({
                    event: 'response_usage',
                    id,
                    at: new Date().toISOString(),
                    model: model.id,
                    responseId: result.id,
                    usage: {
                        input_tokens: input,
                        output_tokens: usage.output,
                        total_tokens: input + usage.output,
                        input_tokens_details: { cached_tokens: usage.cacheRead },
                        ...(Number.isSafeInteger(usage.reasoning)
                            ? { output_tokens_details: { reasoning_tokens: usage.reasoning } }
                            : {}),
                    },
                });
                if (result.error) throw new Error(result.error);
                stream.push({ type: 'done', reason: message.stopReason, message });
            } catch (error) {
                emit({ event: 'request_error', id, at: new Date().toISOString(), error: error.name });
                message.stopReason = options.signal?.aborted ? 'aborted' : 'error';
                message.errorMessage = error.message;
                stream.push({ type: 'error', reason: message.stopReason, error: message });
            } finally {
                stream.end();
            }
        })();
        return stream;
    };
}

let nativeRequest;
export async function registerClaudeCode(runtime, request) {
    request ??= nativeRequest ??= controllerModelClient();
    const models = claudeModels(
        (await request('catalog')).map(entry => {
            const metadata = runtime.getModel('anthropic', entry.resolvedModel);
            return metadata
                ? { ...entry, contextWindow: metadata.contextWindow, maxTokens: metadata.maxTokens }
                : entry;
        }),
    );
    runtime.registerProvider('claude-code', {
        api: 'claude-code',
        baseUrl: 'local://claude-code',
        authHeader: false,
        apiKey: 'local-cli',
        models,
        streamSimple: claudeStream(request),
    });
}
