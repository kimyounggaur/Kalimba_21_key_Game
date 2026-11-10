import { describe, it, expect } from "vitest";
import {
  keys,
  songs,
  lessons,
  physicalMidi,
  noteByMidi,
  noteById,
  focusCapacity,
  requiredSpan,
  validateSong,
  parseBars,
  isLessonComplete,
  lessonSong,
  frequencyHz,
} from "./content";

describe("canonical 21-key tuning", () => {
  it("preserves physical order and unique IDs, with F3 in the middle", () => {
    expect(keys.map((k) => k.midi)).toEqual([
      86, 83, 79, 76, 72, 69, 65, 62, 59, 55, 53, 57, 60, 64, 67, 71, 74, 77,
      81, 84, 88,
    ]);
    expect(new Set(keys.map((k) => k.id)).size).toBe(21);
    expect(new Set(physicalMidi).size).toBe(21);
    expect(noteById("k11")?.noteName).toBe("F3");
    expect(noteById("k13")?.noteName).toBe("C4");
    expect(noteByMidi(62)?.id).toBe("k08");
    expect(noteByMidi(54)).toBeUndefined();
    expect(frequencyHz(69)).toBe(440);
  });
  it("uses independent scale degrees and octave dots", () => {
    expect(noteById("k11")).toMatchObject({ scaleDegree: 4, octaveDots: -1 });
    expect(noteByMidi(60)).toMatchObject({ scaleDegree: 1, octaveDots: 0 });
    expect(noteByMidi(72)).toMatchObject({ scaleDegree: 1, octaveDots: 1 });
    expect(noteByMidi(84)).toMatchObject({ scaleDegree: 1, octaveDots: 2 });
  });
  it("bases focus on physical span, not the count of pitches", () => {
    expect(focusCapacity(360)).toBe(6);
    expect(focusCapacity(390)).toBe(7);
    expect(requiredSpan(parseBars("test", ["C4:1 D4:1 E4:2"]))).toBe(7);
    expect(requiredSpan(songs[2].events)).toBe(9);
  });
});
describe("five original scores", () => {
  const expected = [
    {
      id: "S01",
      bars: 8,
      ticks: 15360,
      seconds: 32,
      events: 22,
      slots: 22,
      rests: 0,
      chords: 0,
      span: 7,
    },
    {
      id: "S02",
      bars: 12,
      ticks: 23040,
      seconds: 40,
      events: 43,
      slots: 43,
      rests: 0,
      chords: 0,
      span: 7,
    },
    {
      id: "S03",
      bars: 12,
      ticks: 23040,
      seconds: 36,
      events: 36,
      slots: 36,
      rests: 0,
      chords: 0,
      span: 9,
    },
    {
      id: "S04",
      bars: 12,
      ticks: 23040,
      seconds: 40,
      events: 40,
      slots: 26,
      rests: 14,
      chords: 0,
      span: 9,
    },
    {
      id: "S05",
      bars: 16,
      ticks: 30720,
      seconds: 480 / 11,
      events: 43,
      slots: 57,
      rests: 1,
      chords: 15,
      span: 12,
    },
  ];
  it.each(expected)(
    "$id expands all exact bars, slots, rests and chords",
    (r) => {
      const song = songs.find((s) => s.id === r.id)!;
      expect(validateSong(song)).toEqual([]);
      expect(song.bars).toBe(r.bars);
      expect(song.totalTicks).toBe(r.ticks);
      expect(((song.totalTicks / 480) * 60) / song.bpm).toBeCloseTo(
        r.seconds,
        9,
      );
      expect(song.events).toHaveLength(r.events);
      expect(song.events.reduce((n, e) => n + e.midi.length, 0)).toBe(r.slots);
      expect(song.events.filter((e) => e.midi.length === 0)).toHaveLength(
        r.rests,
      );
      expect(song.events.filter((e) => e.midi.length === 2)).toHaveLength(
        r.chords,
      );
      expect(requiredSpan(song.events)).toBe(r.span);
      expect(new Set(song.events.map((e) => e.id)).size).toBe(r.events);
    },
  );
  it("rejects short bars, unsupported notes, duplicate chords, gaps and malformed events", () => {
    expect(() => parseBars("bad", ["C4:3.5"])).toThrow(/1920/);
    expect(() => parseBars("bad", ["F#4:4"])).toThrow();
    expect(() => parseBars("bad", ["[C4,C4]:4"])).toThrow(/chord/);
    const song = structuredClone(songs[0]);
    song.events[0].midi = [54];
    expect(validateSong(song).some((e) => e.includes("unsupported MIDI"))).toBe(
      true,
    );
    song.events[0].midi = [60];
    song.events[1].tick += 1;
    expect(validateSong(song).some((e) => e.includes("gap"))).toBe(true);
  });
});
describe("12 exact lessons and separate completion rules", () => {
  it("has a complete recommended path without hidden unlock requirements", () => {
    expect(lessons.map((l) => l.id)).toEqual(
      Array.from(
        { length: 12 },
        (_, i) => `L${String(i + 1).padStart(2, "0")}`,
      ),
    );
    for (const l of lessons.filter((l) => l.events.length))
      expect(validateSong(lessonSong(l))).toEqual([]);
    expect(lessons[2].events.map((e) => e.midi[0])).toEqual([
      60, 62, 64, 64, 62, 60, 60, 62, 64, 64, 62, 60,
    ]);
    expect(lessons[9].events).toHaveLength(8);
    expect(lessons[10].events.map((e) => e.midi)).toEqual([
      [60, 64],
      [55, 62],
      [53, 60],
      [60, 64],
    ]);
    expect(lessonSong(lessons[11], "S05").id).toBe("S05");
    expect(lessonSong(lessons[8], "S01").id).toBe("S03");
  });
  it("requires actual different keys and correct sequential events", () => {
    expect(
      isLessonComplete(lessons[0], { completed: false, distinctKeys: 2 }),
    ).toBe(false);
    expect(
      isLessonComplete(lessons[0], { completed: false, distinctKeys: 3 }),
    ).toBe(true);
    expect(
      isLessonComplete(lessons[2], {
        completed: true,
        waitCompletedEvents: 11,
      }),
    ).toBe(false);
    expect(
      isLessonComplete(lessons[2], {
        completed: true,
        waitCompletedEvents: 12,
      }),
    ).toBe(true);
  });
  it("does not turn broad hits or silence into lesson achievement", () => {
    expect(
      isLessonComplete(lessons[3], {
        completed: true,
        tp: 6,
        fp: 0,
        pitchF1: 0.69,
      }),
    ).toBe(false);
    expect(
      isLessonComplete(lessons[3], {
        completed: true,
        tp: 6,
        fp: 0,
        pitchF1: 0.7,
      }),
    ).toBe(true);
    expect(
      isLessonComplete(lessons[5], {
        completed: true,
        tp: 3,
        fp: 2,
        pitchF1: 0.85,
      }),
    ).toBe(false);
    expect(
      isLessonComplete(lessons[7], {
        completed: true,
        tp: 3,
        fp: 0,
        pitchF1: 0.85,
        restPassed: 2,
      }),
    ).toBe(false);
    expect(
      isLessonComplete(lessons[11], {
        completed: true,
        recall: 0.74,
        pitchF1: 0.85,
      }),
    ).toBe(false);
    expect(
      isLessonComplete(lessons[11], {
        completed: true,
        recall: 0.75,
        pitchF1: 0.85,
      }),
    ).toBe(true);
  });
});
