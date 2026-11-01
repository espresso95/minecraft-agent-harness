import { query } from '@anthropic-ai/claude-agent-sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const claudeExecutable = process.env.CLAUDE_CODE_EXECUTABLE ?? join(homedir(), '.local/bin/claude');
function options() {
    const env = { ...process.env };
    for (const key of Object.keys(env))
        if (/^(ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_USE_|CLAUDECODE$)/.test(key)) env[key] = undefined;
    return {
        pathToClaudeCodeExecutable: claudeExecutable,
        env,
        tools: [],
        mcpServers: {},
        strictMcpConfig: true,
        persistSession: false,
        settingSources: [],
    };
}
export async function discoverClaude() {
    let finish;
    const closed = new Promise(resolve => {
        finish = resolve;
    });
    const session = query({
        // Metadata discovery has no user prompt and makes no generation request.
        // eslint-disable-next-line require-yield
        prompt: (async function* () {
            await closed;
        })(),
        options: options(),
    });
    try {
        return await session.supportedModels();
    } finally {
        finish();
        session.close();
    }
}

export function conversation(context) {
    // Preserve actual instructions and results, excluding provider-specific reasoning signatures.
    const messages = context.messages.map(message => ({
        role: message.role,
        ...(message.toolCallId
            ? { toolCallId: message.toolCallId, toolName: message.toolName, isError: message.isError }
            : {}),
        content: Array.isArray(message.content)
            ? message.content.filter(part => !['thinking', 'image'].includes(part.type))
            : message.content,
    }));
    return (
        'Continue the existing Minecraft conversation below. Historical tool calls have ALREADY executed; ' +
        'their toolResult records are real results from the game runtime, not proposed actions. ' +
        'Use them as established history. Choose only the NEXT decision after the last message; do not replay historical calls. ' +
        'Tool names in this transcript omit the mcp__minecraft__ prefix.\n' +
        JSON.stringify(messages)
    );
}
export async function completeClaude({ model, context, effort }, signal, dependencies = {}) {
    const toolNames = new Set((context.tools ?? []).map(tool => tool.name));
    const toolName = name => name.replace(/^mcp__minecraft__/, '');
    const server = new McpServer({ name: 'minecraft', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: (context.tools ?? []).map(tool => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.parameters,
            _meta: { 'anthropic/alwaysLoad': true },
        })),
    }));
    // Capture intents only. The canonical Pi loop executes them, with its existing safety guards.
    server.server.setRequestHandler(CallToolRequestSchema, async () => ({
        content: [{ type: 'text', text: 'Tool intent captured. Actual result will be supplied by the game runtime.' }],
    }));
    const session = (dependencies.query ?? query)({
        prompt: (async function* () {
            const images = context.messages.flatMap(message =>
                Array.isArray(message.content) ? message.content.filter(part => part.type === 'image') : [],
            );
            yield {
                type: 'user',
                session_id: '',
                parent_tool_use_id: null,
                message: {
                    role: 'user',
                    content: [
                        { type: 'text', text: conversation(context) },
                        ...images.map(part => ({
                            type: 'image',
                            source: { type: 'base64', media_type: part.mimeType, data: part.data },
                        })),
                    ],
                },
            };
        })(),
        options: {
            ...options(),
            model,
            ...(effort === 'off' ? { thinking: { type: 'disabled' } } : effort ? { effort } : {}),
            systemPrompt: context.systemPrompt,
            maxTurns: 1,
            mcpServers: { minecraft: { type: 'sdk', name: 'minecraft', instance: server } },
            canUseTool: async (name, input) =>
                toolNames.has(toolName(name))
                    ? { behavior: 'allow', updatedInput: input }
                    : { behavior: 'deny', message: 'Only Minecraft tools are available' },
        },
    });
    const abort = () => session.close();
    signal?.addEventListener('abort', abort, { once: true });
    let assistant, result, generationError;
    try {
        signal?.throwIfAborted();
        try {
            for await (const event of session) {
                if (event.type === 'assistant') {
                    const next = event.message;
                    const parts = assistant?.id === next.id ? [...assistant.content, ...next.content] : next.content;
                    const unique = new Map(parts.map(part => [part.id ?? JSON.stringify(part), part]));
                    assistant = { ...next, content: [...unique.values()] };
                }
                if (event.type === 'result') result = event;
            }
        } catch (error) {
            if (!assistant || !error.message.includes('Reached maximum number of turns (1)')) generationError = error;
        }
        signal?.throwIfAborted();
        if (!assistant && !result?.usage) throw generationError ?? new Error('Claude Code returned no decision');
        if (result?.is_error && result.subtype !== 'error_max_turns')
            generationError ??= new Error(result.errors?.join('; ') ?? 'Claude Code request failed');
        const content = (assistant?.content ?? []).flatMap(part => {
            if (part.type === 'text') return [{ type: 'text', text: part.text }];
            if (part.type === 'tool_use' && toolNames.has(toolName(part.name)))
                return [
                    {
                        type: 'toolCall',
                        id: part.id,
                        name: toolName(part.name),
                        arguments: part.input,
                    },
                ];
            return [];
        });
        if (!content.length) generationError ??= new Error('Claude Code returned no declared Minecraft action or text');
        const raw = result?.usage ?? assistant?.usage;
        if (!raw || !Number.isFinite(raw.input_tokens) || !Number.isFinite(raw.output_tokens))
            throw new Error('Claude Code returned no token usage');
        const usage = {
            input: raw.input_tokens,
            output: raw.output_tokens,
            cacheRead: raw.cache_read_input_tokens ?? 0,
            cacheWrite: raw.cache_creation_input_tokens ?? 0,
        };
        usage.totalTokens = Object.values(usage).reduce((sum, value) => sum + value, 0);
        const reasoning = raw.output_tokens_details?.thinking_tokens;
        if (Number.isSafeInteger(reasoning) && reasoning >= 0) usage.reasoning = reasoning;
        return { id: assistant?.id, content, usage, ...(generationError ? { error: generationError.message } : {}) };
    } finally {
        signal?.removeEventListener('abort', abort);
        session.close();
        await server.close();
    }
}
