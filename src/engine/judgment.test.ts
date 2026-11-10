import { describe, expect, it } from "vitest";
import type { MusicEvent, Song } from "../domain/content";
import {
  ChallengeJudge,
  WaitEngine,
  evaluateBadges,
  tickToMs,
} from "./judgment";

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
  kind: midi.length === 0 ? "rest" : midi.length === 1 ? "note" : "chord",
});
const song = (events: MusicEvent[], bpm = 60): Song => ({
  id: "test",
  contentVersion: 1,
  title: "판정 검증",
  description: "test fixture",
  color: "#758b78",
  difficulty: 1,
  bpm,
  bars: 2,
  totalTicks: Math.max(
    ...events.map((value) => value.tick + value.durationTicks),
  ),
  events,
});
const single = () => song([event("e1", 0, 1920, [60])]);
const complete = (judge: ChallengeJudge) => {
  judge.advance(judge.finalTimeMs);
  return judge.result();
};

describe("ChallengeJudge ownership and score", () => {
  it("gives an exact note full score and no phantom extra taps", () => {
    const judge = new ChallengeJudge(single());
    expect(judge.tap(60, 0)).toMatchObject({
      status: "hit",
      grade: "perfect",
      deltaMs: 0,
    });
    expect(complete(judge)).toMatchObject({
      tp: 1,
      fp: 0,
      fn: 0,
      pitchF1: 1,
      rhythmMean: 1,
      score: 1000,
      completed: true,
    });
  });
  it("keeps the wrong tap when a correct tap follows inside the same window", () => {
    const judge = new ChallengeJudge(single());
    judge.tap(62, -10);
    judge.tap(60, 0);
    expect(complete(judge)).toMatchObject({ tp: 1, fp: 1, fn: 0, score: 783 });
  });
  it("makes all-key spam less accurate rather than choosing only correct inputs", () => {
    const judge = new ChallengeJudge(single());
    [
      53, 55, 57, 59, 60, 62, 64, 65, 67, 69, 71, 72, 74, 76, 77, 79, 81, 83,
      84, 86, 88,
    ].forEach((midi) => judge.tap(midi, 0));
    expect(complete(judge)).toMatchObject({ tp: 1, fp: 20, fn: 0 });
    expect(judge.result().pitchF1).toBeCloseTo(1 / 11);
  });
  it("reports null rhythm for no correct input and zero score", () => {
    expect(complete(new ChallengeJudge(single()))).toMatchObject({
      tp: 0,
      fp: 0,
      fn: 1,
      rhythmMean: null,
      score: 0,
    });
  });
  it.each([
    [-240, "hit"],
    [-160, "good"],
    [-80, "perfect"],
    [80, "perfect"],
    [160, "good"],
    [240, "hit"],
  ] as const)("grades the included boundary %d ms", (offset, grade) => {
    const judge = new ChallengeJudge(single());
    expect(judge.tap(60, offset)).toMatchObject({ status: "hit", grade });
  });
  it("excludes count-in before the first early window and the tail outside body", () => {
    const judge = new ChallengeJudge(single());
    expect(judge.tap(60, -241).status).toBe("ignored");
    expect(judge.tap(60, 4000).status).toBe("ignored");
    expect(judge.tap(60, 3000).status).toBe("wrong");
    expect(complete(judge)).toMatchObject({ tp: 0, fp: 1, fn: 1 });
  });
  it("gives the exact midpoint to the later repeated note once", () => {
    const judge = new ChallengeJudge(
      song([event("e1", 0, 120, [60]), event("e2", 120, 120, [60])], 120),
    );
    expect(judge.windows[0].upper).toBe(62.5);
    expect(judge.tap(60, 62.5)).toMatchObject({ status: "hit", eventId: "e2" });
    expect(complete(judge)).toMatchObject({ tp: 1, fp: 0, fn: 1 });
  });
  it("selects the time owner before checking pitch and cannot skip to another group", () => {
    const judge = new ChallengeJudge(
      song([event("e1", 0, 120, [60]), event("e2", 120, 120, [62])], 120),
    );
    expect(judge.tap(62, 30)).toMatchObject({ status: "wrong", eventId: "e1" });
    expect(complete(judge)).toMatchObject({ tp: 0, fp: 1, fn: 2 });
  });
  it("ignores duplicate input IDs without satisfying the next slot", () => {
    const judge = new ChallengeJudge(single());
    judge.tap(60, 0, "one");
    expect(judge.tap(60, 1, "one").status).toBe("ignored");
    expect(complete(judge)).toMatchObject({ tp: 1, fp: 0 });
  });
  it("holds each group open for 100 ms delivery grace before freezing it", () => {
    const value = song([
      event("e1", 0, 480, [60]),
      event("e2", 480, 480, [62]),
    ]);
    const judge = new ChallengeJudge(value);
    judge.advance(290); // first upper 240; a generated-at-230 tap delivered at 280 is still valid
    expect(judge.tap(60, 230).status).toBe("hit");
    const closed = new ChallengeJudge(value);
    closed.advance(340);
    expect(closed.tap(60, 230)).toMatchObject({
      status: "ignored",
      reason: "late-delivery",
      requiresRestart: true,
    });
  });
  it("uses exact totalTicks and the final window plus grace, not a rounded duration", () => {
    const judge = new ChallengeJudge(song([event("e1", 0, 60, [60])], 120));
    expect(judge.songEndMs).toBe(62.5);
    expect(judge.finalTimeMs).toBe(340);
    judge.advance(339.99);
    expect(judge.result().completed).toBe(false);
    judge.tap(60, 240);
    judge.advance(340);
    expect(judge.result()).toMatchObject({ tp: 1, completed: true });
  });
  it("stretches event times at half tempo without altering the MIDI", () => {
    expect(tickToMs(480, 120, 0.5)).toBe(1000);
    const judge = new ChallengeJudge(
      song([event("e1", 0, 480, [60]), event("e2", 480, 480, [62])], 120),
      0.5,
    );
    expect(judge.tap(62, 1000)).toMatchObject({ status: "hit", eventId: "e2" });
  });
});

describe("chords, rests, and section restart", () => {
  it.each([
    [80, 1],
    [100, 1],
    [140, 0],
  ])(
    "matches both chord notes with %d ms spread but records together=%d",
    (spread, count) => {
      const judge = new ChallengeJudge(
        song([event("chord", 0, 1920, [60, 64])]),
      );
      judge.tap(60, 0);
      judge.tap(64, spread);
      expect(complete(judge)).toMatchObject({
        tp: 2,
        fn: 0,
        chordTotal: 1,
        chordTogether: count,
      });
    },
  );
  it("does not substitute a repeated chord note for the other note", () => {
    const judge = new ChallengeJudge(song([event("chord", 0, 1920, [60, 64])]));
    judge.tap(60, 0);
    judge.tap(60, 10);
    expect(complete(judge)).toMatchObject({
      tp: 1,
      fp: 1,
      fn: 1,
      chordTogether: 0,
    });
  });
  it("shows the worse constituent grade for a completed chord", () => {
    const judge = new ChallengeJudge(song([event("chord", 0, 1920, [60, 64])]));
    judge.tap(60, -160);
    expect(judge.tap(64, -70).grade).toBe("good");
  });
  const restSong = () =>
    song([
      event("a", 0, 480, [60]),
      event("rest", 480, 480, []),
      event("b", 960, 960, [62]),
    ]);
  it("keeps residual sound free of rest violations; no release timing is involved", () => {
    const judge = new ChallengeJudge(restSong());
    judge.tap(60, 0);
    judge.tap(62, 2000);
    expect(complete(judge)).toMatchObject({ tp: 2, restPassed: 1 });
  });
  it("fails a rest for a new unmatched tap, counting FP only once", () => {
    const judge = new ChallengeJudge(restSong());
    judge.tap(60, 0);
    judge.tap(64, 1500);
    judge.tap(62, 2000);
    expect(complete(judge)).toMatchObject({
      tp: 2,
      fp: 1,
      restTotal: 1,
      restPassed: 0,
    });
  });
  it("scores a tap in an initial rest as a rest violation rather than count-in", () => {
    const judge = new ChallengeJudge(
      song([event("rest", 0, 480, []), event("a", 480, 1440, [60])]),
    );
    expect(judge.tap(62, -1).status).toBe("ignored");
    expect(judge.tap(62, 500)).toMatchObject({
      status: "wrong",
      reason: "rest",
    });
    judge.tap(60, 1000);
    expect(complete(judge)).toMatchObject({ tp: 1, fp: 1, restPassed: 0 });
  });
  it("does not double-penalize a neighboring correct early hit inside a rest", () => {
    const judge = new ChallengeJudge(restSong());
    judge.tap(60, 0);
    judge.tap(62, 1900);
    expect(complete(judge)).toMatchObject({ tp: 2, fp: 0, restPassed: 1 });
  });
  it("discards only the restarted two-bar section and keeps prior matches and errors", () => {
    const judge = new ChallengeJudge(
      song([event("a", 0, 3840, [60]), event("b", 3840, 3840, [62])]),
    );
    judge.tap(64, 0, "wrong");
    judge.tap(60, 0, "first");
    judge.tap(62, 8000, "second");
    judge.advance(9000);
    judge.truncateFromTick(3840);
    expect(judge.result()).toMatchObject({
      tp: 1,
      fp: 1,
      fn: 1,
      completed: false,
    });
    expect(judge.tap(62, 8000, "second").status).toBe("hit");
    expect(complete(judge)).toMatchObject({ tp: 2, fp: 1, fn: 0 });
  });
});

describe("badges", () => {
  const perfectResult = () => {
    const judge = new ChallengeJudge(single());
    judge.tap(60, 0);
    return complete(judge);
  };
  it("separates pitch, rhythm and independent badges", () => {
    expect(
      evaluateBadges(perfectResult(), {
        guideLevel: "off",
        timingQuality: "normal",
      }),
    ).toEqual(["pitch", "rhythm", "independent"]);
    expect(
      evaluateBadges(perfectResult(), {
        guideLevel: "guided",
        timingQuality: "normal",
      }),
    ).toEqual(["pitch", "rhythm"]);
  });
  it.each([
    "answer-guide",
    "pause-restart",
    "section-seek",
    "demo-during-attempt",
    "timing-fallback",
  ])("excludes independent for %s", (flag) => {
    expect(
      evaluateBadges(perfectResult(), {
        guideLevel: "off",
        timingQuality: "normal",
        assistFlags: [flag],
      }),
    ).not.toContain("independent");
  });
  it("does not exclude independent for accessible pads, metronome or pre-attempt demo", () => {
    expect(
      evaluateBadges(perfectResult(), {
        guideLevel: "off",
        timingQuality: "normal",
        assistFlags: ["pads", "metronome", "demo-before-attempt"],
      }),
    ).toContain("independent");
  });
  it("requires full completed challenge and normal independent timing", () => {
    expect(evaluateBadges(perfectResult(), { scope: "segment" })).toEqual([]);
    expect(evaluateBadges(perfectResult(), { mode: "wait" })).toEqual([]);
    expect(evaluateBadges(perfectResult(), { completed: false })).toEqual([]);
    expect(
      evaluateBadges(perfectResult(), {
        guideLevel: "off",
        timingQuality: "degraded",
      }),
    ).not.toContain("independent");
  });
});

describe("WaitEngine", () => {
  it("waits through incorrect pitches, then advances exactly once per correct event", () => {
    const wait = new WaitEngine([
      event("one", 0, 480, [60]),
      event("two", 480, 480, [62]),
    ]);
    for (let i = 0; i < 10; i++) expect(wait.tap(64, i).status).toBe("wrong");
    expect(wait.currentIndex).toBe(0);
    expect(wait.tap(60, 10).status).toBe("hit");
    expect(wait.tap(60, 11).status).toBe("wrong");
    wait.tap(62, 12);
    expect(wait.completed).toBe(true);
    expect(wait.progress).toBe(1);
    expect(wait.attempts).toBe(13);
  });
  it("permits sequential chord notes without timeout but not the same note twice", () => {
    const wait = new WaitEngine([event("chord", 0, 1920, [60, 64])]);
    expect(wait.tap(60, 0).status).toBe("waiting");
    expect(wait.tap(60, 1000).status).toBe("wrong");
    expect(wait.tap(64, 60000).status).toBe("hit");
    expect(wait.completed).toBe(true);
  });
  it.each([
    [399, true],
    [400, true],
    [401, false],
  ])("together completion at %d ms is %s", (spread, expected) => {
    const wait = new WaitEngine([event("chord", 0, 1920, [60, 64])], {
      policy: "together",
      chordWindowMs: 400,
    });
    wait.tap(60, 0);
    wait.tap(64, spread);
    expect(wait.completed).toBe(expected);
    if (!expected) {
      wait.tap(60, spread + 1);
      expect(wait.completed).toBe(true);
    }
  });
  it("advances an explicit rest on its guide clock and restarts it on a fresh tap", () => {
    const wait = new WaitEngine(
      [
        event("a", 0, 480, [60]),
        event("rest", 480, 480, []),
        event("b", 960, 480, [62]),
      ],
      { bpm: 60 },
    );
    wait.tap(60, 0);
    wait.advance(999);
    expect(wait.currentIndex).toBe(1);
    expect(wait.tap(64, 999)).toMatchObject({
      status: "wrong",
      reason: "rest",
    });
    wait.advance(1998);
    expect(wait.currentIndex).toBe(1);
    wait.advance(1999);
    expect(wait.currentIndex).toBe(2);
    wait.tap(62, 1999);
    expect(wait.completed).toBe(true);
  });
  it("resets only a section and discards its partial chord state and attempts", () => {
    const wait = new WaitEngine([
      event("a", 0, 3840, [60]),
      event("b", 3840, 1920, [62, 64]),
    ]);
    wait.tap(60, 0);
    wait.tap(62, 10);
    wait.resetSegment(3840);
    expect(wait.completedEvents).toBe(1);
    expect(wait.attempts).toBe(1);
    expect(wait.confirmedMidi).toEqual([]);
    wait.tap(64, 20);
    expect(wait.completed).toBe(false);
    wait.tap(62, 30);
    expect(wait.completed).toBe(true);
  });
});
