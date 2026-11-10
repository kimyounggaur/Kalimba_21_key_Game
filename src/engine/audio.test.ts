import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUDIO_MIDIS,
  AudioEngine,
  calibrateOffsets,
  mapPerformanceTime,
  median,
  normalizeEventTimestamp,
  validOutputTimestamp,
} from "./audio";

class FakeParam {
  value = 1;
  setValueAtTime = vi.fn();
  linearRampToValueAtTime = vi.fn();
  exponentialRampToValueAtTime = vi.fn();
  setTargetAtTime = vi.fn();
  cancelScheduledValues = vi.fn();
}
class FakeNode {
  gain = new FakeParam();
  frequency = new FakeParam();
  threshold = new FakeParam();
  knee = new FakeParam();
  ratio = new FakeParam();
  attack = new FakeParam();
  release = new FakeParam();
  buffer: unknown;
  onended: (() => void) | null = null;
  type = "";
  start = vi.fn();
  stop = vi.fn();
  disconnect = vi.fn();
  connect(target: FakeNode): FakeNode {
    return target;
  }
}
class FakeContext {
  static instance: FakeContext;
  currentTime = 10;
  state = "suspended";
  destination = new FakeNode();
  sampleRate = 22050;
  sources: FakeNode[] = [];
  resume = vi.fn(async () => {
    this.state = "running";
  });
  decodeAudioData = vi.fn(async () => ({ length: 88200, duration: 4 }));
  addEventListener = vi.fn();
  constructor() {
    FakeContext.instance = this;
  }
  createGain() {
    return new FakeNode();
  }
  createDynamicsCompressor() {
    return new FakeNode();
  }
  createBufferSource() {
    const source = new FakeNode();
    this.sources.push(source);
    return source;
  }
  createOscillator() {
    return this.createBufferSource();
  }
  getOutputTimestamp() {
    return { contextTime: 9.9, performanceTime: 1000 };
  }
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("audio lifecycle", () => {
  function setup() {
    vi.stubGlobal("AudioContext", FakeContext);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new ArrayBuffer(4), {
            headers: { "content-type": "audio/wav" },
          }),
      ),
    );
    vi.spyOn(performance, "now").mockReturnValue(1000);
    return new AudioEngine();
  }
  it("loads all 21 buffers once and creates a fresh source for every strike", async () => {
    const engine = setup();
    await engine.unlock();
    await engine.unlock();
    expect(engine.ready).toBe(true);
    expect(FakeContext.instance.decodeAudioData).toHaveBeenCalledTimes(21);
    engine.play(60);
    engine.play(60);
    expect(FakeContext.instance.sources).toHaveLength(2);
    expect(FakeContext.instance.sources[0]!.buffer).toBe(
      FakeContext.instance.sources[1]!.buffer,
    );
    expect(FakeContext.instance.sources[0]!.stop).not.toHaveBeenCalled();
  });
  it("caps active voices and cancels future scheduled audio on stop", async () => {
    const engine = setup();
    await engine.unlock();
    for (let i = 0; i < 40; i++) engine.play(60);
    expect(engine.activeVoices).toBe(32);
    expect(FakeContext.instance.sources[0]!.stop).toHaveBeenCalledWith(10.015);
    engine.play(64, 12);
    const future = FakeContext.instance.sources.at(-1)!;
    engine.stop();
    expect(engine.activeVoices).toBe(0);
    expect(future.stop).toHaveBeenCalledWith(10);
  });
  it("does not pretend missing or HTML fallback samples are ready and allows retry", async () => {
    const engine = setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<html/>", { headers: { "content-type": "text/html" } }),
      ),
    );
    await expect(engine.unlock()).rejects.toThrow();
    expect(engine.ready).toBe(false);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new ArrayBuffer(4), {
            headers: { "content-type": "audio/wav" },
          }),
      ),
    );
    await engine.unlock();
    expect(engine.ready).toBe(true);
  });
  it("keeps the clock mode frozen until explicit release", async () => {
    const engine = setup();
    await engine.unlock();
    expect(engine.freezeTimingMode()).toBe("output-timestamp");
    vi.spyOn(FakeContext.instance, "getOutputTimestamp").mockReturnValue({
      contextTime: 0,
      performanceTime: 0,
    });
    expect(engine.timingMode).toBe("output-timestamp");
    expect(engine.heardTime()).toBeCloseTo(9.9);
    engine.releaseTimingMode();
    expect(engine.timingMode).toBe("render-clock");
    expect(engine.eventTime(900)).toBeCloseTo(9.9);
  });
});

describe("audio clock and calibration", () => {
  it("has exactly the physical 21-note preset", () => {
    expect(new Set(AUDIO_MIDIS).size).toBe(21);
    expect(AUDIO_MIDIS[10]).toBe(53);
    expect(AUDIO_MIDIS[12]).toBe(60);
  });
  it("maps the performance timestamp without adding hardware latency twice", () => {
    expect(
      mapPerformanceTime(1090, { contextTime: 5, performanceTime: 1000 }),
    ).toBeCloseTo(5.09);
    expect(90 - 70).toBe(20);
    expect(-50 - -30).toBe(-20);
  });
  it("rejects zero, stale, impossible and nonfinite output samples", () => {
    expect(
      validOutputTimestamp(
        { contextTime: 5, performanceTime: 1000 },
        1030,
        5.1,
      ),
    ).toBe(true);
    expect(
      validOutputTimestamp({ contextTime: 0, performanceTime: 0 }, 1000, 5),
    ).toBe(false);
    expect(
      validOutputTimestamp({ contextTime: 5, performanceTime: 1000 }, 5000, 6),
    ).toBe(false);
    expect(
      validOutputTimestamp({ contextTime: 9, performanceTime: 1000 }, 1030, 5),
    ).toBe(false);
    expect(
      validOutputTimestamp(
        { contextTime: NaN, performanceTime: 1000 },
        1030,
        5,
      ),
    ).toBe(false);
  });
  it("marks invalid event timestamps as fallback", () => {
    expect(normalizeEventTimestamp(990, 1000)).toEqual({
      perfMs: 990,
      timingQuality: "normal",
    });
    expect(normalizeEventTimestamp(1760000000000, 1000)).toEqual({
      perfMs: 1000,
      timingQuality: "fallback",
    });
    expect(normalizeEventTimestamp(NaN, 1000).timingQuality).toBe("fallback");
  });
  it("drops exactly four warm-up taps and uses median", () => {
    expect(
      calibrateOffsets([999, 999, -999, -999, ...Array(12).fill(70)]),
    ).toEqual({ ok: true, offsetMs: 70, madMs: 0, validCount: 12 });
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
  it("discards outliers at 250ms difference and requires at least eight taps", () => {
    const result = calibrateOffsets([
      0,
      0,
      0,
      0,
      ...Array(8).fill(20),
      270,
      270,
      270,
      270,
    ]);
    expect(result).toEqual({ ok: true, offsetMs: 20, madMs: 0, validCount: 8 });
    expect(
      calibrateOffsets([
        0,
        0,
        0,
        0,
        ...Array(6).fill(-400),
        ...Array(6).fill(400),
      ]).ok,
    ).toBe(false);
  });
  it("does not clamp an excessive offset into an accepted one", () => {
    expect(calibrateOffsets(Array(16).fill(251)).ok).toBe(false);
    expect(calibrateOffsets(Array(16).fill(-250)).ok).toBe(true);
    expect(calibrateOffsets(Array(15).fill(0)).ok).toBe(false);
    expect(
      calibrateOffsets([
        0,
        0,
        0,
        0,
        ...Array(6).fill(-100),
        ...Array(6).fill(100),
      ]).ok,
    ).toBe(false);
  });
});
