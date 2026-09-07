//! Provider-neutral access to feedback marked in attn's review margin.

use std::io::{self, Write};
use std::path::PathBuf;

use anyhow::{Context, Result};
use clap::Args;

use crate::review::feedback::{FeedbackFreshness, feedback_snapshot, render_feedback};
use crate::review::store::ReviewStore;

#[derive(Args, Debug)]
pub struct FeedbackArgs {
    /// Project directory or exact shared file. Defaults to the current directory.
    #[arg(default_value = ".", value_name = "PATH")]
    pub path: PathBuf,

    /// Emit one structured JSON snapshot instead of the readable agent packet.
    #[arg(long)]
    pub json: bool,

    /// Wait for changes and emit flushed NDJSON snapshot/upsert/remove records.
    #[arg(long)]
    pub watch: bool,

    /// Target a specific attn runtime profile.
    #[arg(long, global = true, value_name = "DIR")]
    pub attn_home: Option<PathBuf>,
}

pub fn run(args: FeedbackArgs) -> Result<()> {
    if let Some(home) = args.attn_home.as_deref() {
        crate::cli_review::set_attn_home_for_review(home)?;
    }
    if args.watch {
        return crate::daemon::watch_feedback(&args.path);
    }

    let store = ReviewStore::open_existing()?;
    let snapshot = feedback_snapshot(&store, &args.path, FeedbackFreshness::PersistedLocal)?;
    let output = if args.json {
        serde_json::to_string_pretty(&snapshot).context("serialize feedback snapshot")?
    } else {
        render_feedback(&snapshot)
    };
    let mut stdout = io::stdout().lock();
    stdout
        .write_all(output.as_bytes())
        .context("write feedback")?;
    if !output.ends_with('\n') {
        stdout.write_all(b"\n").context("finish feedback output")?;
    }
    stdout.flush().context("flush feedback output")
}
