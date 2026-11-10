import type { MusicEvent, Song } from "../domain/content";

export const PPQ = 480;
export const PERFECT_MS = 80;
export const GOOD_MS = 160;
export const HIT_WINDOW_MS = 240;
export const CHORD_SPREAD_MS = 100;
export const LATE_DELIVERY_GRACE_MS = 100;
export type Grade = "perfect" | "good" | "hit";
export interface JudgmentFeedback {
  status: "hit" | "wrong" | "ignored" | "waiting";
  grade?: Grade;
  eventId?: string;
  deltaMs?: number;
  reason?: string;
  requiresRestart?: boolean;
}
export interface JudgmentWindow {
  eventId: string;
  tick: number;
  targetMs: number;
  lower: number;
  upper: number;
  last: boolean;
  midi: number[];
}
interface MatchedTap {
  midi: number;
  timeMs: number;
  deltaMs: number;
  inputId: string;
}
interface LoggedTap {
  midi: number;
  timeMs: number;
  inputId: string;
  eventId?: string;
  matched: boolean;
}
export interface SegmentSummary {
  startTick: number;
  endTick: number;
  barIndex: number;
  tp: number;
  fp: number;
  fn: number;
  restTotal: number;
  restPassed: number;
  chordTotal: number;
  chordTogether: number;
}
export interface JudgmentResult {
  tp: number;
  fp: number;
  fn: number;
  totalSlots: number;
  precision: number;
  recall: number;
  pitchF1: number;
  rhythmMean: number | null;
  score: number;
  restTotal: number;
  restPassed: number;
  chordTotal: number;
  chordTogether: number;
  completed: boolean;
  segmentSummaries: SegmentSummary[];
}

export const tickToMs = (tick: number, bpm: number, tempoScale = 1): number =>
  ((tick / PPQ) * 60_000) / (bpm * tempoScale);
export const timingWeight = (deltaMs: number): number =>
  Math.abs(deltaMs) <= PERFECT_MS
    ? 1
    : Math.abs(deltaMs) <= GOOD_MS
      ? 0.7
      : 0.4;
const timingGrade = (deltaMs: number): Grade =>
  Math.abs(deltaMs) <= PERFECT_MS
    ? "perfect"
    : Math.abs(deltaMs) <= GOOD_MS
      ? "good"
      : "hit";

/** Pure relative-time judge. The caller supplies the already corrected audio-output time in ms. */
export class ChallengeJudge {
  readonly windows: JudgmentWindow[];
  readonly finalTimeMs: number;
  readonly songEndMs: number;
  private nowMs = -Infinity;
  private serial = 0;
  private taps: LoggedTap[] = [];
  private seenIds = new Set<string>();
  private matches = new Map<string, MatchedTap[]>();
  private finalized = new Set<string>();

  constructor(
    readonly song: Song,
    readonly tempoScale = 1,
  ) {
    if (!Number.isFinite(tempoScale) || tempoScale <= 0 || song.bpm <= 0) {
      throw new Error("A positive finite tempo is required");
    }
    const sounding = song.events.filter((event) => event.midi.length > 0);
    this.windows = sounding.map((event, i) => {
      const targetMs = tickToMs(event.tick, song.bpm, tempoScale);
      const previous =
        i > 0
          ? tickToMs(sounding[i - 1].tick, song.bpm, tempoScale)
          : -Infinity;
      const next =
        i + 1 < sounding.length
          ? tickToMs(sounding[i + 1].tick, song.bpm, tempoScale)
          : Infinity;
      return {
        eventId: event.id,
        tick: event.tick,
        targetMs,
        lower: Math.max(targetMs - HIT_WINDOW_MS, (previous + targetMs) / 2),
        upper: Math.min(targetMs + HIT_WINDOW_MS, (targetMs + next) / 2),
        last: i === sounding.length - 1,
        midi: [...event.midi],
      };
    });
    this.songEndMs = tickToMs(song.totalTicks, song.bpm, tempoScale);
    this.finalTimeMs =
      Math.max(this.songEndMs, this.windows.at(-1)?.upper ?? 0) +
      LATE_DELIVERY_GRACE_MS;
  }

  tap(
    midi: number,
    timeMs: number,
    inputId = `tap-${++this.serial}`,
  ): JudgmentFeedback {
    if (!Number.isFinite(timeMs) || !Number.isFinite(midi))
      return { status: "ignored", reason: "invalid-input" };
    if (this.seenIds.has(inputId))
      return { status: "ignored", reason: "duplicate-input" };
    const owner = this.windows.find(
      (window) =>
        timeMs >= window.lower &&
        (timeMs < window.upper || (window.last && timeMs === window.upper)),
    );
    // Count-in excludes everything before the first early window. Tail outside a valid window is not scored.
    const beforePlayableCountIn = timeMs < 0 && !owner;
    if (beforePlayableCountIn || (timeMs >= this.songEndMs && !owner)) {
      return {
        status: "ignored",
        reason: beforePlayableCountIn ? "count-in" : "tail",
      };
    }
    if (this.nowMs >= this.finalTimeMs)
      return { status: "ignored", reason: "completed" };
    if (owner && this.finalized.has(owner.eventId)) {
      return {
        status: "ignored",
        reason: "late-delivery",
        requiresRestart: true,
      };
    }
    this.seenIds.add(inputId);
    const consumed = owner ? (this.matches.get(owner.eventId) ?? []) : [];
    const matched = Boolean(
      owner?.midi.includes(midi) && !consumed.some((tap) => tap.midi === midi),
    );
    this.taps.push({ midi, timeMs, inputId, eventId: owner?.eventId, matched });
    if (matched && owner) {
      const deltaMs = timeMs - owner.targetMs;
      consumed.push({ midi, timeMs, deltaMs, inputId });
      this.matches.set(owner.eventId, consumed);
      const worstDelta = consumed.reduce(
        (worst, tap) =>
          Math.abs(tap.deltaMs) > Math.abs(worst) ? tap.deltaMs : worst,
        0,
      );
      return {
        status: "hit",
        grade: timingGrade(worstDelta),
        eventId: owner.eventId,
        deltaMs,
      };
    }
    const inRest = this.song.events.some(
      (event) =>
        !event.midi.length &&
        timeMs >= tickToMs(event.tick, this.song.bpm, this.tempoScale) &&
        timeMs <
          tickToMs(
            event.tick + event.durationTicks,
            this.song.bpm,
            this.tempoScale,
          ),
    );
    return {
      status: "wrong",
      eventId: owner?.eventId,
      reason: inRest ? "rest" : owner ? "wrong-note" : "timing",
    };
  }

  advance(nowMs: number): void {
    if (!Number.isFinite(nowMs)) return;
    this.nowMs = Math.max(this.nowMs, nowMs);
    for (const window of this.windows) {
      if (this.nowMs >= window.upper + LATE_DELIVERY_GRACE_MS)
        this.finalized.add(window.eventId);
    }
  }

  /** Discard only the section being restarted and anything after it; earlier owned taps survive. */
  truncateFromTick(tick: number): void {
    const timeMs = tickToMs(tick, this.song.bpm, this.tempoScale);
    const retainedEvents = new Set(
      this.windows
        .filter((window) => window.tick < tick)
        .map((window) => window.eventId),
    );
    this.taps = this.taps.filter((tap) =>
      tap.matched && tap.eventId
        ? retainedEvents.has(tap.eventId)
        : tap.timeMs < timeMs,
    );
    this.seenIds = new Set(this.taps.map((tap) => tap.inputId));
    for (const id of this.matches.keys())
      if (!retainedEvents.has(id)) this.matches.delete(id);
    for (const id of this.finalized)
      if (!retainedEvents.has(id)) this.finalized.delete(id);
    this.nowMs = timeMs - HIT_WINDOW_MS;
  }

  result(): JudgmentResult {
    const allMatches = [...this.matches.values()].flat();
    const tp = allMatches.length;
    const fp = this.taps.filter((tap) => !tap.matched).length;
    const totalSlots = this.windows.reduce(
      (sum, window) => sum + window.midi.length,
      0,
    );
    const fn = totalSlots - tp;
    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = totalSlots > 0 ? tp / totalSlots : 0;
    const pitchF1 =
      precision + recall > 0
        ? (2 * precision * recall) / (precision + recall)
        : 0;
    const rhythmMean =
      tp > 0
        ? allMatches.reduce((sum, tap) => sum + timingWeight(tap.deltaMs), 0) /
          tp
        : null;
    const restEvents = this.song.events.filter((event) => !event.midi.length);
    const restPassed = (event: MusicEvent): boolean =>
      !this.taps.some(
        (tap) =>
          !tap.matched &&
          tap.timeMs >= tickToMs(event.tick, this.song.bpm, this.tempoScale) &&
          tap.timeMs <
            tickToMs(
              event.tick + event.durationTicks,
              this.song.bpm,
              this.tempoScale,
            ),
      );
    const together = (window: JudgmentWindow): boolean => {
      const taps = this.matches.get(window.eventId) ?? [];
      return (
        taps.length === window.midi.length &&
        Math.max(...taps.map((tap) => tap.timeMs)) -
          Math.min(...taps.map((tap) => tap.timeMs)) <=
          CHORD_SPREAD_MS
      );
    };
    const chords = this.windows.filter((window) => window.midi.length > 1);
    const segmentSummaries: SegmentSummary[] = [];
    for (
      let startTick = 0;
      startTick < this.song.totalTicks;
      startTick += 3840
    ) {
      const endTick = Math.min(startTick + 3840, this.song.totalTicks);
      const windows = this.windows.filter(
        (window) => window.tick >= startTick && window.tick < endTick,
      );
      const eventIds = new Set(windows.map((window) => window.eventId));
      const segmentTaps = this.taps.filter((tap) =>
        tap.matched && tap.eventId
          ? eventIds.has(tap.eventId)
          : Math.max(0, tap.timeMs) >=
              tickToMs(startTick, this.song.bpm, this.tempoScale) &&
            tap.timeMs < tickToMs(endTick, this.song.bpm, this.tempoScale),
      );
      const segmentTp = segmentTaps.filter((tap) => tap.matched).length;
      const rests = restEvents.filter(
        (event) => event.tick >= startTick && event.tick < endTick,
      );
      const chordWindows = windows.filter((window) => window.midi.length > 1);
      segmentSummaries.push({
        startTick,
        endTick,
        barIndex: startTick / 1920 + 1,
        tp: segmentTp,
        fp: segmentTaps.length - segmentTp,
        fn:
          windows.reduce((sum, window) => sum + window.midi.length, 0) -
          segmentTp,
        restTotal: rests.length,
        restPassed: rests.filter(restPassed).length,
        chordTotal: chordWindows.length,
        chordTogether: chordWindows.filter(together).length,
      });
    }
    return {
      tp,
      fp,
      fn,
      totalSlots,
      precision,
      recall,
      pitchF1,
      rhythmMean,
      score: Math.round(
        1000 * (0.65 * pitchF1 + 0.35 * (rhythmMean ?? 0) * recall),
      ),
      restTotal: restEvents.length,
      restPassed: restEvents.filter(restPassed).length,
      chordTotal: chords.length,
      chordTogether: chords.filter(together).length,
      completed: this.nowMs >= this.finalTimeMs,
      segmentSummaries,
    };
  }
}

export interface BadgeContext {
  mode?: string;
  completed?: boolean;
  scope?: string;
  guideLevel?: string;
  timingQuality?: string;
  assistFlags?: string[];
  interruptionCount?: number;
}
export function evaluateBadges(
  result: JudgmentResult,
  context: BadgeContext = {},
): string[] {
  if (
    (context.mode && context.mode !== "challenge") ||
    context.scope === "segment" ||
    !(context.completed ?? result.completed)
  )
    return [];
  const badges: string[] = [];
  if (result.pitchF1 >= 0.85) badges.push("pitch");
  if (
    result.pitchF1 >= 0.85 &&
    result.recall >= 0.9 &&
    (result.rhythmMean ?? 0) >= 0.8 &&
    (result.restTotal === 0 || result.restPassed / result.restTotal >= 0.8) &&
    (result.chordTotal === 0 || result.chordTogether / result.chordTotal >= 0.8)
  )
    badges.push("rhythm");
  const disqualifying = [
    "answer-guide",
    "pause-restart",
    "section-seek",
    "demo-during-attempt",
    "timing-fallback",
  ];
  if (
    result.pitchF1 >= 0.85 &&
    result.recall >= 0.9 &&
    context.timingQuality === "normal" &&
    context.guideLevel === "off" &&
    !(context.interruptionCount ?? 0) &&
    !(context.assistFlags ?? []).some((flag) => disqualifying.includes(flag))
  )
    badges.push("independent");
  return badges;
}

export interface WaitOptions {
  policy?: "sequential" | "together";
  chordWindowMs?: number;
  bpm?: number;
}
/** Untimed pitch finding; only explicit rests and the optional together task have clocks. */
export class WaitEngine {
  currentIndex = 0;
  attempts = 0;
  readonly policy: "sequential" | "together";
  private partial = new Set<number>();
  private chordStartedMs: number | null = null;
  private restStartedMs: number | null = null;
  private attemptLog: number[] = [];
  constructor(
    readonly events: MusicEvent[],
    readonly options: WaitOptions = {},
  ) {
    this.policy = options.policy ?? "sequential";
  }
  get currentEvent(): MusicEvent | undefined {
    return this.events[this.currentIndex];
  }
  get completed(): boolean {
    return this.currentIndex >= this.events.length;
  }
  get completedEvents(): number {
    return this.currentIndex;
  }
  get progress(): number {
    return this.events.length ? this.currentIndex / this.events.length : 1;
  }
  get confirmedMidi(): number[] {
    return [...this.partial];
  }
  private next(nowMs: number): void {
    this.currentIndex++;
    this.partial.clear();
    this.chordStartedMs = null;
    this.restStartedMs = this.currentEvent?.midi.length === 0 ? nowMs : null;
  }
  tap(midi: number, nowMs: number): JudgmentFeedback {
    if (!Number.isFinite(midi) || !Number.isFinite(nowMs))
      return { status: "ignored", reason: "invalid-input" };
    if (this.completed) return { status: "ignored", reason: "completed" };
    this.advance(nowMs);
    const event = this.currentEvent;
    if (!event) return { status: "ignored", reason: "completed" };
    this.attempts++;
    this.attemptLog.push(this.currentIndex);
    if (!event.midi.length) {
      this.restStartedMs = nowMs;
      return { status: "wrong", reason: "rest", eventId: event.id };
    }
    if (!event.midi.includes(midi) || this.partial.has(midi)) {
      return { status: "wrong", reason: "wrong-note", eventId: event.id };
    }
    if (this.chordStartedMs === null) this.chordStartedMs = nowMs;
    this.partial.add(midi);
    if (event.midi.every((note) => this.partial.has(note))) {
      this.next(nowMs);
      return { status: "hit", eventId: event.id };
    }
    return { status: "waiting", eventId: event.id, reason: "chord-partial" };
  }
  advance(nowMs: number): void {
    if (!Number.isFinite(nowMs)) return;
    if (
      this.policy === "together" &&
      this.chordStartedMs !== null &&
      nowMs - this.chordStartedMs > (this.options.chordWindowMs ?? 400)
    ) {
      this.partial.clear();
      this.chordStartedMs = null;
    }
    while (this.currentEvent && !this.currentEvent.midi.length) {
      if (this.restStartedMs === null) this.restStartedMs = nowMs;
      const durationMs = tickToMs(
        this.currentEvent.durationTicks,
        this.options.bpm ?? 60,
      );
      if (nowMs < this.restStartedMs + durationMs) break;
      const endMs = this.restStartedMs + durationMs;
      this.next(endMs);
    }
  }
  resetSegment(tick: number): void {
    const target = this.events.findIndex((event) => event.tick >= tick);
    this.currentIndex = target < 0 ? this.events.length : target;
    this.partial.clear();
    this.chordStartedMs = null;
    this.restStartedMs = null;
    this.attemptLog = this.attemptLog.filter(
      (index) => index < this.currentIndex,
    );
    this.attempts = this.attemptLog.length;
  }
}
