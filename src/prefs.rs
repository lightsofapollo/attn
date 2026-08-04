//! Durable UI preferences (appearance, typeset).
//!
//! Kept next to the project registry in the daemon's runtime namespace so a
//! preference survives daemon restarts AND can be read before the window
//! exists. That ordering is the point: the theme is stamped into the page HTML
//! at build time, so the first frame already carries the right appearance and
//! the user never sees a flash of the wrong theme.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// `system` defers to the OS appearance, resolved in the webview (which
/// tracks macOS light/dark live via `prefers-color-scheme`).
pub const THEME_LIGHT: &str = "light";
pub const THEME_DARK: &str = "dark";
pub const THEME_SYSTEM: &str = "system";

pub const TYPESET_DEFAULT: &str = "editorial";
const TYPESETS: [&str; 3] = [TYPESET_DEFAULT, "modern", "compact"];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Preferences {
    /// `light` | `dark` | `system`
    #[serde(default = "default_theme")]
    pub theme: String,
    /// Typeset preset id — see `web/styles/typeset.css`.
    #[serde(default = "default_typeset")]
    pub typeset: String,
}

fn default_theme() -> String {
    THEME_SYSTEM.to_string()
}

fn default_typeset() -> String {
    TYPESET_DEFAULT.to_string()
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            theme: default_theme(),
            typeset: default_typeset(),
        }
    }
}

/// Normalize an untrusted theme string; anything unrecognized falls back to
/// `system` rather than stamping a bogus attribute into the page.
pub fn normalize_theme(value: &str) -> String {
    match value.trim() {
        THEME_LIGHT => THEME_LIGHT.to_string(),
        THEME_DARK => THEME_DARK.to_string(),
        _ => THEME_SYSTEM.to_string(),
    }
}

pub fn normalize_typeset(value: &str) -> String {
    let trimmed = value.trim();
    if TYPESETS.contains(&trimmed) {
        trimmed.to_string()
    } else {
        TYPESET_DEFAULT.to_string()
    }
}

pub fn load() -> Preferences {
    let path = prefs_path();
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return Preferences::default();
    };
    match serde_json::from_str::<Preferences>(&raw) {
        Ok(prefs) => Preferences {
            theme: normalize_theme(&prefs.theme),
            typeset: normalize_typeset(&prefs.typeset),
        },
        Err(e) => {
            tracing::warn!("could not parse preferences {}: {}", path.display(), e);
            Preferences::default()
        }
    }
}

pub fn set_theme(theme: &str) -> Result<Preferences> {
    let mut prefs = load();
    prefs.theme = normalize_theme(theme);
    save(&prefs)?;
    Ok(prefs)
}

pub fn set_typeset(typeset: &str) -> Result<Preferences> {
    let mut prefs = load();
    prefs.typeset = normalize_typeset(typeset);
    save(&prefs)?;
    Ok(prefs)
}

fn save(prefs: &Preferences) -> Result<()> {
    let dir = crate::projects::storage_dir();
    std::fs::create_dir_all(&dir).with_context(|| format!("could not create {}", dir.display()))?;
    let path = prefs_path();
    let payload = serde_json::to_string_pretty(prefs).context("could not serialize preferences")?;
    std::fs::write(&path, payload).with_context(|| format!("could not write {}", path.display()))
}

fn prefs_path() -> PathBuf {
    crate::projects::storage_dir().join("prefs.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_theme_falls_back_to_system() {
        assert_eq!(normalize_theme("dark"), THEME_DARK);
        assert_eq!(normalize_theme("light"), THEME_LIGHT);
        assert_eq!(normalize_theme("system"), THEME_SYSTEM);
        assert_eq!(normalize_theme("chartreuse"), THEME_SYSTEM);
        assert_eq!(normalize_theme(""), THEME_SYSTEM);
    }

    #[test]
    fn unknown_typeset_falls_back_to_default() {
        assert_eq!(normalize_typeset("modern"), "modern");
        assert_eq!(normalize_typeset("compact"), "compact");
        assert_eq!(normalize_typeset("wingdings"), TYPESET_DEFAULT);
    }

    #[test]
    fn preferences_round_trip_through_json() {
        let prefs = Preferences {
            theme: THEME_DARK.to_string(),
            typeset: "compact".to_string(),
        };
        let raw = serde_json::to_string(&prefs).expect("serialize");
        let parsed: Preferences = serde_json::from_str(&raw).expect("deserialize");
        assert_eq!(parsed.theme, THEME_DARK);
        assert_eq!(parsed.typeset, "compact");
    }

    #[test]
    fn missing_fields_use_defaults() {
        let parsed: Preferences = serde_json::from_str("{}").expect("deserialize empty");
        assert_eq!(parsed.theme, THEME_SYSTEM);
        assert_eq!(parsed.typeset, TYPESET_DEFAULT);
    }
}
