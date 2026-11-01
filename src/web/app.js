const $ = id => document.getElementById(id);
let session,
    state,
    catalog,
    selected = null,
    tab = 'chat',
    adding = false,
    dirty = false,
    lifetime = false,
    busy = false;
let agentsOnly = false;
let before = 0,
    sender = '',
    recipient = '',
    hasOlder = false,
    pendingMessage,
    messageVersion = 0,
    renderedMessages = '',
    refreshVersion = 0,
    rosterVersion = '',
    hostDirty = false;
try {
    session = JSON.parse(localStorage.getItem('minecraft-companions'));
} catch {}
const say = text => {
    $('notice').textContent = text;
};
async function call(method, path, body, authenticated = true) {
    const response = await fetch(path, {
        method,
        signal: AbortSignal.timeout(60000),
        headers: {
            ...(authenticated && session ? { authorization: 'Bearer ' + session.token } : {}),
            ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const value = await response.json();
    if (!response.ok) {
        if (response.status === 401) {
            session = null;
            localStorage.removeItem('minecraft-companions');
            display();
        }
        throw new Error(value.error ?? 'Controller unavailable');
    }
    return value;
}
async function mutate(method, path, body) {
    if (busy) throw new Error('Wait for the current action to finish');
    busy = true;
    say('Working…');
    ++refreshVersion;
    try {
        const value = await call(method, path, { player: session.player, ...body });
        await refresh();
        say('Saved');
        return value;
    } finally {
        busy = false;
    }
}
const action = fn => async event => {
    event?.preventDefault();
    try {
        await fn();
    } catch (error) {
        say(error.message);
    }
};
const agent = () => state?.agents.find(a => a.name === selected);
function options(select, values, value) {
    const signature = JSON.stringify(values);
    if (select.dataset.options !== signature) {
        select.replaceChildren();
        for (const [key, label] of values) {
            const item = document.createElement('option');
            item.value = key;
            item.textContent = label;
            select.append(item);
        }
        select.dataset.options = signature;
    }
    if (document.activeElement !== select) select.value = value;
}
function choose(name) {
    selected = name;
    adding = false;
    dirty = false;
    tab = 'chat';
    before = 0;
    sender = recipient = '';
    pendingMessage = null;
    renderedMessages = '';
    display();
    void messages();
}
async function refresh() {
    if (!session) return;
    const version = ++refreshVersion;
    if (!catalog) catalog = await call('GET', '/v1/models');
    const next = await call('GET', '/v1/state');
    if (version !== refreshVersion) return;
    state = next;
    if (selected && !agent()) {
        selected = null;
        adding = dirty = false;
        tab = 'chat';
    }
    display();
    if (tab === 'chat') await messages();
}
function display() {
    const connected = Boolean(session && state);
    $('pair').hidden = connected;
    $('workspace').hidden = !connected;
    $('host-button').hidden = !connected;
    if (!connected) {
        $('connection').textContent = 'Pair to connect';
        return;
    }
    $('connection').textContent = session.player;
    const rosterKey = JSON.stringify([selected, adding, state.agents.map(a => [a.name, a.status.label, a.skinUrl])]);
    if (rosterKey !== rosterVersion) {
        const position = [$('roster').scrollLeft, $('roster').scrollTop];
        $('roster').replaceChildren();
        for (const a of [{ name: null, status: { label: state.agents.length + ' companions' } }, ...state.agents]) {
            const button = document.createElement('button');
            button.classList.toggle('active', a.name === selected && !adding);
            button.onclick = () => choose(a.name);
            if (a.skinUrl) {
                const avatar = document.createElement('span');
                avatar.className = 'avatar';
                avatar.style.backgroundImage = `url(${JSON.stringify(a.skinUrl)})`;
                button.append(avatar);
            }
            const label = document.createElement('span');
            label.textContent = a.name ?? 'Team';
            const status = document.createElement('small');
            status.textContent = a.status.label;
            label.append(status);
            button.append(label);
            $('roster').append(button);
        }
        $('roster').scrollTo(...position);
        rosterVersion = rosterKey;
    }
    const a = agent(),
        usage = (a ?? state)[lifetime ? 'lifetimeUsage' : 'usage'];
    $('selected-title').textContent = adding ? 'New agent' : selected ? selected + ' · ' + a.status.label : 'Team';
    $('summary').textContent =
        `${new Intl.NumberFormat().format(usage?.total ?? 0)} reported tokens · ${usage?.pending ?? 0} pending · ${usage?.unknown ?? 0} unknown`;
    $('primary').hidden = adding;
    $('primary').textContent = !selected
        ? 'Pause all'
        : a.controls.includes('pause')
          ? 'Pause'
          : a.state === 'paused'
            ? 'Resume'
            : 'Start';
    $('primary').disabled = selected
        ? !a.controls.some(c => ['pause', 'resume'].includes(c))
        : !state.agents.some(v => v.controls.includes('pause'));
    $('more').hidden = !selected || adding;
    $('stop').disabled = !a?.controls.includes('stop');
    for (const button of document.querySelectorAll('[data-tab]')) {
        button.classList.toggle('active', button.dataset.tab === tab);
        button.disabled = button.dataset.tab === 'settings' && !selected && !adding;
    }
    for (const name of ['chat', 'work', 'settings', 'usage']) $(name).hidden = tab !== name;
    if (tab === 'work') displayWork((a ?? state).work);
    $('filters').hidden = Boolean(selected);
    $('agents-only').checked = agentsOnly;
    const participants = [
        ...new Set([session.player, ...state.agents.map(v => v.name), ...(state.participants ?? [])]),
    ];
    options($('sender'), [['', 'Anyone'], ...participants.map(n => [n, n === session.player ? 'You' : n])], sender);
    options(
        $('recipient'),
        [['', 'Anyone'], ...participants.map(n => [n, n === session.player ? 'You' : n])],
        recipient,
    );
    $('message').placeholder = selected ? 'Message ' + selected + '…' : 'Message all companions…';
    $('send-form').querySelector('button').disabled = !state.agents.length;
    if (tab === 'settings' && !dirty) populate(adding ? { ...catalog.defaults, name: '' } : a);
    if (tab === 'usage') {
        $('period').textContent = lifetime ? 'All sessions' : 'This session';
        $('usage-rows').replaceChildren();
        for (const [label, key] of [
            ['Input', 'input'],
            ['Cached (part of input)', 'cached'],
            ['Output', 'output'],
            ['Reasoning (part of output)', 'reasoning'],
            ['Total: input + output', 'total'],
            ['Reported responses', 'reported'],
            ['Pending requests', 'pending'],
            ['Unknown requests', 'unknown'],
            ['Reported in last minute', 'tokensLastMinute'],
        ]) {
            const row = document.createElement('tr');
            if (key === 'total') row.className = 'total';
            const title = document.createElement('td'),
                number = document.createElement('td');
            title.textContent = label;
            number.textContent = new Intl.NumberFormat().format(usage?.[key] ?? 0);
            row.append(title, number);
            $('usage-rows').append(row);
        }
    }
}
function displayWork(work) {
    const pane = $('work');
    const signature = JSON.stringify(work);
    if (pane.dataset.version === signature) return;
    const expanded = new Set([...pane.querySelectorAll('details[open]')].map(e => e.dataset.id));
    pane.dataset.version = signature;
    const fields = (parent, values) => {
        parent.replaceChildren();
        for (const field of values) {
            const p = document.createElement('p'),
                label = document.createElement('strong');
            label.textContent = field.label + ': ';
            p.append(label, document.createTextNode(field.value));
            parent.append(p);
        }
    };
    fields($('work-summary'), work?.summary ?? []);
    $('work-items').replaceChildren();
    for (const item of work?.items ?? []) {
        const card = document.createElement('details'),
            title = document.createElement('summary'),
            content = document.createElement('div');
        card.dataset.id = String(item.id);
        card.open = expanded.has(card.dataset.id);
        title.textContent = item.title + ' · ' + item.detail;
        fields(content, item.fields);
        card.append(title, content);
        $('work-items').append(card);
    }
}
function efforts(value) {
    const model = catalog.models.find(m => m.id === $('model').value);
    options(
        $('thinking'),
        (model?.efforts ?? []).map(e => [e, e]),
        model?.efforts.includes(value) ? value : model?.efforts[0],
    );
}
function populate(profile) {
    if (!profile) return;
    $('name-label').hidden = !adding;
    for (const key of ['name', 'skin', 'personality', 'objective']) $(key).value = profile[key] ?? '';
    options(
        $('model'),
        catalog.models.map(m => [m.id, m.name]),
        profile.model,
    );
    efforts(profile.thinking);
    $('save-profile').textContent = adding ? 'Add agent' : 'Save settings';
}
async function messages() {
    if (!session || !state || tab !== 'chat') return;
    const version = ++messageVersion;
    const params = new URLSearchParams({ before, limit: 100 });
    if (selected) params.set('participants', session.player + ',' + selected);
    else {
        if (agentsOnly) params.set('agentsOnly', 'true');
        if (sender) params.set('sender', sender);
        if (recipient) params.set('recipient', recipient);
    }
    const result = await call('GET', '/v1/messages?' + params);
    if (version !== messageVersion) return;
    hasOlder = result.hasOlder;
    $('older').disabled = !hasOlder;
    $('latest').disabled = before === 0;
    $('older').dataset.before = result.messages[0]?.id ?? 0;
    const signature = JSON.stringify(result.messages);
    if (signature === renderedMessages) return;
    renderedMessages = signature;
    const pane = $('messages'),
        atBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 40;
    pane.replaceChildren();
    for (const m of result.messages) {
        const item = document.createElement('div');
        item.className = 'message';
        const head = document.createElement('small'),
            text = document.createElement('p');
        head.textContent =
            `${new Date(m.createdAt).toLocaleTimeString()}  ${m.sender} → ${m.recipient}` +
            (m.sender === session.player ? (m.readByRecipient ? ' · read' : ' · delivered') : '');
        text.textContent = m.text;
        item.append(head, text);
        pane.append(item);
    }
    if (atBottom && before === 0) pane.scrollTop = pane.scrollHeight;
}
$('pair').onsubmit = action(async () => {
    const player = $('player').value.trim(),
        paired = await call('POST', '/v1/pair', { player, code: $('code').value, kind: 'web' }, false);
    session = { player, token: paired.token };
    localStorage.setItem('minecraft-companions', JSON.stringify(session));
    $('code').value = '';
    await refresh();
    say('Connected');
});
$('add').onclick = () => {
    adding = true;
    selected = null;
    dirty = false;
    tab = 'settings';
    display();
};
for (const button of document.querySelectorAll('[data-tab]'))
    button.onclick = () => {
        tab = button.dataset.tab;
        display();
        if (tab === 'chat') void messages().catch(e => say(e.message));
    };
$('settings').oninput = () => {
    dirty = true;
};
$('model').onchange = () => {
    dirty = true;
    efforts($('thinking').value);
};
$('settings').onsubmit = action(async () => {
    const profile = Object.fromEntries(
        ['name', 'model', 'thinking', 'skin', 'personality', 'objective'].map(key => [key, $(key).value]),
    );
    const name = adding ? profile.name : selected;
    if (!adding) delete profile.name;
    await mutate(adding ? 'POST' : 'PATCH', adding ? '/v1/agents' : '/v1/agents/' + selected, { agent: profile });
    choose(name);
});
$('primary').onclick = action(async () => {
    const a = agent(),
        names = selected ? [selected] : state.agents.filter(v => v.controls.includes('pause')).map(v => v.name);
    if (names.length)
        await mutate('POST', '/v1/control', {
            agents: names,
            action: !a || a.controls.includes('pause') ? 'pause' : 'resume',
        });
});
$('stop').onclick = action(() => mutate('POST', '/v1/control', { agents: [selected], action: 'stop' }));
$('remove').onclick = action(async () => {
    await mutate('DELETE', '/v1/agents/' + selected, {});
    choose(null);
});
$('period').onclick = () => {
    lifetime = !lifetime;
    display();
};
for (const id of ['sender', 'recipient', 'agents-only'])
    $(id).onchange = action(async () => {
        agentsOnly = $('agents-only').checked;
        sender = $('sender').value;
        recipient = $('recipient').value;
        before = 0;
        renderedMessages = '';
        await messages();
    });
$('older').onclick = action(async () => {
    before = Number($('older').dataset.before);
    await messages();
});
$('latest').onclick = action(async () => {
    before = 0;
    await messages();
});
$('send-form').onsubmit = action(async () => {
    const text = $('message').value,
        recipients = selected ? [selected] : state.agents.map(a => a.name);
    if (
        !pendingMessage ||
        pendingMessage.text !== text ||
        JSON.stringify(pendingMessage.recipients) !== JSON.stringify(recipients)
    )
        pendingMessage = {
            text,
            recipients,
            submissionId: Array.from(crypto.getRandomValues(new Uint8Array(16)), x =>
                x.toString(16).padStart(2, '0'),
            ).join(''),
        };
    await mutate('POST', '/v1/messages', pendingMessage);
    pendingMessage = null;
    $('message').value = '';
    before = 0;
    await messages();
    say('Message delivered');
});
function hostInfo() {
    if (!hostDirty) {
        options(
            $('difficulty'),
            (state.server.difficulties ?? []).map(d => [d, d]),
            state.server.difficulty,
        );
        $('permanent').checked = state.server.permanentDeath;
    }
    $('difficulty').disabled = $('permanent').disabled = !state.server.available || state.server.nativeHardcore;
    $('host-form').querySelector('button').disabled = !state.server.available;
    $('lan').checked = state.access.lanEnabled;
    $('invite').textContent =
        `Pairing code: ${state.access.pairingCode}\nWeb: ${location.origin}\n` +
        (state.access.lanUrls ?? []).map(u => 'LAN web: ' + u).join('\n') +
        '\n' +
        (state.access.gameAddresses ?? []).map(a => 'Minecraft: ' + a).join('\n');
}
$('host-button').onclick = () => {
    hostDirty = false;
    hostInfo();
    $('host').showModal();
};
$('host-form').oninput = () => {
    hostDirty = true;
};
$('host-close').onclick = () => $('host').close();
$('host-form').onsubmit = action(async () => {
    await mutate('PATCH', '/v1/server', {
        settings: { difficulty: $('difficulty').value, permanentDeath: $('permanent').checked },
    });
    hostDirty = false;
    hostInfo();
});
$('lan').onchange = action(async () => {
    await mutate('PATCH', '/v1/access', { access: { lanEnabled: $('lan').checked } });
    hostInfo();
});
$('rotate').onclick = action(async () => {
    const result = await call('PATCH', '/v1/access', { player: session.player, access: { rotateCode: true } });
    say('Paired access revoked. New pairing code: ' + result.pairingCode);
    $('host').close();
    session = null;
    localStorage.removeItem('minecraft-companions');
    display();
});
display();
if (session) void refresh().catch(e => say(e.message));
setInterval(() => {
    if (session && !busy)
        void refresh()
            .then(() => {
                if ($('host').open && document.activeElement?.tagName !== 'SELECT') hostInfo();
            })
            .catch(e => say(e.message));
}, 2000);
