//! Linux overlayfs-based isolation.
//!
//! Tries to stack a kernel `overlay` filesystem at `merged` over the
//! read-only `lower` tree. The mount uses sibling `upper` and `work`
//! directories derived from `merged.parent()` so a single caller-owned base
//! directory cleans up with one `rm -rf`.
//!
//! When the kernel rejects the mount (typically `EPERM` outside a user
//! namespace, or `ENODEV` if the module is absent) we fall back to
//! `fuse-overlayfs(1)` because that is what the project shipped before and
//! existing user environments rely on it.
//!
//! Backend selection is remembered per-mount so
//! [`stop`](IsolationBackend::stop) dispatches to the correct teardown path
//! (`umount2` vs `fusermount[3] -u`).

use std::path::Path;

use async_trait::async_trait;

#[cfg(not(target_os = "linux"))]
use crate::IsoError;
use crate::{BackendKind, IsoResult, IsolationBackend, ProbeResult};

pub struct OverlayfsBackend;

pub fn backend() -> &'static dyn IsolationBackend {
	&OverlayfsBackend
}

#[async_trait]
impl IsolationBackend for OverlayfsBackend {
	fn kind(&self) -> BackendKind {
		BackendKind::Overlayfs
	}

	fn probe(&self) -> ProbeResult {
		#[cfg(target_os = "linux")]
		{
			imp::probe()
		}
		#[cfg(not(target_os = "linux"))]
		{
			ProbeResult::unavailable("overlayfs isolation is only available on Linux")
		}
	}

	fn start(&self, lower: &Path, merged: &Path) -> IsoResult<()> {
		#[cfg(target_os = "linux")]
		{
			imp::start(lower, merged)
		}
		#[cfg(not(target_os = "linux"))]
		{
			let _ = (lower, merged);
			Err(IsoError::unavailable("overlayfs isolation is only available on Linux"))
		}
	}

	fn stop(&self, merged: &Path) -> IsoResult<()> {
		#[cfg(target_os = "linux")]
		{
			imp::stop(merged)
		}
		#[cfg(not(target_os = "linux"))]
		{
			let _ = merged;
			Ok(())
		}
	}
}

#[cfg(target_os = "linux")]
mod imp {
	use std::{
		collections::BTreeMap,
		env,
		ffi::{CString, OsStr},
		fs, io,
		os::unix::{ffi::OsStrExt, fs::PermissionsExt},
		path::{Path, PathBuf},
		process::{Command, Stdio},
		sync::LazyLock,
	};

	use parking_lot::Mutex;

	use crate::{IsoError, IsoResult, ProbeResult, command_failed};

	#[derive(Clone, Copy)]
	enum MountFlavor {
		Kernel,
		Fuse,
	}

	static ACTIVE_MOUNTS: LazyLock<Mutex<BTreeMap<PathBuf, MountFlavor>>> =
		LazyLock::new(|| Mutex::new(BTreeMap::new()));

	pub fn probe() -> ProbeResult {
		if kernel_overlay_supported() {
			return ProbeResult::available();
		}
		if fuse_overlayfs_binary().is_some() {
			return ProbeResult::available();
		}
		ProbeResult::unavailable(
			"overlay filesystem unavailable: kernel `overlay` module missing and `fuse-overlayfs` \
			 not on PATH",
		)
	}

	pub fn start(lower: &Path, merged: &Path) -> IsoResult<()> {
		let lower = canonical_existing_dir(lower)?;
		let merged = absolutize(merged);
		let base = merged.parent().ok_or_else(|| {
			IsoError::other(format!("merged path has no parent: {}", merged.display()))
		})?;
		let upper = base.join("upper");
		let work = base.join("work");

		remove_dir_if_exists(&upper, "stale overlay upper")?;
		remove_dir_if_exists(&work, "stale overlay work")?;
		remove_dir_if_exists(&merged, "stale overlay merged")?;

		fs::create_dir_all(&upper)
			.map_err(|err| IsoError::other(format!("create upper dir {}: {err}", upper.display())))?;
		fs::create_dir_all(&work)
			.map_err(|err| IsoError::other(format!("create work dir {}: {err}", work.display())))?;
		fs::create_dir_all(&merged).map_err(|err| {
			IsoError::other(format!("create merged dir {}: {err}", merged.display()))
		})?;

		let opts = format!(
			"lowerdir={},upperdir={},workdir={}",
			lower.display(),
			upper.display(),
			work.display()
		);

		match kernel_mount(&merged, &opts) {
			Ok(()) => {
				ACTIVE_MOUNTS.lock().insert(merged, MountFlavor::Kernel);
				Ok(())
			},
			Err(err) if err.is_unavailable() => {
				fuse_mount(&lower, &upper, &work, &merged)?;
				ACTIVE_MOUNTS.lock().insert(merged, MountFlavor::Fuse);
				Ok(())
			},
			Err(err) => Err(err),
		}
	}

	pub fn stop(merged: &Path) -> IsoResult<()> {
		let merged = absolutize(merged);
		let result = {
			let flavor = ACTIVE_MOUNTS.lock().remove(&merged);
			match flavor {
				Some(MountFlavor::Fuse) => fuse_umount(&merged),
				Some(MountFlavor::Kernel) | None => {
					// `None` covers callers that skipped `start` (probe-style flow)
					// or processes that re-attached after a crash; try a kernel
					// umount first, fall back to fusermount so we don't silently
					// leak a mount.
					kernel_umount(&merged).or_else(|err| {
						if err.is_unavailable() {
							fuse_umount(&merged)
						} else {
							Err(err)
						}
					})
				},
			}
		};
		result?;

		if let Some(base) = merged.parent() {
			remove_dir_if_exists(&base.join("upper"), "overlay upper")?;
			remove_dir_if_exists(&base.join("work"), "overlay work")?;
		}
		remove_dir_if_exists(&merged, "overlay merged")
	}

	fn kernel_mount(merged: &Path, opts: &str) -> IsoResult<()> {
		let target = to_cstring(merged.as_os_str().as_bytes(), "merged")?;
		let source = CString::new("overlay").expect("static source");
		let fstype = CString::new("overlay").expect("static fstype");
		let opts_c = to_cstring(opts.as_bytes(), "overlay options")?;

		// SAFETY: all pointers are valid CString-backed and outlive the call.
		let rc = unsafe {
			libc::mount(
				source.as_ptr(),
				target.as_ptr(),
				fstype.as_ptr(),
				0,
				opts_c.as_ptr().cast::<libc::c_void>(),
			)
		};
		if rc == 0 {
			return Ok(());
		}
		let err = std::io::Error::last_os_error();
		let raw = err.raw_os_error();
		if matches!(
			raw,
			Some(libc::EPERM | libc::EACCES | libc::ENODEV | libc::ENOENT | libc::EINVAL)
		) {
			return Err(IsoError::unavailable(format!(
				"kernel overlay mount denied ({err}); falling back to fuse-overlayfs"
			)));
		}
		Err(IsoError::other(format!("overlay mount {}: {err}", merged.display())))
	}

	fn kernel_umount(merged: &Path) -> IsoResult<()> {
		let target = to_cstring(merged.as_os_str().as_bytes(), "merged")?;
		// SAFETY: `target` lives until after the syscall returns.
		let rc = unsafe { libc::umount2(target.as_ptr(), libc::MNT_DETACH) };
		if rc == 0 {
			return Ok(());
		}
		let err = std::io::Error::last_os_error();
		match err.raw_os_error() {
			Some(libc::EINVAL | libc::ENOENT) => {
				// Nothing mounted there — already torn down.
				Ok(())
			},
			Some(libc::EPERM | libc::EACCES) => {
				Err(IsoError::unavailable(format!("kernel umount denied: {err}")))
			},
			_ => Err(IsoError::other(format!("umount {}: {err}", merged.display()))),
		}
	}

	fn fuse_mount(lower: &Path, upper: &Path, work: &Path, merged: &Path) -> IsoResult<()> {
		// Probe PATH before spawning. Spawning a missing binary from a
		// large-VSZ parent does not necessarily report ENOENT: measured on
		// asus-kiosk 2026-09-10, a 43 GB-VSZ session under
		// `vm.overcommit_memory=0` got `Cannot allocate memory (os error
		// 12)` in ~270 ms, masking the "not found" that would otherwise
		// have triggered the fallback chain.
		let binary = fuse_overlayfs_binary().ok_or_else(|| {
			IsoError::unavailable(
				"fuse-overlayfs not found on PATH; install it to enable overlay isolation",
			)
		})?;
		let opts = format!(
			"lowerdir={},upperdir={},workdir={}",
			lower.display(),
			upper.display(),
			work.display()
		);
		let output = Command::new(&binary)
			.args(["-o", &opts])
			.arg(merged)
			.stdin(Stdio::null())
			.stdout(Stdio::piped())
			.stderr(Stdio::piped())
			.output();
		let output = match output {
			Ok(out) => out,
			// Any spawn failure means this backend cannot run here — the host
			// may be out of address space (ENOMEM), out of pids (EAGAIN), or
			// the binary may have vanished after the PATH probe. None of those
			// is a task failure: report unavailable so the resolver records the
			// reason and falls through to the next backend (worktree / rcopy).
			Err(err) => return Err(spawn_unavailable("fuse-overlayfs", &err)),
		};
		if output.status.success() {
			return Ok(());
		}
		Err(command_failed(
			"fuse-overlayfs mount failed",
			output.status.code().unwrap_or(-1),
			&output.stderr,
		))
	}

	fn fuse_umount(merged: &Path) -> IsoResult<()> {
		for binary in ["fusermount3", "fusermount"] {
			let result = Command::new(binary)
				.arg("-u")
				.arg(merged)
				.stdin(Stdio::null())
				.stdout(Stdio::null())
				.stderr(Stdio::piped())
				.output();
			match result {
				Ok(out) if out.status.success() => return Ok(()),
				Ok(_) => {},
				// Spawn failure (missing binary, ENOMEM, …): try the next
				// candidate rather than aborting teardown.
				Err(_) => {},
			}
		}
		// Last resort — try the lazy kernel umount; it works for both kernel
		// overlay and any fuse mount the user can reach.
		kernel_umount(merged)
	}

	fn kernel_overlay_supported() -> bool {
		let Ok(text) = fs::read_to_string("/proc/filesystems") else {
			return false;
		};
		text
			.lines()
			.any(|line| line.split_whitespace().any(|word| word == "overlay"))
	}

	/// Locate `fuse-overlayfs` without spawning it.
	///
	/// The previous implementation ran `fuse-overlayfs --version` and treated
	/// any successful spawn as availability; under memory pressure the spawn
	/// itself fails, so a filesystem lookup is both cheaper and more truthful.
	fn fuse_overlayfs_binary() -> Option<PathBuf> {
		find_in_path("fuse-overlayfs", env::var_os("PATH").as_deref())
	}

	fn find_in_path(name: &str, path_var: Option<&OsStr>) -> Option<PathBuf> {
		if name.contains('/') {
			let direct = PathBuf::from(name);
			return is_executable_file(&direct).then_some(direct);
		}
		env::split_paths(path_var?)
			.filter(|dir| !dir.as_os_str().is_empty())
			.map(|dir| dir.join(name))
			.find(|candidate| is_executable_file(candidate))
	}

	fn is_executable_file(path: &Path) -> bool {
		fs::metadata(path).is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
	}

	fn spawn_unavailable(binary: &str, err: &io::Error) -> IsoError {
		IsoError::unavailable(format!("spawn {binary}: {err}"))
	}

	fn canonical_existing_dir(path: &Path) -> IsoResult<PathBuf> {
		let resolved = absolutize(path);
		let meta = fs::metadata(&resolved).map_err(|err| {
			IsoError::other(format!("invalid overlay lower {}: {err}", resolved.display()))
		})?;
		if !meta.is_dir() {
			return Err(IsoError::other(format!(
				"overlay lower {} is not a directory",
				resolved.display()
			)));
		}
		Ok(fs::canonicalize(&resolved).unwrap_or(resolved))
	}

	fn absolutize(path: &Path) -> PathBuf {
		if path.is_absolute() {
			path.to_path_buf()
		} else {
			std::env::current_dir().map_or_else(|_| path.to_path_buf(), |cwd| cwd.join(path))
		}
	}

	fn remove_dir_if_exists(path: &Path, label: &str) -> IsoResult<()> {
		match fs::remove_dir_all(path) {
			Ok(()) => Ok(()),
			Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
			Err(err) => Err(IsoError::other(format!("remove {label} {}: {err}", path.display()))),
		}
	}

	fn to_cstring(bytes: &[u8], label: &str) -> IsoResult<CString> {
		CString::new(bytes)
			.map_err(|err| IsoError::other(format!("{label} path contains NUL byte: {err}")))
	}

	#[cfg(test)]
	mod tests {
		use std::{ffi::OsString, fs, io, os::unix::fs::PermissionsExt};

		use super::{find_in_path, is_executable_file, spawn_unavailable};

		#[test]
		fn spawn_enomem_degrades_to_unavailable() {
			// Measured failure: `spawn fuse-overlayfs: Cannot allocate memory
			// (os error 12)` used to be `IsoError::Other`, which the TS
			// resolver treats as a hard task failure instead of a fallback.
			let err = io::Error::from_raw_os_error(libc::ENOMEM);
			let iso = spawn_unavailable("fuse-overlayfs", &err);
			assert!(iso.is_unavailable(), "spawn ENOMEM must be backend-unavailable: {iso:?}");
			assert!(iso.message().contains("fuse-overlayfs"), "reason names the binary: {iso}");
			assert!(iso.message().contains("Cannot allocate memory"), "reason names the error: {iso}");
		}

		#[test]
		fn spawn_any_io_error_degrades_to_unavailable() {
			for raw in [libc::ENOENT, libc::EAGAIN, libc::EPERM] {
				let iso = spawn_unavailable("fuse-overlayfs", &io::Error::from_raw_os_error(raw));
				assert!(iso.is_unavailable(), "errno {raw} must be unavailable: {iso:?}");
			}
		}

		#[test]
		fn path_probe_finds_executable_without_spawning() {
			let dir = std::env::temp_dir().join(format!("pi-iso-path-{}", std::process::id()));
			fs::create_dir_all(&dir).expect("temp dir");
			let bin = dir.join("fuse-overlayfs");
			fs::write(&bin, b"#!/bin/sh\nexit 0\n").expect("write stub");
			let path_var = OsString::from(dir.as_os_str());

			fs::set_permissions(&bin, fs::Permissions::from_mode(0o644)).expect("chmod 644");
			assert!(!is_executable_file(&bin), "non-executable file is not a usable binary");
			assert_eq!(find_in_path("fuse-overlayfs", Some(&path_var)), None);

			fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).expect("chmod 755");
			assert_eq!(
				find_in_path("fuse-overlayfs", Some(&path_var)).as_deref(),
				Some(bin.as_path())
			);

			// An empty or absent PATH must never read as "found".
			assert_eq!(find_in_path("fuse-overlayfs", None), None);
			assert_eq!(find_in_path("fuse-overlayfs", Some(&OsString::new())), None);

			fs::remove_dir_all(&dir).ok();
		}
	}
}
