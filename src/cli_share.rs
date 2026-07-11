//! Top-level durable-share CLI.

use std::path::PathBuf;

use anyhow::{Context, Result, bail};
use clap::{Args, Subcommand};

#[derive(Args, Debug)]
pub struct ShareArgs {
    /// File or directory to publish as a durable share.
    #[arg(value_name = "FILE_OR_DIR")]
    pub path: Option<PathBuf>,

    #[command(subcommand)]
    pub command: Option<ShareSubcommand>,
}

#[derive(Subcommand, Debug)]
pub enum ShareSubcommand {
    /// Renew one durable share, or every active share when TARGET is omitted.
    Renew {
        /// Canonical share id or exact persisted owner path.
        target: Option<String>,
    },
    /// Revoke a durable share immediately.
    Revoke {
        /// Canonical share id or exact persisted owner path.
        target: String,
    },
}

pub fn run(args: ShareArgs) -> Result<()> {
    match (args.path, args.command) {
        (Some(path), None) => {
            let (absolute, _) = crate::review::share_lifecycle::canonical_share_target(&path)
                .map_err(|error| anyhow::anyhow!(error.to_string()))
                .with_context(|| format!("validate durable share path {}", path.display()))?;
            crate::daemon::send_durable_share_create(&absolute)
        }
        (None, Some(ShareSubcommand::Renew { target })) => {
            crate::daemon::send_durable_share_renew(target.as_deref())
        }
        (None, Some(ShareSubcommand::Revoke { target })) => {
            crate::daemon::send_durable_share_revoke(&target)
        }
        (None, None) => bail!("provide a file/directory, `renew`, or `revoke`"),
        (Some(_), Some(_)) => bail!("a durable share path cannot be combined with a subcommand"),
    }
}

#[cfg(test)]
mod tests {
    use clap::{Parser, Subcommand};

    use super::*;

    #[derive(Parser, Debug)]
    struct TestCli {
        #[command(subcommand)]
        command: TestCommand,
    }

    #[derive(Subcommand, Debug)]
    enum TestCommand {
        Share(ShareArgs),
    }

    #[test]
    fn parses_create_renew_and_revoke_forms() {
        let create = TestCli::try_parse_from(["attn", "share", "notes.md"]).expect("create");
        assert!(matches!(
            create.command,
            TestCommand::Share(ShareArgs {
                path: Some(path),
                command: None
            }) if path == std::path::Path::new("notes.md")
        ));

        let renew = TestCli::try_parse_from(["attn", "share", "renew"]).expect("renew all");
        assert!(matches!(
            renew.command,
            TestCommand::Share(ShareArgs {
                path: None,
                command: Some(ShareSubcommand::Renew { target: None })
            })
        ));

        let revoke =
            TestCli::try_parse_from(["attn", "share", "revoke", "share-id"]).expect("revoke");
        assert!(matches!(
            revoke.command,
            TestCommand::Share(ShareArgs {
                path: None,
                command: Some(ShareSubcommand::Revoke { target })
            }) if target == "share-id"
        ));
    }
}
