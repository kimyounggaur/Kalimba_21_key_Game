import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { songs } from "../domain/content";
import type { MusicEvent, Song } from "../domain/content";
const clock = vi.hoisted(() => ({
  now: 0,
  state: "running",
  fail: false,
  mode: "output-timestamp" as "output-timestamp" | "render-clock",
}));
vi.mock("./audio", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./audio")>();
  return {
    normalizeEventTimestamp: actual.normalizeEventTimestamp,
    audio: {
      get context() {
        return { state: clock.state };
      },
      unlock: vi.fn(async () => {}),
      prepare: vi.fn(async () => {}),
      freezeTimingMode: vi.fn(() => clock.mode),
      releaseTimingMode: vi.fn(),
      currentTime: vi.fn(() => clock.now),
      heardTime: vi.fn(() => {
        if (clock.fail) throw new Error("clock unavailable");
        return clock.now;
      }),
      eventTime: vi.fn(() => {
        if (clock.fail) throw new Error("clock unavailable");
        return clock.now;
      }),
      click: vi.fn(),
      play: vi.fn(),
      stop: vi.fn(),
    },
  };
});
import { audio } from "./audio";
import { Session } from "./session";
import type { SessionConfig, SessionView } from "./session";
const event = (
  id: string,
  tick: number,
  durationTicks: number,
  midi: number[],
): MusicEvent => ({
  id,
  tick,
  durationTicks,
  midi,
  kind: midi.length === 0 ? "rest" : midi.length === 2 ? "chord" : "note",
});
const fixture: Song = {
  ...songs[0],
  id: "session-fixture",
  bpm: 60,
  bars: 4,
  totalTicks: 7680,
  events: [event("a", 0, 3840, [60]), event("b", 3840, 3840, [62])],
};
const sessions: Session[] = [];
const make = (patch: Partial<SessionConfig> = {}) => {
  const session = new Session({
    song: fixture,
    mode: "challenge",
    tempo: 1,
    offsetMs: 0,
    metronome: true,
    policy: "sequential",
    ...patch,
  });
  sessions.push(session);
  return session;
};
const updateAt = (now: number) => {
  clock.now = now;
  vi.advanceTimersByTime(25);
};
const pluckAt = (session: Session, midi: number, now: number) => {
  clock.now = now;
  session.pluck(midi, performance.now());
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  clock.now = 0;
  clock.state = "running";
  clock.fail = false;
  clock.mode = "output-timestamp";
  vi.clearAllMocks();
});
afterEach(() => {
  sessions.splice(0).forEach((session) => session.dispose());
  vi.useRealTimers();
});

describe("Session lifecycle", () => {
  it("shows exactly four preparation beats and keeps visual count-in separate from calibration", async () => {
    const session = make({ offsetMs: 200 });
    await session.start();
    expect(session.state).toBe("countin");
    expect(session.count).toBe(4);
    updateAt(0.01);
    expect(session.count).toBe(4);
    updateAt(4.16);
    expect(session.state).toBe("playing");
    expect(session.tick).toBeCloseTo(4.8);
    pluckAt(session, 60, 4.35);
    expect(session.judge.result().tp).toBe(1);
  });
  it("preserves earlier two-bar results and removes the restarted section only", async () => {
    const session = make();
    await session.start();
    pluckAt(session, 60, 4.15);
    updateAt(12.2);
    pluckAt(session, 62, 12.2);
    expect(session.judge.result().tp).toBe(2);
    session.pause();
    expect(session.state).toBe("paused");
    expect(session.judge.result().tp).toBe(1);
    updateAt(100);
    expect(session.judge.result().tp).toBe(1);
    expect(session.state).toBe("paused");
    await session.resume();
    expect(session.tick).toBe(3840);
    expect(session.state).toBe("countin");
    pluckAt(session, 62, 104.15);
    expect(session.judge.result().tp).toBe(2);
    updateAt(112.26);
    expect(session.state).toBe("result");
    expect(session.judge.result().completed).toBe(true);
    expect(session.interrupted).toBe(1);
    expect(session.assistFlags.has("pause-restart")).toBe(true);
  });
  it("restarts cleanly when tempo changes rather than combining targets from two clocks", async () => {
    const session = make();
    await session.start();
    pluckAt(session, 60, 4.15);
    updateAt(12.2);
    session.pause();
    session.config.tempo = 0.5;
    clock.now = 100;
    await session.resume();
    expect(session.tick).toBe(0);
    expect(session.judge.tempoScale).toBe(0.5);
    expect(session.judge.result().tp).toBe(0);
    expect(session.assistFlags.has("tempo-change")).toBe(true);
    pluckAt(session, 60, 108.15);
    expect(session.judge.result().tp).toBe(1);
  });
  it("pauses recoverably on an output-clock error in either timer or input path", async () => {
    const session = make();
    await session.start();
    clock.fail = true;
    expect(() => updateAt(1)).not.toThrow();
    expect(session.state).toBe("paused");
    expect(session.degraded).toBe(true);
    clock.fail = false;
    await session.resume();
    clock.fail = true;
    expect(() => session.pluck(60, performance.now())).not.toThrow();
    expect(session.state).toBe("paused");
  });
  it("checks suspended audio before attempting to read a broken output clock", async () => {
    const session = make();
    await session.start();
    clock.fail = true;
    clock.state = "suspended";
    expect(() => updateAt(1)).not.toThrow();
    expect(session.state).toBe("paused");
  });
  it("replaces a calibration with zero if resuming selects a different time mode", async () => {
    const session = make({ offsetMs: 70 });
    await session.start();
    session.pause();
    clock.mode = "render-clock";
    await session.resume();
    expect(session.timingMode).toBe("render-clock");
    expect(session.config.offsetMs).toBe(0);
    expect(session.degraded).toBe(true);
  });
  it("rejects delayed input and restarts the current section without adding a false tap", async () => {
    const session = make();
    await session.start();
    updateAt(4.16);
    vi.advanceTimersByTime(200);
    session.pluck(60, performance.now() - 101);
    expect(session.state).toBe("paused");
    expect(session.degraded).toBe(true);
    expect(session.judge.result().tp).toBe(0);
    expect(session.judge.result().fp).toBe(0);
  });
  it.each([NaN, -1, 1_700_000_000_000])(
    "normalizes invalid event timestamp %s and records degraded timing",
    async (timestamp) => {
      const session = make();
      await session.start();
      clock.now = 4.15;
      session.pluck(60, timestamp);
      expect(session.judge.result().tp).toBe(1);
      expect(session.degraded).toBe(true);
      expect(session.assistFlags.has("timing-fallback")).toBe(true);
      expect(vi.mocked(audio.eventTime).mock.calls.at(-1)?.[0]).toBe(
        performance.now(),
      );
    },
  );
  it("records an explicitly selected range in assistance metadata", () => {
    expect(
      make({ startTick: 3840, endTick: 7680 }).assistFlags.has("section-seek"),
    ).toBe(true);
    expect(make().assistFlags.has("section-seek")).toBe(false);
  });
  it("keeps a late end-of-song pause inside the last section instead of seeking past the end", async () => {
    const session = make();
    await session.start();
    updateAt(20.2); // 50 ms after body; still inside final grace.
    expect(session.state).toBe("playing");
    session.pause();
    await session.resume();
    expect(session.tick).toBe(3840);
  });
  it("uses the live audio clock if pause crosses a section boundary between UI updates", async () => {
    const session = make();
    await session.start();
    pluckAt(session, 60, 4.15);
    updateAt(12.14);
    clock.now = 12.16;
    session.pause();
    await session.resume();
    expect(session.tick).toBe(3840);
    expect(session.judge.result().tp).toBe(1);
  });
  it("cancels timers and prevents disposed sessions from completing or restarting", async () => {
    const session = make();
    const finish = vi.fn();
    session.onFinish = finish;
    await session.start();
    session.dispose();
    updateAt(100);
    session.pluck(60, performance.now());
    await session.resume();
    expect(finish).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not let an obsolete async prepare begin playback after disposal", async () => {
    let release: () => void = () => {};
    vi.mocked(audio.prepare).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const session = make();
    const changes: SessionView[] = [];
    session.onChange = (view) => changes.push(view);
    const start = session.start();
    await Promise.resolve();
    session.dispose();
    release();
    await start;
    expect(changes.map((view) => view.state)).toEqual(["loading"]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("wait range and rest lifecycle", () => {
  const short: Song = {
    ...fixture,
    bars: 1,
    totalTicks: 1920,
    events: [event("a", 0, 480, [60]), event("b", 480, 1440, [62])],
  };
  it("loops the final wait range without finishing or granting repeated completion", async () => {
    const session = make({
      song: short,
      mode: "wait",
      loop: true,
      startTick: 0,
      endTick: 1920,
    });
    const finish = vi.fn();
    session.onFinish = finish;
    await session.start();
    for (let i = 0; i < 3; i++) {
      pluckAt(session, 60, i * 2);
      pluckAt(session, 62, i * 2 + 1);
      expect(session.wait.currentIndex).toBe(0);
    }
    expect(session.state).toBe("playing");
    expect(finish).not.toHaveBeenCalled();
  });
  it("finishes a partial wait range without claiming that all song events were played", async () => {
    const session = make({ song: short, mode: "wait", endTick: 480 });
    const finish = vi.fn();
    session.onFinish = finish;
    await session.start();
    pluckAt(session, 60, 0);
    expect(session.state).toBe("result");
    expect(session.wait.completed).toBe(false);
    expect(finish).toHaveBeenCalledTimes(1);
  });
  it("lets the final wait pluck decay rather than immediately stopping its sound", async () => {
    const session = make({ song: short, mode: "wait" });
    await session.start();
    pluckAt(session, 60, 0);
    const stopCount = vi.mocked(audio.stop).mock.calls.length;
    pluckAt(session, 62, 1);
    expect(session.state).toBe("result");
    expect(audio.stop).toHaveBeenCalledTimes(stopCount);
  });
  it("restarts the current wait section with a new four-beat count-in and clears a partial chord", async () => {
    const chord: Song = {
      ...short,
      events: [event("chord", 0, 1920, [60, 64])],
    };
    const session = make({ song: chord, mode: "wait", policy: "together" });
    await session.start();
    pluckAt(session, 60, 0);
    session.pause();
    clock.now = 1;
    await session.resume();
    expect(session.state).toBe("countin");
    expect(session.wait.confirmedMidi).toEqual([]);
    pluckAt(session, 64, 2);
    expect(session.wait.confirmedMidi).toEqual([]);
    updateAt(5.16);
    expect(session.state).toBe("playing");
    pluckAt(session, 60, 5.2);
    pluckAt(session, 64, 5.3);
    expect(session.state).toBe("result");
  });
  it("does not add hidden time to the rest guide after pause and resume", async () => {
    const rest: Song = {
      ...short,
      events: [event("rest", 0, 480, []), event("note", 480, 1440, [60])],
    };
    const session = make({ song: rest, mode: "wait" });
    await session.start();
    updateAt(0.5);
    expect(session.wait.currentIndex).toBe(0);
    session.pause();
    clock.now = 100;
    await session.resume();
    updateAt(104.16);
    expect(session.wait.currentIndex).toBe(0);
    updateAt(105.17);
    expect(session.wait.currentIndex).toBe(1);
  });
});
