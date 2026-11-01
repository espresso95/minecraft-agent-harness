# Local Minecraft setup

Double-click **Play Companions.command** or run `npm run play`. See [the companion guide](docs/companions.md) for the roster, in-game panel, web UI, skins and optional local-network sharing.

Login uses `npm run login`. OAuth credentials remain in private `.agent-state/auth.json`. The frozen benchmark image and measurements below are retained separately from the current companion app.

## Retained benchmarks

The Luna medium and xhigh benchmark uses separate worlds and agent state under `.agent-state/benchmarks/luna-medium-xhigh/`, with the same starting-world hash, empty inventory, task and 20-minute limit. `AGENT_MODEL_AUTH_FILE` lets these isolated states share the existing subscription credential store. Measurement records are under `.agent-state/measurements/luna-medium-20m-v1/` and `luna-xhigh-20m-v1/`.

To recheck the retained measurements after both runs finish:

```sh
node scripts/summarize-run.js luna-medium-20m-v1
python3 scripts/check-benchmark.py medium
node scripts/summarize-run.js luna-xhigh-20m-v1
python3 scripts/check-benchmark.py xhigh
node scripts/compare-benchmarks.js
```

The final comparison is written to `results/luna-comparison.json`. Missing request usage stays unknown. Published credit-rate equivalents are separate from measured subscription debits; account-wide quota readings cannot isolate this app's subscription usage.

The matched Terra trials are under `.agent-state/benchmarks/terra-medium-xhigh/`, with measurement IDs `terra-medium-20m-v1` and `terra-xhigh-20m-v1`. Their worlds were cloned from the frozen Luna baseline, and their harness image matches the Luna image. The in-game avatar remains named Luna in all four trials to keep the prompt identity constant; the protocol and provider ledger record the actual model. `scripts/model-benchmark.js` is the shared runner and world auditor.

To recheck the Terra trials and compare all four matched runs:

```sh
node scripts/summarize-run.js terra-medium-20m-v1
python3 scripts/check-benchmark.py medium terra
node scripts/summarize-run.js terra-xhigh-20m-v1
python3 scripts/check-benchmark.py xhigh terra
node scripts/compare-benchmarks.js --all
```

The four-run results are written to `results/model-comparison.json`. Standard API-price equivalents use the dated official rates in `results/benchmark-rate-card.json`. They are hypothetical API prices for reported tokens; the trials use subscription OAuth. Logged tool entries can include both shell wrappers and nested calls, so the timing calculation merges overlapping intervals. Goal completion is graded from saved blocks, chest contents, player inventory and position, and retained notes.

The Luna follow-ups use separate worlds and state under `.agent-state/benchmarks/luna-followups/`: `xhigh-v2` repeats the first xhigh trial, and `max-v1` tests max reasoning. Both are launched together with isolated Compose projects and ports 25566 and 25567. The temporary Colima allocation is eight CPUs and 12 GiB RAM; xhigh uses CPU cores 0–3 and max uses cores 4–7. Each Minecraft server retains the earlier 2 GiB Java heap. Resource samples include CPU, memory and server TPS. The earlier trials were sequential, which remains a comparison limitation.

The xhigh repeat uses the original frozen harness image. Max uses `Dockerfile.benchmark-max`, derived from that image with only `max` added to the accepted reasoning-level configuration values. The clone preflight verifies that all other game and agent source bytes match. The SDK and outgoing request ledger confirm the requested level.

After the follow-ups finish, recheck them with:

```sh
node scripts/summarize-run.js luna-xhigh-20m-v2
python3 scripts/check-benchmark.py xhigh luna v2
node scripts/summarize-run.js luna-max-20m-v1
python3 scripts/check-benchmark.py max luna v1
node scripts/compare-benchmarks.js --luna-followups
node scripts/compare-benchmarks.js --all-trials
```

The comparison outputs are `results/luna-followup-comparison.json` and `results/all-trials-comparison.json`. The parallel runs share account-wide before/after subscription-meter snapshots. Their individual token ledgers remain separate, but account-meter changes cannot be assigned to either run.
