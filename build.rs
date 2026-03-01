use std::process::Command;

fn main() {
    // Recursively watch all web source files so any change triggers Vite rebuild
    watch_dir("web/src");
    watch_dir("web/styles");
    println!("cargo:rerun-if-changed=web/index.html");
    println!("cargo:rerun-if-changed=web/vite.config.ts");
    println!("cargo:rerun-if-changed=web/svelte.config.js");

    // Run vite build
    let status = Command::new("npm")
        .args(["run", "build"])
        .current_dir("web")
        .status()
        .expect("failed to run 'npm run build' — is npm installed?");

    if !status.success() {
        panic!("vite build failed");
    }
}

fn watch_dir(dir: &str) {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        println!("cargo:rerun-if-changed={}", path.display());
        if path.is_dir()
            && let Some(s) = path.to_str()
        {
            watch_dir(s);
        }
    }
}
