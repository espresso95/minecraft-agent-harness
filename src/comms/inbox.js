import { messagePolicy } from './messages.js';

export class AgentInbox {
    constructor({ store, peers, getRunner, actions, checkWait = () => false, record = () => {} }) {
        Object.assign(this, { store, peers, getRunner, actions, checkWait, record });
        this.cursor = 0;
        this.offered = new Set();
        this.inFlight = [];
        this.lastInterrupt = new Map();
    }

    notify({ replay = false, interrupt = true } = {}) {
        this.notifyWork();
        if (replay) this.cursor = 0;
        let wake = false,
            count = 0,
            page;
        do {
            page = this.store.unreadMessages({ after: this.cursor, limit: 50 });
            for (const message of page) {
                this.cursor = message.id;
                count++;
                const policy = messagePolicy(message, this.peers);
                wake ||= policy.wake;
                const active = this.actions.status;
                const now = Date.now();
                const sender = message.sender.toLowerCase();
                if (
                    interrupt &&
                    policy.interrupt &&
                    active.active &&
                    !active.background &&
                    now - (this.lastInterrupt.get(sender) ?? -Infinity) > 15000
                ) {
                    this.lastInterrupt.set(sender, now);
                    this.actions.interrupt(`Interrupted: private instruction from ${message.sender}`);
                }
                if (!replay)
                    this.record('message_received', {
                        id: message.id,
                        from: message.sender,
                        chars: message.text.length,
                    });
            }
        } while (page.length === 50);
        if (count)
            this.getRunner()?.enqueue(
                {
                    kind: 'mailbox',
                    text: `${count} private message(s) available; incoming messages are included below.`,
                },
                { key: 'mailbox', urgent: wake, wakeWhenIdle: wake, passive: !wake },
            );
    }

    notifyWork() {
        if (!this.store.work) return;
        const work = this.store.work();
        const runner = this.getRunner();
        if (runner?.waitFor) {
            if (this.checkWait(runner.waitFor))
                runner.enqueue(
                    {
                        kind: 'work',
                        text: 'Your waiting condition changed or is satisfied. Inspect fresh observations and resume useful work.',
                    },
                    { key: 'condition', urgent: true, interrupt: false, wakeWhenIdle: true },
                );
            return;
        }
        const initial = this.readySignature === undefined;
        const signature = JSON.stringify([
            work.attentionRevision,
            work.ready.map(t => [t.id, t.revision]),
            work.resources?.map(r => [r.key, r.contents]),
        ]);
        if (signature === this.readySignature) return;
        this.readySignature = signature;
        if (!work.readyCount && (initial || !work.attentionRevision)) return;
        const busy = work.current.some(t => t.state !== 'blocked');
        this.getRunner()?.enqueue(
            {
                kind: 'work',
                text: `Shared work changed: ${JSON.stringify(work)}. Choose suitable work within the human's goal; claim it before acting. A ready task does not require leader approval.`,
            },
            { key: 'work', urgent: !busy, interrupt: false, wakeWhenIdle: !busy, passive: busy },
        );
    }

    note() {
        const messages = this.store.unreadMessages({ limit: 20, priority: true }).filter(m => !this.offered.has(m.id));
        if (!messages.length) return null;
        for (const message of messages) this.offered.add(message.id);
        return (
            `Incoming private messages (IDs identify durable mailbox records):\n${JSON.stringify(messages)}\n` +
            'Human instructions take priority. Use work_tasks/work_claim/work_update for task state; message IDs are receipts. Progress notices do not require a reply. Never acknowledge an acknowledgement. Read receipts do not mean tasks are complete.'
        );
    }

    shouldYield() {
        let after = 0,
            page;
        do {
            page = this.store.unreadMessages({ after, limit: 50 });
            if (page.some(message => messagePolicy(message, this.peers).yield)) return true;
            after = page.at(-1)?.id ?? after;
        } while (page.length === 50);
        return false;
    }

    beginRequest() {
        this.inFlight = [...this.offered];
    }

    finishRequest(success) {
        if (success && this.inFlight.length) {
            this.store.acknowledge(this.inFlight);
            for (const id of this.inFlight) this.offered.delete(id);
        }
        this.inFlight = [];
    }

    endCycle({ failed = false } = {}) {
        this.offered.clear();
        this.inFlight = [];
        if (!failed) this.notify({ replay: true, interrupt: false });
    }
}
