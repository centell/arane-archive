import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
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

  // idle 순환
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

  // 다운로드 시작 → 문열어 2.5초 후 진행률 기반으로 전환
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

  // 진행률 추적
  useEffect(() => {
    if (status !== "downloading" || !progress) return;

    // 영상 하나 완료 → 박수 flash
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

  // 완료 순환
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

  // 에러
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

function formatDate(d: string | null): string {
  if (!d || d.length !== 8) return "";
  return `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6, 8)}`;
}

export default function App() {
  const [selected, setSelected] = useState<Set<string>>(new Set(VIDEOS.map((v) => v.id)));
  const [outputDir, setOutputDir] = useState(() => localStorage.getItem("outputDir") ?? "");
  const [quality, setQuality] = useState("best");
  const [status, setStatus] = useState<DownloadStatus>("idle");
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [doneIds, setDoneIds] = useState<Set<string>>(new Set());

  const emote = useCharacterEmote(status, progress);

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

    return () => {
      unlistenProgress.then((f) => f());
      unlistenError.then((f) => f());
    };
  }, []);

  function toggleAll() {
    if (selected.size === VIDEOS.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(VIDEOS.map((v) => v.id)));
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
    setDoneIds(new Set());
    const videoIds = VIDEOS.filter((v) => selected.has(v.id)).map((v) => v.id);
    try {
      await invoke("download_videos", { videoIds, outputDir, quality });
    } catch (e) {
      setErrorMsg(String(e));
      setStatus("error");
    }
  }

  function handleReset() {
    setStatus("idle");
    setProgress(null);
    setErrorMsg("");
    setDoneIds(new Set());
  }

  async function handleSelectFolder() {
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir === "string") {
      setOutputDir(dir);
      localStorage.setItem("outputDir", dir);
    }
  }

  const isDownloading = status === "downloading";
  const allSelected = selected.size === VIDEOS.length;
  const canDownload = !isDownloading && outputDir.trim() !== "" && selected.size > 0;
  const currentVideo = progress ? VIDEOS.find((v) => v.id === progress.videoId) : null;

  return (
    <div className="app">
      <header className="header">
        <div className="header-title">
          {TITLE_IMAGES.map((img) => (
            <img key={img.alt} src={img.src} alt={img.alt} className="title-sticker" />
          ))}
          <span className="title-sub">아카이브</span>
        </div>
        <p className="header-desc">🍒🖤 마녀님의 추억을 소중히 보관해요 · 영상 {VIDEOS.length}개</p>
      </header>

      <div className="layout">
        <div className="video-panel">
          <div className="video-panel-header">
            <span className="panel-title">영상 목록</span>
            <button className="select-all-btn" onClick={toggleAll} disabled={isDownloading}>
              {allSelected ? "전체 해제" : "전체 선택"}
            </button>
            <span className="select-count">{selected.size}/{VIDEOS.length}</span>
          </div>
          <div className="video-list">
            {VIDEOS.map((video) => {
              const isDone = doneIds.has(video.id);
              const isCurrent = progress?.videoId === video.id && isDownloading;
              return (
                <div
                  key={video.id}
                  className={`video-item ${selected.has(video.id) ? "selected" : ""} ${isDone ? "done" : ""} ${isCurrent ? "current" : ""}`}
                  onClick={() => !isDownloading && toggleOne(video.id)}
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
                    {isDone && <div className="thumb-done">🖤</div>}
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
          </div>
        </div>

        <div className="side-panel">
          <div className="character-area">
            <img
              src={emote}
              alt="status"
              className="character-emote"
              key={emote}
            />
          </div>

          <div className="form">
            <div className="field">
              <label className="field-label">저장 경로</label>
              <div className="folder-row">
                <button
                  className="folder-btn"
                  onClick={handleSelectFolder}
                  disabled={isDownloading}
                >
                  {outputDir ? (
                    <span className="folder-path">{outputDir}</span>
                  ) : (
                    <span className="folder-placeholder">📁 폴더 선택...</span>
                  )}
                </button>
                {outputDir && (
                  <button
                    className="folder-open-btn"
                    onClick={() => openPath(outputDir).then(() => console.log("열기 성공")).catch((e) => console.error("열기 실패:", e))}
                    title="폴더 열기"
                  >
                    ↗
                  </button>
                )}
              </div>
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

            <button className="download-btn" onClick={handleDownload} disabled={!canDownload}>
              {isDownloading ? (
                <>
                  <img src="/emotes/araneA03_응원2.gif" alt="" className="btn-emote" />
                  다운로드 중...
                </>
              ) : (
                <>🍒 {selected.size}개 다운로드</>
              )}
            </button>
          </div>

          {isDownloading && progress && (
            <div className="progress-area">
              <div className="progress-queue">
                {progress.current} / {progress.total}
              </div>
              {currentVideo && (
                <p className="progress-video-title">{currentVideo.title}</p>
              )}
              <div className="progress-bar-wrap">
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
                <p>🖤 모두 완료!</p>
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
