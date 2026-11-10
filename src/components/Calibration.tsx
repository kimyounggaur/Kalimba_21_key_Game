import { useCallback, useEffect, useRef, useState } from "react";
import { Clock3, RotateCcw, X } from "lucide-react";
import {
  audio,
  calibrateOffsets,
  normalizeEventTimestamp,
} from "../engine/audio";
import type { TimingMode } from "../engine/audio";
import { saveCalibration } from "../storage/progress";
import type { CalibrationProfile } from "../storage/progress";

type OutputKind = NonNullable<CalibrationProfile["outputKind"]>;
type Phase =
  "idle" | "preparing" | "running" | "saving" | "done" | "error" | "unsaved";
interface Props {
  onClose: () => void;
  onApplied: (offsetMs: number) => void;
}
interface Measurement {
  start: number;
  taps: Map<number, number>;
  timingMode: TimingMode;
  sampleRate: number;
  outputKind: OutputKind;
  invalidTiming: boolean;
}

export const calibrationProfileId = (
  mode: TimingMode,
  sampleRate: number,
): string => `${mode}:${sampleRate}`;

/** One fresh pointer/key/virtual-click per scheduled beat; no count-based beat assignment. */
export default function Calibration({ onClose, onApplied }: Props) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [count, setCount] = useState(0);
  const [beat, setBeat] = useState(-1);
  const [message, setMessage] = useState(
    "첫 4번은 준비, 다음 12번은 측정해요. 소리에 맞춰 원을 한 번씩 눌러 주세요.",
  );
  const [outputKind, setOutputKind] = useState<OutputKind>("speaker");
  const [savedOffset, setSavedOffset] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const measurement = useRef<Measurement | null>(null);
  const pendingProfile = useRef<CalibrationProfile | null>(null);
  const generation = useRef(0);
  const callbacks = useRef({ onClose, onApplied });
  callbacks.current = { onClose, onApplied };
  const lastPointerPerf = useRef(-Infinity);
  const lastKeyboardPerf = useRef(-Infinity);

  const stopAudio = useCallback(() => {
    if (timer.current !== null) clearInterval(timer.current);
    timer.current = null;
    measurement.current = null;
    audio.stop();
    audio.releaseTimingMode();
  }, []);

  const close = useCallback(() => {
    generation.current += 1;
    stopAudio();
    callbacks.current.onClose();
  }, [stopAudio]);

  useEffect(() => {
    const onHidden = () => {
      if (document.hidden && measurement.current) {
        generation.current += 1;
        stopAudio();
        setPhase("error");
        setMessage("측정이 잠시 중단됐어요. 이 화면에서 다시 측정해 주세요.");
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    };
    document.addEventListener("visibilitychange", onHidden);
    document.addEventListener("keydown", onKey);
    return () => {
      generation.current += 1;
      stopAudio();
      document.removeEventListener("visibilitychange", onHidden);
      document.removeEventListener("keydown", onKey);
    };
  }, [close, stopAudio]);

  const persist = async (profile: CalibrationProfile, token: number) => {
    setPhase("saving");
    setMessage("보정값을 이 기기에 저장하고 있어요.");
    try {
      await saveCalibration(profile);
      if (token !== generation.current) return;
      pendingProfile.current = null;
      setPhase("done");
      setSavedOffset(profile.offsetMs);
      setMessage(
        `보정 완료 · ${Math.round(profile.offsetMs)}ms. 이 출력 경로와 소리 시계에 적용했어요.`,
      );
      callbacks.current.onApplied(profile.offsetMs);
    } catch {
      if (token !== generation.current) return;
      pendingProfile.current = profile;
      setPhase("unsaved");
      setMessage(
        "측정은 끝났지만 보정값을 저장하지 못했어요. 다시 저장할 수 있어요.",
      );
    }
  };

  const finish = (token: number) => {
    const current = measurement.current;
    if (!current || token !== generation.current) return;
    stopAudio();
    if (current.invalidTiming) {
      setPhase("error");
      setMessage(
        "탭의 전달 시각이 불안정했어요. 다른 앱을 닫고 다시 측정해 주세요.",
      );
      return;
    }
    if (current.taps.size !== 16) {
      setPhase("error");
      setMessage(
        `${current.taps.size}/16번을 받았어요. 들리는 각 박자에 한 번씩 눌러 다시 측정해 주세요.`,
      );
      return;
    }
    const values = Array.from({ length: 16 }, (_, i) => current.taps.get(i)!);
    const result = calibrateOffsets(values);
    if (!result.ok) {
      setPhase("error");
      setMessage(result.reason);
      return;
    }
    const profile: CalibrationProfile = {
      id: calibrationProfileId(current.timingMode, current.sampleRate),
      timingMode: current.timingMode,
      sampleRate: current.sampleRate,
      outputKind: current.outputKind,
      offsetMs: result.offsetMs,
      measuredAtISO: new Date().toISOString(),
      madMs: result.madMs,
      validCount: result.validCount,
    };
    pendingProfile.current = profile;
    void persist(profile, token);
  };

  const start = async () => {
    generation.current += 1;
    const token = generation.current;
    stopAudio();
    pendingProfile.current = null;
    setPhase("preparing");
    setCount(0);
    setBeat(-1);
    setSavedOffset(null);
    setMessage("소리를 준비하고 있어요. 준비되면 첫 박자가 들려요.");
    try {
      // This call is directly inside the start/retry user gesture, before any await.
      await audio.unlock();
      if (token !== generation.current) return;
      const mode = audio.freezeTimingMode();
      const current: Measurement = {
        start: audio.currentTime() + 1,
        taps: new Map(),
        timingMode: mode,
        sampleRate: audio.context!.sampleRate,
        outputKind,
        invalidTiming: false,
      };
      measurement.current = current;
      for (let i = 0; i < 16; i++)
        audio.click(current.start + i * 0.75, i % 4 === 0);
      setPhase("running");
      setMessage(
        "소리에 맞춰 한 박자에 한 번씩 눌러 주세요. 처음 4번은 준비예요.",
      );
      timer.current = setInterval(() => {
        if (token !== generation.current) return;
        try {
          if (!audio.ready)
            throw new Error("소리가 중단됐어요. 다시 측정해 주세요.");
          const now = audio.heardTime();
          setBeat(Math.min(15, Math.floor((now - current.start) / 0.75)));
          if (now > current.start + 15 * 0.75 + 0.4) finish(token);
        } catch (error) {
          stopAudio();
          setPhase("error");
          setMessage(
            error instanceof Error
              ? error.message
              : "측정이 중단됐어요. 다시 시도해 주세요.",
          );
        }
      }, 40);
    } catch (error) {
      if (token !== generation.current) return;
      stopAudio();
      setPhase("error");
      setMessage(
        error instanceof Error
          ? error.message
          : "소리를 준비하지 못했어요. 다시 시도해 주세요.",
      );
    }
  };

  const tap = (timestamp: number) => {
    const current = measurement.current;
    if (!current) return;
    const received = performance.now();
    const normalized = normalizeEventTimestamp(timestamp, received);
    if (
      normalized.timingQuality === "fallback" ||
      received - normalized.perfMs > 100
    )
      current.invalidTiming = true;
    try {
      const tapTime = audio.eventTime(normalized.perfMs);
      const index = Math.round((tapTime - current.start) / 0.75);
      if (index < 0 || index >= 16 || current.taps.has(index)) return;
      current.taps.set(
        index,
        (tapTime - (current.start + index * 0.75)) * 1000,
      );
      setCount(current.taps.size);
      if (current.taps.size === 16) finish(generation.current);
    } catch {
      stopAudio();
      setPhase("error");
      setMessage("오디오 시계가 중단됐어요. 다시 측정해 주세요.");
    }
  };

  const active = phase === "running";
  const busy = phase === "preparing" || phase === "saving";
  return (
    <div className="modal-backdrop">
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="calibration-title"
        aria-describedby="calibration-description"
      >
        <button
          className="modal-close icon-button"
          aria-label="보정 닫기"
          onClick={close}
        >
          <X />
        </button>
        <div className="eyebrow">FIND YOUR RHYTHM</div>
        <h2 id="calibration-title">들리는 박자에 맞춰 탭</h2>
        <p id="calibration-description" className="muted" aria-live="polite">
          {message}
        </p>
        <label className="control-label" htmlFor="calibration-output">
          현재 소리 출력
        </label>
        <select
          id="calibration-output"
          disabled={active || busy}
          value={outputKind}
          onChange={(e) => setOutputKind(e.target.value as OutputKind)}
          style={{
            width: "100%",
            padding: 10,
            borderRadius: 8,
            border: "1px solid #d4ddca",
            background: "transparent",
          }}
        >
          <option value="speaker">기기 스피커</option>
          <option value="wired">유선 이어폰</option>
          <option value="bluetooth">Bluetooth</option>
          <option value="unknown">잘 모르겠어요</option>
        </select>
        <button
          type="button"
          className="calibration-tap"
          disabled={!active}
          aria-label={`박자에 맞춰 탭, ${count}번 측정됨`}
          onPointerDown={(e) => {
            lastPointerPerf.current = performance.now();
            tap(e.timeStamp);
          }}
          onKeyDown={(e) => {
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault();
            if (e.repeat) return;
            lastKeyboardPerf.current = performance.now();
            tap(e.timeStamp);
          }}
          onClick={(e) => {
            // Mouse/touch compatibility click has detail>0; keyboard click follows handled keydown.
            const now = performance.now();
            if (
              e.detail === 0 &&
              now - lastPointerPerf.current > 600 &&
              now - lastKeyboardPerf.current > 600
            )
              tap(e.timeStamp);
          }}
        >
          {phase === "done" ? `${Math.round(savedOffset ?? 0)}` : count}
          <small>{phase === "done" ? "ms" : "/ 16 TAP"}</small>
        </button>
        {active && (
          <p
            className="small-note"
            style={{ textAlign: "center", marginBottom: 18 }}
          >
            {beat < 0
              ? "첫 박자를 기다려요"
              : beat < 4
                ? `준비 ${beat + 1} / 4`
                : `측정 ${beat - 3} / 12`}
          </p>
        )}
        {phase === "unsaved" && (
          <button
            className="primary"
            onClick={() => {
              if (pendingProfile.current)
                void persist(pendingProfile.current, generation.current);
            }}
          >
            보정값 다시 저장
          </button>
        )}
        {!active && phase !== "unsaved" && (
          <button
            className={phase === "idle" ? "primary" : "secondary"}
            disabled={busy}
            onClick={() => void start()}
          >
            {phase === "idle" ? "측정 시작" : busy ? "준비 중…" : "다시 측정"}
            {phase === "idle" ? <Clock3 size={16} /> : <RotateCcw size={16} />}
          </button>
        )}
        {active && (
          <button className="secondary" onClick={() => void start()}>
            처음부터 다시 측정
            <RotateCcw size={16} />
          </button>
        )}
        <p className="small-note" style={{ marginTop: 18 }}>
          출력 지연 자체를 줄이는 기능은 아니에요. 출력 장치를 바꾸면 다시
          측정해 주세요. Enter 또는 Space로도 탭할 수 있어요.
        </p>
      </section>
    </div>
  );
}
