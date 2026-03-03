use anyhow::{Context, Result, bail};
use std::collections::HashSet;
use std::env;
use std::path::{Path, PathBuf};

#[derive(Debug)]
pub enum InstallCliAliasResult {
    AlreadyInstalled(PathBuf),
    Installed { path: PathBuf, dir_on_path: bool },
}

#[cfg(target_os = "macos")]
pub fn has_attn_on_path() -> bool {
    find_attn_on_path().is_some()
}

fn find_attn_on_path() -> Option<PathBuf> {
    let path = env::var_os("PATH")?;
    for dir in env::split_paths(&path) {
        let candidate = dir.join("attn");
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

pub fn install_attn_cli_alias() -> Result<InstallCliAliasResult> {
    if let Some(existing) = find_attn_on_path() {
        return Ok(InstallCliAliasResult::AlreadyInstalled(existing));
    }

    let source = env::current_exe().context("cannot determine running app binary path")?;
    let source = source
        .canonicalize()
        .with_context(|| format!("cannot resolve '{}'", source.display()))?;

    let mut attempted_dirs = HashSet::<PathBuf>::new();
    let path_dirs = env::var_os("PATH")
        .map(|path| env::split_paths(&path).collect::<Vec<_>>())
        .unwrap_or_default();

    for dir in fallback_dirs() {
        if !attempted_dirs.insert(dir.clone()) {
            continue;
        }
        if let Err(err) = std::fs::create_dir_all(&dir) {
            eprintln!("attn: could not create '{}': {}", dir.display(), err);
            continue;
        }
        let target = dir.join("attn");
        if let Some(result) = try_install_to_target(&source, &target)? {
            return Ok(result);
        }
    }

    for dir in path_dirs {
        if !dir.is_absolute() || !dir.exists() || !attempted_dirs.insert(dir.clone()) {
            continue;
        }
        let target = dir.join("attn");
        if let Some(result) = try_install_to_target(&source, &target)? {
            return Ok(result);
        }
    }

    bail!(
        "could not install alias; no writable destination found in PATH and fallback dirs (~/.local/bin, ~/bin)"
    )
}

fn fallback_dirs() -> Vec<PathBuf> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    vec![home.join(".local/bin"), home.join("bin")]
}

fn try_install_to_target(source: &Path, target: &Path) -> Result<Option<InstallCliAliasResult>> {
    match std::fs::symlink_metadata(target) {
        Ok(meta) => {
            if meta.file_type().is_symlink()
                && let Ok(existing_target) = std::fs::read_link(target)
                && let Ok(existing_resolved) = existing_target.canonicalize()
                && existing_resolved == source
            {
                return Ok(Some(InstallCliAliasResult::AlreadyInstalled(
                    target.to_path_buf(),
                )));
            }
            eprintln!("attn: skipping '{}'; file already exists", target.display());
            Ok(None)
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::symlink;
                match symlink(source, target) {
                    Ok(()) => {
                        let dir_on_path = target.parent().map(path_dir_is_on_path).unwrap_or(false);
                        Ok(Some(InstallCliAliasResult::Installed {
                            path: target.to_path_buf(),
                            dir_on_path,
                        }))
                    }
                    Err(err) => {
                        eprintln!("attn: could not create '{}': {}", target.display(), err);
                        Ok(None)
                    }
                }
            }
            #[cfg(not(unix))]
            {
                let _ = source;
                let _ = target;
                bail!("CLI alias installation is only supported on unix platforms");
            }
        }
        Err(err) => Err(err).with_context(|| format!("cannot inspect '{}'", target.display())),
    }
}

fn path_dir_is_on_path(dir: &Path) -> bool {
    let Some(path) = env::var_os("PATH") else {
        return false;
    };
    let mut dir_candidates = Vec::new();
    dir_candidates.push(dir.to_path_buf());
    if let Ok(canon) = dir.canonicalize() {
        dir_candidates.push(canon);
    }

    env::split_paths(&path).any(|entry| {
        if dir_candidates.iter().any(|candidate| candidate == &entry) {
            return true;
        }
        match entry.canonicalize() {
            Ok(canon_entry) => dir_candidates
                .iter()
                .any(|candidate| candidate == &canon_entry),
            Err(_) => false,
        }
    })
}
