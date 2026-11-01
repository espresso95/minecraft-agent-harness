import { allowWhisper } from './chat-guard.js';

const ASCII_MAP = [
    [/[\u2010-\u2015\u2212]/g, '-'],
    [/[\u2018\u2019\u201a\u201b\u2032]/g, "'"],
    [/[\u201c\u201d\u201e\u201f\u2033]/g, '"'],
    [/\u2026/g, '...'],
    [/[\u2022\u00b7]/g, '*'],
    [/\u00d7/g, 'x'],
    [/\u2192/g, '->'],
    [/\u2190/g, '<-'],
    [/[\u00a0\u2000-\u200b\u202f\u205f\u3000]/g, ' '],
];

export function asciiSafe(text) {
    let out = String(text ?? '');
    for (const [pattern, replacement] of ASCII_MAP) out = out.replace(pattern, replacement);
    return out
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\x20-\x7e]/g, '')
        .replace(/ {2,}/g, ' ');
}

export const chatLimit = (bot, recipient) =>
    (bot.supportFeature?.('lessCharsInChat') ? 100 : 256) - (recipient ? `/tell ${recipient} `.length : 0);

export function chatPreview(text, limit, suffix) {
    const line = asciiSafe(text.replace(/[\r\n]+/g, ' ')),
        tail = asciiSafe(suffix);
    return line.length <= limit ? line : line.slice(0, Math.max(0, limit - tail.length)) + tail.slice(0, limit);
}

export function chatChunks(text, limit) {
    let remaining = asciiSafe(text);
    const chunks = [];
    while (remaining.length > limit) {
        const space = remaining.lastIndexOf(' ', limit),
            end = space > 0 ? space : limit;
        chunks.push(remaining.slice(0, end));
        remaining = remaining.slice(end).trimStart();
    }
    if (remaining.trim()) chunks.push(remaining);
    return chunks;
}

export function installAsciiChat(bot) {
    if (typeof bot.chat !== 'function' || bot.chat.asciiSafe) return bot;
    const rawChat = bot.chat.bind(bot);
    const chat = message => rawChat(asciiSafe(message));
    chat.asciiSafe = true;
    bot.chat = chat;
    if (typeof bot.whisper === 'function') {
        const rawWhisper = bot.whisper.bind(bot);
        bot.whisper = (username, message) => {
            allowWhisper(bot._client ?? {}, username);
            return rawWhisper(username, asciiSafe(message));
        };
    }
    return bot;
}
