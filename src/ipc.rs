use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
pub enum IpcMessage {
    #[serde(rename = "checkbox_toggle")]
    CheckboxToggle { index: usize, checked: bool },

    #[serde(rename = "navigate")]
    Navigate { path: String },

    #[serde(rename = "edit_save")]
    EditSave { content: String },

    #[serde(rename = "theme_change")]
    ThemeChange { theme: String },

    #[serde(rename = "quit")]
    Quit,
}

pub fn handle_message(body: &str) {
    match serde_json::from_str::<IpcMessage>(body) {
        Ok(msg) => match msg {
            IpcMessage::Quit => {
                std::process::exit(0);
            }
            IpcMessage::CheckboxToggle { index, checked } => {
                eprintln!("checkbox toggle: index={}, checked={}", index, checked);
                // TODO: find the file, update the line, write back
            }
            IpcMessage::Navigate { path } => {
                eprintln!("navigate to: {}", path);
                // TODO: load new file, re-render, push to frontend
            }
            IpcMessage::EditSave { content } => {
                eprintln!("edit save: {} bytes", content.len());
                // TODO: write content to current file
            }
            IpcMessage::ThemeChange { theme } => {
                eprintln!("theme change: {}", theme);
            }
        },
        Err(e) => {
            eprintln!("attn: invalid IPC message: {}", e);
        }
    }
}
