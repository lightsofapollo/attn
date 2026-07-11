//! Explicit resident-daemon and macOS login-item support.
//!
//! Installation is never implicit. Filesystem mutation is relative to an
//! already-open, nofollow directory descriptor so a concurrent symlink swap
//! cannot redirect plist writes outside the user's LaunchAgents directory.

use anyhow::{Result, bail};

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResidentStatus {
    pub supported: bool,
    pub installed: bool,
    pub loaded: bool,
    pub degraded: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use anyhow::Context;
    use nix::errno::Errno;
    use nix::fcntl::{OFlag, open, openat, renameat};
    use nix::sys::stat::{Mode, SFlag, fstat, mkdirat};
    use nix::unistd::{UnlinkatFlags, unlinkat};
    use std::fs::File;
    use std::io::Write;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::path::{Path, PathBuf};
    use std::process::{Command, Output};
    use std::time::{SystemTime, UNIX_EPOCH};

    const LABEL: &str = "com.attn.resident";
    const PLIST_NAME: &str = "com.attn.resident.plist";
    const LAUNCHCTL: &str = "/bin/launchctl";
    const DIR_FLAGS: OFlag = OFlag::O_RDONLY
        .union(OFlag::O_DIRECTORY)
        .union(OFlag::O_CLOEXEC)
        .union(OFlag::O_NOFOLLOW);

    unsafe extern "C" {
        fn geteuid() -> u32;
    }

    fn launch_agents_dir() -> Result<PathBuf> {
        let home = dirs::home_dir().context("could not determine home directory")?;
        Ok(home.join("Library").join("LaunchAgents"))
    }

    fn child_dir(parent: &File, name: &str, create: bool) -> Result<Option<File>> {
        let fd = match openat(Some(parent.as_raw_fd()), name, DIR_FLAGS, Mode::empty()) {
            Ok(fd) => fd,
            Err(Errno::ENOENT) if create => {
                match mkdirat(
                    Some(parent.as_raw_fd()),
                    name,
                    Mode::from_bits_truncate(0o755),
                ) {
                    Ok(()) | Err(Errno::EEXIST) => {}
                    Err(error) => return Err(error).context(format!("could not create {name}")),
                }
                openat(Some(parent.as_raw_fd()), name, DIR_FLAGS, Mode::empty())?
            }
            Err(Errno::ENOENT) => return Ok(None),
            Err(error) => return Err(error).context(format!("refusing unsafe {name} directory")),
        };
        // SAFETY: openat returned a new descriptor owned by this function.
        Ok(Some(unsafe { File::from_raw_fd(fd) }))
    }

    fn open_launch_agents_at(home: &Path, create: bool) -> Result<Option<File>> {
        let home_fd = open(home, DIR_FLAGS, Mode::empty())
            .with_context(|| format!("refusing unsafe home directory {}", home.display()))?;
        // SAFETY: open returned a new descriptor owned by this function.
        let home = unsafe { File::from_raw_fd(home_fd) };
        let Some(library) = child_dir(&home, "Library", create)? else {
            return Ok(None);
        };
        child_dir(&library, "LaunchAgents", create)
    }

    fn open_launch_agents() -> Result<File> {
        let dir = launch_agents_dir()?;
        let home = dir
            .parent()
            .and_then(Path::parent)
            .context("LaunchAgents directory has no home parent")?;
        open_launch_agents_at(home, true)?.context("could not create the LaunchAgents directory")
    }

    fn open_launch_agents_existing() -> Result<Option<File>> {
        let dir = launch_agents_dir()?;
        let home = dir
            .parent()
            .and_then(Path::parent)
            .context("LaunchAgents directory has no home parent")?;
        open_launch_agents_at(home, false)
    }

    fn xml_escape(value: &str) -> String {
        value
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
            .replace('\'', "&apos;")
    }

    pub(super) fn plist(executable: &Path) -> String {
        let executable = xml_escape(&executable.to_string_lossy());
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{executable}</string>
    <string>daemon</string>
    <string>--resident</string>
    <string>--no-fork</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ProcessType</key>
  <string>Interactive</string>
</dict>
</plist>
"#
        )
    }

    fn domain() -> String {
        // SAFETY: geteuid has no preconditions and returns a numeric value.
        format!("gui/{}", unsafe { geteuid() })
    }

    fn service_target() -> String {
        format!("{}/{}", domain(), LABEL)
    }

    fn launchctl(args: &[&str]) -> Result<Output> {
        Command::new(LAUNCHCTL)
            .args(args)
            .output()
            .with_context(|| format!("could not execute {LAUNCHCTL}"))
    }

    fn output_message(output: &Output) -> String {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        if stderr.is_empty() {
            String::from_utf8_lossy(&output.stdout).trim().to_owned()
        } else {
            stderr
        }
    }

    fn service_not_found(output: &Output) -> bool {
        if output.status.success() {
            return false;
        }
        let message = output_message(output).to_ascii_lowercase();
        message.contains("could not find service") || message.contains("service not found")
    }

    fn query_loaded() -> Result<bool> {
        let target = service_target();
        let output = launchctl(&["print", &target])?;
        if output.status.success() {
            Ok(true)
        } else if service_not_found(&output) {
            Ok(false)
        } else {
            bail!("launchctl print failed: {}", output_message(&output))
        }
    }

    /// Stop the service or prove that it is already absent. An unknown
    /// bootout failure is never treated as success.
    fn bootout() -> Result<()> {
        let target = service_target();
        let output = launchctl(&["bootout", &target])?;
        let succeeded = output.status.success();
        let absent = service_not_found(&output);
        if !succeeded && !absent {
            bail!("launchctl bootout failed: {}", output_message(&output));
        }
        let still_loaded = query_loaded()?;
        if bootout_allows_removal(succeeded, absent, still_loaded) {
            return Ok(());
        }
        bail!("launchctl accepted bootout but the service remains loaded")
    }

    fn bootout_allows_removal(succeeded: bool, absent: bool, still_loaded: bool) -> bool {
        (succeeded || absent) && !still_loaded
    }

    fn installed(dir: &File) -> Result<bool> {
        match openat(
            Some(dir.as_raw_fd()),
            PLIST_NAME,
            OFlag::O_RDONLY | OFlag::O_CLOEXEC | OFlag::O_NOFOLLOW,
            Mode::empty(),
        ) {
            Ok(fd) => {
                // SAFETY: openat returned a new descriptor owned here.
                let file = unsafe { File::from_raw_fd(fd) };
                let stat = fstat(file.as_raw_fd())?;
                let kind = SFlag::from_bits_truncate(stat.st_mode);
                if !kind.contains(SFlag::S_IFREG) {
                    bail!("refusing non-regular LaunchAgent entry");
                }
                Ok(true)
            }
            Err(Errno::ENOENT) => Ok(false),
            Err(error) => Err(error).context("refusing unsafe LaunchAgent entry"),
        }
    }

    fn unique_name(kind: &str) -> String {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        format!(".{PLIST_NAME}.{}.{nanos}.{kind}", std::process::id())
    }

    fn write_temp(dir: &File, name: &str, contents: &[u8]) -> Result<()> {
        let fd = openat(
            Some(dir.as_raw_fd()),
            name,
            OFlag::O_WRONLY | OFlag::O_CREAT | OFlag::O_EXCL | OFlag::O_CLOEXEC | OFlag::O_NOFOLLOW,
            Mode::from_bits_truncate(0o600),
        )
        .context("could not create LaunchAgent temporary file")?;
        // SAFETY: openat returned a new descriptor owned by this function.
        let mut file = unsafe { File::from_raw_fd(fd) };
        file.write_all(contents)
            .context("could not write LaunchAgent")?;
        file.sync_all().context("could not sync LaunchAgent")
    }

    fn unlink_if_exists(dir: &File, name: &str) -> Result<()> {
        match unlinkat(Some(dir.as_raw_fd()), name, UnlinkatFlags::NoRemoveDir) {
            Ok(()) | Err(Errno::ENOENT) => Ok(()),
            Err(error) => Err(error).context(format!("could not remove {name}")),
        }
    }

    fn bootstrap() -> Result<()> {
        let path = launch_agents_dir()?.join(PLIST_NAME);
        let output = launchctl(&["bootstrap", &domain(), &path.to_string_lossy()])?;
        if output.status.success() && query_loaded()? {
            Ok(())
        } else {
            bail!("launchctl bootstrap failed: {}", output_message(&output))
        }
    }

    fn rollback_install(
        dir: &File,
        backup: &str,
        had_old: bool,
        restart_old: bool,
        remove_new: bool,
    ) -> Result<()> {
        if remove_new {
            unlink_if_exists(dir, PLIST_NAME)?;
        }
        if had_old {
            renameat(
                Some(dir.as_raw_fd()),
                backup,
                Some(dir.as_raw_fd()),
                PLIST_NAME,
            )
            .context("could not restore previous LaunchAgent plist")?;
        }
        dir.sync_all()
            .context("could not sync LaunchAgent rollback")?;
        if restart_old {
            bootstrap().context("previous plist restored but its service could not restart")?;
        }
        Ok(())
    }

    pub(super) fn install() -> Result<()> {
        let dir = open_launch_agents()?;
        let executable = std::env::current_exe().context("could not determine executable path")?;
        let temp = unique_name("tmp");
        let backup = unique_name("backup");
        write_temp(&dir, &temp, plist(&executable).as_bytes())?;

        let had_old = match installed(&dir) {
            Ok(value) => value,
            Err(error) => {
                let _ = unlink_if_exists(&dir, &temp);
                return Err(error);
            }
        };
        let was_loaded = match query_loaded() {
            Ok(value) => value,
            Err(error) => {
                let _ = unlink_if_exists(&dir, &temp);
                return Err(error).context("could not establish prior service state");
            }
        };
        if was_loaded && !had_old {
            let _ = unlink_if_exists(&dir, &temp);
            bail!("refusing to replace a loaded service without a trusted installed plist");
        }

        // Do not replace a plist while launchd may still own the old service.
        if let Err(error) = bootout() {
            let _ = unlink_if_exists(&dir, &temp);
            return Err(error).context("refusing to replace a loaded LaunchAgent");
        }

        if had_old
            && let Err(error) = renameat(
                Some(dir.as_raw_fd()),
                PLIST_NAME,
                Some(dir.as_raw_fd()),
                backup.as_str(),
            )
        {
            let _ = unlink_if_exists(&dir, &temp);
            let restart = if was_loaded { bootstrap() } else { Ok(()) };
            return match restart {
                Ok(()) => Err(error).context("could not preserve previous LaunchAgent"),
                Err(restart_error) => Err(anyhow::anyhow!(
                    "could not preserve previous LaunchAgent ({error}); prior service restart failed ({restart_error:#})"
                )),
            };
        }
        if let Err(error) = renameat(
            Some(dir.as_raw_fd()),
            temp.as_str(),
            Some(dir.as_raw_fd()),
            PLIST_NAME,
        ) {
            let _ = unlink_if_exists(&dir, &temp);
            return match rollback_install(&dir, &backup, had_old, had_old && was_loaded, false) {
                Ok(()) => {
                    Err(error).context("could not install LaunchAgent; previous state restored")
                }
                Err(rollback_error) => Err(anyhow::anyhow!(
                    "could not install LaunchAgent ({error}); rollback failed ({rollback_error:#})"
                )),
            };
        }
        if let Err(sync_error) = dir.sync_all() {
            let rollback = rollback_install(&dir, &backup, had_old, had_old && was_loaded, true);
            return match rollback {
                Ok(()) => Err(sync_error)
                    .context("install directory sync failed; previous service restored"),
                Err(rollback_error) => Err(anyhow::anyhow!(
                    "install directory sync failed ({sync_error}); rollback failed ({rollback_error:#})"
                )),
            };
        }

        if let Err(bootstrap_error) = bootstrap() {
            return match rollback_install(&dir, &backup, had_old, had_old && was_loaded, true) {
                Ok(()) => Err(bootstrap_error).context("LaunchAgent install rolled back"),
                Err(rollback_error) => Err(anyhow::anyhow!(
                    "new LaunchAgent rejected ({bootstrap_error:#}); rollback failed ({rollback_error:#})"
                )),
            };
        }

        if had_old {
            unlink_if_exists(&dir, &backup)?;
            dir.sync_all()
                .context("could not sync LaunchAgents directory")?;
        }
        Ok(())
    }

    pub(super) fn uninstall() -> Result<()> {
        // Never remove the only on-disk recovery/control record while launchd
        // still reports the service loaded or bootout is ambiguous.
        bootout()?;
        if query_loaded()? {
            bail!("refusing to remove LaunchAgent while service remains loaded");
        }
        let Some(dir) = open_launch_agents_existing()? else {
            return Ok(());
        };
        unlink_if_exists(&dir, PLIST_NAME)?;
        dir.sync_all()
            .context("could not sync LaunchAgents directory")?;
        Ok(())
    }

    pub(super) fn status() -> ResidentStatus {
        let installed_result = open_launch_agents_existing()
            .and_then(|dir| dir.map_or(Ok(false), |dir| installed(&dir)));
        let loaded_result = query_loaded();
        let installed = installed_result.as_ref().copied().unwrap_or(false);
        let loaded = loaded_result.as_ref().copied().unwrap_or(false);
        let mut errors = Vec::new();
        if let Err(error) = installed_result {
            errors.push(format!("installed-state check failed: {error:#}"));
        }
        if let Err(error) = loaded_result {
            errors.push(format!("loaded-state check failed: {error:#}"));
        }
        if installed != loaded {
            errors.push(if installed {
                "LaunchAgent is installed but not loaded".to_owned()
            } else {
                "LaunchAgent is loaded without a trusted installed plist".to_owned()
            });
        }
        ResidentStatus {
            supported: true,
            installed,
            loaded,
            degraded: !errors.is_empty(),
            error: (!errors.is_empty()).then(|| errors.join("; ")),
        }
    }

    #[cfg(test)]
    pub(super) fn open_test_dir(home: &Path) -> Result<File> {
        open_launch_agents_at(home, true)?.context("test LaunchAgents missing")
    }

    #[cfg(test)]
    pub(super) fn installed_test(dir: &File) -> Result<bool> {
        installed(dir)
    }

    #[cfg(test)]
    pub(super) fn existing_test(home: &Path) -> Result<Option<File>> {
        open_launch_agents_at(home, false)
    }

    #[cfg(test)]
    pub(super) fn service_not_found_test(code: i32, stderr: &str) -> bool {
        use std::os::unix::process::ExitStatusExt;
        service_not_found(&Output {
            status: std::process::ExitStatus::from_raw(code << 8),
            stdout: Vec::new(),
            stderr: stderr.as_bytes().to_vec(),
        })
    }

    #[cfg(test)]
    pub(super) fn write_temp_test(dir: &File, name: &str, contents: &[u8]) -> Result<()> {
        write_temp(dir, name, contents)
    }

    #[cfg(test)]
    pub(super) fn bootout_allows_removal_test(
        succeeded: bool,
        absent: bool,
        still_loaded: bool,
    ) -> bool {
        bootout_allows_removal(succeeded, absent, still_loaded)
    }
}

pub fn status() -> ResidentStatus {
    #[cfg(target_os = "macos")]
    {
        macos::status()
    }
    #[cfg(not(target_os = "macos"))]
    {
        ResidentStatus {
            supported: false,
            installed: false,
            loaded: false,
            degraded: false,
            error: None,
        }
    }
}

pub fn install_launch_agent() -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        macos::install()
    }
    #[cfg(not(target_os = "macos"))]
    {
        bail!("launch-at-login is supported only on macOS")
    }
}

pub fn uninstall_launch_agent() -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        macos::uninstall()
    }
    #[cfg(not(target_os = "macos"))]
    {
        bail!("launch-at-login is supported only on macOS")
    }
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "macos")]
    #[test]
    fn plist_uses_one_daemon_path_and_escapes_executable() {
        let plist = super::macos::plist(std::path::Path::new("/Applications/A & B/attn"));
        assert!(plist.contains("/Applications/A &amp; B/attn"));
        assert!(plist.contains("<string>daemon</string>"));
        assert!(plist.contains("<string>--resident</string>"));
        assert_eq!(plist.matches("<key>ProgramArguments</key>").count(), 1);
        assert!(!plist.contains("<key>ShellPath</key>"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn launch_agents_traversal_rejects_symlinked_library() {
        use std::os::unix::fs::symlink;
        let home = tempfile::tempdir().expect("home");
        let outside = tempfile::tempdir().expect("outside");
        symlink(outside.path(), home.path().join("Library")).expect("symlink");
        assert!(super::macos::open_test_dir(home.path()).is_err());
        assert!(!outside.path().join("LaunchAgents").exists());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn launch_agents_traversal_creates_real_directories() {
        let home = tempfile::tempdir().expect("home");
        let dir = super::macos::open_test_dir(home.path()).expect("safe traversal");
        dir.sync_all().expect("directory fsync");
        assert!(home.path().join("Library/LaunchAgents").is_dir());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn installed_check_rejects_symlinked_plist() {
        use std::os::unix::fs::symlink;
        let home = tempfile::tempdir().expect("home");
        let outside = tempfile::NamedTempFile::new().expect("outside");
        let dir = super::macos::open_test_dir(home.path()).expect("safe traversal");
        symlink(
            outside.path(),
            home.path()
                .join("Library/LaunchAgents/com.attn.resident.plist"),
        )
        .expect("symlink plist");
        assert!(super::macos::installed_test(&dir).is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn read_only_traversal_does_not_create_settings_directories() {
        let home = tempfile::tempdir().expect("home");
        assert!(
            super::macos::existing_test(home.path())
                .expect("read-only traversal")
                .is_none()
        );
        assert!(!home.path().join("Library").exists());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn only_explicit_service_not_found_is_idempotent() {
        assert!(super::macos::service_not_found_test(
            3,
            "Could not find service com.attn.resident in domain for user"
        ));
        assert!(!super::macos::service_not_found_test(
            1,
            "Operation not permitted"
        ));
        assert!(!super::macos::service_not_found_test(0, ""));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn temp_write_rejects_precreated_symlink_without_touching_target() {
        use std::os::unix::fs::symlink;
        let home = tempfile::tempdir().expect("home");
        let outside = tempfile::NamedTempFile::new().expect("outside");
        std::fs::write(outside.path(), b"sentinel").expect("seed outside");
        let dir = super::macos::open_test_dir(home.path()).expect("safe traversal");
        symlink(
            outside.path(),
            home.path().join("Library/LaunchAgents/attacker.tmp"),
        )
        .expect("symlink temp");
        assert!(super::macos::write_temp_test(&dir, "attacker.tmp", b"owned").is_err());
        assert_eq!(std::fs::read(outside.path()).expect("outside"), b"sentinel");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn uninstall_never_removes_for_unknown_failure_or_loaded_service() {
        let allowed = super::macos::bootout_allows_removal_test;
        assert!(allowed(true, false, false));
        assert!(allowed(false, true, false));
        assert!(!allowed(false, false, false));
        assert!(!allowed(true, false, true));
        assert!(!allowed(false, true, true));
    }
}
