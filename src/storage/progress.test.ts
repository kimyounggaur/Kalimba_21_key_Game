import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  completeLesson,
  comparisonKey,
  defaultSettings,
  getCalibration,
  getSettings,
  loadProgress,
  resetProgress,
  rewardEligible,
  saveAttempt,
  saveCalibration,
  saveSettings,
  type SavedAttempt,
} from "./progress";

const attempt = (overrides: Partial<SavedAttempt> = {}): SavedAttempt => ({
  attemptId: crypto.randomUUID(),
  songId: "S01",
  mode: "challenge",
  completed: true,
  scope: "song",
  recall: 0.8,
  score: 800,
  ...overrides,
});

beforeEach(async () => {
  await resetProgress();
});

describe("local settings and calibration", () => {
  it("returns documented defaults and merges partial updates atomically", async () => {
    expect(await getSettings()).toEqual(defaultSettings);
    await saveSettings({ volume: 0.2, labelMode: "solfege" });
    await saveSettings({ reducedMotion: true });
    expect(await getSettings()).toMatchObject({
      volume: 0.2,
      labelMode: "solfege",
      reducedMotion: true,
    });
  });
  it("keeps output timestamp and render clock calibration separate", async () => {
    await saveCalibration({
      id: "output:48000:speaker",
      timingMode: "output-timestamp",
      offsetMs: 70,
      sampleRate: 48000,
    });
    expect((await getCalibration("output:48000:speaker"))?.offsetMs).toBe(70);
    expect(await getCalibration("render:48000:speaker")).toBeUndefined();
    await expect(
      saveCalibration({
        id: "bad",
        timingMode: "render-clock",
        offsetMs: 251,
        sampleRate: 48000,
      }),
    ).rejects.toThrow();
    expect(await getCalibration("bad")).toBeUndefined();
  });
});

describe("transactional attempts and rewards", () => {
  it("stores one attempt and one stable first-clear reward when retried", async () => {
    const a = attempt();
    expect(await saveAttempt(a)).toEqual({
      saved: true,
      alreadySaved: false,
      rewardedCat: "cat-mikan",
    });
    expect(await saveAttempt(a)).toEqual({
      saved: true,
      alreadySaved: true,
      rewardedCat: null,
    });
    const snapshot = await loadProgress();
    expect(snapshot.attempts).toHaveLength(1);
    expect(snapshot.cats).toEqual(["cat-mikan"]);
  });
  it("serializes simultaneous saves, granting the same cat just once", async () => {
    const results = await Promise.all([
      saveAttempt(attempt()),
      saveAttempt(attempt()),
    ]);
    expect(results.filter((r) => r.rewardedCat)).toHaveLength(1);
    expect((await loadProgress()).attempts).toHaveLength(2);
    expect((await loadProgress()).cats).toEqual(["cat-mikan"]);
  });
  it("does not reset reward identity for another content version", async () => {
    await saveAttempt(attempt({ songContentVersion: 1 }));
    expect(
      (await saveAttempt(attempt({ songContentVersion: 2 }))).rewardedCat,
    ).toBeNull();
    expect((await loadProgress()).cats).toHaveLength(1);
  });
  it("rejects no-input, unfinished, and segment rewards", async () => {
    const attempts = [
      attempt({ recall: 0 }),
      attempt({ completed: false }),
      attempt({ scope: "segment" }),
    ];
    for (const a of attempts)
      expect((await saveAttempt(a)).rewardedCat).toBeNull();
    expect((await loadProgress()).cats).toEqual([]);
  });
  it("uses recall 0.50 for a complete challenge, independent of star thresholds", async () => {
    expect(rewardEligible(attempt({ recall: 0.499 }))).toBe(false);
    expect(rewardEligible(attempt({ recall: 0.5 }))).toBe(true);
  });
  it("requires every actual waiting event but preserves sequential wait eligibility", async () => {
    expect(
      (
        await saveAttempt(
          attempt({ mode: "wait", waitCompletedEvents: 4, waitTotalEvents: 5 }),
        )
      ).rewardedCat,
    ).toBeNull();
    expect(
      (
        await saveAttempt(
          attempt({
            mode: "wait",
            waitCompletedEvents: 5,
            waitTotalEvents: 5,
            waitChordPolicy: "sequential",
          }),
        )
      ).rewardedCat,
    ).toBe("cat-mikan");
  });
  it("keeps higher best scores and separates speeds, guidance, and timing modes", async () => {
    await saveAttempt(attempt({ score: 900 }));
    await saveAttempt(attempt({ score: 400 }));
    await saveAttempt(attempt({ score: 600, tempoScale: 0.5 }));
    await saveAttempt(attempt({ score: 700, guideLevel: "off" }));
    await saveAttempt(attempt({ score: 800, timingMode: "output-timestamp" }));
    const best = (await loadProgress()).best;
    expect(Object.keys(best)).toHaveLength(4);
    expect(
      Object.values(best).filter(
        (a) =>
          a.tempoScale === undefined &&
          a.guideLevel === undefined &&
          a.timingMode === undefined,
      )[0].score,
    ).toBe(900);
    expect(comparisonKey(attempt({ tempoScale: 1 }))).not.toBe(
      comparisonKey(attempt({ tempoScale: 0.5 })),
    );
  });
  it("records a lesson only after its own completion predicate is supplied", async () => {
    await saveAttempt(attempt({ lessonId: "L04", lessonCompleted: false }));
    expect((await loadProgress()).lessonIds).toEqual([]);
    await saveAttempt(attempt({ lessonId: "L04", lessonCompleted: true }));
    await completeLesson("L01");
    expect((await loadProgress()).lessonIds).toEqual(["L01", "L04"]);
  });
  it("preserves earned stars when a new score is lower", async () => {
    await saveAttempt(attempt({ score: 900, badges: ["pitch"] }));
    await saveAttempt(attempt({ score: 850, badges: ["rhythm"] }));
    const best = Object.values((await loadProgress()).best)[0];
    expect(best.score).toBe(900);
    expect(best.badges).toEqual(["pitch", "rhythm"]);
  });
  it("rolls back a failed transaction and preserves existing records for retry", async () => {
    await saveAttempt(attempt());
    const invalid = attempt({ songId: "S02", nonCloneable: () => true });
    await expect(saveAttempt(invalid)).rejects.toBeDefined();
    const snapshot = await loadProgress();
    expect(snapshot.attempts).toHaveLength(1);
    expect(snapshot.cats).toEqual(["cat-mikan"]);
    delete invalid.nonCloneable;
    expect((await saveAttempt(invalid)).rewardedCat).toBe("cat-socks");
  });
  it("caps detailed history without deleting a best score or reward ledger", async () => {
    await saveAttempt(
      attempt({ score: 1000, endedAtISO: "2025-01-01T00:00:00Z" }),
    );
    for (let index = 0; index < 201; index++) {
      await saveAttempt(
        attempt({
          score: 300,
          endedAtISO: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
          inputLog: new Array(1100).fill(1),
        }),
      );
    }
    const snapshot = await loadProgress();
    expect(snapshot.attempts).toHaveLength(200);
    expect(snapshot.attempts.filter((a) => a.inputLog)).toHaveLength(20);
    expect(snapshot.attempts[0].inputLog).toHaveLength(1000);
    expect(Object.values(snapshot.best)[0].score).toBe(1000);
    expect(snapshot.cats).toEqual(["cat-mikan"]);
    expect((await saveAttempt(attempt())).rewardedCat).toBeNull();
  });
});
