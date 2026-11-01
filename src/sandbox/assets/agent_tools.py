"""The same tool relay used by the CLI, importable from generated programs."""
import json
import os
import sys
import urllib.error
import urllib.request


class BatchPaused(RuntimeError):
    def __init__(self, result):
        self.result = result
        super().__init__("Batch yielded; preserve progress and review instructions: " + json.dumps(result))


class BatchIncomplete(RuntimeError):
    def __init__(self, result):
        self.result = result
        super().__init__("Action made partial progress; inspect before continuing: " + json.dumps(result))


def call(name, arguments=None, **kwargs):
    if arguments is not None and kwargs:
        raise ValueError("Use an argument dictionary or keyword arguments")
    arguments = kwargs if arguments is None else arguments
    if not isinstance(arguments, dict):
        raise ValueError("Tool arguments must be an object")
    request = urllib.request.Request(
        os.environ.get("TOOL_RELAY_URL", "http://127.0.0.1:7777") + "/call",
        data=json.dumps({"name": name, "args": arguments}).encode(),
        headers={"x-token": os.environ["TOOL_API_TOKEN"], "content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=605) as response:
            reply = json.load(response)
    except (urllib.error.URLError, TimeoutError) as error:
        raise RuntimeError("Tool response unavailable; verify the world before retrying mutations") from error
    if not reply.get("ok"):
        raise RuntimeError(reply.get("error") or "Tool failed")
    result = reply.get("result")
    if isinstance(result, dict) and result.get("yielded"):
        raise BatchPaused(result)
    if isinstance(result, dict) and result.get("outcome") == "partial":
        raise BatchIncomplete(result)
    return result


def parameters():
    value = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
    if not isinstance(value, dict):
        raise ValueError("Program parameters must be an object")
    return value
