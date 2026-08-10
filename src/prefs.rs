//! Durable UI preferences (appearance, typeset, review-rail width).
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
/// Mirrors `TypesetName` in web/src/lib/types.ts and the presets in
/// web/styles/typeset.css. An id missing here is silently downgraded to the
/// default, so all three lists have to move together.
const TYPESETS: [&str; 5] = [
    TYPESET_DEFAULT,
    "modern",
    "compact",
    "manuscript",
    "terminal",
];

/// Expanded review-rail width, in CSS px (attn-11g4.2).
///
/// Mirrors `RAIL_WIDTH_PX.expanded`, `RAIL_WIDTH_MIN_PX` and
/// `RAIL_WIDTH_MAX_PX` in `web/src/lib/review/rail-mode.ts`, where the bounds
/// are justified against card legibility and prose measure. The webview clamps
/// before it sends; this is the gate that decides what is allowed to survive a
/// restart, so the two sets of numbers have to move together.
/// `web/src/lib/review/rail-width.test.ts` reads this file and fails on drift.
pub const RAIL_WIDTH_DEFAULT: u32 = 320;
pub const RAIL_WIDTH_MIN: u32 = 260;
pub const RAIL_WIDTH_MAX: u32 = 640;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Preferences {
    /// `light` | `dark` | `system`
    #[serde(default = "default_theme")]
    pub theme: String,
    /// Typeset preset id — see `web/styles/typeset.css`.
    #[serde(default = "default_typeset")]
    pub typeset: String,
    /// Width of the expanded review rail in CSS px. `#[serde(default)]` keeps
    /// prefs.json files written before attn-11g4.2 loading cleanly.
    #[serde(default = "default_rail_width")]
    pub rail_width: u32,
}

fn default_theme() -> String {
    THEME_SYSTEM.to_string()
}

fn default_typeset() -> String {
    TYPESET_DEFAULT.to_string()
}

fn default_rail_width() -> u32 {
    RAIL_WIDTH_DEFAULT
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            theme: default_theme(),
            typeset: default_typeset(),
            rail_width: default_rail_width(),
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

/// Normalize an untrusted rail width.
///
/// Deliberately the same discipline as `normalize_typeset`: out-of-range means
/// *reject*, not snap to the nearest bound. The webview already clamps into
/// `[RAIL_WIDTH_MIN, RAIL_WIDTH_MAX]` before it sends, so a value outside the
/// range did not come from a drag — it came from a hand-edited prefs.json or a
/// caller we should not be interpolating for. Falling back to the default
/// gives the user a rail they can see and re-drag instead of one silently
/// pinned to an edge they never chose.
pub fn normalize_rail_width(value: u32) -> u32 {
    if (RAIL_WIDTH_MIN..=RAIL_WIDTH_MAX).contains(&value) {
        value
    } else {
        RAIL_WIDTH_DEFAULT
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
            rail_width: normalize_rail_width(prefs.rail_width),
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

pub fn set_rail_width(width: u32) -> Result<Preferences> {
    let mut prefs = load();
    prefs.rail_width = normalize_rail_width(width);
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
        assert_eq!(normalize_typeset("manuscript"), "manuscript");
        assert_eq!(normalize_typeset("terminal"), "terminal");
        assert_eq!(normalize_typeset("wingdings"), TYPESET_DEFAULT);
    }

    /// The allowlist is the last gate before an id is stamped into the page as
    /// `data-typeset`, so every id the UI can select has to survive it.
    #[test]
    fn every_allowlisted_typeset_round_trips() {
        for id in TYPESETS {
            assert_eq!(normalize_typeset(id), id);
        }
    }

    #[test]
    fn preferences_round_trip_through_json() {
        let prefs = Preferences {
            theme: THEME_DARK.to_string(),
            typeset: "compact".to_string(),
            rail_width: 420,
        };
        let raw = serde_json::to_string(&prefs).expect("serialize");
        let parsed: Preferences = serde_json::from_str(&raw).expect("deserialize");
        assert_eq!(parsed.theme, THEME_DARK);
        assert_eq!(parsed.typeset, "compact");
        assert_eq!(parsed.rail_width, 420);
    }

    #[test]
    fn missing_fields_use_defaults() {
        let parsed: Preferences = serde_json::from_str("{}").expect("deserialize empty");
        assert_eq!(parsed.theme, THEME_SYSTEM);
        assert_eq!(parsed.typeset, TYPESET_DEFAULT);
        assert_eq!(parsed.rail_width, RAIL_WIDTH_DEFAULT);
    }

    /// Every prefs.json written before attn-11g4.2 lacks `rail_width`. Those
    /// files must keep loading — a user who set a theme two releases ago does
    /// not get reset to `system` because a rail learned to resize.
    #[test]
    fn prefs_written_before_rail_width_still_load() {
        let parsed: Preferences =
            serde_json::from_str(r#"{"theme":"dark","typeset":"compact"}"#).expect("deserialize");
        assert_eq!(parsed.theme, THEME_DARK);
        assert_eq!(parsed.typeset, "compact");
        assert_eq!(parsed.rail_width, RAIL_WIDTH_DEFAULT);
    }

    #[test]
    fn in_range_rail_widths_round_trip() {
        for width in [
            RAIL_WIDTH_MIN,
            RAIL_WIDTH_DEFAULT,
            RAIL_WIDTH_MAX,
            261,
            400,
            639,
        ] {
            assert_eq!(normalize_rail_width(width), width, "width {width}");
        }
    }

    /// Out-of-range reverts to the default rather than snapping to a bound —
    /// see `normalize_rail_width` for why. Covers both directions plus the
    /// degenerate values a corrupt file can produce.
    #[test]
    fn out_of_range_rail_width_falls_back_to_default() {
        for width in [0, 1, RAIL_WIDTH_MIN - 1, RAIL_WIDTH_MAX + 1, 4096, u32::MAX] {
            assert_eq!(
                normalize_rail_width(width),
                RAIL_WIDTH_DEFAULT,
                "width {width}"
            );
        }
    }

    /// The default has to be a width the gate accepts, or `set_rail_width`
    /// would bounce the reset the double-click handler sends.
    #[test]
    fn rail_width_default_survives_its_own_gate() {
        // Const blocks, per clippy's `assertions_on_constants` (1.97): these
        // two are invariants BETWEEN constants, so they can fail at compile
        // time instead of at test time — strictly earlier, same intent.
        const {
            assert!(RAIL_WIDTH_MIN < RAIL_WIDTH_MAX);
            assert!(RAIL_WIDTH_MIN <= RAIL_WIDTH_DEFAULT && RAIL_WIDTH_DEFAULT <= RAIL_WIDTH_MAX);
        }
        assert_eq!(normalize_rail_width(RAIL_WIDTH_DEFAULT), RAIL_WIDTH_DEFAULT);
    }

    /// A stored width outside the range must not reach the frontend even
    /// though it parsed fine — `load()` is the only reader, so this is where
    /// a hand-edited prefs.json gets caught.
    #[test]
    fn load_normalizes_an_out_of_range_stored_width() {
        let parsed: Preferences =
            serde_json::from_str(r#"{"theme":"dark","typeset":"modern","rail_width":9999}"#)
                .expect("deserialize");
        // Raw parse keeps the bogus value...
        assert_eq!(parsed.rail_width, 9999);
        // ...and the normalization `load()` applies is what rejects it.
        assert_eq!(normalize_rail_width(parsed.rail_width), RAIL_WIDTH_DEFAULT);
    }
}
