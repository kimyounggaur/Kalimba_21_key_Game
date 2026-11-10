import { physicalMidi as AUDIO_MIDIS } from "../domain/content";
export { AUDIO_MIDIS };
export type TimingMode = "output-timestamp" | "render-clock";
export type AudioRole = "instrument" | "demo" | "metronome";
export type AudioState = "idle" | "loading" | "ready" | "error";
export type CalibrationResult =
  | { ok: true; offsetMs: number; madMs: number; validCount: number }
  | { ok: false; reason: string; validCount: number };

export const MAX_VOICES = 32;
export const STOP_FADE_SEC = 0.015;

export function median(values: number[]): number {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[i]! : (sorted[i - 1]! + sorted[i]!) / 2;
}

/** Input is 16 raw (tap - target) deltas in ms, including the first 4 warm-up taps. */
export function calibrateOffsets(taps: number[]): CalibrationResult {
  if (taps.length !== 16 || taps.some((v) => !Number.isFinite(v)))
    return {
      ok: false,
      reason: "16번의 유효한 탭을 측정해 주세요.",
      validCount: 0,
    };
  const samples = taps.slice(4);
  const initial = median(samples);
  const valid = samples.filter((v) => Math.abs(v - initial) < 250);
  if (valid.length < 8)
    return {
      ok: false,
      reason: "일정한 탭이 부족해요. 출력 장치를 확인하고 다시 해 주세요.",
      validCount: valid.length,
    };
  const offsetMs = median(valid);
  const madMs = median(valid.map((v) => Math.abs(v - offsetMs)));
  if (madMs > 60)
    return {
      ok: false,
      reason: "탭 간격의 차이가 커요. 다시 측정해 주세요.",
      validCount: valid.length,
    };
  if (Math.abs(offsetMs) > 250)
    return {
      ok: false,
      reason: "지연이 커요. 스피커·유선 출력을 확인하고 다시 해 주세요.",
      validCount: valid.length,
    };
  return { ok: true, offsetMs, madMs, validCount: valid.length };
}

export interface ClockSample {
  contextTime: number;
  performanceTime: number;
}
export function validOutputTimestamp(
  sample: ClockSample,
  perfNow: number,
  contextNow: number,
): boolean {
  return (
    Number.isFinite(sample.contextTime) &&
    Number.isFinite(sample.performanceTime) &&
    sample.contextTime > 0 &&
    sample.performanceTime > 0 &&
    Math.abs(perfNow - sample.performanceTime) < 2000 &&
    sample.contextTime <= contextNow + 0.1 &&
    contextNow - sample.contextTime < 2
  );
}
export function mapPerformanceTime(
  eventPerfMs: number,
  sample: ClockSample,
): number {
  return sample.contextTime + (eventPerfMs - sample.performanceTime) / 1000;
}
export function normalizeEventTimestamp(
  timestamp: number,
  receivedPerfMs: number,
): { perfMs: number; timingQuality: "normal" | "fallback" } {
  // Epoch-based timestamps or values from another time origin are not performance-clock timestamps.
  if (
    !Number.isFinite(timestamp) ||
    timestamp < 0 ||
    timestamp > receivedPerfMs + 100 ||
    receivedPerfMs - timestamp > 60_000
  )
    return { perfMs: receivedPerfMs, timingQuality: "fallback" };
  return { perfMs: timestamp, timingQuality: "normal" };
}

interface Voice {
  source: AudioScheduledSourceNode;
  gain: GainNode;
  start: number;
  duration: number;
  epoch: number;
}

/** Owns one context, decoded sample cache, and every scheduled source (including future sources). */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private gains: Record<AudioRole, GainNode> | null = null;
  private buffers = new Map<number, AudioBuffer>();
  private voices = new Set<Voice>();
  private loadPromise: Promise<void> | null = null;
  private frozenMode: TimingMode | null = null;
  private lastOutput: ClockSample | null = null;
  private volume = 0.6;
  private epoch = 0;
  state: AudioState = "idle";
  loaded = 0;
  error: string | null = null;
  onStateChange?: () => void;

  get context(): AudioContext | null {
    return this.ctx;
  }
  get ready(): boolean {
    return this.state === "ready" && this.ctx?.state === "running";
  }
  get activeVoices(): number {
    return this.voices.size;
  }
  get timingMode(): TimingMode {
    return (
      this.frozenMode ??
      (this.outputSample() ? "output-timestamp" : "render-clock")
    );
  }
  currentTime(): number {
    return this.ctx?.currentTime ?? 0;
  }

  private notify(): void {
    this.onStateChange?.();
  }
  private ensureContext(): AudioContext {
    if (this.ctx) return this.ctx;
    const AudioCtor =
      globalThis.AudioContext ??
      (globalThis as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioCtor)
      throw new Error("이 브라우저는 Web Audio를 지원하지 않아요.");
    const ctx = new AudioCtor({ latencyHint: "interactive" });
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.knee.value = 6;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.12;
    this.master.connect(limiter).connect(ctx.destination);
    const make = (value: number) => {
      const g = ctx.createGain();
      g.gain.value = value;
      g.connect(this.master!);
      return g;
    };
    this.gains = {
      instrument: make(1),
      demo: make(0.7),
      metronome: make(0.25),
    };
    ctx.addEventListener("statechange", () => {
      if (ctx.state !== "running") this.stop();
      this.notify();
    });
    return ctx;
  }

  /** Call from the original user gesture; context creation/resume happens before the first await. */
  async unlock(): Promise<void> {
    try {
      const ctx = this.ensureContext();
      const resume = ctx.state === "running" ? Promise.resolve() : ctx.resume();
      await resume;
      if (ctx.state !== "running") throw new Error("소리를 다시 켜 주세요.");
      await this.prepare();
    } catch (error) {
      this.state = "error";
      this.error =
        error instanceof Error ? error.message : "소리를 켜지 못했어요.";
      this.notify();
      throw error;
    }
  }

  async prepare(): Promise<void> {
    if (this.buffers.size === AUDIO_MIDIS.length) {
      this.state = "ready";
      this.notify();
      return;
    }
    if (this.loadPromise) return this.loadPromise;
    const ctx = this.ensureContext();
    this.state = "loading";
    this.error = null;
    this.notify();
    this.loadPromise = Promise.all(
      AUDIO_MIDIS.map(async (midi) => {
        if (this.buffers.has(midi)) return;
        const response = await fetch(`/audio/${midi}.wav`);
        if (
          !response.ok ||
          response.headers.get("content-type")?.includes("text/html")
        )
          throw new Error(
            `음원 ${midi}를 불러오지 못했어요. 다시 불러와 주세요.`,
          );
        const bytes = await response.arrayBuffer();
        const buffer = await ctx.decodeAudioData(bytes);
        if (!buffer.length || !Number.isFinite(buffer.duration))
          throw new Error(`음원 ${midi}가 손상됐어요.`);
        this.buffers.set(midi, buffer);
        this.loaded = this.buffers.size;
        this.notify();
      }),
    )
      .then(() => {
        this.state = "ready";
        this.error = null;
        this.notify();
      })
      .catch((error) => {
        this.state = "error";
        this.error =
          error instanceof Error ? error.message : "소리를 준비하지 못했어요.";
        this.notify();
        throw error;
      })
      .finally(() => {
        this.loadPromise = null;
      });
    return this.loadPromise;
  }

  setVolume(value: number): void {
    this.volume = Math.max(0, Math.min(1, value));
    if (this.master && this.ctx)
      this.master.gain.setTargetAtTime(
        this.volume,
        this.ctx.currentTime,
        0.015,
      );
  }

  private discard(voice: Voice, now: number): void {
    this.voices.delete(voice);
    if (voice.start > now) {
      try {
        voice.source.stop(now);
      } catch {
        /* already ended */
      }
      return;
    }
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
    voice.gain.gain.linearRampToValueAtTime(0, now + STOP_FADE_SEC);
    try {
      voice.source.stop(now + STOP_FADE_SEC);
    } catch {
      /* already ended */
    }
  }

  private track(
    source: AudioScheduledSourceNode,
    gain: GainNode,
    start: number,
    duration: number,
  ): void {
    const now = this.currentTime();
    if (this.voices.size >= MAX_VOICES) {
      // Old, decaying sources first; future scheduled notes are not discarded before old tails.
      const candidates = [...this.voices].sort((a, b) => {
        const aFuture = a.start > now ? 1 : 0,
          bFuture = b.start > now ? 1 : 0;
        return aFuture - bFuture || a.start - b.start;
      });
      this.discard(candidates[0]!, now);
    }
    const voice: Voice = { source, gain, start, duration, epoch: this.epoch };
    this.voices.add(voice);
    source.onended = () => {
      this.voices.delete(voice);
      source.disconnect();
      gain.disconnect();
    };
  }

  play(midi: number, when?: number, role: AudioRole = "instrument"): void {
    const ctx = this.ctx,
      buffer = this.buffers.get(midi);
    if (!ctx || !this.gains || !this.ready)
      throw new Error("소리 켜기를 먼저 눌러 주세요.");
    if (!buffer) throw new Error(`등록되지 않은 음: ${midi}`);
    const start = Math.max(ctx.currentTime, when ?? ctx.currentTime);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = 0.72;
    source.connect(gain).connect(this.gains[role]);
    this.track(source, gain, start, buffer.duration);
    source.start(start);
  }

  click(when?: number, accent = false): void {
    const ctx = this.ctx;
    if (!ctx || !this.gains || ctx.state !== "running") return;
    const start = Math.max(ctx.currentTime, when ?? ctx.currentTime);
    const source = ctx.createOscillator();
    source.type = "sine";
    source.frequency.value = accent ? 1400 : 950;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.linearRampToValueAtTime(0.7, start + 0.001);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.045);
    source.connect(gain).connect(this.gains.metronome);
    this.track(source, gain, start, 0.05);
    source.start(start);
    source.stop(start + 0.05);
  }

  stop(): void {
    this.epoch += 1;
    const now = this.currentTime();
    for (const voice of [...this.voices]) this.discard(voice, now);
  }

  private outputSample(): ClockSample | null {
    const ctx = this.ctx;
    if (
      !ctx ||
      ctx.state !== "running" ||
      typeof ctx.getOutputTimestamp !== "function"
    )
      return null;
    const stamp = ctx.getOutputTimestamp();
    const sample: ClockSample = {
      contextTime: stamp.contextTime ?? NaN,
      performanceTime: stamp.performanceTime ?? NaN,
    };
    if (!validOutputTimestamp(sample, performance.now(), ctx.currentTime))
      return null;
    this.lastOutput = sample;
    return sample;
  }

  freezeTimingMode(): TimingMode {
    this.frozenMode = this.outputSample() ? "output-timestamp" : "render-clock";
    return this.frozenMode;
  }
  releaseTimingMode(): void {
    this.frozenMode = null;
    this.lastOutput = null;
  }

  private clockSample(): ClockSample {
    const now = performance.now();
    if (this.timingMode === "output-timestamp") {
      const sample = this.outputSample();
      if (sample) return sample;
      // Keep the selected clock for this attempt. Stale samples are an explicit recoverable error.
      if (this.lastOutput && now - this.lastOutput.performanceTime < 2000)
        return this.lastOutput;
      throw new Error(
        "오디오 시계가 중단됐어요. 잠시 멈춘 뒤 다시 시작해 주세요.",
      );
    }
    return { contextTime: this.currentTime(), performanceTime: now };
  }

  heardTime(): number {
    return mapPerformanceTime(performance.now(), this.clockSample());
  }
  eventTime(eventPerfMs: number): number {
    return mapPerformanceTime(eventPerfMs, this.clockSample());
  }
}

export const audio = new AudioEngine();
