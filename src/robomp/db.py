"""SQLite-backed durable event queue + bot state."""

from __future__ import annotations

import json
import sqlite3
import threading
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Literal

EventState = Literal["queued", "running", "done", "failed", "skipped"]
INACTIVE_EVENT_STATES: tuple[EventState, ...] = ("done", "failed", "skipped")

IssueState = Literal[
    "new",
    "reproducing",
    "fixing",
    "opened",
    "merged",
    "closed",
    "abandoned",
]

SCHEMA = """
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS events (
  delivery_id   TEXT PRIMARY KEY,
  event_type    TEXT NOT NULL,
  repo          TEXT,
  issue_key     TEXT,
  payload_json  TEXT NOT NULL,
  received_at   TEXT NOT NULL,
  state         TEXT NOT NULL
    CHECK (state IN ('queued','running','done','failed','skipped')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  started_at    TEXT,
  finished_at   TEXT,
  model         TEXT
);

CREATE INDEX IF NOT EXISTS events_state_received
  ON events(state, received_at);

CREATE TABLE IF NOT EXISTS issues (
  key            TEXT PRIMARY KEY,
  repo           TEXT NOT NULL,
  number         INTEGER NOT NULL,
  branch         TEXT,
  session_dir    TEXT,
  pr_number      INTEGER,
  state          TEXT NOT NULL,
  classification TEXT,         -- bug|enhancement|question|proposal|documentation|invalid|duplicate
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_key     TEXT NOT NULL,
  tool          TEXT NOT NULL,
  args_json     TEXT NOT NULL,
  result_json   TEXT,
  error         TEXT,
  ts            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tool_calls_issue ON tool_calls(issue_key, ts);

CREATE TABLE IF NOT EXISTS submissions (
  delivery_id   TEXT PRIMARY KEY,
  login         TEXT NOT NULL,
  repo          TEXT,
  ts            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS submissions_login_ts ON submissions(login, ts);
"""


def _utcnow() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def iso_seconds_ago(seconds: float) -> str:
    """ISO-UTC timestamp for `seconds` ago, matching the format `_utcnow` writes."""
    return (datetime.now(UTC) - timedelta(seconds=seconds)).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


@dataclass(slots=True, frozen=True)
class EventRow:
    delivery_id: str
    event_type: str
    repo: str | None
    issue_key: str | None
    payload: dict[str, Any]
    received_at: str
    state: EventState
    attempts: int
    last_error: str | None


@dataclass(slots=True, frozen=True)
class IssueRow:
    key: str
    repo: str
    number: int
    branch: str | None
    session_dir: str | None
    pr_number: int | None
    state: IssueState
    updated_at: str
    classification: str | None = None


@dataclass(slots=True, frozen=True)
class SubmissionAdmission:
    accepted: bool
    duplicate: bool
    used: int


def issue_key(repo: str, number: int) -> str:
    return f"{repo}#{number}"


class Database:
    """Thread-safe sqlite wrapper. One connection per thread via locks."""

    def __init__(self, path: Path) -> None:
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            self._conn.executescript(SCHEMA)
            self._migrate()

    def _migrate(self) -> None:
        # SQLite-friendly forward migrations. Each is idempotent.
        issue_cols = {row[1] for row in self._conn.execute("PRAGMA table_info(issues)").fetchall()}
        if "classification" not in issue_cols:
            self._conn.execute("ALTER TABLE issues ADD COLUMN classification TEXT")
        event_cols = {row[1] for row in self._conn.execute("PRAGMA table_info(events)").fetchall()}
        if "model" not in event_cols:
            self._conn.execute("ALTER TABLE events ADD COLUMN model TEXT")

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    @contextmanager
    def _txn(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            try:
                yield self._conn
                self._conn.execute("COMMIT")
            except BaseException:
                self._conn.execute("ROLLBACK")
                raise

    # ---- events ----
    def record_event(
        self,
        *,
        delivery_id: str,
        event_type: str,
        repo: str | None,
        issue_key: str | None,
        payload: Mapping[str, Any],
        state: EventState = "queued",
        last_error: str | None = None,
    ) -> bool:
        """Insert a webhook event. Returns False if duplicate (by delivery id).

        `last_error` is the reason text surfaced on the dashboard for non-queued
        states (skipped, failed). Ignored when state == 'queued'.
        """
        now = _utcnow()
        with self._lock:
            cur = self._conn.execute(
                """
                INSERT OR IGNORE INTO events
                  (delivery_id, event_type, repo, issue_key, payload_json, received_at, state, last_error)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    delivery_id,
                    event_type,
                    repo,
                    issue_key,
                    json.dumps(payload, separators=(",", ":")),
                    now,
                    state,
                    last_error,
                ),
            )
            return cur.rowcount > 0

    def claim_next_event(self) -> EventRow | None:
        """Atomically dequeue one queued event into running state."""
        with self._txn() as conn:
            row = conn.execute(
                """
                SELECT delivery_id, event_type, repo, issue_key, payload_json, received_at,
                       state, attempts, last_error
                FROM events
                WHERE state = 'queued'
                ORDER BY received_at
                LIMIT 1
                """
            ).fetchone()
            if row is None:
                return None
            now = _utcnow()
            conn.execute(
                "UPDATE events SET state='running', attempts=attempts+1, started_at=? WHERE delivery_id=?",
                (now, row["delivery_id"]),
            )
            return EventRow(
                delivery_id=row["delivery_id"],
                event_type=row["event_type"],
                repo=row["repo"],
                issue_key=row["issue_key"],
                payload=json.loads(row["payload_json"]),
                received_at=row["received_at"],
                state="running",
                attempts=int(row["attempts"]) + 1,
                last_error=row["last_error"],
            )

    def mark_event(self, delivery_id: str, state: EventState, *, error: str | None = None) -> None:
        with self._lock:
            self._conn.execute(
                "UPDATE events SET state=?, last_error=?, finished_at=? WHERE delivery_id=?",
                (state, error, _utcnow(), delivery_id),
            )

    def set_event_model(self, delivery_id: str, model: str) -> None:
        """Persist the model the worker actually picked for this event.

        Called once per run, right after `pick_model()`, so the dashboard and
        post-mortems can attribute behavior to the exact model used.
        """
        with self._lock:
            self._conn.execute(
                "UPDATE events SET model=? WHERE delivery_id=?",
                (model, delivery_id),
            )

    def reset_stuck_running(self) -> int:
        """Recover events that were running at shutdown."""
        with self._lock:
            cur = self._conn.execute(
                "UPDATE events SET state='queued' WHERE state='running'",
            )
            return cur.rowcount

    def list_events(self, *, limit: int = 50) -> list[EventRow]:
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT delivery_id, event_type, repo, issue_key, payload_json, received_at,
                       state, attempts, last_error
                FROM events
                ORDER BY received_at DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        return [
            EventRow(
                delivery_id=row["delivery_id"],
                event_type=row["event_type"],
                repo=row["repo"],
                issue_key=row["issue_key"],
                payload=json.loads(row["payload_json"]),
                received_at=row["received_at"],
                state=row["state"],
                attempts=int(row["attempts"]),
                last_error=row["last_error"],
            )
            for row in rows
        ]

    def remove_event(self, delivery_id: str) -> None:
        """Hard-delete an event row. Used to clear stale state before a manual re-trigger."""
        with self._lock:
            self._conn.execute("DELETE FROM events WHERE delivery_id=?", (delivery_id,))

    def replace_event_if_state_in(
        self,
        *,
        delivery_id: str,
        event_type: str,
        repo: str | None,
        issue_key: str | None,
        payload: Mapping[str, Any],
        state: EventState = "queued",
        allowed_existing_states: tuple[EventState, ...],
    ) -> bool:
        """Replace an existing event only when its current state is permitted."""
        now = _utcnow()
        with self._txn() as conn:
            row = conn.execute(
                "SELECT state FROM events WHERE delivery_id = ?",
                (delivery_id,),
            ).fetchone()
            if row is not None:
                if row["state"] not in allowed_existing_states:
                    return False
                conn.execute("DELETE FROM events WHERE delivery_id = ?", (delivery_id,))
            conn.execute(
                """
                INSERT INTO events
                  (delivery_id, event_type, repo, issue_key, payload_json, received_at, state)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    delivery_id,
                    event_type,
                    repo,
                    issue_key,
                    json.dumps(payload, separators=(",", ":")),
                    now,
                    state,
                ),
            )
            return True

    def latest_event_for_issue(self, key: str) -> EventRow | None:
        """Return the most recent event whose issue_key matches, or None."""
        with self._lock:
            row = self._conn.execute(
                """
                SELECT delivery_id, event_type, repo, issue_key, payload_json, received_at,
                       state, attempts, last_error
                FROM events
                WHERE issue_key = ?
                ORDER BY received_at DESC
                LIMIT 1
                """,
                (key,),
            ).fetchone()
        if row is None:
            return None
        return EventRow(
            delivery_id=row["delivery_id"],
            event_type=row["event_type"],
            repo=row["repo"],
            issue_key=row["issue_key"],
            payload=json.loads(row["payload_json"]),
            received_at=row["received_at"],
            state=row["state"],
            attempts=int(row["attempts"]),
            last_error=row["last_error"],
        )

    def event_state_counts(self) -> dict[str, int]:
        """Return current row counts per event state, including states with zero rows."""
        with self._lock:
            rows = self._conn.execute("SELECT state, COUNT(*) AS n FROM events GROUP BY state").fetchall()
        counts: dict[str, int] = dict.fromkeys(("queued", "running", "done", "failed", "skipped"), 0)
        for row in rows:
            counts[row["state"]] = int(row["n"])
        return counts

    def list_running_events(self) -> list[dict[str, Any]]:
        """Snapshot of currently-running events.

        Returns elapsed-time inputs (`started_at`) plus per-run telemetry:
        - `model`: the omp model the worker picked for this run, set after
          `pick_model()` so it reflects the actual pool selection.
        - `last_tool` / `last_tool_ts`: the most recent host-tool call audited
          on the same `issue_key` since `started_at`. Scoping by start time
          prevents stale entries from a prior run on the same issue leaking
          into the dashboard before this run has emitted any tool calls.
        """
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT e.delivery_id, e.event_type, e.repo, e.issue_key, e.received_at,
                       e.started_at, e.attempts, e.model,
                       (SELECT tool FROM tool_calls
                          WHERE issue_key = e.issue_key AND ts >= e.started_at
                          ORDER BY ts DESC LIMIT 1) AS last_tool,
                       (SELECT ts FROM tool_calls
                          WHERE issue_key = e.issue_key AND ts >= e.started_at
                          ORDER BY ts DESC LIMIT 1) AS last_tool_ts
                FROM events e
                WHERE e.state = 'running'
                ORDER BY COALESCE(e.started_at, e.received_at)
                """
            ).fetchall()
        return [
            {
                "delivery_id": r["delivery_id"],
                "event_type": r["event_type"],
                "repo": r["repo"],
                "issue_key": r["issue_key"],
                "received_at": r["received_at"],
                "started_at": r["started_at"],
                "attempts": int(r["attempts"]),
                "model": r["model"],
                "last_tool": r["last_tool"],
                "last_tool_ts": r["last_tool_ts"],
            }
            for r in rows
        ]

    def get_event(self, delivery_id: str) -> EventRow | None:
        with self._lock:
            row = self._conn.execute(
                """
                SELECT delivery_id, event_type, repo, issue_key, payload_json, received_at,
                       state, attempts, last_error
                FROM events WHERE delivery_id = ?
                """,
                (delivery_id,),
            ).fetchone()
        if row is None:
            return None
        return EventRow(
            delivery_id=row["delivery_id"],
            event_type=row["event_type"],
            repo=row["repo"],
            issue_key=row["issue_key"],
            payload=json.loads(row["payload_json"]),
            received_at=row["received_at"],
            state=row["state"],
            attempts=int(row["attempts"]),
            last_error=row["last_error"],
        )

    def requeue_event(
        self,
        delivery_id: str,
        *,
        from_states: tuple[EventState, ...] | None = None,
    ) -> bool:
        """Move an event back to queued without clobbering last_error.

        Returns True only when a row was actually transitioned. `from_states`
        restricts which current states may be requeued; callers use this to
        keep public retries from mutating queued/running rows while preserving
        internal recovery of a just-claimed running event.
        """
        with self._lock:
            if from_states is None:
                cur = self._conn.execute(
                    "UPDATE events SET state='queued' WHERE delivery_id=?",
                    (delivery_id,),
                )
            elif not from_states:
                return False
            else:
                placeholders = ",".join("?" for _ in from_states)
                cur = self._conn.execute(
                    f"UPDATE events SET state='queued' WHERE delivery_id=? AND state IN ({placeholders})",
                    (delivery_id, *from_states),
                )
            return cur.rowcount > 0

    # ---- issues ----
    def upsert_issue(
        self,
        *,
        key: str,
        repo: str,
        number: int,
        state: IssueState,
        branch: str | None = None,
        session_dir: str | None = None,
        pr_number: int | None = None,
    ) -> IssueRow:
        now = _utcnow()
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO issues (key, repo, number, branch, session_dir, pr_number, state, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                  branch = COALESCE(excluded.branch, issues.branch),
                  session_dir = COALESCE(excluded.session_dir, issues.session_dir),
                  pr_number = COALESCE(excluded.pr_number, issues.pr_number),
                  state = excluded.state,
                  updated_at = excluded.updated_at
                """,
                (key, repo, number, branch, session_dir, pr_number, state, now),
            )
        got = self.get_issue(key)
        assert got is not None
        return got

    def set_issue_state(self, key: str, state: IssueState) -> None:
        with self._lock:
            self._conn.execute(
                "UPDATE issues SET state=?, updated_at=? WHERE key=?",
                (state, _utcnow(), key),
            )

    def set_issue_pr(self, key: str, pr_number: int) -> None:
        with self._lock:
            self._conn.execute(
                "UPDATE issues SET pr_number=?, updated_at=? WHERE key=?",
                (pr_number, _utcnow(), key),
            )

    def set_issue_classification(self, key: str, classification: str) -> None:
        with self._lock:
            self._conn.execute(
                "UPDATE issues SET classification=?, updated_at=? WHERE key=?",
                (classification, _utcnow(), key),
            )

    def set_issue_branch(self, key: str, branch: str) -> None:
        with self._lock:
            self._conn.execute(
                "UPDATE issues SET branch=?, updated_at=? WHERE key=?",
                (branch, _utcnow(), key),
            )

    def get_issue(self, key: str) -> IssueRow | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT key, repo, number, branch, session_dir, pr_number, state, classification, updated_at FROM issues WHERE key=?",
                (key,),
            ).fetchone()
        if row is None:
            return None
        return IssueRow(
            key=row["key"],
            repo=row["repo"],
            number=int(row["number"]),
            branch=row["branch"],
            session_dir=row["session_dir"],
            pr_number=int(row["pr_number"]) if row["pr_number"] is not None else None,
            state=row["state"],
            updated_at=row["updated_at"],
            classification=row["classification"],
        )

    def find_issue_by_pr(self, repo: str, pr_number: int) -> IssueRow | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT key, repo, number, branch, session_dir, pr_number, state, classification, updated_at FROM issues WHERE repo=? AND pr_number=?",
                (repo, pr_number),
            ).fetchone()
        if row is None:
            return None
        return IssueRow(
            key=row["key"],
            repo=row["repo"],
            number=int(row["number"]),
            branch=row["branch"],
            session_dir=row["session_dir"],
            pr_number=int(row["pr_number"]),
            state=row["state"],
            updated_at=row["updated_at"],
            classification=row["classification"],
        )

    def find_issue_by_branch(self, repo: str, branch: str) -> IssueRow | None:
        with self._lock:
            row = self._conn.execute(
                """
                SELECT key, repo, number, branch, session_dir, pr_number, state, classification, updated_at
                FROM issues
                WHERE repo=? AND branch=?
                ORDER BY updated_at DESC
                LIMIT 1
                """,
                (repo, branch),
            ).fetchone()
        if row is None:
            return None
        return IssueRow(
            key=row["key"],
            repo=row["repo"],
            number=int(row["number"]),
            branch=row["branch"],
            session_dir=row["session_dir"],
            pr_number=int(row["pr_number"]) if row["pr_number"] is not None else None,
            state=row["state"],
            updated_at=row["updated_at"],
            classification=row["classification"],
        )

    def list_issues(self, limit: int = 100) -> list[IssueRow]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT key, repo, number, branch, session_dir, pr_number, state, classification, updated_at FROM issues ORDER BY updated_at DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [
            IssueRow(
                key=r["key"],
                repo=r["repo"],
                number=int(r["number"]),
                branch=r["branch"],
                session_dir=r["session_dir"],
                pr_number=int(r["pr_number"]) if r["pr_number"] is not None else None,
                state=r["state"],
                updated_at=r["updated_at"],
                classification=r["classification"],
            )
            for r in rows
        ]

    # ---- tool_calls ----
    def log_tool_call(
        self,
        *,
        issue_key: str,
        tool: str,
        args: Mapping[str, Any],
        result: Mapping[str, Any] | None = None,
        error: str | None = None,
    ) -> int:
        with self._lock:
            cur = self._conn.execute(
                "INSERT INTO tool_calls (issue_key, tool, args_json, result_json, error, ts) VALUES (?, ?, ?, ?, ?, ?)",
                (
                    issue_key,
                    tool,
                    json.dumps(args, separators=(",", ":"), default=str),
                    json.dumps(result, separators=(",", ":"), default=str) if result is not None else None,
                    error,
                    _utcnow(),
                ),
            )
            return int(cur.lastrowid or 0)

    # ---- submissions (per-user rate limiting) ----
    def admit_submission(
        self,
        *,
        delivery_id: str,
        login: str,
        repo: str | None,
        since: str,
        cap: int | None,
    ) -> SubmissionAdmission:
        """Atomically check a submitter's rolling cap and record this delivery.

        Duplicate delivery ids are accepted without inserting a second row, so a
        webhook retry remains idempotent even after the submitter reaches the cap.
        `used` is the matching submission count after acceptance, or the count
        that caused rejection when `accepted` is False.
        """
        normalized_login = login.lower()
        with self._txn() as conn:
            existing = conn.execute(
                "SELECT 1 FROM submissions WHERE delivery_id=?",
                (delivery_id,),
            ).fetchone()
            if existing is not None:
                row = conn.execute(
                    "SELECT COUNT(*) AS n FROM submissions WHERE login=? AND ts>=?",
                    (normalized_login, since),
                ).fetchone()
                return SubmissionAdmission(
                    accepted=True,
                    duplicate=True,
                    used=int(row["n"]) if row is not None else 0,
                )

            row = conn.execute(
                "SELECT COUNT(*) AS n FROM submissions WHERE login=? AND ts>=?",
                (normalized_login, since),
            ).fetchone()
            used = int(row["n"]) if row is not None else 0
            if cap is not None and used >= cap:
                return SubmissionAdmission(accepted=False, duplicate=False, used=used)

            conn.execute(
                "INSERT INTO submissions (delivery_id, login, repo, ts) VALUES (?, ?, ?, ?)",
                (delivery_id, normalized_login, repo, _utcnow()),
            )
            return SubmissionAdmission(accepted=True, duplicate=False, used=used + 1)

    def record_submission(
        self,
        *,
        delivery_id: str,
        login: str,
        repo: str | None,
    ) -> bool:
        """Idempotently log a queue-worthy submission by `login`.

        Returns False if the delivery_id was already recorded (webhook retry).
        """
        now = _utcnow()
        with self._lock:
            cur = self._conn.execute(
                "INSERT OR IGNORE INTO submissions (delivery_id, login, repo, ts) VALUES (?, ?, ?, ?)",
                (delivery_id, login.lower(), repo, now),
            )
            return cur.rowcount > 0

    def count_submissions_since(self, login: str, since: str) -> int:
        """Count submissions by `login` (case-insensitive) with ts >= `since`."""
        with self._lock:
            row = self._conn.execute(
                "SELECT COUNT(*) AS n FROM submissions WHERE login=? AND ts>=?",
                (login.lower(), since),
            ).fetchone()
        return int(row["n"]) if row is not None else 0


_DB_SINGLETON: Database | None = None
_DB_LOCK = threading.Lock()


def get_database(path: Path) -> Database:
    global _DB_SINGLETON
    with _DB_LOCK:
        if _DB_SINGLETON is None or _DB_SINGLETON.path != path:
            if _DB_SINGLETON is not None:
                _DB_SINGLETON.close()
            _DB_SINGLETON = Database(path)
        return _DB_SINGLETON


def close_database() -> None:
    global _DB_SINGLETON
    with _DB_LOCK:
        if _DB_SINGLETON is not None:
            _DB_SINGLETON.close()
            _DB_SINGLETON = None
