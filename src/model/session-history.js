export function createSessionHistoryTool(getEntries) {
    return {
        name: 'session_history',
        idle: true,
        label: 'Private session history',
        description:
            'Search your own persisted session text, including messages before compaction. Literal case-insensitive query (empty lists recent messages), newest first. Omit before or use 0 to start at the newest page; pass a positive nextBefore as before for older pages, and stop when nextBefore is null. Text excerpts are capped at 2000 characters per entry and 12000 JSON characters per page. Does not search reasoning, images, or other agents.',
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                query: {
                    type: 'string',
                    maxLength: 200,
                    description:
                        'Literal case-insensitive substring, not a regex. Omit or use an empty string to list recent messages.',
                },
                before: {
                    type: 'integer',
                    minimum: 0,
                    description:
                        'Omit or use 0 to start at the newest page. Positive values are an exclusive upper-bound entry index: copy nextBefore from the previous result for older pages. Stop when nextBefore is null.',
                },
                limit: {
                    type: 'integer',
                    minimum: 1,
                    maximum: 20,
                    description:
                        'Maximum matching entries per page (default 10, range 1-20). Output size limits may return fewer; use nextBefore to continue until null.',
                },
            },
        },
        execute: async (_id, params, signal) => {
            signal?.throwIfAborted();
            if (
                !params ||
                typeof params !== 'object' ||
                Array.isArray(params) ||
                Object.keys(params).some(key => !['query', 'before', 'limit'].includes(key))
            )
                throw new Error('Invalid history parameters');
            const { query = '', before, limit = 10 } = params;
            if (
                typeof query !== 'string' ||
                query.length > 200 ||
                !Number.isInteger(limit) ||
                limit < 1 ||
                limit > 20 ||
                (before !== undefined && (!Number.isSafeInteger(before) || before < 0))
            )
                throw new Error('Invalid history parameters');
            const entries = getEntries();
            let cursor = Math.min(before === undefined || before === 0 ? entries.length : before, entries.length);
            const page = { entries: [], nextBefore: null };
            const needle = query.toLowerCase();
            while (cursor > 0 && page.entries.length < limit) {
                signal?.throwIfAborted();
                const index = cursor - 1;
                const entry = entries[index],
                    message = entry?.message;
                if (entry?.type !== 'message' || !['user', 'assistant', 'toolResult'].includes(message?.role)) {
                    cursor--;
                    continue;
                }
                const content = message.content;
                const text =
                    typeof content === 'string'
                        ? content
                        : (Array.isArray(content) ? content : [])
                              .filter(part => part?.type === 'text' && typeof part.text === 'string')
                              .map(part => part.text)
                              .join('\n');
                const match = text.toLowerCase().indexOf(needle);
                if (!text || match < 0) {
                    cursor--;
                    continue;
                }
                const start = Math.max(0, match - 200);
                const item = {
                    index,
                    role: message.role,
                    text: text.slice(start, start + 2000),
                    truncated: start > 0 || text.length > 2000,
                };
                if (message.role === 'toolResult' && typeof message.toolName === 'string')
                    item.tool = message.toolName.slice(0, 100);
                while (JSON.stringify(item).length > 6000) {
                    item.text = item.text.slice(0, Math.floor(item.text.length / 2));
                    item.truncated = true;
                }
                page.entries.push(item);
                if (JSON.stringify(page).length > 11900) {
                    page.entries.pop();
                    break;
                }
                cursor--;
            }
            page.nextBefore = cursor > 0 ? cursor : null;
            return { content: [{ type: 'text', text: JSON.stringify(page) }] };
        },
    };
}
