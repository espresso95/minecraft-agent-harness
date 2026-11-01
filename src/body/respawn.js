export function installRespawn(
    bot,
    {
        allowed,
        respawnAllowed = () => true,
        stopBody,
        pauseSession,
        resumeSession,
        record,
        finish,
        delay = 500,
        recoveryTimeoutMs = 15000,
        pauseTimeoutMs = 180000,
    },
) {
    let pending = false,
        failed = false,
        quiescent = false,
        spawned = false,
        generation = 0,
        watchdog,
        pauseWatchdog;
    const clear = () => {
        clearTimeout(watchdog);
        clearTimeout(pauseWatchdog);
    };
    const fail = reason => {
        if (failed) return;
        failed = true;
        clear();
        finish(reason);
    };
    const complete = () => {
        if (!pending || failed || !quiescent || !spawned) return;
        if (!respawnAllowed()) {
            fail('death');
            return;
        }
        if (!allowed()) {
            fail('contest_deadline');
            return;
        }
        clear();
        pending = false;
        record('respawn');
        resumeSession();
    };
    bot.on('death', () => {
        if (pending || failed) return;
        if (!respawnAllowed() || !allowed()) {
            fail('death');
            return;
        }
        pending = true;
        quiescent = false;
        spawned = false;
        const current = ++generation;
        watchdog = setTimeout(() => {
            if (!spawned) fail('respawn_timeout');
        }, recoveryTimeoutMs);
        pauseWatchdog = setTimeout(() => fail('pause_timeout'), pauseTimeoutMs);
        record('death');
        let pausing;
        try {
            pausing = Promise.resolve(pauseSession());
        } catch {
            fail('respawn_error');
            return;
        }
        pausing.then(
            () => {
                if (failed || current !== generation || !pending) return;
                quiescent = true;
                complete();
            },
            () => fail('respawn_error'),
        );
        void (async () => {
            try {
                await stopBody();
                if (failed || current !== generation || !pending || spawned) return;
                if (!respawnAllowed()) {
                    fail('death');
                    return;
                }
                if (!allowed()) {
                    fail('contest_deadline');
                    return;
                }
                setTimeout(() => {
                    if (failed || current !== generation || !pending || spawned) return;
                    if (!respawnAllowed()) {
                        fail('death');
                        return;
                    }
                    if (!allowed()) {
                        fail('contest_deadline');
                        return;
                    }
                    try {
                        bot.respawn();
                    } catch {
                        fail('respawn_error');
                    }
                }, delay);
            } catch {
                fail('respawn_error');
            }
        })();
    });
    bot.on('spawn', () => {
        if (!pending || failed) return;
        spawned = true;
        complete();
    });
}
