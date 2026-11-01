const text = o => ({ content: [{ type: 'text', text: JSON.stringify(o) }], details: o });
function entry(bot, n) {
    const p = bot?.players?.[n];
    const pos = p?.entity?.position;
    return {
        name: n,
        online: !!p,
        ...(pos ? { position: [Math.round(pos.x), Math.round(pos.y), Math.round(pos.z)] } : {}),
    };
}
export function createDirectoryTools({ bot, peers, self }) {
    return [
        {
            name: 'directory',
            idle: true,
            label: 'directory',
            description:
                'List the other agents in this world, with whether each is online and their position when they are in view.',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
            execute: async () => text({ self, agents: peers.map(n => entry(bot, n)) }),
        },
        {
            name: 'directory_search',
            idle: true,
            label: 'directory search',
            description: 'Find other agents whose name contains query (case-insensitive).',
            parameters: {
                type: 'object',
                properties: { query: { type: 'string' } },
                required: ['query'],
                additionalProperties: false,
            },
            execute: async (_id, a) => {
                const q = String(a?.query ?? '').toLowerCase();
                return text({
                    query: q,
                    agents: peers.filter(n => n.toLowerCase().includes(q)).map(n => entry(bot, n)),
                });
            },
        },
    ];
}
