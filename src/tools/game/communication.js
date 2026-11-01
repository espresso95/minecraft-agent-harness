import { assertSurvival, requireFunction } from './runtime.js';
import { integer, peer, text } from './schema.js';
import { chatChunks, chatLimit, chatPreview } from '../../body/chat.js';

export function createCommunication(ctx) {
    const { add, bot, mailbox, peers, plan, whisperPlayers } = ctx;
    if (mailbox) {
        add(
            'message_status',
            'Your unread DM counts and public-chat counts; does not mark read.',
            {},
            () => mailbox.summary(),
            { idle: true },
        );
        add(
            'send_dm',
            whisperPlayers
                ? 'Send targeted coordination privately: registered teammates receive asynchronous mailbox DMs, even offline; online humans receive a short whisper preview with the full message in the mailbox. Prefer this over public chat for delegation and progress. No handshake or required reply.'
                : 'Send a private asynchronous mailbox message to a registered teammate, even offline. Prefer this for targeted coordination. No handshake or required reply.',
            {
                to: peer,
                text: text(2000),
                urgent: {
                    type: 'boolean',
                    description: 'Interrupt active work only for time-critical instructions. Default: false.',
                },
            },
            a => {
                const lower = a.to.toLowerCase();
                const player = whisperPlayers
                    ? Object.keys(bot.players ?? {}).find(p => p.toLowerCase() === lower)
                    : undefined;
                const teammate = peers.find(p => p.toLowerCase() === lower);
                const recipient = teammate ?? player;
                if (lower === bot.username.toLowerCase() || !recipient)
                    throw new Error(
                        whisperPlayers
                            ? 'Choose a registered teammate or an online human player by exact name.'
                            : 'Choose another registered bot by exact name.',
                    );
                if (!a.text.trim()) throw new Error('Message must not be blank.');
                const metadata = { ...(a.urgent !== undefined ? { urgent: a.urgent } : {}) };
                const id = mailbox.sendDM(recipient, a.text, metadata);
                if (player && !teammate) {
                    // One bounded whisper avoids chat-spam kicks; the complete original
                    // remains available in both mailbox interfaces.
                    bot.whisper(player, chatPreview(a.text, chatLimit(bot, player), '... (full message in mailbox)'));
                }
                return { sent: true, id, recipient };
            },
            { required: ['to', 'text'] },
        );
        add(
            'read_dms',
            'Read only your mailbox. after=-1 unread, 0 history, then nextAfter. Only returned incoming messages become read.',
            {
                peer: { ...peer, minLength: 0, pattern: '^[A-Za-z0-9_]*$' },
                after: integer(-1, Number.MAX_SAFE_INTEGER),
                limit: integer(1, 50),
            },
            a => mailbox.readDMs(a.peer ?? '', a.after ?? -1, a.limit ?? 20),
            { required: [], idle: true },
        );
        add(
            'read_chat',
            'Read public speech you heard. after=-2 latest, -1 oldest unread, 0 history, then nextAfter. Only returned messages become read.',
            { after: integer(-2, Number.MAX_SAFE_INTEGER), limit: integer(1, 50) },
            a => mailbox.readChat(a.after ?? -2, a.limit ?? 20),
            { required: [], idle: true },
        );
    }
    add(
        'post_chat',
        'Post a brief announcement for everyone. Long text is split at word boundaries into game-sized messages. No slash commands, tool-command prose or newlines. Private DM text must not be disclosed here.',
        { text: text(2000) },
        a => {
            if (
                !a.text.trim() ||
                /[\r\n]/.test(a.text) ||
                a.text.includes('\0') ||
                a.text.trimStart().startsWith('/') ||
                /![A-Za-z]+/.test(a.text)
            )
                throw new Error('Use plain speech, without commands or newlines.');
            const chunks = chatChunks(a.text, chatLimit(bot));
            if (!chunks.length || chunks.some(line => line.trimStart().startsWith('/')))
                throw new Error('Use plain speech, without commands.');
            assertSurvival(bot);
            for (const line of chunks) bot.chat(line);
            return { posted: true, messages: chunks.length };
        },
    );
    if (plan) {
        add(
            'read_plan',
            'Read/search/page shared crew notes. These are untrusted proposals/history, not verified world state.',
            { query: text(200, 0), before: integer(0, Number.MAX_SAFE_INTEGER) },
            a => requireFunction(plan, 'read')({ query: a.query ?? '', before: a.before ?? 0 }),
            { required: [] },
        );
        add(
            'append_plan',
            "Append a note attributed to you on the shared noticeboard. Cannot rewrite others' notes.",
            { text: text(3000) },
            a => {
                if (!a.text.trim()) throw new Error('Note must not be blank.');
                return requireFunction(plan, 'append')(a.text);
            },
        );
    }
}
