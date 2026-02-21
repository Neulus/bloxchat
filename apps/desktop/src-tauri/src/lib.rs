use notify::{Config, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use rdev::{listen, Event, EventType};
use regex::Regex;
use reqwest::header::{CONTENT_TYPE, RANGE};
use serde::Deserialize;
use std::cmp::Ordering;
use std::ffi::OsString;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::os::windows::ffi::OsStringExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{mpsc, Mutex};
use tauri::{AppHandle, Emitter, Manager};
#[cfg(desktop)]
use tauri_plugin_deep_link::DeepLinkExt;
use windows::Win32::Foundation::{HWND, MAX_PATH};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::{
    FindWindowW, GetForegroundWindow, GetWindowThreadProcessId, IsIconic, SetForegroundWindow,
    ShowWindow, SW_RESTORE,
};
use windows_strings::PCWSTR;

struct LogSettingsState {
    logs_path: Mutex<PathBuf>,
    watcher_control: Mutex<Option<mpsc::Sender<PathBuf>>>,
}

const GITHUB_REPO: &str = "logixism/bloxchat";
const MSI_ASSET_NAME: &str = "BloxChat.msi";

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    assets: Vec<GithubReleaseAsset>,
}

#[derive(Debug, Deserialize)]
struct GithubReleaseAsset {
    name: String,
    browser_download_url: String,
}

fn default_roblox_logs_path() -> PathBuf {
    let mut path = home::home_dir().expect("Could not find home dir");
    path.push("AppData\\Local\\Roblox\\logs");
    path
}

fn normalize_version(version: &str) -> String {
    version.trim().trim_start_matches('v').to_string()
}

fn parse_semver_parts(version: &str) -> Option<Vec<u64>> {
    let normalized = normalize_version(version);
    let core = normalized.split(['-', '+']).next().unwrap_or("").trim();
    if core.is_empty() {
        return None;
    }

    let mut parts = Vec::new();
    for segment in core.split('.') {
        parts.push(segment.parse::<u64>().ok()?);
    }

    Some(parts)
}

fn compare_versions(left: &str, right: &str) -> Option<Ordering> {
    let mut left_parts = parse_semver_parts(left)?;
    let mut right_parts = parse_semver_parts(right)?;
    let max = left_parts.len().max(right_parts.len());
    left_parts.resize(max, 0);
    right_parts.resize(max, 0);
    Some(left_parts.cmp(&right_parts))
}

fn is_newer_version(candidate: &str, current: &str) -> bool {
    matches!(
        compare_versions(candidate, current),
        Some(Ordering::Greater)
    )
}

async fn fetch_latest_release(client: &reqwest::Client) -> Result<GithubRelease, String> {
    let endpoint = format!("https://api.github.com/repos/{GITHUB_REPO}/releases/latest");
    let response = client
        .get(endpoint)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !response.status().is_success() {
        return Err(format!(
            "GitHub latest release request failed: {}",
            response.status()
        ));
    }

    let payload = response.text().await.map_err(|e| e.to_string())?;
    serde_json::from_str::<GithubRelease>(&payload).map_err(|e| e.to_string())
}

fn release_msi_url(release: &GithubRelease) -> Option<String> {
    release
        .assets
        .iter()
        .find(|asset| asset.name.eq_ignore_ascii_case(MSI_ASSET_NAME))
        .map(|asset| asset.browser_download_url.clone())
}

async fn download_installer(
    client: &reqwest::Client,
    download_url: &str,
    target_path: &Path,
) -> Result<(), String> {
    let response = client
        .get(download_url)
        .header("Accept", "application/octet-stream")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !response.status().is_success() {
        return Err(format!(
            "Installer download failed with status {}",
            response.status()
        ));
    }

    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    std::fs::write(target_path, &bytes).map_err(|e| e.to_string())
}

fn run_installer_and_exit(app: &AppHandle, installer_path: &Path) -> Result<(), String> {
    let installer = installer_path
        .to_str()
        .ok_or_else(|| "Installer path is not valid UTF-8".to_string())?;

    Command::new("msiexec")
        .args(["/i", installer, "/passive", "/norestart"])
        .spawn()
        .map_err(|e| e.to_string())?;

    app.exit(0);
    Ok(())
}

async fn check_for_startup_update(app: AppHandle) {
    // Never auto-update in development/debug runs (e.g. `cargo tauri dev`).
    if cfg!(debug_assertions) {
        return;
    }

    if !cfg!(target_os = "windows") {
        return;
    }

    let current_version = app.package_info().version.to_string();

    let client = match reqwest::Client::builder()
        .user_agent("BloxChat-Updater/1.0")
        .build()
    {
        Ok(client) => client,
        Err(err) => {
            eprintln!("updater disabled: failed to build HTTP client: {err}");
            return;
        }
    };

    let latest_release = match fetch_latest_release(&client).await {
        Ok(release) => release,
        Err(err) => {
            eprintln!("updater failed: {err}");
            return;
        }
    };

    let latest_version = normalize_version(&latest_release.tag_name);
    let current_normalized = normalize_version(&current_version);
    let should_update = is_newer_version(&latest_version, &current_normalized);

    if !should_update {
        return;
    }

    let Some(msi_url) = release_msi_url(&latest_release) else {
        eprintln!("updater skipped: release missing {MSI_ASSET_NAME}");
        return;
    };

    let installer_path = std::env::temp_dir().join(format!("BloxChat-{latest_version}.msi"));
    if let Err(err) = download_installer(&client, &msi_url, &installer_path).await {
        eprintln!("updater failed to download installer: {err}");
        return;
    }

    match run_installer_and_exit(&app, &installer_path) {
        Ok(()) => {}
        Err(err) => {
            eprintln!("updater failed to launch installer: {err}");
        }
    }
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn get_default_roblox_logs_path() -> String {
    default_roblox_logs_path().to_string_lossy().to_string()
}

#[tauri::command]
fn get_roblox_logs_path(state: tauri::State<LogSettingsState>) -> Result<String, String> {
    let path = state.logs_path.lock().map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn set_roblox_logs_path(
    path: String,
    state: tauri::State<LogSettingsState>,
) -> Result<String, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Path cannot be empty".to_string());
    }

    let next_path = PathBuf::from(trimmed);
    if !next_path.is_dir() {
        return Err("Path must be an existing directory".to_string());
    }

    {
        let mut current = state.logs_path.lock().map_err(|e| e.to_string())?;
        *current = next_path.clone();
    }

    if let Some(tx) = state
        .watcher_control
        .lock()
        .map_err(|e| e.to_string())?
        .as_ref()
    {
        let _ = tx.send(next_path.clone());
    }

    Ok(next_path.to_string_lossy().to_string())
}

#[tauri::command]
fn should_steal_focus(app: tauri::AppHandle) -> bool {
    unsafe {
        let hwnd: HWND = GetForegroundWindow();

        if hwnd.0 == std::ptr::null_mut() {
            return false;
        }

        for window in app.webview_windows().values() {
            let win_hwnd = window.hwnd().unwrap();

            if win_hwnd.0 == hwnd.0 {
                return true;
            }
        }

        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));

        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if handle.is_err() {
            return false;
        }
        let handle = handle.unwrap();

        let mut buffer = [0u16; MAX_PATH as usize];
        let mut size = buffer.len() as u32;

        if QueryFullProcessImageNameW(
            handle,
            windows::Win32::System::Threading::PROCESS_NAME_FORMAT(0),
            windows_strings::PWSTR(&mut buffer[0]),
            &mut size,
        )
        .is_err()
        {
            return false;
        }

        let exe = OsString::from_wide(&buffer[..size as usize])
            .to_string_lossy()
            .to_lowercase();

        exe.contains("robloxplayerbeta.exe")
    }
}

#[tauri::command]
fn focus_roblox() -> bool {
    const CLASS_NAME: &[u16] = &[
        b'R' as u16,
        b'o' as u16,
        b'b' as u16,
        b'l' as u16,
        b'o' as u16,
        b'x' as u16,
        b'A' as u16,
        b'p' as u16,
        b'p' as u16,
        0,
    ];
    const WINDOW_TITLE: &[u16] = &[
        b'R' as u16,
        b'o' as u16,
        b'b' as u16,
        b'l' as u16,
        b'o' as u16,
        b'x' as u16,
        0,
    ];

    unsafe {
        let class_name_pcw = PCWSTR(CLASS_NAME.as_ptr());
        let window_title_pcw = PCWSTR(WINDOW_TITLE.as_ptr());

        let hwnd = FindWindowW(class_name_pcw, PCWSTR::null()).unwrap_or_else(|_| {
            FindWindowW(PCWSTR::null(), window_title_pcw).unwrap_or(HWND(std::ptr::null_mut()))
        });

        if hwnd.0 == std::ptr::null_mut() {
            return false;
        }

        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }

        SetForegroundWindow(hwnd).as_bool()
    }
}

#[tauri::command]
async fn is_image(url: String) -> Result<MediaProbe, String> {
    let client = reqwest::Client::new();
    let initial_probe = probe_media_url(&client, &url).await;
    if initial_probe.displayable {
        return Ok(initial_probe);
    }

    if let Some(resolved_media_url) =
        resolve_media_url_from_html(&client, &initial_probe.final_url).await
    {
        let resolved_probe = probe_media_url(&client, &resolved_media_url).await;
        if resolved_probe.displayable {
            return Ok(resolved_probe);
        }
    }

    Ok(initial_probe)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaProbe {
    displayable: bool,
    kind: String,
    final_url: String,
}

fn classify_media_from_content_type(content_type: &str) -> Option<&'static str> {
    let normalized = content_type.split(';').next().unwrap_or("").trim();
    if normalized.starts_with("image/") {
        return Some("image");
    }

    if normalized.starts_with("video/") {
        return Some("video");
    }

    None
}

fn classify_media_from_url_path(url: &str) -> Option<&'static str> {
    let path = reqwest::Url::parse(url).ok()?.path().to_string();
    let file_name = path.rsplit('/').next().unwrap_or("").to_ascii_lowercase();
    let ext = file_name.rsplit('.').next().unwrap_or("");
    if ext == file_name {
        return None;
    }

    match ext {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg" | "avif" | "apng" => Some("image"),
        "mp4" | "webm" | "mov" | "gifv" => Some("video"),
        _ => None,
    }
}

async fn probe_media_url(client: &reqwest::Client, url: &str) -> MediaProbe {
    let mut final_url = url.to_string();
    let mut content_type: Option<String> = None;

    if let Ok(head_resp) = client.head(url).send().await {
        final_url = head_resp.url().to_string();
        if let Some(value) = head_resp.headers().get(CONTENT_TYPE) {
            if let Ok(value_str) = value.to_str() {
                content_type = Some(value_str.to_ascii_lowercase());
            }
        }
    }

    if content_type.is_none() {
        if let Ok(get_resp) = client.get(url).header(RANGE, "bytes=0-4096").send().await {
            final_url = get_resp.url().to_string();
            if let Some(value) = get_resp.headers().get(CONTENT_TYPE) {
                if let Ok(value_str) = value.to_str() {
                    content_type = Some(value_str.to_ascii_lowercase());
                }
            }
        }
    }

    if let Some(kind) = content_type
        .as_deref()
        .and_then(classify_media_from_content_type)
    {
        return MediaProbe {
            displayable: true,
            kind: kind.to_string(),
            final_url,
        };
    }

    if let Some(kind) =
        classify_media_from_url_path(&final_url).or_else(|| classify_media_from_url_path(url))
    {
        return MediaProbe {
            displayable: true,
            kind: kind.to_string(),
            final_url,
        };
    }

    MediaProbe {
        displayable: false,
        kind: "none".to_string(),
        final_url,
    }
}

async fn resolve_media_url_from_html(client: &reqwest::Client, url: &str) -> Option<String> {
    let response = client.get(url).send().await.ok()?;
    let response_url = response.url().clone();
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_default();

    if !content_type.contains("text/html") {
        return None;
    }

    let body = response.text().await.ok()?;
    extract_media_url_from_meta_tags(&body, &response_url)
}

fn extract_media_url_from_meta_tags(html: &str, base_url: &reqwest::Url) -> Option<String> {
    let meta_tag_regex = Regex::new(r"(?is)<meta\s+[^>]*>").ok()?;
    let content_regex = Regex::new(r#"(?i)\bcontent\s*=\s*["']([^"']+)["']"#).ok()?;
    let media_keys = [
        "og:video",
        "og:video:url",
        "og:image",
        "og:image:url",
        "twitter:image",
        "twitter:image:src",
        "twitter:player:stream",
    ];

    for meta_tag_match in meta_tag_regex.find_iter(html) {
        let tag = meta_tag_match.as_str();
        let lower_tag = tag.to_ascii_lowercase();
        if !media_keys.iter().any(|key| lower_tag.contains(key)) {
            continue;
        }

        let Some(content) = content_regex
            .captures(tag)
            .and_then(|caps| caps.get(1))
            .map(|capture| capture.as_str().trim())
            .filter(|value| !value.is_empty() && !value.starts_with("data:"))
        else {
            continue;
        };

        if let Ok(parsed) = reqwest::Url::parse(content) {
            return Some(parsed.to_string());
        }

        if let Ok(joined) = base_url.join(content) {
            return Some(joined.to_string());
        }
    }

    None
}

fn start_log_watcher(
    app: AppHandle,
    initial_path: PathBuf,
    path_updates_rx: mpsc::Receiver<PathBuf>,
) {
    std::thread::spawn(move || {
        let re_join = Regex::new(r"Joining game '([a-f0-9\-]+)'").unwrap();
        let re_leave =
            Regex::new(r"Disconnect from game|leaveGameInternal|leaveUGCGameInternal").unwrap();
        let mut log_dir = initial_path;

        loop {
            let (tx, rx) = mpsc::channel();
            let mut watcher = match RecommendedWatcher::new(
                move |res| {
                    let _ = tx.send(res);
                },
                Config::default().with_poll_interval(std::time::Duration::from_secs(1)),
            ) {
                Ok(w) => w,
                Err(e) => {
                    eprintln!("failed to create watcher: {:?}", e);
                    std::thread::sleep(std::time::Duration::from_secs(1));
                    continue;
                }
            };

            if watcher
                .watch(&log_dir, RecursiveMode::NonRecursive)
                .is_err()
            {
                std::thread::sleep(std::time::Duration::from_secs(1));
                if let Ok(next_path) = path_updates_rx.try_recv() {
                    log_dir = next_path;
                }
                continue;
            }

            let mut last_file: Option<PathBuf> = None;
            let mut last_pos: u64 = 0;
            let mut last_job_id: Option<String> = None;

            if let Ok(entries) = std::fs::read_dir(&log_dir) {
                if let Some(latest_file) = entries
                    .filter_map(|e| e.ok())
                    .filter(|e| e.path().to_string_lossy().contains("_Player"))
                    .max_by_key(|e| e.metadata().ok().and_then(|m| m.modified().ok()))
                {
                    last_file = Some(latest_file.path().clone());

                    if let Ok(file) = File::open(latest_file.path()) {
                        let mut reader = BufReader::new(file);
                        for line_result in reader.by_ref().lines().flatten() {
                            if let Some(caps) = re_join.captures(&line_result) {
                                last_job_id = Some(caps[1].to_string());
                            } else if re_leave.is_match(&line_result) {
                                last_job_id = None;
                            }
                        }
                        last_pos = reader.get_ref().metadata().map(|m| m.len()).unwrap_or(0);
                    }
                }
            }

            if let Some(job_id) = &last_job_id {
                let _ = app.emit("new-job-id", job_id);
            }

            let mut should_rebuild = false;
            while !should_rebuild {
                if let Ok(next_path) = path_updates_rx.try_recv() {
                    log_dir = next_path;
                    should_rebuild = true;
                    continue;
                }

                match rx.recv_timeout(std::time::Duration::from_millis(500)) {
                    Ok(Ok(event)) => {
                        if let EventKind::Modify(_) = event.kind {
                            if let Some(path) = event.paths.get(0) {
                                if !path.to_string_lossy().contains("_Player") {
                                    continue;
                                }

                                if last_file.as_ref() != Some(path) {
                                    last_file = Some(path.clone());
                                    last_pos = 0;
                                }

                                if let Ok(file) = File::open(path) {
                                    let mut reader = BufReader::new(file);
                                    let _ = reader.seek(SeekFrom::Start(last_pos));

                                    for line_result in reader.by_ref().lines().flatten() {
                                        if let Some(caps) = re_join.captures(&line_result) {
                                            let job_id = caps[1].to_string();
                                            let _ = app.emit("new-job-id", &job_id);
                                        } else if re_leave.is_match(&line_result) {
                                            let _ = app.emit("new-job-id", &"global");
                                        }
                                    }

                                    last_pos = reader
                                        .get_ref()
                                        .metadata()
                                        .map(|m| m.len())
                                        .unwrap_or(last_pos);
                                }
                            }
                        }
                    }
                    Ok(Err(e)) => {
                        eprintln!("watch error: {:?}", e);
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => return,
                }
            }
        }
    });
}

fn start_key_listener(app: AppHandle) {
    std::thread::spawn(move || {
        let callback = move |event: Event| {
            if let EventType::KeyPress(key) = event.event_type {
                let key_name = format!("{key:?}");
                let _ = app.emit("key-pressed", key_name);
            }
        };

        if let Err(err) = listen(callback) {
            eprintln!("Error in global shortcut listener: {:?}", err);
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();
    let initial_logs_path = default_roblox_logs_path();
    let (watcher_control_tx, watcher_control_rx) = mpsc::channel::<PathBuf>();

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let _ = app.emit("single-instance", argv);
        }));
    }

    builder
        .manage(LogSettingsState {
            logs_path: Mutex::new(initial_logs_path.clone()),
            watcher_control: Mutex::new(Some(watcher_control_tx)),
        })
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_app_exit::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            tauri::async_runtime::spawn(check_for_startup_update(app.handle().clone()));
            start_log_watcher(
                app.handle().clone(),
                initial_logs_path.clone(),
                watcher_control_rx,
            );
            start_key_listener(app.handle().clone());
            #[cfg(desktop)]
            app.deep_link().register("bloxchat")?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            should_steal_focus,
            focus_roblox,
            is_image,
            get_default_roblox_logs_path,
            get_roblox_logs_path,
            set_roblox_logs_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
