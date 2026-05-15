from __future__ import annotations

import os
import signal
import stat
import subprocess
from pathlib import Path

import pytest

from robomp.git_ops import GitCommandError
from robomp.sandbox import (
    SandboxManager,
    Workspace,
    _chown_workspace,
    _prepare_slot_tmpdir,
    _reap_slot,
    _share_git_metadata_with_slots,
    _slot_pids,
    make_branch,
    rename_workspace_branch,
    workspace_key,
)


def _git(args: list[str], cwd: Path) -> None:
    subprocess.run(["git", *args], cwd=str(cwd), check=True, capture_output=True, text=True)


def _workspace(root: Path) -> Workspace:
    return Workspace(
        root=root,
        repo_dir=root / "repo",
        session_dir=root / ".omp-session",
        context_dir=root / "context",
        artifacts_dir=root / "artifacts",
        branch="farm/test/topic",
        repo_full_name="octo/widget",
        issue_number=1,
    )


@pytest.fixture
def upstream_repo(tmp_path: Path) -> Path:
    """Create a local --bare-ish remote with one commit on main."""
    repo = tmp_path / "upstream.git"
    repo.mkdir()
    _git(["init", "--initial-branch=main", "--bare", str(repo)], cwd=tmp_path)
    seed = tmp_path / "seed"
    seed.mkdir()
    _git(["init", "--initial-branch=main", str(seed)], cwd=tmp_path)
    (seed / "README.md").write_text("hello\n", encoding="utf-8")
    _git(["-C", str(seed), "add", "."], cwd=tmp_path)
    env = os.environ | {
        "GIT_AUTHOR_NAME": "t",
        "GIT_AUTHOR_EMAIL": "t@t",
        "GIT_COMMITTER_NAME": "t",
        "GIT_COMMITTER_EMAIL": "t@t",
    }
    subprocess.run(
        ["git", "commit", "-m", "init"],
        cwd=str(seed),
        check=True,
        capture_output=True,
        text=True,
        env=env,
    )
    _git(["-C", str(seed), "remote", "add", "origin", str(repo)], cwd=tmp_path)
    _git(["-C", str(seed), "push", "origin", "main"], cwd=tmp_path)
    return repo


def test_workspace_key_and_branch_shape() -> None:
    assert workspace_key("oven-sh/bun", 30654) == "oven-sh__bun__30654"
    branch = make_branch(issue_number=30654, title="JSON.parse crashes on BOM", seed="oven-sh/bun#30654")
    assert branch.startswith("farm/")
    parts = branch.split("/")
    assert len(parts) == 3 and len(parts[1]) == 8
    assert "json-parse-crashes" in parts[2]


def _init_worktree_repo(repo_dir: Path, branch: str) -> None:
    """Stand up a minimal local git repo with `branch` checked out."""
    repo_dir.mkdir(parents=True, exist_ok=True)
    _git(["init", f"--initial-branch={branch}", str(repo_dir)], cwd=repo_dir.parent)
    (repo_dir / "README.md").write_text("hello\n", encoding="utf-8")
    _git(["-C", str(repo_dir), "add", "."], cwd=repo_dir.parent)
    subprocess.run(
        ["git", "commit", "-m", "init"],
        cwd=str(repo_dir),
        check=True,
        capture_output=True,
        text=True,
        env=os.environ
        | {
            "GIT_AUTHOR_NAME": "t",
            "GIT_AUTHOR_EMAIL": "t@t",
            "GIT_COMMITTER_NAME": "t",
            "GIT_COMMITTER_EMAIL": "t@t",
        },
    )


def test_rename_workspace_branch_renames_local_branch(tmp_path: Path) -> None:
    root = tmp_path / "ws"
    repo_dir = root / "repo"
    initial = "farm/abc12345/some-issue"
    _init_worktree_repo(repo_dir, initial)
    ws = Workspace(
        root=root,
        repo_dir=repo_dir,
        session_dir=root / ".omp-session",
        context_dir=root / "context",
        artifacts_dir=root / "artifacts",
        branch=initial,
        repo_full_name="octo/widget",
        issue_number=1,
    )
    new_branch = rename_workspace_branch(ws, "fix-json-bom")
    assert new_branch == "farm/abc12345/fix-json-bom"
    assert ws.branch == "farm/abc12345/fix-json-bom"
    head = subprocess.run(
        ["git", "symbolic-ref", "HEAD"],
        cwd=str(repo_dir),
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    assert head == "refs/heads/farm/abc12345/fix-json-bom"


def test_rename_workspace_branch_is_idempotent_when_slug_unchanged(tmp_path: Path) -> None:
    root = tmp_path / "ws"
    repo_dir = root / "repo"
    initial = "farm/abc12345/keep-me"
    _init_worktree_repo(repo_dir, initial)
    ws = Workspace(
        root=root,
        repo_dir=repo_dir,
        session_dir=root / ".omp-session",
        context_dir=root / "context",
        artifacts_dir=root / "artifacts",
        branch=initial,
        repo_full_name="octo/widget",
        issue_number=1,
    )
    # No git operation should run; nothing to rename. We assert that by
    # passing a non-existent repo_dir — the helper must not touch git.
    ws.repo_dir = tmp_path / "does-not-exist"
    out = rename_workspace_branch(ws, "keep-me")
    assert out == initial
    assert ws.branch == initial


@pytest.mark.parametrize(
    "bad",
    [
        "",
        "Has-Caps",
        "-leading",
        "trailing-",
        "double--hyphen",
        "has/slash",
        "has_underscore",
        "a" * 51,
        None,
        123,
    ],
)
def test_rename_workspace_branch_rejects_bad_slug(tmp_path: Path, bad: object) -> None:
    ws = _workspace(tmp_path / "ws")
    with pytest.raises(ValueError):
        rename_workspace_branch(ws, bad)  # type: ignore[arg-type]


def test_rename_workspace_branch_rejects_non_farm_branch(tmp_path: Path) -> None:
    ws = _workspace(tmp_path / "ws")
    ws.branch = "main"
    with pytest.raises(ValueError):
        rename_workspace_branch(ws, "ok-slug")


def test_rename_workspace_branch_surfaces_git_failure(tmp_path: Path) -> None:
    root = tmp_path / "ws"
    repo_dir = root / "repo"
    initial = "farm/abc12345/old"
    _init_worktree_repo(repo_dir, initial)
    # Create a second branch that collides with the rename target.
    _git(["-C", str(repo_dir), "branch", "farm/abc12345/new"], cwd=repo_dir.parent)
    ws = Workspace(
        root=root,
        repo_dir=repo_dir,
        session_dir=root / ".omp-session",
        context_dir=root / "context",
        artifacts_dir=root / "artifacts",
        branch=initial,
        repo_full_name="octo/widget",
        issue_number=1,
    )
    with pytest.raises(GitCommandError):
        rename_workspace_branch(ws, "new")
    # Original branch must remain on failure.
    assert ws.branch == initial


def test_ensure_workspace_creates_worktree(tmp_path: Path, upstream_repo: Path) -> None:
    mgr = SandboxManager(tmp_path / "workspaces")
    ws = mgr.ensure_workspace(
        repo="octo/widget",
        number=42,
        title="something is wrong",
        clone_url=str(upstream_repo),
        default_branch="main",
        author_name="robomp-bot",
        author_email="robomp-bot@example.invalid",
    )
    assert ws.repo_dir.is_dir()
    assert (ws.repo_dir / "README.md").read_text() == "hello\n"
    # Branch is checked out.
    result = subprocess.run(
        ["git", "-C", str(ws.repo_dir), "rev-parse", "--abbrev-ref", "HEAD"],
        capture_output=True,
        text=True,
        check=True,
    )
    assert result.stdout.strip() == ws.branch
    assert ws.branch.startswith("farm/")
    # Session and context dirs exist.
    assert ws.session_dir.is_dir()
    assert ws.context_dir.is_dir()
    assert ws.repro_dir.is_dir()
    assert ws.artifacts_dir.is_dir()


def test_chown_workspace_noops_when_not_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[list[str], bool]] = []

    monkeypatch.setattr("robomp.sandbox.platform.system", lambda: "Linux")
    monkeypatch.setattr("robomp.sandbox.os.geteuid", lambda: 1000)
    monkeypatch.setattr(
        "robomp.sandbox.subprocess.run",
        lambda cmd, *, check: calls.append((cmd, check)),
    )

    _chown_workspace(tmp_path, 2001)

    assert calls == []


def test_chown_workspace_noops_off_linux(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[list[str], bool]] = []

    monkeypatch.setattr("robomp.sandbox.platform.system", lambda: "Darwin")
    monkeypatch.setattr("robomp.sandbox.os.geteuid", lambda: 0)
    monkeypatch.setattr(
        "robomp.sandbox.subprocess.run",
        lambda cmd, *, check: calls.append((cmd, check)),
    )

    _chown_workspace(tmp_path, 2001)

    assert calls == []


def test_chown_workspace_runs_chown_and_chmod_as_root_on_linux(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[list[str], bool]] = []

    monkeypatch.setattr("robomp.sandbox.platform.system", lambda: "Linux")
    monkeypatch.setattr("robomp.sandbox.os.geteuid", lambda: 0)
    monkeypatch.setattr(
        "robomp.sandbox.subprocess.run",
        lambda cmd, *, check: calls.append((cmd, check)),
    )

    _chown_workspace(tmp_path, 2001)

    # 2001 is the slot-private GID matching the slot UID, not the shared omp group.
    assert calls == [
        (["chown", "-R", "0:2001", str(tmp_path)], True),
        (["chmod", "-R", "u=rwX,g=rwX,o=", str(tmp_path)], True),
    ]


def test_slot_pids_reads_proc_status_and_skips_zombies(tmp_path: Path) -> None:
    nonnumeric = tmp_path / "self"
    nonnumeric.mkdir()

    live = tmp_path / "123"
    live.mkdir()
    (live / "status").write_text(
        "Name:\tomp\nState:\tS (sleeping)\nUid:\t0\t2001\t2001\t2001\n",
        encoding="utf-8",
    )

    zombie = tmp_path / "124"
    zombie.mkdir()
    (zombie / "status").write_text(
        "Name:\tomp\nState:\tZ (zombie)\nUid:\t2001\t2001\t2001\t2001\n",
        encoding="utf-8",
    )

    other = tmp_path / "125"
    other.mkdir()
    (other / "status").write_text(
        "Name:\troot\nState:\tS (sleeping)\nUid:\t0\t0\t0\t0\n",
        encoding="utf-8",
    )

    assert _slot_pids(2001, tmp_path) == (123,)


def test_reap_slot_noops_when_permissions_inactive(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[int, int]] = []

    monkeypatch.setattr("robomp.sandbox.platform.system", lambda: "Darwin")
    monkeypatch.setattr("robomp.sandbox.os.geteuid", lambda: 0)
    monkeypatch.setattr("robomp.sandbox.os.kill", lambda pid, sig: calls.append((pid, sig)))

    _reap_slot(2001)

    assert calls == []


def test_reap_slot_kills_slot_uid_on_linux_root(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[int, int]] = []

    monkeypatch.setattr("robomp.sandbox.platform.system", lambda: "Linux")
    monkeypatch.setattr("robomp.sandbox.os.geteuid", lambda: 0)
    monkeypatch.setattr("robomp.sandbox._slot_pids", lambda _uid: (111, 222))
    monkeypatch.setattr("robomp.sandbox.os.kill", lambda pid, sig: calls.append((pid, sig)))

    _reap_slot(2001)

    assert calls == [(111, signal.SIGKILL), (222, signal.SIGKILL)]


def test_prepare_slot_tmpdir_chowns_slot_and_locks_down(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    chowns: list[tuple[Path, int, int]] = []

    monkeypatch.setattr("robomp.sandbox.platform.system", lambda: "Linux")
    monkeypatch.setattr("robomp.sandbox.os.geteuid", lambda: 0)
    monkeypatch.setattr("robomp.sandbox.os.chown", lambda path, uid, gid: chowns.append((Path(path), uid, gid)))

    tmpdir = _prepare_slot_tmpdir(_workspace(tmp_path), 2001)

    assert tmpdir == tmp_path / ".omp-tmp"
    assert tmpdir.is_dir()
    assert stat.S_IMODE(tmpdir.stat().st_mode) == 0o700
    assert chowns == [(tmpdir, 2001, 2001)]


def test_prepare_slot_tmpdir_replaces_symlink_without_touching_target(tmp_path: Path) -> None:
    target = tmp_path / "target"
    target.mkdir()
    tmpdir = tmp_path / ".omp-tmp"
    tmpdir.symlink_to(target, target_is_directory=True)

    prepared = _prepare_slot_tmpdir(_workspace(tmp_path), None)

    assert prepared == tmpdir
    assert prepared.is_dir()
    assert not prepared.is_symlink()
    assert target.is_dir()


def test_share_git_metadata_keeps_pool_writable_for_retry_slot(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    repo_dir = tmp_path / "workspaces" / "octo__widget__43" / "repo"
    repo_dir.mkdir(parents=True)
    common_dir = tmp_path / "workspaces" / "_pool" / "octo__widget" / ".git"
    git_dir = common_dir / "worktrees" / "repo"
    git_dir.mkdir(parents=True)
    (repo_dir / ".git").write_text(f"gitdir: {git_dir}\n", encoding="utf-8")
    (git_dir / "commondir").write_text("../..\n", encoding="utf-8")

    object_dir = common_dir / "objects" / "ab"
    object_dir.mkdir(parents=True)
    object_file = object_dir / "object"
    object_file.write_text("object\n", encoding="utf-8")
    object_file.chmod(0o600)

    ref_dir = common_dir / "refs" / "heads"
    ref_dir.mkdir(parents=True)
    ref_file = ref_dir / "farm"
    ref_file.write_text("sha\n", encoding="utf-8")
    ref_file.chmod(0o600)

    log_dir = common_dir / "logs" / "refs" / "heads"
    log_dir.mkdir(parents=True)
    log_file = log_dir / "farm"
    log_file.write_text("sha sha bot <bot@example.invalid> commit\n", encoding="utf-8")
    log_file.chmod(0o600)

    index_file = git_dir / "index"
    index_file.write_text("index\n", encoding="utf-8")
    index_file.chmod(0o600)

    chowns: list[tuple[Path, int, int]] = []
    monkeypatch.setattr("robomp.sandbox.platform.system", lambda: "Linux")
    monkeypatch.setattr("robomp.sandbox.os.geteuid", lambda: 0)
    monkeypatch.setattr("robomp.sandbox.os.chown", lambda path, uid, gid: chowns.append((Path(path), uid, gid)))

    _share_git_metadata_with_slots(repo_dir, 2002)

    assert object_dir.stat().st_mode & stat.S_IWGRP
    assert object_dir.stat().st_mode & stat.S_ISGID
    assert object_file.stat().st_mode & stat.S_IRGRP
    assert not object_file.stat().st_mode & stat.S_IWGRP
    assert ref_file.stat().st_mode & stat.S_IWGRP
    assert log_file.stat().st_mode & stat.S_IWGRP
    assert index_file.stat().st_mode & stat.S_IWGRP
    assert (git_dir, -1, 2000) in chowns


def test_ensure_workspace_refreshes_permissions_for_retry_slot_and_session(
    tmp_path: Path, upstream_repo: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    chowns: list[tuple[Path, int | None]] = []
    shared: list[tuple[Path, int | None]] = []

    monkeypatch.setattr("robomp.sandbox._chown_workspace", lambda root, slot_uid: chowns.append((root, slot_uid)))
    monkeypatch.setattr(
        "robomp.sandbox._share_git_metadata_with_slots",
        lambda repo_dir, slot_uid: shared.append((repo_dir, slot_uid)),
    )

    mgr = SandboxManager(tmp_path / "workspaces")
    ws1 = mgr.ensure_workspace(
        repo="octo/widget",
        number=44,
        title="retry me",
        clone_url=str(upstream_repo),
        default_branch="main",
        slot_uid=2001,
        author_name="robomp-bot",
        author_email="robomp-bot@example.invalid",
    )
    transcript = ws1.session_dir / "turn.jsonl"
    transcript.write_text("{}\n", encoding="utf-8")
    ws2 = mgr.ensure_workspace(
        repo="octo/widget",
        number=44,
        title="retry me",
        clone_url=str(upstream_repo),
        default_branch="main",
        existing_branch=ws1.branch,
        slot_uid=2002,
        author_name="robomp-bot",
        author_email="robomp-bot@example.invalid",
    )

    assert ws2.repo_dir == ws1.repo_dir
    assert ws2.session_dir == ws1.session_dir
    assert transcript.is_file()
    assert ws2.branch == ws1.branch
    assert shared == [(ws1.repo_dir, 2001), (ws1.repo_dir, 2002)]
    assert chowns == [(ws1.root, 2001), (ws1.root, 2002)]


def test_ensure_workspace_invokes_slot_chown(
    tmp_path: Path, upstream_repo: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[tuple[Path, int | None]] = []

    def record_chown(ws_root: Path, slot_uid: int | None) -> None:
        calls.append((ws_root, slot_uid))

    monkeypatch.setattr("robomp.sandbox._chown_workspace", record_chown)
    mgr = SandboxManager(tmp_path / "workspaces")

    ws = mgr.ensure_workspace(
        repo="octo/widget",
        number=43,
        title="something is wrong",
        clone_url=str(upstream_repo),
        default_branch="main",
        slot_uid=2001,
        author_name="robomp-bot",
        author_email="robomp-bot@example.invalid",
    )

    assert calls == [(ws.root, 2001)]


def test_ensure_workspace_is_idempotent(tmp_path: Path, upstream_repo: Path) -> None:
    mgr = SandboxManager(tmp_path / "workspaces")
    ws1 = mgr.ensure_workspace(
        repo="octo/widget",
        number=5,
        title="t",
        clone_url=str(upstream_repo),
        default_branch="main",
        author_name="robomp-bot",
        author_email="robomp-bot@example.invalid",
    )
    ws2 = mgr.ensure_workspace(
        repo="octo/widget",
        number=5,
        title="t",
        clone_url=str(upstream_repo),
        default_branch="main",
        author_name="robomp-bot",
        author_email="robomp-bot@example.invalid",
    )
    assert ws1.repo_dir == ws2.repo_dir
    assert ws1.branch == ws2.branch


def test_remove_workspace(tmp_path: Path, upstream_repo: Path) -> None:
    mgr = SandboxManager(tmp_path / "workspaces")
    ws = mgr.ensure_workspace(
        repo="octo/widget",
        number=12,
        title="t",
        clone_url=str(upstream_repo),
        default_branch="main",
        author_name="robomp-bot",
        author_email="robomp-bot@example.invalid",
    )
    assert ws.repo_dir.exists()
    mgr.remove_workspace(repo="octo/widget", number=12)
    assert not ws.repo_dir.exists()
    assert not ws.root.exists()


def test_redact_credentials_strips_userinfo() -> None:
    from robomp.sandbox import redact_credentials

    assert (
        redact_credentials("Cloning into 'x' from https://bot:ghp_secret@github.com/o/r.git failed")
        == "Cloning into 'x' from https://***@github.com/o/r.git failed"
    )
    # Multiple URLs in one string.
    assert (
        redact_credentials("a https://x:y@example.com b https://q:z@example.org c")
        == "a https://***@example.com b https://***@example.org c"
    )
    # No-op on strings without credentials.
    assert redact_credentials("plain message") == "plain message"
    assert redact_credentials(None) == ""


def test_git_command_error_redacts_url_in_args_and_stderr(tmp_path: Path) -> None:
    """An ENOENT-style git failure on a credentialed clone URL must not echo the token."""
    import pytest as _pytest

    from robomp.sandbox import _run

    cred_url = "https://bot:ghp_abc123secret@example.invalid/o/r.git"
    with _pytest.raises(Exception) as exc:
        _run(["git", "clone", cred_url, str(tmp_path / "out")])
    text = str(exc.value)
    assert "ghp_abc123secret" not in text
    assert "bot" not in text or "https://bot:" not in text
    assert "***" in text or "example.invalid" in text


def test_ensure_workspace_rewrites_credentialed_origin(tmp_path: Path, upstream_repo: Path) -> None:
    """A pool clone created by an older deploy with `https://user:pass@…` in
    `.git/config` must have its `origin` URL rewritten to the credential-free
    URL before the next fetch — credentials NEVER persist on disk."""
    mgr = SandboxManager(tmp_path / "workspaces")
    # Pre-seed the pool by hand, simulating an older deploy: clone, then
    # rewrite `origin` to a credentialed URL pointing at the same local bare.
    pool = mgr.pool_path("octo/widget")
    pool.parent.mkdir(parents=True, exist_ok=True)
    _git(["clone", "--filter=blob:none", str(upstream_repo), str(pool)], cwd=tmp_path)
    credentialed = "https://bot:ghp_seekrit@example.invalid/octo/widget.git"
    _git(["-C", str(pool), "remote", "set-url", "origin", credentialed], cwd=tmp_path)
    config = (pool / ".git" / "config").read_text()
    assert "ghp_seekrit" in config  # sanity: precondition

    # Now resolve through ensure_workspace using the clean URL we now own.
    # The fetch step itself will fail against the bogus example.invalid host,
    # so route through a clean local URL by setting it as the canonical
    # clone_url; the remote MUST be rewritten BEFORE fetch.
    mgr.ensure_workspace(
        repo="octo/widget",
        number=7,
        title="t",
        clone_url=str(upstream_repo),
        default_branch="main",
        author_name="robomp-bot",
        author_email="robomp-bot@example.invalid",
    )
    config_after = (pool / ".git" / "config").read_text()
    assert "ghp_seekrit" not in config_after, config_after
    assert "bot:" not in config_after, config_after
    # Origin now points at the clean URL.
    url = subprocess.run(
        ["git", "-C", str(pool), "remote", "get-url", "origin"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    assert url == str(upstream_repo)


def test_push_force_with_lease_succeeds_after_local_amend(tmp_path: Path, upstream_repo: Path) -> None:
    """An agent amending an already-pushed commit (e.g. `--reset-author`) must
    still be able to push: `--force-with-lease` allows the local rewrite as
    long as origin still matches what we last fetched."""
    from robomp.git_ops import push as git_push

    # Clone, make a commit, push, then amend and push again.
    work = tmp_path / "work"
    _git(["clone", str(upstream_repo), str(work)], cwd=tmp_path)
    _git(["-C", str(work), "config", "user.email", "t@t"], cwd=tmp_path)
    _git(["-C", str(work), "config", "user.name", "t"], cwd=tmp_path)
    _git(["-C", str(work), "checkout", "-b", "farm/abc/topic"], cwd=tmp_path)
    (work / "x.txt").write_text("a\n")
    _git(["-C", str(work), "add", "x.txt"], cwd=tmp_path)
    _git(["-C", str(work), "commit", "-m", "initial"], cwd=tmp_path)
    git_push(work, branch="farm/abc/topic", expected_head=None, token=None)

    # Amend (rewrites the SHA at origin/farm/abc/topic).
    (work / "x.txt").write_text("a-amended\n")
    _git(["-C", str(work), "add", "x.txt"], cwd=tmp_path)
    _git(["-C", str(work), "commit", "--amend", "--no-edit"], cwd=tmp_path)
    amended = subprocess.run(
        ["git", "-C", str(work), "rev-parse", "HEAD"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    result = git_push(work, branch="farm/abc/topic", expected_head=None, token=None)
    assert result.head == amended

    # Origin's branch ref now matches the amended SHA.
    on_origin = subprocess.run(
        ["git", "-C", str(upstream_repo), "rev-parse", "refs/heads/farm/abc/topic"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    assert on_origin == amended


def test_push_force_with_lease_refuses_when_origin_moved(tmp_path: Path, upstream_repo: Path) -> None:
    """If origin's branch ref has been moved by some other writer between our
    last fetch and this push, the lease MUST refuse — even though we're
    force-pushing."""
    from robomp.git_ops import GitCommandError
    from robomp.git_ops import push as git_push

    work = tmp_path / "work"
    _git(["clone", str(upstream_repo), str(work)], cwd=tmp_path)
    _git(["-C", str(work), "config", "user.email", "t@t"], cwd=tmp_path)
    _git(["-C", str(work), "config", "user.name", "t"], cwd=tmp_path)
    _git(["-C", str(work), "checkout", "-b", "farm/abc/topic"], cwd=tmp_path)
    (work / "x.txt").write_text("a\n")
    _git(["-C", str(work), "add", "x.txt"], cwd=tmp_path)
    _git(["-C", str(work), "commit", "-m", "initial"], cwd=tmp_path)
    git_push(work, branch="farm/abc/topic", expected_head=None, token=None)

    # A "sneaky" second writer publishes a different SHA to the same ref on
    # origin — pushed from an independent worktree, NOT seen by `work`'s
    # remote-tracking ref.
    intruder = tmp_path / "intruder"
    _git(["clone", str(upstream_repo), str(intruder)], cwd=tmp_path)
    _git(["-C", str(intruder), "config", "user.email", "i@i"], cwd=tmp_path)
    _git(["-C", str(intruder), "config", "user.name", "i"], cwd=tmp_path)
    _git(["-C", str(intruder), "checkout", "-b", "farm/abc/topic", "origin/farm/abc/topic"], cwd=tmp_path)
    (intruder / "x.txt").write_text("from-intruder\n")
    _git(["-C", str(intruder), "add", "x.txt"], cwd=tmp_path)
    _git(["-C", str(intruder), "commit", "--amend", "--no-edit"], cwd=tmp_path)
    _git(["-C", str(intruder), "push", "--force", "origin", "farm/abc/topic"], cwd=tmp_path)

    # Now `work` tries to push another amended commit. The lease pins the
    # expected origin SHA to whatever `work`'s remote-tracking ref still
    # records — which is now stale — so origin's actual SHA differs and the
    # push must be refused.
    (work / "x.txt").write_text("from-us\n")
    _git(["-C", str(work), "add", "x.txt"], cwd=tmp_path)
    _git(["-C", str(work), "commit", "--amend", "--no-edit"], cwd=tmp_path)
    with pytest.raises(GitCommandError) as exc:
        git_push(work, branch="farm/abc/topic", expected_head=None, token=None)
    assert (
        "stale info" in (exc.value.stderr + exc.value.stdout).lower()
        or "rejected" in (exc.value.stderr + exc.value.stdout).lower()
    )


def test_run_git_kills_hung_child(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A `git` invocation that hangs past the timeout must be killed and
    raised as `GitCommandError(124)` rather than pinning the calling
    thread. The proxy already bounds the async caller via
    `asyncio.wait_for`, but the OS process only goes away because of this
    timeout."""
    from robomp.git_ops import GitCommandError, _run_git

    fakebin = tmp_path / "bin"
    fakebin.mkdir()
    fake_git = fakebin / "git"
    # Use `exec /bin/sleep 30` so the kill from `subprocess.run`'s timeout
    # actually terminates the wait — `sh` with a non-exec `sleep` would
    # keep the parent alive on SIGTERM, and the absolute path means the
    # shim doesn't depend on PATH (we point PATH at fakebin so `git`
    # itself resolves to our shim).
    fake_git.write_text("#!/bin/sh\nexec /bin/sleep 30\n")
    fake_git.chmod(0o755)
    monkeypatch.setenv("PATH", str(fakebin))

    with pytest.raises(GitCommandError) as exc:
        _run_git(["status"], cwd=tmp_path, token=None, timeout=0.5)
    assert exc.value.returncode == 124
    assert "timed out" in exc.value.stderr.lower()
