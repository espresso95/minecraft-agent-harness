export function installAgentControl({
    runner,
    actionRunner,
    stop,
    record,
    setStatus,
    configure,
    onMailbox,
    channel = process,
}) {
    let work = Promise.resolve();
    const receive = message => {
        if (message?.type === 'mailbox_available') {
            try {
                onMailbox?.();
            } catch (error) {
                record('mailbox_delivery_error', { message: String(error.message) });
            }
            return;
        }
        if (message?.type !== 'companion_control' || typeof message.id !== 'string') return;
        work = work.then(async () => {
            try {
                let configuration;
                if (message.action === 'pause') {
                    await runner.cancel();
                    await actionRunner.stop();
                    setStatus('paused');
                } else if (message.action === 'resume') {
                    runner.enqueue({
                        kind: 'control',
                        text: 'The player resumed you. Read new messages, then continue useful work.',
                    });
                    runner.start();
                    setStatus('running');
                } else if (message.action === 'configure') {
                    configuration = await configure(message.configuration);
                } else if (message.action === 'stop') {
                    channel.send?.({ type: 'companion_ack', id: message.id, ok: true });
                    await stop();
                    return;
                } else throw new Error('Unknown control action');
                record('owner_control', { action: message.action, ...(configuration ? { configuration } : {}) });
                channel.send?.({ type: 'companion_ack', id: message.id, ok: true });
            } catch (error) {
                channel.send?.({
                    type: 'companion_ack',
                    id: message.id,
                    ok: false,
                    error: String(error.message).slice(0, 200),
                });
            }
        });
    };
    channel.on('message', receive);
    return () => channel.removeListener('message', receive);
}
