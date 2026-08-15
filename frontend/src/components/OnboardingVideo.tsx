/**
 * The introduction video, and the one component that plays it.
 *
 * Used in two places — the first-run modal and the Guide page — which is the
 * whole reason it is a component: the controls, the keyboard handling and the
 * "what happens when it ends" behaviour are identical in both, and two copies
 * would drift the first time one of them was fixed.
 *
 * **Custom controls over `controls`.** The native control bar is drawn by the
 * operating system: it ignores the product's type and colour, it looks
 * different on every platform, and there is no way to put "Skip video" or
 * "Continue" inside it. `controls` is still offered as an escape hatch for the
 * Guide page, where fullscreen and scrubbing matter more than the chrome
 * matching — see `nativeControls`.
 *
 * The asset is imported rather than hardcoded as a path so Vite fingerprints it
 * and a re-encoded video cannot be served from a stale cache.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import videoSrc from "../video/tinnitus_introduction.mp4";
import {
  IconPause,
  IconPlay,
  IconReplay,
  IconVolume,
  IconVolumeOff,
} from "./icons";

export { videoSrc };

/** `93` → "1:33". */
function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function OnboardingVideo({
  autoPlay = false,
  nativeControls = false,
  onEnded,
  className = "",
}: {
  autoPlay?: boolean;
  /**
   * Use the browser's own control bar instead of the custom one. The Guide
   * page turns this on: it is a reference screen where a user may want to
   * scrub, change speed or go fullscreen, and reimplementing all of that
   * badly is worse than a control bar that does not match the type.
   */
  nativeControls?: boolean;
  onEnded?(): void;
  className?: string;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(autoPlay);
  const [elapsed, setElapsed] = useState(0);
  const [duration, setDuration] = useState(0);
  const [failed, setFailed] = useState(false);

  /**
   * Autoplay, and cope with the browser refusing.
   *
   * Chrome and Safari block autoplay with sound until the page has been
   * interacted with. Starting muted is what makes it allowed — the mute button
   * is then the first thing the user is likely to press, which is a normal
   * interaction and unblocks audio. If it is refused even muted, the promise
   * rejects and we fall back to a paused video with a visible play button
   * rather than a black rectangle that appears broken.
   */
  useEffect(() => {
    if (!autoPlay) return;
    const node = ref.current;
    if (!node) return;
    node.muted = true;
    void node.play().then(
      () => setPlaying(true),
      () => setPlaying(false)
    );
  }, [autoPlay]);

  const toggle = useCallback(() => {
    const node = ref.current;
    if (!node) return;
    if (node.paused) void node.play().then(() => setPlaying(true), () => undefined);
    else {
      node.pause();
      setPlaying(false);
    }
  }, []);

  const toggleMute = useCallback(() => {
    const node = ref.current;
    if (!node) return;
    node.muted = !node.muted;
    setMuted(node.muted);
  }, []);

  const replay = useCallback(() => {
    const node = ref.current;
    if (!node) return;
    node.currentTime = 0;
    void node.play().then(() => setPlaying(true), () => undefined);
  }, []);

  const progress = duration > 0 ? (elapsed / duration) * 100 : 0;

  return (
    <div className={`videoplayer ${className}`}>
      <div className="videoplayer__frame">
        {failed ? (
          <div className="videoplayer__fallback">
            <p className="meta">{t("video.unavailable")}</p>
          </div>
        ) : (
          <video
            ref={ref}
            className="videoplayer__el"
            src={videoSrc}
            controls={nativeControls}
            playsInline
            preload="metadata"
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => {
              setPlaying(false);
              onEnded?.();
            }}
            onTimeUpdate={(e) => setElapsed(e.currentTarget.currentTime)}
            onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
            onError={() => setFailed(true)}
            aria-label={t("video.label")}
          />
        )}
      </div>

      {!nativeControls && !failed && (
        <div className="videoplayer__bar">
          <button
            type="button"
            className="btn btn--sm btn--icon"
            onClick={toggle}
            aria-label={t(playing ? "video.pause" : "video.play")}
            title={t(playing ? "video.pause" : "video.play")}
          >
            {playing ? <IconPause size={15} /> : <IconPlay size={15} />}
          </button>

          <button
            type="button"
            className="btn btn--sm btn--icon"
            onClick={toggleMute}
            aria-label={t(muted ? "video.unmute" : "video.mute")}
            title={t(muted ? "video.unmute" : "video.mute")}
          >
            {muted ? <IconVolumeOff size={15} /> : <IconVolume size={15} />}
          </button>

          <button
            type="button"
            className="btn btn--sm btn--icon"
            onClick={replay}
            aria-label={t("video.replay")}
            title={t("video.replay")}
          >
            <IconReplay size={15} />
          </button>

          {/* A progress bar, not a scrubber. Seeking is what `nativeControls`
              is for; here it is a read-out of how much is left, which is the
              question someone deciding whether to skip is actually asking. */}
          <div
            className="videoplayer__track"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={Math.round(duration)}
            aria-valuenow={Math.round(elapsed)}
            aria-label={t("video.progress")}
          >
            <span className="videoplayer__fill" style={{ width: `${progress}%` }} />
          </div>

          <span className="videoplayer__time mono">
            {clock(elapsed)} / {clock(duration)}
          </span>
        </div>
      )}
    </div>
  );
}

export default OnboardingVideo;
