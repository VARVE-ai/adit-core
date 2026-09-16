import json
import os
from datetime import datetime, timezone


FIELDS = (
    "input_tokens", "output_tokens", "cached_input_tokens", "cache_read_input_tokens",
    "cache_creation_input_tokens", "cache_write_input_tokens", "reasoning_output_tokens", "total_tokens",
)
MAX_FRAME = 1024 * 1024


def numeric_usage(value):
    if not isinstance(value, dict):
        return {}
    return {key: value[key] for key in FIELDS if type(value.get(key)) is int and 0 <= value[key] <= 9007199254740991}


def safe_id(value):
    return value if isinstance(value, str) and 0 < len(value) <= 256 else None


class UsageDecoder:
    def __init__(self, provider, streaming):
        self.provider = provider
        self.streaming = streaming
        self.buffer = b""
        self.data_lines = []
        self.raw = {}
        self.response_id = None
        self.model = None
        self.final = False
        self.invalid = False
        self.discard_line = False

    def event(self, value):
        if not isinstance(value, dict):
            self.invalid = True
            return
        kind = value.get("type")
        if self.provider == "claude":
            message = value.get("message", {}) if kind == "message_start" else value
            if not isinstance(message, dict):
                self.invalid = True
                return
            self.response_id = safe_id(message.get("id")) or self.response_id
            self.model = safe_id(message.get("model")) or self.model
            if kind in ("message_start", "message_delta") or not self.streaming:
                self.raw.update(numeric_usage(message.get("usage")))
            if kind == "message_stop" or not self.streaming:
                self.final = True
        else:
            response = value.get("response", {}) if kind else value
            if not isinstance(response, dict):
                self.invalid = True
                return
            self.response_id = safe_id(response.get("id")) or self.response_id
            self.model = safe_id(response.get("model")) or self.model
            if kind == "response.completed" or (not self.streaming and response.get("status") == "completed"):
                usage = response.get("usage", {})
                if not isinstance(usage, dict):
                    self.invalid = True
                    return
                raw = numeric_usage(usage)
                for container, field, target in (
                    ("input_tokens_details", "cached_tokens", "cached_input_tokens"),
                    ("output_tokens_details", "reasoning_tokens", "reasoning_output_tokens"),
                ):
                    detail = usage.get(container, {})
                    if isinstance(detail, dict):
                        raw.update(numeric_usage({target: detail.get(field)}))
                self.raw = raw
                self.final = True
        if kind in ("error", "response.failed", "response.incomplete"):
            self.invalid = True

    def dispatch(self):
        if not self.data_lines:
            return
        data = b"\n".join(self.data_lines)
        self.data_lines = []
        if data == b"[DONE]":
            return
        try:
            self.event(json.loads(data))
        except (ValueError, UnicodeError):
            self.invalid = True

    def feed(self, chunk):
        if not chunk:
            return chunk
        self.buffer += chunk
        if self.streaming:
            while b"\n" in self.buffer:
                line, self.buffer = self.buffer.split(b"\n", 1)
                if self.discard_line:
                    self.discard_line = False
                    continue
                line = line.rstrip(b"\r")
                if len(line) > MAX_FRAME:
                    self.invalid = True
                    self.data_lines = []
                    continue
                if not line:
                    self.dispatch()
                elif line.startswith(b"data:"):
                    self.data_lines.append(line[5:].lstrip(b" "))
                    if sum(map(len, self.data_lines)) > MAX_FRAME:
                        self.data_lines = []
                        self.invalid = True
        if len(self.buffer) > MAX_FRAME:
            self.buffer = b""
            self.discard_line = True
            self.invalid = True
        return chunk

    def finish(self):
        if self.streaming:
            if self.buffer or self.data_lines:
                self.invalid = True
        elif self.buffer and not self.invalid:
            try:
                self.event(json.loads(self.buffer))
            except (ValueError, UnicodeError):
                self.invalid = True
        self.buffer = b""
        self.data_lines = []
        return self.final and not self.invalid and "input_tokens" in self.raw and "output_tokens" in self.raw


class UsageCapture:
    def load(self, loader):
        loader.add_option("usage_hosts", str, "", "Comma-separated exact model API hosts; required")
        loader.add_option("usage_output", str, "", "Usage-only JSONL output path; required")
        self.pending = {}

    def append_record(self, record):
        from mitmproxy import ctx
        descriptor = os.open(ctx.options.usage_output, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        with os.fdopen(descriptor, "a", encoding="utf-8") as output:
            output.write(json.dumps(record, ensure_ascii=False) + "\n")

    def running(self):
        from mitmproxy import ctx, version
        if ctx.options.usage_output:
            self.append_record({"phase": "scope", "schemaVersion": 1,
                "startedAt": datetime.now(timezone.utc).isoformat(), "mitmproxyVersion": version.VERSION,
                "hosts": sorted({host.strip().lower() for host in ctx.options.usage_hosts.split(",") if host.strip()}),
                "paths": ["/messages", "/responses"]})

    def requestheaders(self, flow):
        from mitmproxy import ctx
        hosts = {host.strip().lower() for host in ctx.options.usage_hosts.split(",") if host.strip()}
        path = flow.request.path.split("?", 1)[0].rstrip("/")
        provider = "claude" if path.endswith("/messages") else "codex" if path.endswith("/responses") else None
        if not ctx.options.usage_output or flow.request.host.lower() not in hosts or not provider or flow.request.method != "POST":
            return
        flow.request.headers["accept-encoding"] = "identity"
        flow.request.stream = True
        self.pending[flow.id] = {"provider": provider, "started": flow.request.timestamp_start, "decoder": None, "requestId": None}
        self.append_record({"schemaVersion": 1, "phase": "started", "captureId": flow.id, "provider": provider,
            "occurredAt": datetime.fromtimestamp(flow.request.timestamp_start, timezone.utc).isoformat(),
            "requestId": None, "responseId": None, "model": None, "raw": {}, "complete": False, "status": None})

    def responseheaders(self, flow):
        pending = self.pending.get(flow.id)
        if not pending:
            return
        decoder = UsageDecoder(pending["provider"], "text/event-stream" in flow.response.headers.get("content-type", ""))
        if flow.response.headers.get("content-encoding", "identity") not in ("", "identity"):
            decoder.invalid = True
        pending["decoder"] = decoder
        pending["requestId"] = safe_id(flow.response.headers.get("request-id") or flow.response.headers.get("x-request-id"))
        flow.response.stream = decoder.feed

    def response(self, flow):
        self.write(flow, False)

    def error(self, flow):
        self.write(flow, True)

    def write(self, flow, failed):
        pending = self.pending.pop(flow.id, None)
        if not pending:
            return
        decoder = pending["decoder"]
        complete = decoder.finish() if decoder else False
        status = flow.response.status_code if flow.response else None
        record = {
            "schemaVersion": 1, "phase": "finished", "captureId": flow.id, "provider": pending["provider"],
            "occurredAt": datetime.fromtimestamp(pending["started"], timezone.utc).isoformat(),
            "requestId": pending["requestId"], "responseId": decoder.response_id if decoder else None,
            "model": decoder.model if decoder else None, "raw": decoder.raw if decoder else {},
            "complete": complete and not failed and status is not None and 200 <= status < 300,
            "status": status,
        }
        self.append_record(record)


addons = [UsageCapture()]
