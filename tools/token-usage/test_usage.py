import json
import unittest

from capture import UsageDecoder, numeric_usage
from reconcile import reconcile, normalized, load_captures


def frame(value):
    return b"data: " + json.dumps(value, ensure_ascii=False).encode("utf-8") + b"\r\n\r\n"


class UsageTests(unittest.TestCase):
    def test_unfinished_requests_remain_visible_after_proxy_shutdown(self):
        captured, scopes = load_captures([
            {"phase": "scope", "hosts": ["local-test"]},
            {"phase": "started", "captureId": "unfinished", "complete": False},
        ])
        self.assertEqual(len(captured), 1)
        self.assertEqual(len(scopes), 1)
        self.assertFalse(reconcile(captured, [])["passed"])

    def test_claude_stream_is_cumulative_and_byte_boundaries_are_safe(self):
        decoder = UsageDecoder("claude", True)
        raw = {"input_tokens": 10, "output_tokens": 0, "cache_read_input_tokens": 30, "cache_creation_input_tokens": 20}
        stream = b"".join((
            frame({"type": "message_start", "message": {"id": "msg-1", "model": "test", "usage": raw}}),
            frame({"type": "content_block_delta", "delta": {"text": "private code: 中文"}}),
            frame({"type": "message_delta", "usage": {"output_tokens": 5}}),
            frame({"type": "message_delta", "usage": {"output_tokens": 8}}),
            frame({"type": "message_stop"}),
        ))
        forwarded = b"".join(decoder.feed(bytes([byte])) for byte in stream)
        self.assertEqual(forwarded, stream)
        self.assertTrue(decoder.finish())
        self.assertEqual(decoder.raw["output_tokens"], 8)
        self.assertNotIn("private", repr(decoder.__dict__))
        self.assertEqual(normalized({"provider": "claude", "raw": decoder.raw})["totalTokens"], 68)

    def test_openai_final_usage_preserves_subsets(self):
        decoder = UsageDecoder("codex", True)
        decoder.feed(frame({"type": "response.completed", "response": {
            "id": "resp-1", "model": "test", "usage": {
                "input_tokens": 100, "output_tokens": 20, "total_tokens": 120,
                "input_tokens_details": {"cached_tokens": 80},
                "output_tokens_details": {"reasoning_tokens": 15},
            },
        }}))
        self.assertTrue(decoder.finish())
        self.assertEqual(normalized({"provider": "codex", "raw": decoder.raw})["totalTokens"], 120)
        self.assertEqual(decoder.raw["reasoning_output_tokens"], 15)

    def test_non_streaming_and_incomplete_transport(self):
        decoder = UsageDecoder("codex", False)
        decoder.feed(json.dumps({"id": "resp-1", "status": "completed", "usage": {"input_tokens": 0, "output_tokens": 0}}).encode())
        self.assertTrue(decoder.finish())
        interrupted = UsageDecoder("claude", True)
        interrupted.feed(frame({"type": "message_start", "message": {"usage": {"input_tokens": 10, "output_tokens": 0}}}))
        self.assertFalse(interrupted.finish())

    def test_invalid_and_oversized_frames_cannot_pass(self):
        decoder = UsageDecoder("codex", True)
        decoder.feed(b"data: " + b"x" * (1024 * 1024 + 1))
        self.assertFalse(decoder.finish())
        self.assertEqual(numeric_usage({"api_key": "secret", "input_tokens": True, "output_tokens": -1}), {})

    def fixtures(self):
        captured = {"captureId": "capture", "provider": "codex", "responseId": "resp", "requestId": None,
                    "complete": True, "raw": {"input_tokens": 10, "output_tokens": 5}}
        record = {**captured, **normalized(captured), "id": "record", "granularity": "request"}
        return captured, record

    def test_equal_records_pass_without_estimating_tokens(self):
        captured, record = self.fixtures()
        self.assertTrue(reconcile([captured], [record])["passed"])
        self.assertFalse(reconcile([], [])["passed"])

    def test_mismatch_missing_duplicate_and_unmatched_are_reported(self):
        captured, record = self.fixtures()
        changed = {**record, "outputTokens": 6}
        self.assertEqual(reconcile([captured], [changed])["results"][0]["status"], "different")
        self.assertFalse(reconcile([captured], [record, record])["passed"])
        self.assertFalse(reconcile([captured, captured], [record])["passed"])
        self.assertEqual(reconcile([captured], [])["results"][0]["status"], "missing_in_adit")
        unmatched = {**record, "responseId": "other"}
        self.assertEqual(len(reconcile([captured], [record, unmatched])["unmatched"]), 1)

    def test_incomplete_and_missing_id_never_pass(self):
        captured, record = self.fixtures()
        self.assertFalse(reconcile([{**captured, "complete": False}], [record])["passed"])
        self.assertFalse(reconcile([captured], [{**record, "complete": False}])["passed"])
        self.assertFalse(reconcile([{**captured, "responseId": None}], [record])["passed"])


if __name__ == "__main__":
    unittest.main()
