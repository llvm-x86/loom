"""End-to-end coverage for the FastAPI surface (dashboard + JSON APIs)."""

from __future__ import annotations

import hashlib
import hmac
import json
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from robomp.config import Settings, reset_settings_cache
from robomp.dashboard import tail_jsonl
from robomp.db import close_database, get_database, issue_key
from robomp.github_client import GitHubClient
from robomp.manual_triage import InvalidIssueRef, parse_issue_ref
from robomp.server import create_app


def _seed_db(settings: Settings) -> None:
    db = get_database(settings.sqlite_path)
    db.record_event(
        delivery_id="d-queued",
        event_type="issues",
        repo="octo/widget",
        issue_key=issue_key("octo/widget", 1),
        payload={"action": "opened", "issue": {"number": 1}},
    )
    db.record_event(
        delivery_id="d-skipped",
        event_type="issues",
        repo="octo/widget",
        issue_key=issue_key("octo/widget", 2),
        payload={"action": "labeled"},
        state="skipped",
    )
    # Promote one event to "running" so the running_events list isn't empty.
    db.record_event(
        delivery_id="d-running",
        event_type="issue_comment",
        repo="octo/widget",
        issue_key=issue_key("octo/widget", 3),
        payload={"action": "created"},
    )
    claimed = db.claim_next_event()
    assert claimed is not None  # d-queued or d-running depending on order
    # Make sure at least one event is in running state for our assertions.
    db.upsert_issue(
        key=issue_key("octo/widget", 3),
        repo="octo/widget",
        number=3,
        state="opened",
        branch="farm/abc12345/fix",
        pr_number=42,
    )
    db.set_issue_classification(issue_key("octo/widget", 3), "bug")


def test_index_serves_dashboard_html(settings: Settings) -> None:
    app = create_app(settings)
    with TestClient(app) as client:
        resp = client.get("/")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/html")
    # A few load-bearing markers from the page; if these vanish, the dashboard
    # changed shape and the rest of the test suite should be updated too.
    assert "<title>robomp</title>" in resp.text
    assert "api/status" in resp.text
    assert "api/logs" in resp.text


def test_api_status_reports_runtime_counts_and_inflight(settings: Settings) -> None:
    app = create_app(settings)
    with TestClient(app) as client:
        _seed_db(settings)
        resp = client.get("/api/status")
    close_database()

    assert resp.status_code == 200
    body = resp.json()

    runtime = body["runtime"]
    assert runtime["bot_login"] == "robomp-bot"
    assert runtime["repo_allowlist"] == ["octo/widget"]
    assert runtime["max_concurrency"] == settings.max_concurrency
    assert runtime["model"] == settings.model
    assert runtime["uptime_seconds"] >= 0

    counts = body["event_counts"]
    # All five buckets must be present even when zero — the UI relies on it.
    assert set(counts) == {"queued", "running", "done", "failed", "skipped"}
    assert counts["queued"] + counts["running"] == 2  # d-queued + d-running
    assert counts["skipped"] == 1
    assert counts["running"] >= 1

    running = body["running_events"]
    assert running, "expected at least one running event after claim"
    assert all(r["started_at"] for r in running)

    # No worker pool was started in TestClient lifespan? It actually is — verify
    # the inflight snapshot returns a list even when empty.
    assert isinstance(body["inflight"], list)

    issues = {i["key"]: i for i in body["issues"]}
    fix_key = issue_key("octo/widget", 3)
    assert fix_key in issues
    assert issues[fix_key]["classification"] == "bug"
    assert issues[fix_key]["pr_number"] == 42
    assert issues[fix_key]["branch"] == "farm/abc12345/fix"

    delivery_ids = {e["delivery_id"] for e in body["recent_events"]}
    assert {"d-queued", "d-skipped", "d-running"}.issubset(delivery_ids)


def test_api_logs_returns_empty_when_file_missing(settings: Settings) -> None:
    app = create_app(settings)
    with TestClient(app) as client:
        resp = client.get("/api/logs?limit=10")
    close_database()
    assert resp.status_code == 200
    body = resp.json()
    assert body == {"entries": [], "count": 0, "limit": 10}


def test_api_logs_tails_jsonl_file(settings: Settings) -> None:
    log_path = settings.log_dir / "robomp.log.jsonl"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    payloads = [
        {"ts": "2026-05-14T21:28:28Z", "level": "INFO", "logger": "robomp.queue", "msg": "dispatch loop online"},
        {"ts": "2026-05-14T21:28:54Z", "level": "INFO", "logger": "robomp.server", "msg": "skip",
         "event": "issues", "reason": "issues.labeled ignored"},
        {"ts": "2026-05-14T21:30:00Z", "level": "WARNING", "logger": "robomp.queue", "msg": "tool_end",
         "ok": False},
    ]
    log_path.write_text("\n".join(json.dumps(p) for p in payloads) + "\n", encoding="utf-8")

    app = create_app(settings)
    with TestClient(app) as client:
        resp = client.get("/api/logs?limit=2")
    close_database()

    assert resp.status_code == 200
    body = resp.json()
    assert body["count"] == 2
    assert body["limit"] == 2
    # Oldest of the requested window first.
    assert body["entries"][0]["msg"] == "skip"
    assert body["entries"][1]["msg"] == "tool_end"
    assert body["entries"][1]["level"] == "WARNING"


def test_api_logs_limit_is_clamped(settings: Settings) -> None:
    app = create_app(settings)
    with TestClient(app) as client:
        too_low = client.get("/api/logs?limit=0").json()
        too_high = client.get("/api/logs?limit=99999").json()
    close_database()
    assert too_low["limit"] == 1
    assert too_high["limit"] == 2000


def test_tail_jsonl_recovers_from_garbage_lines(tmp_path: Path) -> None:
    path = tmp_path / "noisy.jsonl"
    path.write_text(
        json.dumps({"ts": "a", "level": "INFO", "msg": "ok"}) + "\n"
        "{not json}\n"
        + json.dumps({"ts": "b", "level": "ERROR", "msg": "bang"}) + "\n",
        encoding="utf-8",
    )
    rows = tail_jsonl(path, limit=10)
    assert len(rows) == 3
    assert rows[0]["msg"] == "ok"
    assert rows[1]["level"] == "RAW"
    assert rows[1]["msg"] == "{not json}"
    assert rows[2]["level"] == "ERROR"


# ---------- manual_triage helpers ----------


def test_parse_issue_ref_accepts_owner_repo_hash_number() -> None:
    assert parse_issue_ref("octo/widget#42") == ("octo/widget", 42)
    assert parse_issue_ref("  octo/widget#42  ") == ("octo/widget", 42)


def test_parse_issue_ref_rejects_garbage() -> None:
    for bad in ("widget#1", "octo/widget", "octo/widget#abc", "octo widget#1", ""):
        with pytest.raises(InvalidIssueRef):
            parse_issue_ref(bad)


# ---------- /api/trigger ----------


def _enable_replay(monkeypatch: pytest.MonkeyPatch) -> str:
    token = "trigger-secret"
    monkeypatch.setenv("ROBOMP_REPLAY_TOKEN", token)
    reset_settings_cache()
    return token


def _install_github_mock(app, transport: httpx.MockTransport) -> None:
    """Replace the real GitHub client with one wired to a MockTransport."""
    app.state.bag["github"] = GitHubClient("token", transport=transport)


def test_trigger_returns_404_when_token_disabled(settings: Settings) -> None:
    app = create_app(settings)
    with TestClient(app) as client:
        resp = client.post("/api/trigger", json={"mode": "triage", "issue": "octo/widget#1"})
    close_database()
    assert resp.status_code == 404
    assert "trigger disabled" in resp.json()["detail"]


def test_trigger_rejects_missing_token(env, monkeypatch: pytest.MonkeyPatch) -> None:
    _enable_replay(monkeypatch)
    cfg = Settings()  # type: ignore[call-arg]
    cfg.ensure_paths()
    app = create_app(cfg)
    with TestClient(app) as client:
        resp = client.post("/api/trigger", json={"mode": "triage", "issue": "octo/widget#1"})
    close_database()
    assert resp.status_code == 401


def test_trigger_triage_fetches_and_enqueues(env, monkeypatch: pytest.MonkeyPatch) -> None:
    token = _enable_replay(monkeypatch)
    cfg = Settings()  # type: ignore[call-arg]
    cfg.ensure_paths()

    captured: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request.url.path)
        if request.url.path.endswith("/issues/7"):
            return httpx.Response(200, json={
                "number": 7, "title": "boom", "body": "details here",
                "state": "open", "user": {"login": "alice"},
                "labels": [{"name": "bug"}],
            })
        if request.url.path.endswith("/repos/octo/widget"):
            return httpx.Response(200, json={
                "full_name": "octo/widget", "default_branch": "main",
                "clone_url": "https://github.com/octo/widget.git", "private": False,
            })
        return httpx.Response(404)

    app = create_app(cfg)
    with TestClient(app) as client:
        _install_github_mock(app, httpx.MockTransport(handler))
        resp = client.post(
            "/api/trigger",
            json={"mode": "triage", "issue": "octo/widget#7"},
            headers={"X-Robomp-Replay-Token": token},
        )
    close_database()

    assert resp.status_code == 202, resp.text
    body = resp.json()
    assert body["mode"] == "triage"
    assert body["state"] == "queued"
    assert body["delivery"] == "manual-octo__widget-7"
    # Both endpoints should have been hit on GitHub.
    assert any(p.endswith("/issues/7") for p in captured)
    assert any(p.endswith("/repos/octo/widget") for p in captured)


def test_trigger_triage_rejects_repo_not_in_allowlist(env, monkeypatch: pytest.MonkeyPatch) -> None:
    token = _enable_replay(monkeypatch)
    cfg = Settings()  # type: ignore[call-arg]
    cfg.ensure_paths()
    app = create_app(cfg)
    with TestClient(app) as client:
        _install_github_mock(app, httpx.MockTransport(lambda r: httpx.Response(500)))
        resp = client.post(
            "/api/trigger",
            json={"mode": "triage", "issue": "evil/repo#1"},
            headers={"X-Robomp-Replay-Token": token},
        )
    close_database()
    assert resp.status_code == 403
    assert "ROBOMP_REPO_ALLOWLIST" in resp.json()["detail"]


def test_trigger_triage_surfaces_github_failure(env, monkeypatch: pytest.MonkeyPatch) -> None:
    token = _enable_replay(monkeypatch)
    cfg = Settings()  # type: ignore[call-arg]
    cfg.ensure_paths()
    transport = httpx.MockTransport(lambda r: httpx.Response(404, json={"message": "Not Found"}))
    app = create_app(cfg)
    with TestClient(app) as client:
        _install_github_mock(app, transport)
        resp = client.post(
            "/api/trigger",
            json={"mode": "triage", "issue": "octo/widget#999"},
            headers={"X-Robomp-Replay-Token": token},
        )
    close_database()
    assert resp.status_code == 502
    assert "github error" in resp.json()["detail"]


def test_trigger_retry_by_delivery_id_requeues(env, monkeypatch: pytest.MonkeyPatch) -> None:
    token = _enable_replay(monkeypatch)
    cfg = Settings()  # type: ignore[call-arg]
    cfg.ensure_paths()
    app = create_app(cfg)
    with TestClient(app) as client:
        db = get_database(cfg.sqlite_path)
        db.record_event(
            delivery_id="d-old", event_type="issues", repo="octo/widget",
            issue_key=issue_key("octo/widget", 4),
            payload={"action": "opened", "issue": {"number": 4}}, state="failed",
        )
        resp = client.post(
            "/api/trigger",
            json={"mode": "retry", "delivery_id": "d-old"},
            headers={"X-Robomp-Replay-Token": token},
        )
        assert resp.status_code == 202
        assert get_database(cfg.sqlite_path).get_event("d-old").state == "queued"
    close_database()


def test_trigger_retry_by_issue_finds_latest_event(env, monkeypatch: pytest.MonkeyPatch) -> None:
    token = _enable_replay(monkeypatch)
    cfg = Settings()  # type: ignore[call-arg]
    cfg.ensure_paths()
    app = create_app(cfg)
    with TestClient(app) as client:
        db = get_database(cfg.sqlite_path)
        key = issue_key("octo/widget", 9)
        db.record_event(delivery_id="d-old-1", event_type="issues", repo="octo/widget",
                        issue_key=key, payload={"a": 1}, state="failed")
        db.record_event(delivery_id="d-old-2", event_type="issue_comment", repo="octo/widget",
                        issue_key=key, payload={"a": 2}, state="done")
        resp = client.post(
            "/api/trigger",
            json={"mode": "retry", "issue": "octo/widget#9"},
            headers={"X-Robomp-Replay-Token": token},
        )
        body = resp.json()
        assert resp.status_code == 202, body
        # Most recently-received row wins.
        assert body["delivery"] == "d-old-2"
        assert get_database(cfg.sqlite_path).get_event("d-old-2").state == "queued"
    close_database()


def test_trigger_retry_unknown_delivery_404s(env, monkeypatch: pytest.MonkeyPatch) -> None:
    token = _enable_replay(monkeypatch)
    cfg = Settings()  # type: ignore[call-arg]
    cfg.ensure_paths()
    app = create_app(cfg)
    with TestClient(app) as client:
        resp = client.post(
            "/api/trigger",
            json={"mode": "retry", "delivery_id": "nope"},
            headers={"X-Robomp-Replay-Token": token},
        )
    close_database()
    assert resp.status_code == 404


def test_trigger_rejects_bad_mode(env, monkeypatch: pytest.MonkeyPatch) -> None:
    token = _enable_replay(monkeypatch)
    cfg = Settings()  # type: ignore[call-arg]
    cfg.ensure_paths()
    app = create_app(cfg)
    with TestClient(app) as client:
        resp = client.post(
            "/api/trigger",
            json={"mode": "explode"},
            headers={"X-Robomp-Replay-Token": token},
        )
    close_database()
    assert resp.status_code == 400


# -------- /webhook/github rate-limiting --------------------------------

def _signed_headers(secret: str, body: bytes, *, event: str, delivery: str) -> dict[str, str]:
    sig = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return {
        "X-GitHub-Event": event,
        "X-GitHub-Delivery": delivery,
        "X-Hub-Signature-256": f"sha256={sig}",
        "Content-Type": "application/json",
    }


def _post_issue_opened(
    client: TestClient,
    *,
    delivery: str,
    user: str,
    number: int,
    association: str = "NONE",
    secret: str = "test-webhook-secret",
):
    payload = {
        "action": "opened",
        "issue": {
            "number": number,
            "user": {"login": user},
            "author_association": association,
        },
        "repository": {"full_name": "octo/widget"},
    }
    body = json.dumps(payload).encode()
    return client.post(
        "/webhook/github",
        content=body,
        headers=_signed_headers(secret, body, event="issues", delivery=delivery),
    )


@pytest.fixture
def rate_limited_settings(monkeypatch: pytest.MonkeyPatch, env: dict[str, str]) -> Settings:
    monkeypatch.setenv("ROBOMP_RATE_LIMIT_DEFAULT", "2")
    monkeypatch.setenv("ROBOMP_RATE_LIMIT_CONTRIBUTOR", "4")
    monkeypatch.setenv("ROBOMP_RATE_LIMIT_WINDOW_SECONDS", "3600")
    monkeypatch.setenv("ROBOMP_RATE_LIMIT_UNLIMITED", "can1357")
    cfg = Settings()  # type: ignore[call-arg]
    cfg.ensure_paths()
    return cfg


def test_webhook_rate_limits_unknown_submitter_at_default_cap(rate_limited_settings: Settings) -> None:
    app = create_app(rate_limited_settings)
    with TestClient(app) as client:
        # Default cap is 2 → first two queued, third throttled.
        states = []
        for i in range(3):
            resp = _post_issue_opened(
                client, delivery=f"d-{i}", user="stranger", number=100 + i,
                association="NONE",
            )
            assert resp.status_code == 202
            states.append(resp.json()["state"])
    close_database()
    assert states == ["queued", "queued", "skipped"]


def test_webhook_contributor_gets_higher_cap(rate_limited_settings: Settings) -> None:
    app = create_app(rate_limited_settings)
    with TestClient(app) as client:
        # Default cap (2) would block at i=2; CONTRIBUTOR cap (4) allows it.
        for i in range(4):
            resp = _post_issue_opened(
                client, delivery=f"c-{i}", user="bob", number=200 + i,
                association="CONTRIBUTOR",
            )
            assert resp.status_code == 202
            assert resp.json()["state"] == "queued", i
        resp = _post_issue_opened(
            client, delivery="c-x", user="bob", number=299,
            association="CONTRIBUTOR",
        )
        assert resp.json()["state"] == "skipped"
    close_database()


def test_webhook_owner_association_bypasses_limit(rate_limited_settings: Settings) -> None:
    app = create_app(rate_limited_settings)
    with TestClient(app) as client:
        for i in range(5):  # well over default cap
            resp = _post_issue_opened(
                client, delivery=f"o-{i}", user="acme-staff", number=300 + i,
                association="OWNER",
            )
            assert resp.json()["state"] == "queued", i
    close_database()


def test_webhook_unlimited_allowlist_bypasses_limit(rate_limited_settings: Settings) -> None:
    app = create_app(rate_limited_settings)
    with TestClient(app) as client:
        # NONE association would normally cap at 2, but `can1357` is whitelisted.
        for i in range(5):
            resp = _post_issue_opened(
                client, delivery=f"u-{i}", user="can1357", number=400 + i,
                association="NONE",
            )
            assert resp.json()["state"] == "queued", i
    close_database()


def test_webhook_rate_limit_per_user_is_independent(rate_limited_settings: Settings) -> None:
    """One user's cap doesn't drain another user's budget."""
    app = create_app(rate_limited_settings)
    with TestClient(app) as client:
        # alice exhausts default cap.
        for i in range(2):
            assert _post_issue_opened(
                client, delivery=f"a-{i}", user="alice", number=500 + i,
                association="NONE",
            ).json()["state"] == "queued"
        # alice's next attempt is skipped.
        assert _post_issue_opened(
            client, delivery="a-x", user="alice", number=599,
            association="NONE",
        ).json()["state"] == "skipped"
        # bob is untouched.
        for i in range(2):
            assert _post_issue_opened(
                client, delivery=f"b-{i}", user="bob", number=600 + i,
                association="NONE",
            ).json()["state"] == "queued"
    close_database()


def test_webhook_rate_limited_event_records_reason(rate_limited_settings: Settings) -> None:
    """Throttled events must surface a useful reason on the dashboard feed."""
    app = create_app(rate_limited_settings)
    with TestClient(app) as client:
        for i in range(3):
            _post_issue_opened(
                client, delivery=f"r-{i}", user="charlie", number=700 + i,
                association="NONE",
            )
        db = get_database(rate_limited_settings.sqlite_path)
        skipped = db.get_event("r-2")
    close_database()
    assert skipped is not None
    assert skipped.state == "skipped"
    assert skipped.last_error is not None
    assert "rate limit" in skipped.last_error
    assert "@charlie" in skipped.last_error


# ---------- /api/github/issues ----------


def _allowlist(monkeypatch: pytest.MonkeyPatch, repos: str) -> None:
    monkeypatch.setenv("ROBOMP_REPO_ALLOWLIST", repos)
    reset_settings_cache()


def _make_issues_handler(by_repo: dict[str, list[dict]]) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        for repo, items in by_repo.items():
            if path == f"/repos/{repo}/issues":
                return httpx.Response(200, json=items)
        return httpx.Response(404, json={"message": "not found"})
    return httpx.MockTransport(handler)


def test_browse_returns_404_without_token(settings: Settings) -> None:
    app = create_app(settings)
    with TestClient(app) as client:
        resp = client.get("/api/github/issues")
    close_database()
    assert resp.status_code == 404


def test_browse_fans_out_across_allowlist_and_filters_prs(
    env, monkeypatch: pytest.MonkeyPatch
) -> None:
    token = _enable_replay(monkeypatch)
    _allowlist(monkeypatch, "octo/widget,octo/gadget")
    cfg = Settings()  # type: ignore[call-arg]
    cfg.ensure_paths()
    transport = _make_issues_handler({
        "octo/widget": [
            {"number": 7, "title": "newest", "state": "open",
             "user": {"login": "alice"}, "labels": [{"name": "bug"}],
             "comments": 3, "updated_at": "2026-05-14T10:00:00Z",
             "created_at": "2026-05-01T10:00:00Z",
             "html_url": "https://github.com/octo/widget/issues/7"},
            {"number": 8, "title": "a PR not an issue", "state": "open",
             "user": {"login": "bob"}, "labels": [], "comments": 0,
             "updated_at": "2026-05-14T11:00:00Z",
             "created_at": "2026-05-14T11:00:00Z",
             "html_url": "https://github.com/octo/widget/pull/8",
             "pull_request": {"url": "..."}},  # GitHub /issues returns these too
        ],
        "octo/gadget": [
            {"number": 2, "title": "older", "state": "open",
             "user": {"login": "carol"}, "labels": [], "comments": 1,
             "updated_at": "2026-05-12T09:00:00Z",
             "created_at": "2026-05-12T09:00:00Z",
             "html_url": "https://github.com/octo/gadget/issues/2"},
        ],
    })
    app = create_app(cfg)
    with TestClient(app) as client:
        _install_github_mock(app, transport)
        resp = client.get(
            "/api/github/issues?state=open&limit=20",
            headers={"X-Robomp-Replay-Token": token},
        )
    close_database()

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["repos"] == ["octo/gadget", "octo/widget"]
    assert body["errors"] == []
    # PR row dropped; issues sorted newest-updated first.
    titles = [(i["repo"], i["number"]) for i in body["issues"]]
    assert titles == [("octo/widget", 7), ("octo/gadget", 2)]
    first = body["issues"][0]
    assert first["author"] == "alice"
    assert first["labels"] == ["bug"]
    assert first["comments"] == 3
    assert first["html_url"].endswith("/issues/7")


def test_browse_per_repo_failure_does_not_take_down_panel(
    env, monkeypatch: pytest.MonkeyPatch
) -> None:
    token = _enable_replay(monkeypatch)
    _allowlist(monkeypatch, "octo/widget,octo/dead")
    cfg = Settings()  # type: ignore[call-arg]
    cfg.ensure_paths()

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/repos/octo/widget/issues":
            return httpx.Response(200, json=[
                {"number": 1, "title": "ok", "state": "open",
                 "user": {"login": "u"}, "labels": [], "comments": 0,
                 "updated_at": "2026-05-14T00:00:00Z",
                 "created_at": "2026-05-14T00:00:00Z",
                 "html_url": "https://github.com/octo/widget/issues/1"},
            ])
        return httpx.Response(500, json={"message": "boom"})

    app = create_app(cfg)
    with TestClient(app) as client:
        _install_github_mock(app, httpx.MockTransport(handler))
        resp = client.get(
            "/api/github/issues",
            headers={"X-Robomp-Replay-Token": token},
        )
    close_database()

    assert resp.status_code == 200
    body = resp.json()
    assert len(body["issues"]) == 1
    assert body["issues"][0]["repo"] == "octo/widget"
    assert len(body["errors"]) == 1
    assert body["errors"][0]["repo"] == "octo/dead"


def test_browse_rejects_bad_state(env, monkeypatch: pytest.MonkeyPatch) -> None:
    token = _enable_replay(monkeypatch)
    cfg = Settings()  # type: ignore[call-arg]
    cfg.ensure_paths()
    app = create_app(cfg)
    with TestClient(app) as client:
        _install_github_mock(app, httpx.MockTransport(lambda r: httpx.Response(500)))
        resp = client.get(
            "/api/github/issues?state=garbage",
            headers={"X-Robomp-Replay-Token": token},
        )
    close_database()
    assert resp.status_code == 400
