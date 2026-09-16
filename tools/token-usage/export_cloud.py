import argparse
import json
import os
from pathlib import Path
from urllib.parse import quote, urlencode, urlparse
from urllib.request import Request, build_opener, HTTPRedirectHandler


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, newurl):
        return None


def main():
    parser = argparse.ArgumentParser(description="Export every page of ADIT cloud usage; token comes from ADIT_ACCESS_TOKEN")
    parser.add_argument("--server", required=True)
    parser.add_argument("--session", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--date-from")
    parser.add_argument("--date-to")
    parser.add_argument("--time-zone", default="UTC")
    args = parser.parse_args()
    address = urlparse(args.server)
    if address.username or address.password or address.query or address.fragment:
        parser.error("Server must be an origin without credentials or query parameters")
    if address.scheme != "https" and not (address.scheme == "http" and address.hostname in ("localhost", "127.0.0.1", "::1")):
        parser.error("HTTPS is required except for loopback testing")
    token = os.environ.get("ADIT_ACCESS_TOKEN")
    if not token:
        parser.error("Set ADIT_ACCESS_TOKEN in the environment; do not put credentials on the command line")
    params = {"timeZone": args.time_zone}
    if args.date_from:
        params["dateFrom"] = args.date_from
    if args.date_to:
        params["dateTo"] = args.date_to
    endpoint = args.server.rstrip("/") + "/api/sessions/" + quote(args.session, safe="") + "/token-usage"
    records = []
    cursors = set()
    opener = build_opener(NoRedirect())
    while True:
        request = Request(endpoint + "?" + urlencode(params), headers={"Authorization": "Bearer " + token})
        with opener.open(request, timeout=30) as response:
            page = json.load(response)
        records.extend(page["records"])
        cursor = page.get("nextCursor")
        if not cursor:
            break
        if cursor in cursors:
            raise RuntimeError("Cloud returned a repeated pagination cursor")
        cursors.add(cursor)
        params["cursor"] = cursor
    exported = {"records": records, "nextCursor": None, "summary": page["summary"],
                "scope": {"sessionId": args.session, "dateFrom": args.date_from, "dateTo": args.date_to, "timeZone": args.time_zone}}
    Path(args.output).write_text(json.dumps(exported, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Exported {len(records)} usage records. Run after generation and cloud sync have stopped.")


if __name__ == "__main__":
    main()
