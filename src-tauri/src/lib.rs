use serde::Serialize;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

struct DownloadState {
    cancel: Arc<AtomicBool>,
    current_child: Mutex<Option<CommandChild>>,
}

impl DownloadState {
    fn new() -> Self {
        Self {
            cancel: Arc::new(AtomicBool::new(false)),
            current_child: Mutex::new(None),
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    percent: f32,
    speed: String,
    eta: String,
    status: String,
    current: usize,
    total: usize,
    video_id: String,
}

fn parse_progress(line: &str) -> Option<(f32, String, String)> {
    if !line.contains("[download]") {
        return None;
    }
    let percent = {
        let start = line.find(char::is_numeric)?;
        let end = line[start..].find('%')? + start;
        line[start..end].trim().parse::<f32>().ok()?
    };
    let speed = if let Some(at_pos) = line.find(" at ") {
        let after_at = &line[at_pos + 4..];
        let end = after_at.find(' ').unwrap_or(after_at.len());
        after_at[..end].trim().to_string()
    } else {
        String::new()
    };
    let eta = if let Some(eta_pos) = line.find("ETA ") {
        let after_eta = &line[eta_pos + 4..];
        let end = after_eta
            .find(|c: char| c == '\n' || c == '\r')
            .unwrap_or(after_eta.len());
        after_eta[..end].trim().to_string()
    } else {
        String::new()
    };
    Some((percent, speed, eta))
}

fn quality_to_format(quality: &str) -> &str {
    match quality {
        "1080p" => "bestvideo[height<=1080]+bestaudio/best[height<=1080]",
        "720p" => "bestvideo[height<=720]+bestaudio/best[height<=720]",
        "480p" => "bestvideo[height<=480]+bestaudio/best[height<=480]",
        _ => "bestvideo+bestaudio/best",
    }
}

#[tauri::command]
fn cancel_download(state: tauri::State<'_, DownloadState>) {
    println!("[cancel] cancel_download 호출됨");
    state.cancel.store(true, Ordering::SeqCst);
    if let Ok(mut child) = state.current_child.lock() {
        if let Some(c) = child.take() {
            println!("[cancel] 프로세스 kill 시도");
            let result = c.kill();
            println!("[cancel] kill 결과: {:?}", result);
        } else {
            println!("[cancel] current_child가 None — kill 불가");
        }
    }
    // PyInstaller 기반 yt-dlp는 부트로더 + Python 자식 프로세스 구조이므로
    // 부모 kill 만으로는 자식이 살아남을 수 있음 — pkill로 전부 종료
    let _ = std::process::Command::new("pkill")
        .args(["-9", "-f", "yt-dlp-aarch64-apple-darwin"])
        .output();
    println!("[cancel] pkill 완료");
}

#[tauri::command]
fn get_downloaded_ids(output_dir: String) -> Vec<String> {
    let archive_path = format!("{}/arane-archive.txt", output_dir);
    let content = match std::fs::read_to_string(&archive_path) {
        Ok(c) => c,
        Err(_) => return vec![],
    };
    content
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(2, ' ');
            let source = parts.next()?;
            let id = parts.next()?.trim();
            if source == "youtube" {
                Some(id.to_string())
            } else {
                None
            }
        })
        .collect()
}

#[tauri::command]
async fn download_videos(
    app: tauri::AppHandle,
    video_ids: Vec<String>,
    output_dir: String,
    quality: String,
    browser: String,
) -> Result<(), String> {
    let state = app.state::<DownloadState>();
    state.cancel.store(false, Ordering::SeqCst);
    let cancel = state.cancel.clone();

    let format = quality_to_format(&quality);
    let total = video_ids.len();
    let archive_path = format!("{}/arane-archive.txt", output_dir);

    for (i, video_id) in video_ids.iter().enumerate() {
        if cancel.load(Ordering::SeqCst) {
            break;
        }

        let url = format!("https://www.youtube.com/watch?v={}", video_id);
        let current = i + 1;

        let (mut rx, child) = app
            .shell()
            .sidecar("yt-dlp")
            .map_err(|e| e.to_string())?
            .args([
                "-f",
                format,
                "-o",
                &format!("{}/%(title)s.%(ext)s", output_dir),
                "--newline",
                "--no-playlist",
                "--download-archive",
                &archive_path,
                "--cookies-from-browser",
                &browser,
                &url,
            ])
            .spawn()
            .map_err(|e| e.to_string())?;

        {
            let mut c = state.current_child.lock().unwrap();
            *c = Some(child);
        }

        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let line = String::from_utf8_lossy(&bytes);
                    if let Some((percent, speed, eta)) = parse_progress(&line) {
                        app.emit(
                            "download-progress",
                            DownloadProgress {
                                percent,
                                speed,
                                eta,
                                status: "downloading".to_string(),
                                current,
                                total,
                                video_id: video_id.clone(),
                            },
                        )
                        .ok();
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    let line = String::from_utf8_lossy(&bytes);
                    eprintln!("[yt-dlp stderr] {}", line.trim());
                }
                CommandEvent::Terminated(status) => {
                    if cancel.load(Ordering::SeqCst) {
                        break;
                    }
                    if status.code == Some(0) {
                        let final_status = if current == total {
                            "completed"
                        } else {
                            "next"
                        };
                        app.emit(
                            "download-progress",
                            DownloadProgress {
                                percent: 100.0,
                                speed: String::new(),
                                eta: String::new(),
                                status: final_status.to_string(),
                                current,
                                total,
                                video_id: video_id.clone(),
                            },
                        )
                        .ok();
                    } else {
                        app.emit(
                            "download-error",
                            format!("{}번 영상 다운로드 실패", current),
                        )
                        .ok();
                    }
                }
                _ => {}
            }
        }

        {
            let mut c = state.current_child.lock().unwrap();
            *c = None;
        }

        if cancel.load(Ordering::SeqCst) {
            app.emit("download-cancelled", ()).ok();
            break;
        }
    }

    Ok(())
}

// ── yt-dlp 업데이트 ───────────────────────────────────────────────

fn sidecar_path() -> PathBuf {
    let exe = std::env::current_exe().expect("exe path");
    let dir = exe.parent().expect("exe dir");
    dir.join("yt-dlp-aarch64-apple-darwin")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateInfo {
    current: String,
    latest: String,
    has_update: bool,
}

#[tauri::command]
fn get_yt_dlp_version() -> String {
    let path = sidecar_path();
    std::process::Command::new(&path)
        .arg("--version")
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|_| "unknown".to_string())
}

#[tauri::command]
async fn check_yt_dlp_update() -> Result<UpdateInfo, String> {
    let current = get_yt_dlp_version();

    let output = std::process::Command::new("curl")
        .args([
            "-s",
            "-H", "Accept: application/vnd.github+json",
            "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest",
        ])
        .output()
        .map_err(|e| e.to_string())?;

    let json: serde_json::Value =
        serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())?;

    let latest = json["tag_name"]
        .as_str()
        .unwrap_or("unknown")
        .to_string();

    let has_update = latest != "unknown" && latest != current;
    Ok(UpdateInfo { current, latest, has_update })
}

#[tauri::command]
async fn update_yt_dlp(app: tauri::AppHandle, latest_version: String) -> Result<(), String> {
    let url = format!(
        "https://github.com/yt-dlp/yt-dlp/releases/download/{}/yt-dlp_macos",
        latest_version
    );
    let dest = sidecar_path();
    let tmp = dest.with_extension("tmp");

    // 다운로드
    let status = std::process::Command::new("curl")
        .args(["-L", "-f", &url, "-o", tmp.to_str().unwrap()])
        .status()
        .map_err(|e| e.to_string())?;

    if !status.success() {
        return Err("다운로드 실패".to_string());
    }

    // 실행 권한 부여
    std::process::Command::new("chmod")
        .args(["+x", tmp.to_str().unwrap()])
        .status()
        .map_err(|e| e.to_string())?;

    // 교체
    std::fs::rename(&tmp, &dest).map_err(|e| e.to_string())?;

    app.emit("yt-dlp-updated", latest_version).ok();
    Ok(())
}

// ── 파일명 정규화 ─────────────────────────────────────────────────

/// 파일명을 정규화: 소문자 변환 + 영숫자/한글 외 문자 제거
fn normalize(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric())
        .map(|c| c.to_lowercase().next().unwrap_or(c))
        .collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanResult {
    added: usize,
    removed: usize,
}

/// 저장 폴더에서 타이틀에 매칭되는 영상 파일 경로를 반환
#[tauri::command]
fn find_video_file(output_dir: String, title: String) -> Option<String> {
    let norm_title = normalize(&title);
    let entries = std::fs::read_dir(&output_dir).ok()?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let lower = name.to_lowercase();
        if lower.ends_with(".mp4") || lower.ends_with(".mkv") || lower.ends_with(".webm") {
            let stem = name.rsplitn(2, '.').last().unwrap_or(&name).to_string();
            let norm_stem = normalize(&stem);
            if norm_stem.contains(&norm_title) || norm_title.contains(&norm_stem) {
                return Some(format!("{}/{}", output_dir, name));
            }
        }
    }
    None
}

/// 저장 폴더를 스캔해서 arane-archive.txt를 양방향 동기화:
/// - 파일이 있으나 archive에 없는 ID → 추가
/// - archive에 있으나 파일이 없는 ID → 제거
#[tauri::command]
fn scan_and_update_archive(
    output_dir: String,
    video_titles: Vec<(String, String)>, // (id, title)
) -> Result<ScanResult, String> {
    let archive_path = format!("{}/arane-archive.txt", output_dir);

    // 저장 폴더의 영상 파일 목록 수집
    let entries = std::fs::read_dir(&output_dir).map_err(|e| e.to_string())?;
    let mut file_names: Vec<String> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let lower = name.to_lowercase();
        if lower.ends_with(".mp4") || lower.ends_with(".mkv") || lower.ends_with(".webm") {
            // 확장자 제거
            let stem = name.rsplitn(2, '.').last().unwrap_or(&name).to_string();
            file_names.push(stem);
        }
    }

    // 정규화된 파일명 set
    let norm_files: Vec<String> = file_names.iter().map(|n| normalize(n)).collect();

    // archive 기존 내용 읽기
    let existing_ids: HashSet<String> = if let Ok(content) = std::fs::read_to_string(&archive_path) {
        content
            .lines()
            .filter_map(|line| {
                let mut parts = line.splitn(2, ' ');
                let source = parts.next()?;
                let id = parts.next()?.trim().to_string();
                if source == "youtube" { Some(id) } else { None }
            })
            .collect()
    } else {
        HashSet::new()
    };

    // 파일 매칭으로 발견된 ID set
    let mut found_ids: HashSet<String> = HashSet::new();
    for (id, title) in &video_titles {
        let norm_title = normalize(title);
        if norm_files.iter().any(|nf| nf.contains(&norm_title) || norm_title.contains(nf.as_str())) {
            found_ids.insert(id.clone());
        }
    }

    // 추가: 파일에 있으나 archive에 없는 것
    let added_ids: Vec<&String> = found_ids.difference(&existing_ids).collect();
    // 제거: archive에 있으나 파일에 없는 것
    let removed_ids: HashSet<&String> = existing_ids.difference(&found_ids).collect();

    let added = added_ids.len();
    let removed = removed_ids.len();

    // 새 archive 내용 구성 (기존 유지 + 추가)
    let mut new_lines: Vec<String> = existing_ids
        .iter()
        .filter(|id| !removed_ids.contains(id))
        .map(|id| format!("youtube {}", id))
        .collect();
    for id in &added_ids {
        new_lines.push(format!("youtube {}", id));
    }
    new_lines.sort();

    std::fs::write(&archive_path, new_lines.join("\n") + "\n").map_err(|e| e.to_string())?;

    Ok(ScanResult { added, removed })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(DownloadState::new())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            download_videos,
            cancel_download,
            get_downloaded_ids,
            scan_and_update_archive,
            find_video_file,
            get_yt_dlp_version,
            check_yt_dlp_update,
            update_yt_dlp,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
