use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    let web_dir = Path::new("web");
    let web_src_dir = web_dir.join("src");
    if !web_src_dir.exists() {
        panic!("missing web/src; frontend sources are required to build attn");
    }

    watch_dir("web/src");
    watch_dir("web/styles");
    watch_dir("web/scripts");
    println!("cargo:rerun-if-changed=web/index.html");
    println!("cargo:rerun-if-changed=web/package.json");
    println!("cargo:rerun-if-changed=web/package-lock.json");
    println!("cargo:rerun-if-changed=web/components.json");
    println!("cargo:rerun-if-changed=web/vite.config.ts");
    println!("cargo:rerun-if-changed=web/svelte.config.js");
    println!("cargo:rerun-if-changed=web/tsconfig.json");

    let out_dir = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR should be set"));
    let out_html = out_dir.join("attn-index.html");
    let source_dist_html = web_dir.join("dist/index.html");

    if source_dist_html.exists() {
        fs::copy(&source_dist_html, &out_html)
            .expect("failed to copy web/dist/index.html to OUT_DIR");
        return;
    }

    build_frontend_in_out_dir(web_dir, &out_dir);

    let generated_html = out_dir.join("web-build/dist/index.html");
    if !generated_html.exists() {
        panic!("frontend build did not produce dist/index.html");
    }
    fs::copy(&generated_html, &out_html).expect("failed to copy generated frontend artifact");
}

fn build_frontend_in_out_dir(web_dir: &Path, out_dir: &Path) {
    let build_root = out_dir.join("web-build");
    if build_root.exists() {
        fs::remove_dir_all(&build_root).expect("failed to clean previous OUT_DIR web-build");
    }
    copy_dir_filtered(web_dir, &build_root);

    let npm_ci = Command::new("npm")
        .args(["ci", "--no-audit", "--no-fund"])
        .current_dir(&build_root)
        .status()
        .expect("failed to run 'npm ci' — is npm installed?");
    if !npm_ci.success() {
        panic!("npm ci failed");
    }

    let npm_build = Command::new("npm")
        .args(["run", "build"])
        .current_dir(&build_root)
        .status()
        .expect("failed to run 'npm run build' — is npm installed?");
    if !npm_build.success() {
        panic!("vite build failed");
    }
}

fn copy_dir_filtered(src: &Path, dst: &Path) {
    fs::create_dir_all(dst).expect("failed to create destination directory");
    let entries = fs::read_dir(src).expect("failed to read source directory");
    for entry in entries {
        let entry = entry.expect("failed to read directory entry");
        let from = entry.path();
        let name = entry.file_name();
        let name_str = name.to_string_lossy();

        if name_str == "node_modules" || name_str == "dist" {
            continue;
        }

        let to = dst.join(&name);
        let file_type = entry.file_type().expect("failed to read file type");
        if file_type.is_dir() {
            copy_dir_filtered(&from, &to);
        } else if file_type.is_file() {
            fs::copy(&from, &to).expect("failed to copy file");
        }
    }
}

fn watch_dir(dir: &str) {
    let entries = match fs::read_dir(dir) {
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
