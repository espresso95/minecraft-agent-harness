"""Independent token reconciliation and descriptive gameplay statistics."""
import collections
import csv
import json
import pathlib
import statistics
import sys
from datetime import datetime
from decimal import Decimal

ROOT = pathlib.Path(__file__).resolve().parents[1]
level = sys.argv[1]
family = sys.argv[2] if len(sys.argv) > 2 else 'luna'
revision = sys.argv[3] if len(sys.argv) > 3 else 'v1'
assert revision.startswith('v') and revision[1:].isdigit()
assert family in ('luna', 'terra')
model = 'gpt-6.1-terra' if family == 'terra' else 'gpt-6-luna'
assert level in ("medium", "xhigh", "max")
run = ROOT / ".agent-state/measurements" / f"{family}-{level}-20m-{revision}"
protocol = json.loads((run / "protocol.json").read_text())
summary = json.loads((run / "summary.json").read_text())


def rows(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


ledger = rows(run / "provider.jsonl")
starts = {r["id"]: r for r in ledger if r["event"] == "request_start"}
responses = [r for r in ledger if r["event"] == "response_usage"]
assert len({r["responseId"] for r in responses}) == len(responses)
assert all(s["model"] == model and s["thinking"] == level for s in starts.values())
assert all(r['model'] == model for r in responses), 'Returned model differs from the requested model'
assert all(r["usage"]["total_tokens"] == r["usage"]["input_tokens"] + r["usage"]["output_tokens"] for r in responses)
totals = {
    "inputIncludingCached": sum(r["usage"]["input_tokens"] for r in responses),
    "cachedInput": sum(r["usage"]["input_tokens_details"]["cached_tokens"] for r in responses),
    "outputIncludingReasoning": sum(r["usage"]["output_tokens"] for r in responses),
    "reasoningSubsetOfOutput": sum(r["usage"]["output_tokens_details"]["reasoning_tokens"] for r in responses),
    "totalReported": sum(r["usage"]["total_tokens"] for r in responses),
}
assert all(summary["tokens"][k] == value for k, value in totals.items())
with (run / "requests.csv").open() as stream:
    request_csv = list(csv.DictReader(stream))
assert sum(int(r["total_tokens"]) for r in request_csv) == totals["totalReported"]
assert len(request_csv) == len(responses)
assert summary["checks"]["rawMinusSdkInput"] == 0
assert summary["checks"]["rawMinusSdkOutput"] == 0
rate_card = json.loads((ROOT / 'results/benchmark-rate-card.json').read_text())
model_rates = rate_card['models'][protocol['model']]
credit_rates = model_rates['creditsPerMillion']
rates = tuple(str(credit_rates[k]) for k in ('uncachedInput', 'cachedInput', 'output'))
equivalent = (
    Decimal(totals["inputIncludingCached"] - totals["cachedInput"]) * Decimal(rates[0])
    + Decimal(totals["cachedInput"]) * Decimal(rates[1])
    + Decimal(totals["outputIncludingReasoning"]) * Decimal(rates[2])
) / Decimal(1000000)
assert abs(Decimal(str(summary["publishedCreditRateEquivalent"]["credits"])) - equivalent) < Decimal("0.000000001")
api_equivalent = Decimal(0)
for response in responses:
    u = response['usage']
    cached = u['input_tokens_details']['cached_tokens']
    writes = u['input_tokens_details'].get('cache_write_tokens', 0)
    assert writes == 0, 'Cache-write retention is unknown; do not guess an API-equivalent cost'
    band = 'long' if u['input_tokens'] > rate_card['longContextThresholdInputTokens'] else 'short'
    ar = model_rates['apiUSDPerMillion'][band]
    api_equivalent += (Decimal(u['input_tokens'] - cached) * Decimal(str(ar['uncachedInput']))
                       + Decimal(cached) * Decimal(str(ar['cachedInput']))
                       + Decimal(u['output_tokens']) * Decimal(str(ar['output']))) / Decimal(1000000)
telemetry = rows(pathlib.Path(protocol["agentStateDir"]) / "Luna/telemetry.jsonl")
tools = [r for r in telemetry if r["event"] == "tool"]
failed = [r for r in tools if not r["success"]]
parse_time = lambda s: datetime.fromisoformat(s.replace("Z", "+00:00"))
latencies = [(parse_time(r["at"]) - parse_time(starts[r["id"]]["at"])).total_seconds() for r in responses]


def interval_union_seconds(events):
    intervals = sorted((parse_time(e['time']).timestamp() - e.get('timeMs', 0) / 1000,
                        parse_time(e['time']).timestamp()) for e in events if e.get('timeMs', 0) > 0)
    merged = []
    for start, end in intervals:
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(end, merged[-1][1])
        else:
            merged.append([start, end])
    return round(sum(end - start for start, end in merged), 6)


non_shell_tools = [r for r in tools if r['tool'] != 'run_shell']
result = {
    "verified": True,
    "tokens": totals,
    "startedRequests": len(starts),
    "reportedResponses": len(responses),
    "missingUsageRequests": [s for s in starts if s not in {r["id"] for r in responses}],
    "allRequestsUsedRequestedModelAndEffort": True,
    "allReportedResponsesUsedRequestedModel": True,
    "responseModelIds": sorted({r['model'] for r in responses}),
    "rawEqualsSdkAndCsv": True,
    "creditRateEquivalent": str(equivalent),
    "creditScope": "Published rate equivalent only; not measured subscription debit",
    "requestSeconds": {"median": statistics.median(latencies), "max": max(latencies), "sum": sum(latencies)},
    "tools": {"completed": len(tools), "success": len(tools) - len(failed), "failed": len(failed)},
    "failureCodes": dict(collections.Counter(r.get("failureCode", "unspecified") for r in failed)),
    "toolSeconds": sum(r.get("timeMs", 0) for r in tools) / 1000,
    "failedToolSeconds": sum(r.get("timeMs", 0) for r in failed) / 1000,
    "toolWallSecondsUnion": interval_union_seconds(tools),
    "failedToolWallSecondsUnion": interval_union_seconds(failed),
    "toolTimingScope": "Union removes overlap between nested game calls and shell wrappers; failed intervals may contain partial progress",
    "toolCountScope": "Logged tool entries include shell wrappers and nested calls; not a count of model decisions or primitive block actions",
    "nonShellTools": {"completed": len(non_shell_tools), "success": sum(r['success'] for r in non_shell_tools), "failed": sum(not r['success'] for r in non_shell_tools)},
    "deaths": [r for r in telemetry if r["event"] == "death"],
    "minimumObservedHealth": min((r["health"] for r in rows(run / "positions.jsonl") if "health" in r), default=None),
    "notesAtRequestedPath": any((pathlib.Path(protocol["agentStateDir"]) / p).is_file() for p in ('Luna/workspace/notes/task.md', 'Luna/workspace/shell-home/notes/task.md')),
    "notesPathRule": "Accept the private workspace notes path or the shell HOME notes path for all models",
    "apiStandardEquivalentUSD": str(api_equivalent),
    "costSource": rate_card['sources'],
    "successfulOakLogsGathered": sum(json.loads(r["result"])["mined"] for r in tools if r["tool"] == "gather" and r["success"] and json.loads(r["args"]).get("block") == "oak_log"),
    "oakPlanksCrafted": sum(json.loads(r["result"])["crafted"] for r in tools if r["tool"] == "craft" and r["success"] and json.loads(r["args"]).get("item") == "oak_planks"),
    "quantityScope": "Successful logged gather/craft returns; mined quantity may differ from actual inventory pickup, and saved inventories control task grading",
    "failedActions": failed,
    "toolSequence": [{k: r.get(k) for k in ("time", "tool", "args", "timeMs", "success", "failureCode", "result")} for r in tools],
}
(run / "independent-checks.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps({k:v for k,v in result.items() if k not in ("failedActions", "toolSequence")}, indent=2))
