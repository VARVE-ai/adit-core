import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path


def identifiers(record):
    return {(record.get("provider"), field, record[field]) for field in ("responseId", "requestId") if record.get(field)}


def load_captures(entries):
    started = {}
    finished = []
    scopes = []
    for entry in entries:
        if entry.get("phase") == "scope":
            scopes.append(entry)
        elif entry.get("phase") == "started":
            started[entry["captureId"]] = entry
        else:
            finished.append(entry)
    completed_ids = {entry.get("captureId") for entry in finished}
    return finished + [entry for key, entry in started.items() if key not in completed_ids], scopes


def normalized(record):
    raw = record.get("raw", {})
    source = raw.get("input_tokens")
    output = raw.get("output_tokens")
    if record.get("provider") == "claude":
        read = raw.get("cache_read_input_tokens")
        write = raw.get("cache_creation_input_tokens")
        input_tokens = source + read + write if all(type(value) is int for value in (source, read, write)) else None
    else:
        read = raw.get("cached_input_tokens")
        write = raw.get("cache_write_input_tokens")
        input_tokens = source
    return {
        "inputTokens": input_tokens, "outputTokens": output,
        "cacheReadTokens": read, "cacheWriteTokens": write,
        "reasoningTokens": raw.get("reasoning_output_tokens"),
        "totalTokens": input_tokens + output if type(input_tokens) is int and type(output) is int else None,
    }


def reconcile(captures, records):
    observations = [record for record in records if record.get("granularity") == "observation"]
    records = [record for record in records if record.get("granularity") != "observation"]
    index = defaultdict(set)
    for position, record in enumerate(records):
        for key in identifiers(record):
            index[key].add(position)
    captured_ids = defaultdict(int)
    for captured in captures:
        for key in identifiers(captured):
            captured_ids[key] += 1
    results = []
    matched = set()
    for captured in captures:
        keys = identifiers(captured)
        candidates = set().union(*(index[key] for key in keys)) if keys else set()
        result = {"captureId": captured.get("captureId"), "responseId": captured.get("responseId"), "differences": {}}
        if any(captured_ids[key] > 1 for key in keys) or len(candidates) > 1 or bool(candidates & matched):
            result["status"] = "ambiguous_or_duplicate"
        elif not captured.get("complete"):
            result["status"] = "capture_incomplete"
        elif not keys:
            result["status"] = "identity_missing"
        elif not candidates:
            result["status"] = "missing_in_adit"
        else:
            position = next(iter(candidates))
            matched.add(position)
            record = records[position]
            result["recordId"] = record.get("id")
            expected = normalized(captured)
            differences = {field: {"capture": value, "adit": record.get(field)} for field, value in expected.items() if value != record.get(field)}
            for field in set(captured.get("raw", {})) | set(record.get("raw", {})):
                left = captured.get("raw", {}).get(field)
                right = record.get("raw", {}).get(field)
                if left != right:
                    differences[f"raw.{field}"] = {"capture": left, "adit": right}
            if captured.get("model") and captured["model"] != record.get("model"):
                differences["model"] = {"capture": captured["model"], "adit": record.get("model")}
            result["differences"] = differences
            result["status"] = "different" if differences else "equal" if record.get("complete") else "adit_incomplete"
        results.append(result)
    unmatched = [{"id": record.get("id"), "granularity": record.get("granularity"), "status": "unmatched_in_adit"} for position, record in enumerate(records) if position not in matched]
    equal = sum(row["status"] == "equal" for row in results)
    return {
        "schemaVersion": 1, "passed": bool(captures) and equal == len(captures) and not unmatched,
        "scope": "Provided capture and cloud export only; billing and turn attribution are not independently verified.",
        "summary": {"captures": len(captures), "aditRecords": len(records), "equal": equal, "unmatchedAdit": len(unmatched), "nonAdditiveObservations": len(observations)},
        "results": results, "unmatched": unmatched,
    }


def main():
    parser = argparse.ArgumentParser(description="Independently reconcile captured API usage with ADIT cloud export")
    parser.add_argument("--capture", required=True)
    parser.add_argument("--adit", required=True)
    parser.add_argument("--report", required=True)
    args = parser.parse_args()
    entries = [json.loads(line) for line in Path(args.capture).read_text(encoding="utf-8").splitlines() if line.strip()]
    captures, scopes = load_captures(entries)
    exported = json.loads(Path(args.adit).read_text(encoding="utf-8"))
    if exported.get("nextCursor"):
        parser.error("Cloud export is paginated; export every page before reconciliation")
    records = exported["records"]
    report = reconcile(captures, records)
    report["captureScopes"] = scopes
    summary = exported.get("summary", {})
    if summary.get("records", len(records)) != len(records):
        report["passed"] = False
        report["exportError"] = "Incomplete cloud export"
    expected_total = sum(record["totalTokens"] for record in records if record.get("totalTokens") is not None and record.get("granularity") == "request")
    if summary.get("knownTokens") is not None and summary["knownTokens"] != expected_total:
        report["passed"] = False
        report["aggregateError"] = {"cloud": summary["knownTokens"], "records": expected_total}
    Path(args.report).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report["summary"]))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
