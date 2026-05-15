"""Per-issue workspace lifecycle: clone pool + git worktrees.

The remote-facing git operations (clone, fetch, push) go through a pluggable
`GitTransport` so a deploy can keep the PAT entirely in a separate `gh-proxy`
container. The default `LocalGitTransport` runs git in-process with ephemeral
PAT injection via `--config-env` (see `robomp.git_ops`); the `ProxyGitTransport`
in `robomp.proxy_client` forwards the same set of operations over HMAC RPC.

Per-issue worktree add/remove stays local — those operations only touch the
shared on-disk pool clone, no remote authentication required.
"""

from __future__ import annotations

import hashlib
import logging
import os
import platform
import re
import secrets
import shutil
import signal
import stat
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from robomp.git_ops import (
    GitCommandError,
    PushResult,
    redact_credentials,
)
from robomp.git_ops import (
    clone as git_clone,
)
from robomp.git_ops import (
    fetch_prune as git_fetch_prune,
)
from robomp.git_ops import (
    fetch_ref as git_fetch_ref,
)
from robomp.git_ops import (
    push as git_push,
)

log = logging.getLogger(__name__)


@dataclass(slots=True)
class Workspace:
    """Resolved per-issue scratch space."""

    root: Path
    repo_dir: Path
    session_dir: Path
    context_dir: Path
    artifacts_dir: Path
    branch: str
    repo_full_name: str
    issue_number: int

    @property
    def repro_dir(self) -> Path:
        return self.context_dir / "repro"

    @property
    def workspace_key(self) -> str:
        return workspace_key(self.repo_full_name, self.issue_number)


def _slug(text: str, *, length: int = 40) -> str:
    cleaned = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    if not cleaned:
        cleaned = "issue"
    return cleaned[:length]


def _short_hex(seed: str | None = None) -> str:
    if seed:
        return hashlib.sha1(seed.encode("utf-8")).hexdigest()[:8]
    return secrets.token_hex(4)


def workspace_key(repo: str, number: int) -> str:
    return f"{repo.replace('/', '__')}__{number}"


def make_branch(*, issue_number: int, title: str, seed: str | None = None) -> str:
    return f"farm/{_short_hex(seed or f'{issue_number}-{title}')}/{_slug(title or f'issue-{issue_number}')}"


_BRANCH_SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def validate_branch_slug(slug: object) -> str:
    """Return ``slug`` if it is a valid kebab-case branch slug, else raise.

    Rules: 1-50 chars, only ``[a-z0-9-]``, no leading/trailing hyphen, no
    double hyphen. Raises ``ValueError`` otherwise.
    """
    if not isinstance(slug, str) or not _BRANCH_SLUG_RE.fullmatch(slug) or len(slug) > 50:
        raise ValueError(
            f"invalid branch slug {slug!r}: expected kebab-case [a-z0-9-], 1-50 chars, no leading/trailing/double hyphen"
        )
    return slug


def rename_workspace_branch(workspace: Workspace, new_slug: str) -> str:
    """Rename the workspace's local branch to ``farm/<hex>/<new_slug>``.

    The 8-hex disambiguator stays untouched; only the trailing slug after
    the second `/` changes. Runs ``git branch -m`` inside the worktree
    (which updates the shared refs in the pool) and mutates
    ``workspace.branch`` in place.

    Idempotent when the computed branch already matches ``workspace.branch``.
    Raises ``ValueError`` for syntactically invalid slugs or for a
    workspace whose branch isn't on the ``farm/<hex>/<slug>`` shape.
    Raises ``GitCommandError`` if the underlying ``git`` invocation fails
    (e.g. the target branch name is already taken).
    """
    validate_branch_slug(new_slug)
    parts = workspace.branch.split("/", 2)
    if len(parts) != 3 or parts[0] != "farm" or not parts[1]:
        raise ValueError(f"refusing to rename non-farm branch {workspace.branch!r}")
    new_branch = f"farm/{parts[1]}/{new_slug}"
    if new_branch == workspace.branch:
        return new_branch
    proc = _safe_run(
        ["git", "branch", "-m", workspace.branch, new_branch],
        cwd=workspace.repo_dir,
    )
    if proc.returncode != 0:
        raise GitCommandError(
            ["git", "branch", "-m", workspace.branch, new_branch],
            proc.returncode,
            proc.stdout,
            proc.stderr,
        )
    workspace.branch = new_branch
    return new_branch


# ---------- GitTransport (transport abstraction over clone/fetch/push) ----------


class GitTransport(Protocol):
    """Pluggable remote-facing git operations.

    Two implementations ship in-tree:
    - `LocalGitTransport`: in-process git with PAT injected per invocation.
    - `robomp.proxy_client.ProxyGitTransport`: forwards over HMAC RPC.
    """

    def clone_pool(self, *, repo: str, clone_url: str, default_branch: str, target: Path) -> None:
        """Fresh clone into `target`. `target` must not exist (or be empty)."""
        ...

    def fetch_pool(self, *, repo: str, pool_dir: Path) -> None:
        """`git fetch --prune origin` against the shared pool clone."""
        ...

    def fetch_base_ref(self, *, repo: str, pool_dir: Path, ref: str) -> None:
        """Best-effort `git fetch origin <ref>` to ensure the base branch is local."""
        ...

    def push_branch(
        self,
        *,
        repo: str,
        workspace_key: str,
        repo_dir: Path,
        branch: str,
        expected_head: str,
    ) -> PushResult:
        """Push `branch` to origin. MUST refuse if HEAD has drifted from `expected_head`."""
        ...


class LocalGitTransport:
    """Default GitTransport: run git in-process with ephemeral PAT injection.

    `token` MAY be `None` for tests against a local bare repo (no auth) or in
    deploys where the orchestrator does not hold a PAT (but then the proxy
    transport should be used instead).
    """

    __slots__ = ("_token",)

    def __init__(self, token: str | None) -> None:
        self._token = token

    def clone_pool(self, *, repo: str, clone_url: str, default_branch: str, target: Path) -> None:
        del repo  # unused; URL identifies the remote
        git_clone(target, clone_url=clone_url, default_branch=default_branch, token=self._token)

    def fetch_pool(self, *, repo: str, pool_dir: Path) -> None:
        del repo
        git_fetch_prune(pool_dir, token=self._token)

    def fetch_base_ref(self, *, repo: str, pool_dir: Path, ref: str) -> None:
        del repo
        git_fetch_ref(pool_dir, ref, token=self._token)

    def push_branch(
        self,
        *,
        repo: str,
        workspace_key: str,
        repo_dir: Path,
        branch: str,
        expected_head: str,
    ) -> PushResult:
        del repo, workspace_key
        return git_push(repo_dir, branch=branch, expected_head=expected_head, token=self._token)


# ---------- low-level helpers retained for callers expecting old shape ----------


def _safe_run(cmd: list[str], *, cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    """Run without raising; caller decides on returncode. Credentials are redacted from any captured output."""
    proc = subprocess.run(
        cmd,
        cwd=str(cwd) if cwd else None,
        check=False,
        capture_output=True,
        text=True,
    )
    if proc.stdout:
        proc.stdout = redact_credentials(proc.stdout)
    if proc.stderr:
        proc.stderr = redact_credentials(proc.stderr)
    return proc


def _run(cmd: list[str], *, cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    """Legacy raising helper (still used by a sandbox test). Forwards to subprocess.run."""
    proc = subprocess.run(
        cmd,
        cwd=str(cwd) if cwd else None,
        check=False,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise GitCommandError(cmd, proc.returncode, proc.stdout, proc.stderr)
    return proc


_SHARED_OMP_GID = 2000


def _slot_permissions_active(slot_uid: int | None) -> bool:
    return slot_uid is not None and platform.system() == "Linux" and os.geteuid() == 0


def _slot_pids(slot_uid: int, proc_root: Path = Path("/proc")) -> tuple[int, ...]:
    """Return non-zombie process ids owned by the slot UID.

    Debian's slim image does not include procps/pkill. Reading `/proc` keeps
    slot cleanup self-contained and avoids adding a runtime package only for
    this one operation.
    """
    try:
        entries = tuple(proc_root.iterdir())
    except OSError as exc:
        log.warning("failed to scan %s for slot user %s: %s", proc_root, slot_uid, exc)
        return ()

    pids: list[int] = []
    for entry in entries:
        if not entry.name.isdecimal():
            continue
        try:
            status = (entry / "status").read_text(encoding="utf-8")
        except OSError:
            # The process may have exited between `iterdir` and `read_text`.
            continue

        state = ""
        uids: tuple[int, ...] = ()
        for line in status.splitlines():
            if line.startswith("State:"):
                parts = line.split(maxsplit=1)
                state = parts[1] if len(parts) == 2 else ""
            elif line.startswith("Uid:"):
                try:
                    uids = tuple(int(part) for part in line.split()[1:5])
                except ValueError:
                    uids = ()

        if state.startswith("Z"):
            continue
        if slot_uid in uids:
            pids.append(int(entry.name))
    return tuple(pids)


def _reap_slot(slot_uid: int | None) -> None:
    """Kill any processes still running as a slot UID.

    Slot UIDs are reused. A previous task's straggler process must not survive
    long enough to observe or interfere with the next task assigned to that UID.
    """
    if not _slot_permissions_active(slot_uid):
        return
    assert slot_uid is not None
    for pid in _slot_pids(slot_uid):
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            continue
        except OSError as exc:
            log.warning("failed to kill slot user %s process %s: %s", slot_uid, pid, exc)


def _prepare_slot_tmpdir(workspace: Workspace, slot_uid: int | None) -> Path:
    """Create the per-workspace temp directory used by the agent subprocess."""
    tmpdir = workspace.root / ".omp-tmp"
    try:
        st = tmpdir.lstat()
    except FileNotFoundError:
        pass
    else:
        if not stat.S_ISDIR(st.st_mode):
            tmpdir.unlink()
    tmpdir.mkdir(mode=0o700, parents=True, exist_ok=True)
    if _slot_permissions_active(slot_uid):
        assert slot_uid is not None
        os.chown(tmpdir, slot_uid, slot_uid)
    tmpdir.chmod(0o700)
    return tmpdir


def _grant_group_bits(path: Path, *, gid: int, bits: int) -> None:
    try:
        st = path.lstat()
    except FileNotFoundError:
        return
    if stat.S_ISLNK(st.st_mode):
        return
    os.chown(path, -1, gid)
    path.chmod(stat.S_IMODE(st.st_mode) | bits)


def _grant_tree(path: Path, *, gid: int, files_group_writable: bool) -> None:
    if not path.exists():
        return
    if path.is_file():
        bits = stat.S_IRGRP | (stat.S_IWGRP if files_group_writable else 0)
        _grant_group_bits(path, gid=gid, bits=bits)
        return
    for root, dirs, files in os.walk(path, followlinks=False):
        root_path = Path(root)
        _grant_group_bits(root_path, gid=gid, bits=stat.S_IRWXG | stat.S_ISGID)
        for dirname in dirs:
            _grant_group_bits(root_path / dirname, gid=gid, bits=stat.S_IRWXG | stat.S_ISGID)
        file_bits = stat.S_IRGRP | (stat.S_IWGRP if files_group_writable else 0)
        for filename in files:
            _grant_group_bits(root_path / filename, gid=gid, bits=file_bits)


def _resolve_worktree_git_dirs(repo_dir: Path) -> tuple[Path, Path] | None:
    marker = repo_dir / ".git"
    if marker.is_dir():
        return marker, marker
    try:
        text = marker.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    prefix = "gitdir:"
    if not text.startswith(prefix):
        return None
    raw_git_dir = text[len(prefix) :].strip()
    git_dir = Path(raw_git_dir)
    if not git_dir.is_absolute():
        git_dir = (repo_dir / git_dir).resolve()
    try:
        raw_common_dir = (git_dir / "commondir").read_text(encoding="utf-8").strip()
    except OSError:
        return git_dir, git_dir
    common_dir = Path(raw_common_dir)
    if not common_dir.is_absolute():
        common_dir = (git_dir / common_dir).resolve()
    return git_dir, common_dir


def _share_git_metadata_with_slots(repo_dir: Path, slot_uid: int | None) -> None:
    """Keep shared Git metadata writable by whichever slot gets the retry.

    The worktree checkout itself is slot-private, but `.git` in a Git worktree
    points back into the shared clone pool. A retry may run as a different
    `omp-N` user, so the pool-side worktree gitdir, refs, reflogs, and object
    directories must stay writable through the shared `omp` group.
    """
    if not _slot_permissions_active(slot_uid):
        return
    dirs = _resolve_worktree_git_dirs(repo_dir)
    if dirs is None:
        return
    git_dir, common_dir = dirs
    gid = _SHARED_OMP_GID
    _grant_tree(git_dir, gid=gid, files_group_writable=True)
    _grant_group_bits(common_dir, gid=gid, bits=stat.S_IRWXG | stat.S_ISGID)
    for rel, files_group_writable in (
        ("objects", False),
        ("refs", True),
        ("logs", True),
        ("worktrees", True),
    ):
        _grant_tree(common_dir / rel, gid=gid, files_group_writable=files_group_writable)
    for rel in ("config", "packed-refs", "HEAD", "FETCH_HEAD", "ORIG_HEAD"):
        _grant_tree(common_dir / rel, gid=gid, files_group_writable=True)


# slot_uid is also the slot-private GID created by entrypoint.sh. Do not use
# the shared omp group for the workspace tree; that would let every slot read
# every other slot's checkout, artifacts, context, and .omp-session. A retry may
# acquire a different slot, so we recursively hand the private workspace tree to
# the current slot before launching `omp --continue`.
def _chown_workspace(ws_root: Path, slot_uid: int | None) -> None:
    if slot_uid is None:
        return
    if platform.system() != "Linux":
        return
    if os.geteuid() != 0:
        return
    subprocess.run(["chown", "-R", f"0:{slot_uid}", str(ws_root)], check=True)
    subprocess.run(["chmod", "-R", "u=rwX,g=rwX,o=", str(ws_root)], check=True)


# ---------- SandboxManager ----------


class SandboxManager:
    """Manages a shared clone pool and per-issue worktrees.

    Remote-facing git operations are delegated to a `GitTransport`; the rest
    (worktree add/remove, identity config, directory layout) is purely local.
    """

    def __init__(self, root: Path, *, transport: GitTransport | None = None) -> None:
        self.root = root
        self.pool = root / "_pool"
        self.transport: GitTransport = transport or LocalGitTransport(token=None)
        root.mkdir(parents=True, exist_ok=True)
        self.pool.mkdir(parents=True, exist_ok=True)

    # ---- pool ----
    def pool_path(self, repo: str) -> Path:
        return self.pool / repo.replace("/", "__")

    def ensure_clone(self, *, repo: str, clone_url: str, default_branch: str) -> Path:
        """Idempotent shared clone for `repo`.

        `clone_url` MUST be a plain `https://github.com/<owner>/<repo>.git`
        (no embedded credentials). Auth is supplied per-call by the transport.
        """
        target = self.pool_path(repo)
        if (target / ".git").exists() or (target / "HEAD").exists():
            # Idempotent refresh. An older deploy may have baked a
            # credentialed `https://user:pass@github.com/...` into
            # `.git/config`; rewrite to the credential-free URL we now own
            # before fetching so the PAT never persists on disk.
            self._reset_origin_url(target, clone_url)
            self.transport.fetch_pool(repo=repo, pool_dir=target)
            return target
        target.mkdir(parents=True, exist_ok=True)
        self.transport.clone_pool(
            repo=repo,
            clone_url=clone_url,
            default_branch=default_branch,
            target=target,
        )
        return target

    @staticmethod
    def _reset_origin_url(repo_dir: Path, clone_url: str) -> None:
        """`git remote set-url origin <clone_url>` if origin exists and differs.

        Best-effort: silent no-op on failure (probe `get-url` first so we don't
        spam logs on first-time clones where origin isn't configured yet).
        """
        probe = _safe_run(["git", "remote", "get-url", "origin"], cwd=repo_dir)
        if probe.returncode != 0:
            return
        if probe.stdout.strip() == clone_url:
            return
        _safe_run(["git", "remote", "set-url", "origin", clone_url], cwd=repo_dir)

    # ---- per-issue workspace ----
    def workspace_root(self, repo: str, number: int) -> Path:
        return self.root / workspace_key(repo, number)

    def ensure_workspace(
        self,
        *,
        repo: str,
        number: int,
        title: str,
        clone_url: str,
        default_branch: str,
        existing_branch: str | None = None,
        author_name: str,
        author_email: str,
        slot_uid: int | None = None,
    ) -> Workspace:
        """Create or resume a per-issue worktree."""
        pool = self.ensure_clone(repo=repo, clone_url=clone_url, default_branch=default_branch)
        ws_root = self.workspace_root(repo, number)
        repo_dir = ws_root / "repo"
        session_dir = ws_root / ".omp-session"
        context_dir = ws_root / "context"
        artifacts_dir = ws_root / "artifacts"
        for path in (ws_root, session_dir, context_dir, context_dir / "repro", artifacts_dir):
            path.mkdir(parents=True, exist_ok=True)

        branch = existing_branch or make_branch(
            issue_number=number,
            title=title,
            seed=f"{repo}#{number}",
        )

        if not (repo_dir / ".git").exists():
            # Make sure the branch's base ref exists locally (best-effort).
            self.transport.fetch_base_ref(repo=repo, pool_dir=pool, ref=default_branch)
            # Try worktree add; if the branch already exists in the pool, reuse it.
            check = _safe_run(["git", "rev-parse", "--verify", f"refs/heads/{branch}"], cwd=pool)
            if check.returncode == 0:
                _run(["git", "worktree", "add", str(repo_dir), branch], cwd=pool)
            else:
                _run(
                    [
                        "git",
                        "worktree",
                        "add",
                        "-b",
                        branch,
                        str(repo_dir),
                        f"origin/{default_branch}",
                    ],
                    cwd=pool,
                )
        # Identity is set on the worktree's shared config; idempotent.
        _safe_run(["git", "config", "user.email", author_email], cwd=repo_dir)
        _safe_run(["git", "config", "user.name", author_name], cwd=repo_dir)
        _share_git_metadata_with_slots(repo_dir, slot_uid)
        _chown_workspace(ws_root, slot_uid)
        return Workspace(
            root=ws_root,
            repo_dir=repo_dir,
            session_dir=session_dir,
            context_dir=context_dir,
            artifacts_dir=artifacts_dir,
            branch=branch,
            repo_full_name=repo,
            issue_number=number,
        )

    def remove_workspace(self, *, repo: str, number: int) -> None:
        ws_root = self.workspace_root(repo, number)
        repo_dir = ws_root / "repo"
        if repo_dir.exists():
            pool = self.pool_path(repo)
            _safe_run(["git", "worktree", "remove", "--force", str(repo_dir)], cwd=pool)
            if repo_dir.exists():
                shutil.rmtree(repo_dir, ignore_errors=True)
        if ws_root.exists():
            shutil.rmtree(ws_root, ignore_errors=True)


__all__ = [
    "GitCommandError",
    "GitTransport",
    "LocalGitTransport",
    "SandboxManager",
    "Workspace",
    "make_branch",
    "rename_workspace_branch",
    "validate_branch_slug",
    "redact_credentials",
    "workspace_key",
]
