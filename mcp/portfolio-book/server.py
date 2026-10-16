"""portfolio-book -- the portfolio system a front-office agent works in, as a
small local MCP server bundled with the Portfolio Analyst starter. AgentBox
scans it, builds it into its own container and reaches it only through MCP
Bridge, under an app-scoped name such as `<app>__portfolio-book`.

Three operations, chosen because the bridge treats each differently:

    get_positions(account)          reads; declared read-only, never held
    save_watchlist_note(ticker, ..) writes a dated note; an ordinary call
    purge_closed_accounts(years)    classified DESTRUCTIVE by the bridge's own
                                    classifier, so it is held for an operator

Records live in a file, seeded on first start from the bundled `book.json`
(seven invented accounts; nobody here is a real client). The path is this
container's own writable layer, which survives a restart but not a
`docker rm`.
"""

from __future__ import annotations

import json
import os
import shutil
import threading
import time
from datetime import date, datetime, timezone
from pathlib import Path

from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations

# host must be 0.0.0.0, not FastMCP's 127.0.0.1 default -- this server runs in
# its own container, reachable from managed-mcp-bridge over the docker network.
mcp = FastMCP("portfolio-book", host="0.0.0.0")

_STORE = Path(os.environ.get("BOOK_STORE_PATH", "/data/portfolio-book.json"))
_SEED = Path(__file__).resolve().parent / "book.json"
_LOCK = threading.Lock()


def _read() -> dict:
    if not _STORE.exists() and _SEED.is_file():
        _STORE.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(_SEED, _STORE)
    try:
        data = json.loads(_STORE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        data = json.loads(_SEED.read_text(encoding="utf-8")) if _SEED.is_file() else {}
    if not isinstance(data, dict):
        data = {}
    data.setdefault("accounts", [])
    data.setdefault("watchlist", [])
    return data


def _write(data: dict) -> None:
    _STORE.parent.mkdir(parents=True, exist_ok=True)
    tmp = _STORE.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(_STORE)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True))
def get_positions(account: str) -> dict:
    """The positions of one account with their weights and period returns, and the account's return against its benchmark."""
    needle = (account or "").strip().lower()
    if not needle:
        return {"found": False, "error": "account must not be empty"}
    with _LOCK:
        accounts = _read()["accounts"]
    for acc in accounts:
        if str(acc.get("id", "")).lower() == needle:
            return {"found": True, "account": acc}
    return {"found": False, "error": f"no account {account}"}


@mcp.tool()
def save_watchlist_note(ticker: str, note: str) -> dict:
    """A dated note added to the watchlist for a ticker; the watchlist count comes back."""
    ticker = (ticker or "").strip().upper()
    note = (note or "").strip()
    if not ticker or not note:
        return {"saved": False, "error": "ticker and note are both required"}
    with _LOCK:
        data = _read()
        data["watchlist"].append(
            {"ticker": ticker, "note": note[:1000], "date": date.today().isoformat(), "saved_at": datetime.now(timezone.utc).isoformat()}
        )
        _write(data)
        count = len(data["watchlist"])
    return {"saved": True, "ticker": ticker, "watchlist": count}


@mcp.tool()
def purge_closed_accounts(years: int = 5) -> dict:
    """Deletes every account record closed for more than the given number of years.

    Destructive on purpose, and named so the bridge can tell: this is the
    starter's example of an action AgentBox holds for a manager rather than
    running on request. Approved in the admin console, the same call is made
    again and the records go.
    """
    try:
        years = int(years)
    except (TypeError, ValueError):
        return {"deleted": 0, "error": "years must be a whole number"}
    cutoff = date.today().year - years
    with _LOCK:
        data = _read()
        keep, gone = [], []
        for acc in data["accounts"]:
            last = str(acc.get("last_activity") or "")
            year = int(last[:4]) if last[:4].isdigit() else cutoff + 1
            (gone if acc.get("status") == "closed" and year < cutoff else keep).append(acc)
        data["accounts"] = keep
        _write(data)
    return {"deleted": len(gone), "remaining": len(keep), "deleted_ids": [a.get("id") for a in gone]}


if __name__ == "__main__":
    # sse, not FastMCP's stdio default: this runs as its own detached
    # container and the bridge reaches it over HTTP at <container>:8000/sse.
    for attempt in range(10):
        try:
            mcp.run(transport="sse")
            break
        except BaseException as exc:
            print(f"portfolio-book: startup attempt {attempt} failed: {exc!r}", flush=True)
            time.sleep(1)
