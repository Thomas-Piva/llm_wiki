//! Downloads and caches ffmpeg + yt-dlp when missing from PATH, so the
//! media-ingest feature (audio/video transcription) works without asking
//! the user to install anything manually. Mirrors `node_runtime.rs`'s
//! cache -> PATH -> download resolution order.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Emitter, Manager};

use super::cli_resolver::find_cli_command;

fn install_root(app: &AppHandle, subdir: &str) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not resolve app data directory: {e}"))?;
    Ok(base.join(subdir))
}

fn ytdlp_asset_name() -> Result<(&'static str, &'static str), String> {
    // (release asset name, local binary file name)
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => Ok(("yt-dlp_linux", "yt-dlp")),
        ("linux", "aarch64") => Ok(("yt-dlp_linux_aarch64", "yt-dlp")),
        ("macos", _) => Ok(("yt-dlp_macos", "yt-dlp")),
        ("windows", "x86_64") => Ok(("yt-dlp.exe", "yt-dlp.exe")),
        (os, arch) => Err(format!(
            "No automatic yt-dlp download available for {os}/{arch} — install yt-dlp manually and reopen Settings."
        )),
    }
}

async fn resolve_latest_ytdlp_tag() -> Result<String, String> {
    let response = reqwest::Client::new()
        .get("https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest")
        .header("User-Agent", "llm-wiki")
        .send()
        .await
        .map_err(|e| format!("Failed to reach GitHub releases API: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("GitHub releases API returned HTTP {}", response.status()));
    }
    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse GitHub releases response: {e}"))?;
    json.get("tag_name")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "GitHub releases response had no tag_name".to_string())
}

/// Cache -> PATH -> download. Returns the absolute path to a working
/// `yt-dlp` binary.
pub async fn ensure_ytdlp(app: &AppHandle) -> Result<PathBuf, String> {
    let root = install_root(app, "ytdlp-runtime")?;
    let (_, local_name) = ytdlp_asset_name()?;
    let cached = root.join(local_name);
    if cached.is_file() {
        return Ok(cached);
    }
    if let Ok(path) = find_cli_command("yt-dlp", &["yt-dlp.exe"]).await {
        return Ok(path);
    }

    let (asset_name, local_name) = ytdlp_asset_name()?;
    let tag = resolve_latest_ytdlp_tag().await?;
    let url = format!("https://github.com/yt-dlp/yt-dlp/releases/download/{tag}/{asset_name}");
    let _ = app.emit("media-tools:log", format!("Downloading yt-dlp {tag}…"));

    std::fs::create_dir_all(&root).map_err(|e| format!("Failed to create {}: {e}", root.display()))?;
    let bytes = reqwest::get(&url)
        .await
        .map_err(|e| format!("Failed to download yt-dlp from {url}: {e}"))?
        .bytes()
        .await
        .map_err(|e| format!("Failed to read yt-dlp download body: {e}"))?;

    let dest = root.join(local_name);
    std::fs::write(&dest, &bytes).map_err(|e| format!("Failed to write {}: {e}", dest.display()))?;
    make_executable(&dest)?;

    let _ = app.emit("media-tools:log", "yt-dlp ready.".to_string());
    Ok(dest)
}

fn make_executable(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(path)
            .map_err(|e| format!("Failed to read metadata for {}: {e}", path.display()))?
            .permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(path, perms)
            .map_err(|e| format!("Failed to chmod {}: {e}", path.display()))?;
    }
    Ok(())
}

/// Downloads only the audio track of `url` via yt-dlp into the OS temp
/// directory. Returns the local file path on success. On failure, the
/// error message is prefixed with "unsupported URL" specifically when
/// yt-dlp itself reports it doesn't recognize the site/URL (as opposed to
/// a network error, geo-block, or private video) — callers use that
/// prefix to decide whether to fall back to a different import path.
#[tauri::command]
pub async fn download_media_url(app: AppHandle, url: String) -> Result<String, String> {
    let ytdlp = ensure_ytdlp(&app).await?;

    let temp_dir = std::env::temp_dir().join("llm-wiki-media-import");
    std::fs::create_dir_all(&temp_dir)
        .map_err(|e| format!("Failed to create {}: {e}", temp_dir.display()))?;
    let output_template = temp_dir.join("%(title).100B [%(id)s].%(ext)s");

    let output = tokio::process::Command::new(&ytdlp)
        .arg("--no-playlist")
        .arg("-x")
        .arg("--audio-format")
        .arg("mp3")
        .arg("-o")
        .arg(&output_template)
        .arg("--print")
        .arg("after_move:filepath")
        .arg(&url)
        .output()
        .await
        .map_err(|e| format!("Failed to spawn yt-dlp: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.to_lowercase().contains("unsupported url")
            || stderr.to_lowercase().contains("is not a valid url")
        {
            return Err(format!("unsupported URL: {}", stderr.trim()));
        }
        return Err(format!("yt-dlp failed for {url}: {}", stderr.trim()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let path = stdout.lines().last().unwrap_or("").trim();
    if path.is_empty() || !Path::new(path).is_file() {
        return Err(format!("yt-dlp reported success but produced no file for {url}"));
    }
    Ok(path.to_string())
}
