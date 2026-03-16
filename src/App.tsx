import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import videosData from "./data/videos.json";
import "./App.css";

type DownloadStatus = "idle" | "downloading" | "completed" | "error";

interface Video {
  id: string;
  title: string;
  duration: number | null;
  upload_date: string | null;
  thumbnail: string | null;
}

interface DownloadProgress {
  percent: number;
  speed: string;
  eta: string;
  status: string;
  current: number;
  total: number;
  videoId: string;
}

const VIDEOS: Video[] = videosData as Video[];

const TITLE_IMAGES = [
  { src: "/emotes/arane11_아.png", alt: "아" },
  { src: "/emotes/arane12_라.png", alt: "라" },
  { src: "/emotes/arane13_네.png", alt: "네" },
];

const IDLE_CYCLE = [
  "/emotes/araneA07_빗자루.gif",
  "/emotes/araneA08_마법의약.gif",
  "/emotes/araneA_question.png",
];
const DONE_CYCLE = [
  "/emotes/araneA02_박수.gif",
  "/emotes/araneA04_웃음.gif",
  "/emotes/araneA06_flex.gif",
];

function getProgressEmote(percent: number): string {
  if (percent < 33) return "/emotes/araneA01_응원1.gif";
  if (percent < 66) return "/emotes/araneA03_응원2.gif";
  return "/emotes/araneA09_응원3.gif";
}

function useCharacterEmote(status: DownloadStatus, progress: DownloadProgress | null): string {
  const [emote, setEmote] = useState(IDLE_CYCLE[0]);
  const phaseRef = useRef<"idle" | "intro" | "progress" | "flash" | "done" | "error">("idle");
  const prevVideoIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (status !== "idle") return;
    phaseRef.current = "idle";
    let idx = 0;
    setEmote(IDLE_CYCLE[0]);
    const tick = setInterval(() => {
      if (phaseRef.current !== "idle") return;
      idx = (idx + 1) % IDLE_CYCLE.length;
      setEmote(IDLE_CYCLE[idx]);
    }, 3500);
    return () => clearInterval(tick);
  }, [status]);

  useEffect(() => {
    if (status !== "downloading") return;
    phaseRef.current = "intro";
    prevVideoIdRef.current = null;
    setEmote("/emotes/araneA05_문열어_네아.gif");
    const t = setTimeout(() => {
      if (phaseRef.current === "intro") {
        phaseRef.current = "progress";
        setEmote(getProgressEmote(progress?.percent ?? 0));
      }
    }, 2500);
    return () => clearTimeout(t);
  }, [status]);

  useEffect(() => {
    if (status !== "downloading" || !progress) return;
    if (progress.status === "next" && progress.videoId !== prevVideoIdRef.current) {
      prevVideoIdRef.current = progress.videoId;
      phaseRef.current = "flash";
      setEmote("/emotes/araneA02_박수.gif");
      setTimeout(() => {
        if (phaseRef.current === "flash") {
          phaseRef.current = "progress";
          setEmote(getProgressEmote(0));
        }
      }, 1500);
      return;
    }
    if (phaseRef.current === "progress") {
      setEmote(getProgressEmote(progress.percent));
    }
  }, [progress, status]);

  useEffect(() => {
    if (status !== "completed") return;
    phaseRef.current = "done";
    let idx = 0;
    setEmote(DONE_CYCLE[0]);
    const t = setInterval(() => {
      idx = (idx + 1) % DONE_CYCLE.length;
      setEmote(DONE_CYCLE[idx]);
    }, 2000);
    return () => clearInterval(t);
  }, [status]);

  useEffect(() => {
    if (status !== "error") return;
    phaseRef.current = "error";
    setEmote("/emotes/arane02_슬픔.png");
  }, [status]);

  return emote;
}

function formatDuration(seconds: number | null): string {
  if (!seconds) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatHoursMinutes(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}시간 ${m}분`;
  return `${m}분`;
}

function formatDate(d: string | null): string {
  if (!d || d.length !== 8) return "";
  return `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6, 8)}`;
}

function IconX() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.73-8.835L1.254 2.25H8.08l4.259 5.63 5.905-5.63zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

function IconYouTube() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
    </svg>
  );
}

export default function App() {
  const [selected, setSelected] = useState<Set<string>>(new Set(VIDEOS.map((v) => v.id)));
  const [outputDir, setOutputDir] = useState(() => localStorage.getItem("outputDir") ?? "");
  const [quality, setQuality] = useState("best");
  const [browser, setBrowser] = useState(() => localStorage.getItem("browser") ?? "safari");
  const [status, setStatus] = useState<DownloadStatus>("idle");
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [doneIds, setDoneIds] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [scanResult, setScanResult] = useState<{ added: number; removed: number } | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [ytdlpVersion, setYtdlpVersion] = useState("");
  const [updateInfo, setUpdateInfo] = useState<{ current: string; latest: string; hasUpdate: boolean } | null>(null);
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [updateDone, setUpdateDone] = useState(false);

  const emote = useCharacterEmote(status, progress);

  useEffect(() => {
    invoke<string>("get_yt_dlp_version").then(setYtdlpVersion);
  }, []);

  // 폴더 변경 시 이미 받은 영상 감지
  useEffect(() => {
    if (!outputDir) return;
    console.log("[scan] 폴더 스캔 시작:", outputDir);
    invoke<string[]>("get_downloaded_ids", { outputDir })
      .then((ids) => {
        console.log("[scan] 감지된 영상 수:", ids.length, ids);
        if (ids.length === 0) return;
        const idSet = new Set(ids);
        setDoneIds(idSet);
        setSelected((prev) => {
          const next = new Set(prev);
          idSet.forEach((id) => next.delete(id));
          return next;
        });
      })
      .catch((e) => console.error("[scan] 실패:", e));
  }, [outputDir]);

  useEffect(() => {
    const unlistenProgress = listen<DownloadProgress>("download-progress", (event) => {
      const p = event.payload;
      setProgress(p);
      if (p.status === "next") {
        setDoneIds((prev) => new Set([...prev, p.videoId]));
      }
      if (p.status === "completed") {
        setDoneIds((prev) => new Set([...prev, p.videoId]));
        setStatus("completed");
      }
    });
    const unlistenError = listen<string>("download-error", (event) => {
      setErrorMsg(event.payload);
      setStatus("error");
    });
    const unlistenCancelled = listen("download-cancelled", () => {
      setStatus("idle");
      setProgress(null);
      setIsCancelling(false);
    });
    return () => {
      unlistenProgress.then((f) => f());
      unlistenError.then((f) => f());
      unlistenCancelled.then((f) => f());
    };
  }, []);

  function toggleAll() {
    const undone = VIDEOS.filter((v) => !doneIds.has(v.id)).map((v) => v.id);
    if (selected.size === undone.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(undone));
    }
  }

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function handleDownload() {
    if (!outputDir.trim() || selected.size === 0) return;
    setStatus("downloading");
    setProgress(null);
    setErrorMsg("");
    const videoIds = VIDEOS.filter((v) => selected.has(v.id)).map((v) => v.id);
    try {
      await invoke("download_videos", { videoIds, outputDir, quality, browser });
    } catch (e) {
      setErrorMsg(String(e));
      setStatus("error");
    }
  }

  function handleCancel() {
    setIsCancelling(true);
    invoke("cancel_download").catch((e) => console.error("[cancel] 실패:", e));
  }

  async function handleCheckUpdate() {
    setIsCheckingUpdate(true);
    setUpdateDone(false);
    try {
      const info = await invoke<{ current: string; latest: string; hasUpdate: boolean }>("check_yt_dlp_update", { current: ytdlpVersion });
      setUpdateInfo(info);
    } catch (e) {
      console.error("[update] 확인 실패:", e);
    } finally {
      setIsCheckingUpdate(false);
    }
  }

  async function handleUpdate() {
    if (!updateInfo) return;
    setIsUpdating(true);
    try {
      await invoke("update_yt_dlp", { latestVersion: updateInfo.latest });
      setYtdlpVersion(updateInfo.latest);
      setUpdateInfo(null);
      setUpdateDone(true);
    } catch (e) {
      console.error("[update] 업데이트 실패:", e);
    } finally {
      setIsUpdating(false);
    }
  }

  async function handleOpenVideo(video: Video) {
    if (!outputDir) return;
    try {
      const path = await invoke<string | null>("find_video_file", {
        outputDir,
        title: video.title,
      });
      if (path) {
        openPath(path);
      } else {
        openPath(outputDir);
      }
    } catch (e) {
      console.error("[open-video] 실패:", e);
    }
  }

  async function handleScan() {
    if (!outputDir) return;
    setIsScanning(true);
    setScanResult(null);
    try {
      const videoTitles = VIDEOS.map((v) => [v.id, v.title] as [string, string]);
      const result = await invoke<{ added: number; removed: number }>("scan_and_update_archive", {
        outputDir,
        videoTitles,
      });
      setScanResult(result);
      // archive 갱신 후 doneIds 다시 로드
      const ids = await invoke<string[]>("get_downloaded_ids", { outputDir });
      const idSet = new Set(ids);
      setDoneIds(idSet);
      setSelected((prev) => {
        const next = new Set(prev);
        idSet.forEach((id) => next.delete(id));
        return next;
      });
    } catch (e) {
      console.error("[scan] 실패:", e);
    } finally {
      setIsScanning(false);
    }
  }

  function handleReset() {
    setStatus("idle");
    setProgress(null);
    setErrorMsg("");
    setIsCancelling(false);
  }

  async function handleSelectFolder() {
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir === "string") {
      setOutputDir(dir);
      localStorage.setItem("outputDir", dir);
    }
  }

  const isDownloading = status === "downloading";
  const filteredVideos = VIDEOS.filter((v) =>
    v.title.toLowerCase().includes(search.toLowerCase())
  );
  const undoneIds = new Set(VIDEOS.filter((v) => !doneIds.has(v.id)).map((v) => v.id));
  const allUndoneSelected = undoneIds.size > 0 && [...undoneIds].every((id) => selected.has(id));
  const canDownload = !isDownloading && outputDir.trim() !== "" && selected.size > 0;
  const currentVideo = progress ? VIDEOS.find((v) => v.id === progress.videoId) : null;

  const overallPercent = progress
    ? ((progress.current - 1 + progress.percent / 100) / progress.total) * 100
    : 0;

  const doneDuration = VIDEOS.filter((v) => doneIds.has(v.id)).reduce(
    (sum, v) => sum + (v.duration ?? 0),
    0
  );

  return (
    <div className="app">
      <header className="header">
        <div className="header-title">
          {TITLE_IMAGES.map((img) => (
            <img key={img.alt} src={img.src} alt={img.alt} className="title-sticker" />
          ))}
          <span className="title-sub">아카이브</span>
          <div className="sns-links">
            <button
              className="sns-btn"
              onClick={() => openUrl("https://x.com/Araneum16")}
              title="아라네 X(트위터)"
            >
              <IconX />
            </button>
            <button
              className="sns-btn"
              onClick={() => openUrl("https://www.youtube.com/@araneum16")}
              title="아라네 유튜브"
            >
              <IconYouTube />
            </button>
          </div>
        </div>
        <p className="header-desc">🍒🖤 마녀과님의 추억을 소중히 보관해요 · 영상 {VIDEOS.length}개</p>
      </header>

      <div className="layout">
        {/* 왼쪽: 영상 목록 */}
        <div className="video-panel">
          <div className="video-panel-header">
            <span className="panel-title">영상 목록</span>
            <input
              className="search-input"
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="검색..."
              disabled={isDownloading}
            />
            <button className="select-all-btn" onClick={toggleAll} disabled={isDownloading}>
              {allUndoneSelected ? "전체 해제" : "전체 선택"}
            </button>
            <span className="select-count">{selected.size}/{VIDEOS.length}</span>
          </div>
          <div className="video-list">
            {filteredVideos.map((video) => {
              const isDone = doneIds.has(video.id);
              const isCurrent = progress?.videoId === video.id && isDownloading;
              return (
                <div
                  key={video.id}
                  className={`video-item ${selected.has(video.id) ? "selected" : ""} ${isDone ? "done" : ""} ${isCurrent ? "current" : ""}`}
                  onClick={() => !isDownloading && !isDone && toggleOne(video.id)}
                >
                  <div className="video-thumb-wrap">
                    {video.thumbnail && (
                      <img src={video.thumbnail} alt="" className="video-thumb" loading="lazy" />
                    )}
                    {isCurrent && (
                      <div className="thumb-overlay">
                        <img src="/emotes/araneA03_응원2.gif" alt="" className="thumb-gif" />
                      </div>
                    )}
                    {isDone && (
                      <button
                        className="thumb-done"
                        onClick={(e) => { e.stopPropagation(); handleOpenVideo(video); }}
                        title="영상 열기"
                      >
                        <img src="/emotes/arane07_팝콘.png" alt="재생" className="thumb-popcorn" />
                      </button>
                    )}
                  </div>
                  <div className="video-info">
                    <p className="video-title">{video.title}</p>
                    <p className="video-meta">
                      {formatDate(video.upload_date)}
                      {video.duration && <span> · {formatDuration(video.duration)}</span>}
                    </p>
                  </div>
                  <div className="video-check">{selected.has(video.id) ? "✓" : ""}</div>
                </div>
              );
            })}
            {filteredVideos.length === 0 && (
              <div className="search-empty">
                <img src="/emotes/araneA_question.png" alt="" style={{ width: 40, opacity: 0.4 }} />
                <p>검색 결과가 없어요</p>
              </div>
            )}
          </div>
        </div>

        {/* 오른쪽 */}
        <div className="side-panel">
          <div className="character-area">
            <img src={emote} alt="status" className="character-emote" key={emote} />
          </div>

          <div className="form">
            <div className="field">
              <label className="field-label">저장 경로</label>
              <div className="folder-row">
                <button className="folder-btn" onClick={handleSelectFolder} disabled={isDownloading}>
                  {outputDir ? (
                    <span className="folder-path">{outputDir}</span>
                  ) : (
                    <span className="folder-placeholder">📁 폴더 선택...</span>
                  )}
                </button>
                {outputDir && (
                  <button
                    className="folder-open-btn"
                    onClick={() => openPath(outputDir)}
                    title="폴더 열기"
                  >
                    ↗
                  </button>
                )}
              </div>
            </div>

            {outputDir && !isDownloading && (
              <button
                className="scan-btn"
                onClick={handleScan}
                disabled={isScanning}
              >
                {isScanning ? "확인 중..." : "✓ 받은 영상 확인"}
              </button>
            )}

            {scanResult && (
              <p className="scan-result">
                {scanResult.added === 0 && scanResult.removed === 0
                  ? "변경사항 없음"
                  : `+${scanResult.added}개 추가 · -${scanResult.removed}개 제거`}
              </p>
            )}

            <div className="field">
              <label className="field-label">브라우저 (쿠키 인증)</label>
              <select
                className="field-select"
                value={browser}
                onChange={(e) => { setBrowser(e.target.value); localStorage.setItem("browser", e.target.value); }}
                disabled={isDownloading}
              >
                <option value="safari">Safari</option>
                <option value="chrome">Chrome</option>
                <option value="firefox">Firefox</option>
                <option value="brave">Brave</option>
                <option value="edge">Edge</option>
                <option value="arc">Arc</option>
              </select>
              <p className="field-hint">선택한 브라우저에서 YouTube에 로그인 후 새로고침 하세요</p>
            </div>

            <div className="field">
              <label className="field-label">화질</label>
              <select
                className="field-select"
                value={quality}
                onChange={(e) => setQuality(e.target.value)}
                disabled={isDownloading}
              >
                <option value="best">최고화질</option>
                <option value="1080p">1080p</option>
                <option value="720p">720p</option>
                <option value="480p">480p</option>
              </select>
            </div>

            <div className="ytdlp-update-row">
              <span className="ytdlp-version">yt-dlp {ytdlpVersion || "..."}</span>
              {updateDone ? (
                <span className="update-done">✓ 최신 버전</span>
              ) : updateInfo?.hasUpdate ? (
                <button className="update-btn" onClick={handleUpdate} disabled={isUpdating}>
                  {isUpdating ? "업데이트 중..." : `→ ${updateInfo.latest}`}
                </button>
              ) : (
                <button className="update-check-btn" onClick={handleCheckUpdate} disabled={isCheckingUpdate || isDownloading}>
                  {isCheckingUpdate ? "확인 중..." : "업데이트 확인"}
                </button>
              )}
            </div>

            {isDownloading ? (
              <button
                className={`cancel-btn ${isCancelling ? "cancelling" : ""}`}
                onClick={handleCancel}
                disabled={isCancelling}
              >
                {isCancelling ? "취소 중..." : "✕ 취소"}
              </button>
            ) : (
              <button className="download-btn" onClick={handleDownload} disabled={!canDownload}>
                🍒 {selected.size}개 다운로드
              </button>
            )}
          </div>

          {isDownloading && progress && (
            <div className="progress-area">
              <div className="overall-progress">
                <span className="overall-label">전체 진행률</span>
                <span className="overall-count">{progress.current} / {progress.total}</span>
              </div>
              <div className="progress-bar-wrap">
                <div className="progress-bar overall" style={{ width: `${overallPercent}%` }} />
              </div>
              {currentVideo && (
                <p className="progress-video-title">{currentVideo.title}</p>
              )}
              <div className="progress-bar-wrap thin">
                <div className="progress-bar" style={{ width: `${progress.percent}%` }} />
              </div>
              <div className="progress-stats">
                <span className="stat">{progress.percent.toFixed(1)}%</span>
                {progress.speed && <span className="stat">⚡ {progress.speed}</span>}
                {progress.eta && <span className="stat">⏱ ETA {progress.eta}</span>}
              </div>
            </div>
          )}

          {status === "completed" && (
            <div className="status-msg success">
              <img src="/emotes/araneA04_웃음.gif" alt="" className="status-emote" />
              <div>
                <p>🖤 백업 완료!</p>
                {doneDuration > 0 && (
                  <p className="stats-text">{formatHoursMinutes(doneDuration)} 분량</p>
                )}
                <button className="reset-btn" onClick={handleReset}>처음으로</button>
              </div>
            </div>
          )}

          {status === "error" && (
            <div className="status-msg error">
              <img src="/emotes/arane02_슬픔.png" alt="" className="status-emote" />
              <div>
                <p>{errorMsg || "오류가 발생했습니다."}</p>
                <button className="reset-btn" onClick={handleReset}>다시 시도</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
