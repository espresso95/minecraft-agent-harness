import { createHash } from 'node:crypto';
import { getCurrentSystemMessage } from '@earendil-works/pi-ai';

const CHECKPOINT = 'minecraft-provider-context-v1';
const digest = message => createHash('sha256').update(JSON.stringify(message)).digest('hex');

export function nativeCompactionProblem(model) {
    if (model.provider === 'openai' && model.api === 'openai-responses') return null;
    return model.provider === 'claude-code'
        ? 'Provider-native compaction is required. The Claude Code bridge cannot relay signed Anthropic compaction blocks. Choose a connected OpenAI model; no Pi summary fallback is enabled.'
        : 'Provider-native compaction is required and this model connection is not supported. Choose a connected OpenAI Responses model.';
}

export function nativeCompactionPolicy(model) {
    const problem = nativeCompactionProblem(model);
    if (problem) throw new Error(problem);
    const window = model.contextWindow;
    if (!Number.isSafeInteger(window) || window < 4096)
        throw new Error('Selected model needs valid context-window metadata');
    const threshold = Math.min(64000, Math.floor(window * 0.75));
    if (Number.isSafeInteger(model.maxTokens) && model.maxTokens > window - threshold)
        throw new Error('Compaction budget leaves insufficient model output headroom');
    return { type: 'compaction', compact_threshold: threshold };
}

export function nativeCompactionModel(model) {
    nativeCompactionPolicy(model);
    // Keep governing instructions and the complete tool catalog outside the
    // history that server-side compaction replaces. No incremental tool loading.
    return {
        ...model,
        compat: {
            ...model.compat,
            supportsAdditionalTools: false,
            supportsToolSearch: false,
            supportsMidConvoSystemMessages: false,
            supportsMidConvoEffort: false,
        },
    };
}

// Pi keeps the complete transcript and owns tools/scheduling. Only the provider's
// request context is shortened. Checkpoints are opaque, model-scoped session data.
export class NativeCompaction {
    constructor(model, manager, fetchImpl) {
        this.manager = manager;
        this.fetchImpl = fetchImpl;
        this.policy = nativeCompactionPolicy(model);
        this.identity = [model.provider, model.id, model.baseUrl];
        this.checkpoint = (manager.getBranch?.() ?? manager.getEntries())
            .filter(entry => entry.type === 'custom' && entry.customType === CHECKPOINT)
            .map(entry => entry.data)
            .findLast(data => JSON.stringify(data.identity) === JSON.stringify(this.identity));
    }

    context(messages) {
        if (this.persistenceError) throw this.persistenceError;
        if (!this.checkpoint) return messages;
        const index = messages.findIndex(
            message =>
                message.role === 'assistant' &&
                message.timestamp === this.checkpoint.timestamp &&
                digest(message) === this.checkpoint.anchor,
        );
        if (index < 0) throw new Error('Provider-native compaction checkpoint does not match this session history');
        const system = getCurrentSystemMessage(messages);
        return [...(system ? [system] : []), ...messages.slice(index).filter(message => message.role !== 'system')];
    }

    payload(payload) {
        let input = payload.input;
        if (!Array.isArray(input)) throw new Error('Provider-native compaction requires Responses input items');
        if (this.checkpoint) {
            const boundary = input.findIndex(item => item.id === this.checkpoint.boundary);
            if (boundary < 0) throw new Error('Provider-native compaction checkpoint replay boundary is missing');
            const governing = input.slice(0, boundary).filter(item => ['developer', 'system'].includes(item.role));
            input = [...governing, ...this.checkpoint.output, ...input.slice(boundary + 1)];
        }
        return { ...payload, input, context_management: [this.policy] };
    }

    fetch(fetchImpl = this.fetchImpl ?? globalThis.fetch) {
        return async (input, init) => {
            this.pending = null;
            const started = Date.now();
            const response = await fetchImpl(input, init);
            if (!response.ok || !response.body) return response;
            // Inspect the same SSE stream before forwarding it, so the checkpoint is
            // captured before Pi emits message_end. No cloned/background body reader.
            const decoder = new TextDecoder();
            let buffered = '';
            const completedItems = new Map();
            const line = value => {
                if (!value.startsWith('data: ')) return;
                let event;
                try {
                    event = JSON.parse(value.slice(6));
                } catch {
                    return;
                }
                if (event.type === 'response.output_item.done' && event.item && Number.isInteger(event.output_index))
                    completedItems.set(event.output_index, event.item);
                if (event.type !== 'response.completed') return;
                // ChatGPT OAuth may leave response.output empty in the terminal
                // event. Completed output-item events carry the canonical items.
                const output = event.response?.output?.length
                    ? event.response.output
                    : [...completedItems.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
                const last = output.findLastIndex(item => item.type === 'compaction');
                if (last < 0) return;
                const checkpoint = output[last];
                const boundary = output.findLast(item => item.type !== 'compaction')?.id;
                if (!checkpoint.encrypted_content || !boundary)
                    throw new Error('Provider-native compaction returned an incomplete checkpoint');
                this.pending = { output: output.slice(last), boundary, started, usage: event.response.usage ?? null };
            };
            const body = response.body.pipeThrough(
                new TransformStream({
                    transform(chunk, controller) {
                        buffered += decoder.decode(chunk, { stream: true });
                        const lines = buffered.split('\n');
                        buffered = lines.pop();
                        for (const value of lines) line(value.trimEnd());
                        controller.enqueue(chunk);
                    },
                    flush() {
                        line((buffered + decoder.decode()).trimEnd());
                    },
                }),
            );
            return new Response(body, {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
            });
        };
    }

    commit(message) {
        const pending = this.pending;
        this.pending = null;
        if (!pending || ['error', 'aborted'].includes(message.stopReason)) return false;
        const checkpoint = {
            identity: this.identity,
            timestamp: message.timestamp,
            anchor: digest(message),
            boundary: pending.boundary,
            output: pending.output,
        };
        try {
            this.manager.appendCustomEntry(CHECKPOINT, checkpoint);
        } catch {
            this.persistenceError = new Error('Provider-native compaction checkpoint could not be saved');
            throw this.persistenceError;
        }
        this.checkpoint = checkpoint;
        this.diagnose?.({
            event: 'compaction_end',
            mechanism: 'provider-native',
            reason: 'provider_threshold',
            outcome: 'success',
            durationMs: Date.now() - pending.started,
            durationScope: 'whole_provider_request',
            requestInputTokens: pending.usage?.input_tokens ?? null,
            tokensAfter: null,
            threshold: this.policy.compact_threshold,
            // The ordinary response usage ledger already accounts for this request.
            separateCompactionUsage: 'not_exposed',
        });
        return true;
    }
}
