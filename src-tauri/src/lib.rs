use serde::Serialize;
use tauri::Emitter;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandEvent;

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
    // [download]  37.4% of   1.45GiB at  4.32MiB/s ETA 02:47
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
        let end = after_eta.find(|c: char| c == '\n' || c == '\r').unwrap_or(after_eta.len());
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
async fn download_videos(
    app: tauri::AppHandle,
    video_ids: Vec<String>,
    output_dir: String,
    quality: String,
) -> Result<(), String> {
    let format = quality_to_format(&quality);
    let total = video_ids.len();

    for (i, video_id) in video_ids.iter().enumerate() {
        let url = format!("https://www.youtube.com/watch?v={}", video_id);
        let current = i + 1;

        let (mut rx, _child) = app
            .shell()
            .sidecar("yt-dlp")
            .map_err(|e| e.to_string())?
            .args([
                "-f", format,
                "-o", &format!("{}/%(title)s.%(ext)s", output_dir),
                "--newline",
                "--no-playlist",
                &url,
            ])
            .spawn()
            .map_err(|e| e.to_string())?;

        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let line = String::from_utf8_lossy(&bytes);
                    if let Some((percent, speed, eta)) = parse_progress(&line) {
                        app.emit("download-progress", DownloadProgress {
                            percent,
                            speed,
                            eta,
                            status: "downloading".to_string(),
                            current,
                            total,
                            video_id: video_id.clone(),
                        }).ok();
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    let line = String::from_utf8_lossy(&bytes);
                    app.emit("download-error", line.trim()).ok();
                }
                CommandEvent::Terminated(status) => {
                    if status.code == Some(0) {
                        app.emit("download-progress", DownloadProgress {
                            percent: 100.0,
                            speed: String::new(),
                            eta: String::new(),
                            status: if current == total { "completed".to_string() } else { "next".to_string() },
                            current,
                            total,
                            video_id: video_id.clone(),
                        }).ok();
                    } else {
                        app.emit("download-error", format!("{}번 영상 다운로드 실패", current)).ok();
                    }
                }
                _ => {}
            }
        }
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![download_videos])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
