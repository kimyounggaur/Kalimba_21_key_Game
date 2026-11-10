import { audio, normalizeEventTimestamp } from "./audio";
import type { TimingMode } from "./audio";
import { ChallengeJudge, WaitEngine } from "./judgment";
import type { Song } from "../domain/content";
export type PlayMode = "free" | "listen" | "wait" | "challenge";
export type PlayState =
  "ready" | "loading" | "countin" | "playing" | "paused" | "result" | "error";
export interface SessionConfig {
  song: Song;
  mode: PlayMode;
  tempo: number;
  offsetMs: number;
  metronome: boolean;
  policy: "sequential" | "together";
  startTick?: number;
  endTick?: number;
  loop?: boolean;
}
export interface SessionView {
  state: PlayState;
  tick: number;
  count: number;
  feedback: string;
  progress: number;
  eventIndex: number;
  reason?: string;
}
/** Musical time comes only from audio clocks. UI callbacks never accumulate elapsed beats. */
export class Session {
  config: SessionConfig;
  judge: ChallengeJudge;
  wait: WaitEngine;
  state: PlayState = "ready";
  tick = 0;
  count = 0;
  interrupted = 0;
  degraded = false;
  epoch = 0;
  readonly assistFlags = new Set<string>();
  timingMode: TimingMode | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private anchor = 0;
  private cursor = 0;
  private beatCursor = 0;
  private waitLast = 0;
  private waitClock = 0;
  private resumeTick = 0;
  private finished = false;
  private disposed = false;
  private lastFeedback = "";
  private lastFeedbackAt = 0;
  private clockTempo: number;
  private clockPolicy: "sequential" | "together";
  onChange: (v: SessionView) => void = () => {};
  onFinish: () => void = () => {};
  constructor(config: SessionConfig) {
    this.config = config;
    this.clockTempo = config.tempo;
    this.clockPolicy = config.policy;
    this.judge = new ChallengeJudge(config.song, config.tempo);
    this.wait = this.makeWait();
    this.resumeTick = config.startTick ?? 0;
    if (
      (config.startTick ?? 0) > 0 ||
      config.endTick !== undefined ||
      config.loop
    )
      this.assistFlags.add("section-seek");
  }
  private makeWait() {
    return new WaitEngine(this.config.song.events, {
      policy: this.config.policy,
      chordWindowMs: 400,
      bpm: this.config.song.bpm * this.config.tempo,
    });
  }
  private seconds(tick: number) {
    return ((tick / 480) * 60) / (this.config.song.bpm * this.config.tempo);
  }
  private feedback(message: string) {
    this.lastFeedback = message;
    this.lastFeedbackAt = Date.now();
  }
  private snapshot(reason?: string) {
    if (this.disposed) return;
    this.onChange({
      state: this.state,
      tick: this.tick,
      count: this.count,
      feedback:
        Date.now() - this.lastFeedbackAt < 1000 ? this.lastFeedback : "",
      progress:
        this.config.mode === "wait"
          ? this.wait.progress
          : Math.max(0, Math.min(1, this.tick / this.config.song.totalTicks)),
      eventIndex: this.wait.currentIndex,
      reason,
    });
  }
  async start(resuming = false) {
    if (this.disposed) return;
    const token = ++this.epoch;
    this.clearTimer();
    this.state = "loading";
    this.snapshot();
    try {
      await audio.unlock();
      await audio.prepare();
      if (token !== this.epoch || this.disposed) return;
      const nextMode = audio.freezeTimingMode();
      if (this.timingMode !== null && this.timingMode !== nextMode) {
        this.config.offsetMs = 0;
        this.degraded = true;
        this.assistFlags.add("timing-fallback");
        this.feedback(
          "출력 시계가 바뀌어 보정을 0ms로 시작해요. 다시 보정할 수 있어요.",
        );
      }
      this.timingMode = nextMode;
      if (this.clockTempo !== this.config.tempo) {
        // Old target times cannot be mixed with the new tempo's score. Restart the selected range cleanly.
        this.judge = new ChallengeJudge(this.config.song, this.config.tempo);
        this.wait = this.makeWait();
        this.resumeTick = this.config.startTick ?? 0;
        this.clockTempo = this.config.tempo;
        this.clockPolicy = this.config.policy;
        this.assistFlags.add("tempo-change");
        this.feedback("속도가 바뀌어 선택한 곡이나 구간을 처음부터 연주해요.");
      } else if (this.clockPolicy !== this.config.policy) {
        this.wait = this.makeWait();
        this.clockPolicy = this.config.policy;
      }
      this.begin(resuming);
    } catch (error) {
      if (token !== this.epoch || this.disposed) return;
      this.clearTimer();
      audio.stop();
      this.state = "error";
      this.snapshot(
        error instanceof Error
          ? error.message
          : "소리를 준비하지 못했어요. 다시 시도해 주세요.",
      );
    }
  }
  private begin(resuming = false) {
    audio.stop();
    this.finished = false;
    const { mode, song } = this.config;
    const beat = 60 / (song.bpm * this.config.tempo);
    this.tick = this.resumeTick;
    this.anchor =
      audio.currentTime() + 0.15 + beat * 4 - this.seconds(this.resumeTick);
    this.cursor = song.events.findIndex((e) => e.tick >= this.resumeTick);
    if (this.cursor < 0) this.cursor = song.events.length;
    this.beatCursor = this.resumeTick / 480 - 4;
    this.waitClock = 0;
    if (mode === "free") {
      this.state = "playing";
      this.count = 0;
    } else if (mode === "wait") {
      this.wait.resetSegment(this.resumeTick);
      this.waitLast = audio.heardTime();
      this.state = resuming ? "countin" : "playing";
      this.count = resuming ? 4 : 0;
      if (!resuming) this.wait.advance(0);
    } else {
      this.state = "countin";
      this.count = 4;
    }
    this.clearTimer();
    this.interval = setInterval(() => this.update(), 25);
    this.snapshot();
  }
  private scheduleBeats(now: number, end: number) {
    while (
      this.beatCursor * 480 < end &&
      this.anchor + this.seconds(this.beatCursor * 480) < now + 0.1
    ) {
      const when = this.anchor + this.seconds(this.beatCursor * 480);
      if (
        when >= now - 0.01 &&
        (this.beatCursor * 480 < this.resumeTick || this.config.metronome)
      )
        audio.click(Math.max(now, when), this.beatCursor % 4 === 0);
      this.beatCursor++;
    }
  }
  private update() {
    if (this.disposed || (this.state !== "playing" && this.state !== "countin"))
      return;
    if (audio.context?.state !== "running") {
      this.pause("소리가 중단되었어요. 준비가 되면 이어서 연주해요.");
      return;
    }
    try {
      this.updateRunning();
    } catch (error) {
      this.clockFailure(error);
    }
  }
  private updateRunning() {
    const { song, mode, tempo, loop } = this.config;
    const end = this.config.endTick ?? song.totalTicks;
    if (mode === "free") {
      this.snapshot();
      return;
    }
    const now = audio.currentTime();
    const heard = audio.heardTime();
    const position = heard - this.anchor;
    const correctedPosition = position - this.config.offsetMs / 1000;
    // Visible count-in uses heard output time, while matching and finalization use corrected time.
    if (mode === "wait") {
      if (this.state === "countin") {
        this.scheduleBeats(now, this.resumeTick);
        this.count = Math.min(
          4,
          Math.max(
            0,
            Math.ceil(
              (this.seconds(this.resumeTick) - position) /
                (60 / (song.bpm * tempo)),
            ),
          ),
        );
        if (this.count > 0) {
          this.snapshot();
          return;
        }
        this.state = "playing";
        this.waitLast = heard;
        this.wait.advance(0);
      }
      this.waitClock += Math.max(0, (heard - this.waitLast) * 1000);
      this.waitLast = heard;
      this.wait.advance(this.waitClock);
      this.tick = this.wait.currentEvent?.tick ?? song.totalTicks;
      if (this.completeWaitRange()) return;
      this.snapshot();
      return;
    }
    this.tick = Math.max(
      this.resumeTick,
      ((position * song.bpm * tempo) / 60) * 480,
    );
    this.count = Math.min(
      4,
      Math.max(
        0,
        Math.ceil(
          (this.seconds(this.resumeTick) - position) /
            (60 / (song.bpm * tempo)),
        ),
      ),
    );
    if (this.count === 0) this.state = "playing";
    this.scheduleBeats(now, end);
    if (mode === "listen")
      while (this.cursor < song.events.length) {
        const e = song.events[this.cursor];
        if (e.tick >= end) break;
        const when = this.anchor + this.seconds(e.tick);
        if (when > now + 0.1) break;
        if (when >= now - 0.02)
          for (const midi of e.midi)
            audio.play(midi, Math.max(now, when), "demo");
        this.cursor++;
      }
    if (mode === "challenge") this.judge.advance(correctedPosition * 1000);
    const final =
      mode === "challenge" && end === song.totalTicks
        ? this.judge.finalTimeMs / 1000
        : this.seconds(end) + 0.1;
    if ((mode === "challenge" ? correctedPosition : position) >= final) {
      if (loop) {
        this.resumeTick = this.config.startTick ?? 0;
        this.judge.truncateFromTick(this.resumeTick);
        this.begin();
      } else this.finish();
      return;
    }
    this.snapshot();
  }
  private completeWaitRange() {
    const end = this.config.endTick ?? this.config.song.totalTicks;
    if (!this.wait.completed && this.tick < end) return false;
    if (this.config.loop) {
      this.wait.resetSegment(this.config.startTick ?? 0);
      this.waitClock = 0;
      this.wait.advance(0);
      this.tick = this.wait.currentEvent?.tick ?? this.config.song.totalTicks;
      this.snapshot();
    } else this.finish();
    return true;
  }
  pluck(midi: number, perfMs: number) {
    if (
      this.disposed ||
      (this.state !== "playing" && this.state !== "countin") ||
      this.config.mode === "listen"
    )
      return;
    try {
      const receivedPerfMs = performance.now();
      const normalized = normalizeEventTimestamp(perfMs, receivedPerfMs);
      if (normalized.timingQuality === "fallback") {
        this.degraded = true;
        this.assistFlags.add("timing-fallback");
      }
      if (this.config.mode === "challenge") {
        const delivery = receivedPerfMs - normalized.perfMs;
        if (delivery > 100) {
          this.degraded = true;
          this.assistFlags.add("timing-fallback");
          this.pause(
            "입력 전달이 지연되어 잠시 멈췄어요. 이 구간부터 다시 시작해요.",
          );
          return;
        }
        const t =
          (audio.eventTime(normalized.perfMs) - this.anchor) * 1000 -
          this.config.offsetMs;
        const f = this.judge.tap(midi, t, crypto.randomUUID());
        if (f.requiresRestart) {
          this.degraded = true;
          this.assistFlags.add("timing-fallback");
          this.pause(
            "입력 시각을 확인하려고 잠시 멈췄어요. 이 구간부터 다시 시작해요.",
          );
          return;
        }
        this.feedback(
          f.status === "hit"
            ? f.grade === "perfect"
              ? "정확해요!"
              : "좋아요!"
            : f.status === "wrong"
              ? f.reason === "rest"
                ? "쉼표에서는 새 음을 치지 않아요."
                : "음과 박자를 다시 확인해요."
              : "",
        );
      } else if (this.config.mode === "wait" && this.state === "playing") {
        const heard = audio.heardTime();
        this.waitClock += Math.max(0, (heard - this.waitLast) * 1000);
        this.waitLast = heard;
        const f = this.wait.tap(midi, this.waitClock);
        this.tick = this.wait.currentEvent?.tick ?? this.config.song.totalTicks;
        this.feedback(
          f.status === "wrong"
            ? f.reason === "rest"
              ? "쉼표를 한 번 더 쉬어볼까요?"
              : "괜찮아요. 빛나는 음을 찾아볼까요?"
            : f.status === "hit"
              ? "잘 찾았어요!"
              : "",
        );
        if (this.completeWaitRange()) return;
      }
      this.snapshot();
    } catch (error) {
      this.clockFailure(error);
    }
  }
  private clockFailure(error: unknown) {
    this.degraded = true;
    this.assistFlags.add("timing-fallback");
    this.pause(
      error instanceof Error
        ? error.message
        : "오디오 시계를 확인하려고 잠시 멈췄어요.",
    );
  }
  pause(reason = "잠시 쉬어 가도 괜찮아요.") {
    if (this.disposed || (this.state !== "playing" && this.state !== "countin"))
      return;
    // A user can pause just across a section boundary between two UI updates.
    if (this.config.mode === "challenge" || this.config.mode === "listen") {
      try {
        this.tick = Math.max(
          this.resumeTick,
          (((audio.heardTime() - this.anchor) *
            this.config.song.bpm *
            this.config.tempo) /
            60) *
            480,
        );
      } catch {
        /* A clock failure uses the last reliable visible tick. */
      }
    }
    this.interrupted++;
    this.assistFlags.add("pause-restart");
    const end = this.config.endTick ?? this.config.song.totalTicks;
    const boundedTick = Math.min(Math.max(0, this.tick), Math.max(0, end - 1));
    this.resumeTick = Math.max(
      this.config.startTick ?? 0,
      Math.floor(boundedTick / 3840) * 3840,
    );
    this.judge.truncateFromTick(this.resumeTick);
    this.state = "paused";
    this.epoch++;
    this.clearTimer();
    audio.stop();
    this.snapshot(reason);
  }
  async resume() {
    await this.start(true);
  }
  private finish() {
    if (this.finished || this.disposed) return;
    this.finished = true;
    this.state = "result";
    this.clearTimer();
    if (this.config.mode !== "wait") audio.stop();
    this.snapshot();
    this.onFinish();
  }
  private clearTimer() {
    if (this.interval !== null) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }
  dispose() {
    this.disposed = true;
    this.finished = true;
    this.epoch++;
    this.clearTimer();
    audio.stop();
    audio.releaseTimingMode();
  }
}
