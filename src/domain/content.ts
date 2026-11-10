/** Canonical musical content, transcribed from design v1.0, chapters 04/09/24. */
export const TUNING_ID = "c-major-f3-e6-v1";
export const PPQ = 480;
export const BAR_TICKS = 1920;
export const SECTION_TICKS = 3840;
export const TEMPO_SCALES = [0.5, 0.75, 1] as const;
export interface NoteKey {
  id: string;
  keyId: string;
  physicalIndex: number;
  midi: number;
  noteName: string;
  solfege: string;
  scaleDegree: number;
  octaveDots: number;
}
export type TuningKey = NoteKey;
export interface MusicEvent {
  id: string;
  kind: "note" | "chord" | "rest";
  tick: number;
  durationTicks: number;
  midi: number[];
}
export interface Song {
  id: string;
  title: string;
  bpm: number;
  bars: number;
  totalTicks: number;
  events: MusicEvent[];
  description: string;
  difficulty: number;
  color: string;
  contentVersion: number;
}
export const physicalMidi = [
  86, 83, 79, 76, 72, 69, 65, 62, 59, 55, 53, 57, 60, 64, 67, 71, 74, 77, 81,
  84, 88,
] as const;
const naturalNames: Record<number, [string, string, number]> = {
  0: ["C", "도", 1],
  2: ["D", "레", 2],
  4: ["E", "미", 3],
  5: ["F", "파", 4],
  7: ["G", "솔", 5],
  9: ["A", "라", 6],
  11: ["B", "시", 7],
};
export const keys: NoteKey[] = physicalMidi.map((midi, i) => {
  const [letter, solfege, scaleDegree] = naturalNames[midi % 12];
  const id = `k${String(i + 1).padStart(2, "0")}`;
  return {
    id,
    keyId: id,
    physicalIndex: i + 1,
    midi,
    noteName: `${letter}${Math.floor(midi / 12) - 1}`,
    solfege,
    scaleDegree,
    octaveDots: Math.floor(midi / 12) - 5,
  };
});
export const noteByMidi = (midi: number): NoteKey | undefined =>
  keys.find((k) => k.midi === midi);
export const noteById = (id: string): NoteKey | undefined =>
  keys.find((k) => k.id === id);
export const frequencyHz = (midi: number): number =>
  440 * 2 ** ((midi - 69) / 12);
export const focusCapacity = (viewportWidth: number, safeArea = 0): number =>
  Math.max(0, Math.floor((viewportWidth - 32 - safeArea + 4) / 48));
export function requiredSpan(events: readonly MusicEvent[]): number {
  const positions = events.flatMap((e) =>
    e.midi.map((m) => {
      const key = noteByMidi(m);
      if (!key) throw new Error(`Unsupported MIDI ${m}`);
      return key.physicalIndex;
    }),
  );
  return positions.length
    ? Math.max(...positions) - Math.min(...positions) + 1
    : 0;
}
/** Parse complete bars; unknown notes and invalid timing are never approximated. */
export function parseBars(id: string, bars: readonly string[]): MusicEvent[] {
  const events: MusicEvent[] = [];
  let tick = 0;
  bars.forEach((bar, bi) => {
    const start = tick;
    bar
      .trim()
      .split(/\s+/)
      .forEach((token, ei) => {
        const match =
          /^(R|[A-G][3-6]|\[[A-G][3-6],[A-G][3-6]\]):(\d+(?:\.\d+)?)$/.exec(
            token,
          );
        if (!match)
          throw new Error(`${id} bar ${bi + 1}: invalid token ${token}`);
        const names =
          match[1] === "R" ? [] : match[1].replace(/[\[\]]/g, "").split(",");
        const midi = names.map((name) => {
          const key = keys.find((k) => k.noteName === name);
          if (!key) throw new Error(`${id}: unsupported note ${name}`);
          return key.midi;
        });
        const durationTicks = Number(match[2]) * PPQ;
        if (
          !Number.isInteger(durationTicks) ||
          durationTicks <= 0 ||
          new Set(midi).size !== midi.length
        )
          throw new Error(`${id} bar ${bi + 1}: invalid duration/chord`);
        events.push({
          id: `${id}-b${bi + 1}-e${ei + 1}`,
          kind:
            midi.length === 0 ? "rest" : midi.length === 2 ? "chord" : "note",
          tick,
          durationTicks,
          midi,
        });
        tick += durationTicks;
      });
    if (tick - start !== BAR_TICKS)
      throw new Error(
        `${id} bar ${bi + 1}: expected 1920 ticks, received ${tick - start}`,
      );
  });
  return events;
}
interface SongSource {
  id: string;
  title: string;
  bpm: number;
  patterns: Record<string, string>;
  order: string[];
}

export const songPatterns: SongSource[] = [
  {
    id: "S01",
    title: "고양이의 첫 인사",
    bpm: 60,
    patterns: {
      A1: "C4:1 D4:1 E4:2",
      A2: "E4:1 D4:1 C4:2",
      A3: "C4:1 C4:1 D4:1 E4:1",
      A4: "C4:4",
    },
    order: ["A1", "A2", "A3", "A4", "A1", "A2", "A3", "A4"],
  },
  {
    id: "S02",
    title: "통통 발자국",
    bpm: 72,
    patterns: {
      A1: "C4:0.5 C4:0.5 D4:1 E4:2",
      A2: "E4:0.5 E4:0.5 D4:1 C4:2",
      A3: "C4:1 D4:0.5 D4:0.5 E4:1 D4:1",
      A4: "C4:4",
      B1: "E4:1 D4:1 C4:0.5 C4:0.5 D4:1",
      B2: "E4:0.5 D4:0.5 C4:1 D4:2",
      B3: "C4:0.5 D4:0.5 E4:1 D4:1 C4:1",
      B4: "C4:4",
    },
    order: [
      "A1",
      "A2",
      "A3",
      "A4",
      "B1",
      "B2",
      "B3",
      "B4",
      "A1",
      "A2",
      "A3",
      "A4",
    ],
  },
  {
    id: "S03",
    title: "다섯 음 산책",
    bpm: 80,
    patterns: {
      A1: "C4:1 D4:1 E4:1 G4:1",
      A2: "G4:1 F4:1 E4:2",
      A3: "D4:1 F4:1 E4:1 D4:1",
      A4: "C4:4",
      B1: "E4:1 F4:1 G4:2",
      B2: "G4:1 E4:1 F4:1 D4:1",
      B3: "C4:1 D4:1 E4:1 D4:1",
      B4: "C4:4",
    },
    order: [
      "A1",
      "A2",
      "A3",
      "A4",
      "B1",
      "B2",
      "B3",
      "B4",
      "A1",
      "A2",
      "A3",
      "A4",
    ],
  },
  {
    id: "S04",
    title: "쉬어 가는 정원",
    bpm: 72,
    patterns: {
      A1: "C4:1 R:1 E4:1 R:1",
      A2: "G4:2 R:1 E4:1",
      A3: "D4:1 R:1 E4:1 D4:1",
      A4: "C4:2 R:2",
      B1: "E4:0.5 F4:0.5 G4:1 R:1 G4:1",
      B2: "F4:1 R:1 E4:2",
      B3: "D4:1 E4:1 R:1 D4:1",
      B4: "C4:2 R:2",
    },
    order: [
      "A1",
      "A2",
      "A3",
      "A4",
      "B1",
      "B2",
      "B3",
      "B4",
      "A1",
      "A2",
      "A3",
      "A4",
    ],
  },
  {
    id: "S05",
    title: "별빛 작은 연주회",
    bpm: 88,
    patterns: {
      A1: "[C4,E4]:2 G4:1 E4:1",
      A2: "[G3,D4]:2 G4:2",
      A3: "[F3,C4]:2 F4:1 E4:1",
      A4: "[C4,E4]:4",
      B1: "[A3,E4]:2 A4:1 G4:1",
      B2: "[F3,C4]:2 F4:2",
      B3: "[G3,D4]:1 E4:1 D4:1 G4:1",
      B4: "[C4,E4]:4",
      C1: "C5:1 G4:1 E4:1 C4:1",
      C2: "[F3,C4]:2 A4:1 F4:1",
      C3: "[G3,D4]:2 B4:1 G4:1",
      C4: "[C4,E4]:2 R:2",
      D1: "[A3,E4]:1 G4:1 E4:1 C4:1",
      D2: "[F3,C4]:1 F4:1 A4:1 F4:1",
      D3: "[G3,D4]:2 B4:1 G4:1",
      D4: "[C4,E4]:4",
    },
    order: [
      "A1",
      "A2",
      "A3",
      "A4",
      "B1",
      "B2",
      "B3",
      "B4",
      "C1",
      "C2",
      "C3",
      "C4",
      "D1",
      "D2",
      "D3",
      "D4",
    ],
  },
];
const descriptions = [
  "도·레·미 세 음으로 건네는 첫 인사",
  "짧은 음과 반복음으로 만드는 발자국",
  "도부터 솔까지, 다섯 음의 작은 산책",
  "쉼표에 귀 기울이고 여운을 느껴요",
  "저음과 두 음 화음이 어우러지는 연주회",
];
const colors = ["#d6a444", "#d68565", "#879c72", "#72a396", "#8b83ac"];
export const songs: Song[] = songPatterns.map((source, i) => ({
  id: source.id,
  title: source.title,
  bpm: source.bpm,
  bars: source.order.length,
  totalTicks: source.order.length * BAR_TICKS,
  events: parseBars(
    source.id,
    source.order.map((name) => source.patterns[name]),
  ),
  description: descriptions[i],
  difficulty: i + 1,
  color: colors[i],
  contentVersion: 1,
}));
export function validateSong(song: Song): string[] {
  const errors: string[] = [];
  if (!song || typeof song !== "object") return ["Song must be an object"];
  if (!song.id || !song.title) errors.push("Song id/title missing");
  if (!Number.isFinite(song.bpm) || song.bpm <= 0)
    errors.push(`${song.id}: invalid BPM`);
  if (
    !Number.isInteger(song.bars) ||
    song.bars < 1 ||
    song.totalTicks !== song.bars * BAR_TICKS
  )
    errors.push(`${song.id}: invalid bar/totalTicks`);
  if (!Array.isArray(song.events))
    return [...errors, `${song.id}: events must be an array`];
  const ids = new Set<string>();
  let cursor = 0;
  for (const event of song.events) {
    const where = `${song.id}/${event.id}`;
    if (!event.id || ids.has(event.id))
      errors.push(`${where}: duplicate or missing event id`);
    ids.add(event.id);
    if (!Number.isInteger(event.tick) || event.tick !== cursor)
      errors.push(`${where}: event gap, overlap or invalid tick`);
    if (!Number.isInteger(event.durationTicks) || event.durationTicks <= 0)
      errors.push(`${where}: invalid duration`);
    if (event.tick + event.durationTicks > song.totalTicks)
      errors.push(`${where}: beyond song end`);
    if (
      Math.floor(event.tick / BAR_TICKS) !==
      Math.floor((event.tick + event.durationTicks - 1) / BAR_TICKS)
    )
      errors.push(`${where}: event crosses bar boundary`);
    if (!Array.isArray(event.midi)) {
      errors.push(`${where}: MIDI must be an array`);
      continue;
    }
    const count = event.midi.length;
    if (count > 2 || new Set(event.midi).size !== count)
      errors.push(`${where}: invalid chord`);
    if (event.kind !== (count === 0 ? "rest" : count === 2 ? "chord" : "note"))
      errors.push(`${where}: kind does not match MIDI`);
    if (event.midi.some((m) => !Number.isInteger(m) || !noteByMidi(m)))
      errors.push(`${where}: unsupported MIDI`);
    cursor = event.tick + event.durationTicks;
  }
  if (cursor !== song.totalTicks)
    errors.push(`${song.id}: incomplete song timeline`);
  return errors;
}
export interface LessonCompletion {
  kind: "distinct-keys" | "sequence-complete" | "challenge";
  targetEvents?: number;
  minTp?: number;
  maxFp?: number;
  minRestPassed?: number;
  minRecall?: number;
  minPitchF1?: number;
}
export interface Lesson {
  id: string;
  title: string;
  description: string;
  mode: "wait" | "challenge" | "explore";
  bpm: number;
  events: MusicEvent[];
  songId?: string;
  task: {
    kind: "distinct-keys" | "pitch-sequence" | "pattern" | "song";
    midi?: number[];
    repeatCount?: number;
    songId?: string;
  };
  completion: LessonCompletion;
  waitChordPolicy: "sequential" | "together";
}
const makeLesson = (
  id: string,
  title: string,
  description: string,
  mode: Lesson["mode"],
  bars: string[],
  completion: LessonCompletion,
  policy: Lesson["waitChordPolicy"] = "sequential",
): Lesson => ({
  id,
  title,
  description,
  mode,
  bpm: 60,
  events: parseBars(id, bars),
  task: { kind: "pattern" },
  completion,
  waitChordPolicy: policy,
});
export const lessons: Lesson[] = [
  {
    ...makeLesson(
      "L01",
      "소리를 열어요",
      "소리를 켜고 서로 다른 세 개의 키를 눌러 보세요.",
      "explore",
      [],
      { kind: "distinct-keys", targetEvents: 3 },
    ),
    task: { kind: "distinct-keys" },
  },
  {
    ...makeLesson(
      "L02",
      "가운데를 알아요",
      "중앙 파 F3와 오른쪽 도 C4를 두 번씩 찾아요.",
      "wait",
      ["F3:1 C4:1 F3:1 C4:1"],
      { kind: "sequence-complete", targetEvents: 4 },
    ),
    task: { kind: "pitch-sequence", midi: [53, 60, 53, 60], repeatCount: 1 },
  },
  {
    ...makeLesson(
      "L03",
      "세 음의 인사",
      "도·레·미, 미·레·도. 여섯 음을 두 번 연주해요.",
      "wait",
      ["C4:1 D4:1 E4:1 E4:1", "D4:1 C4:1 C4:1 D4:1", "E4:1 E4:1 D4:1 C4:1"],
      { kind: "sequence-complete", targetEvents: 12 },
    ),
    task: {
      kind: "pitch-sequence",
      midi: [60, 62, 64, 64, 62, 60],
      repeatCount: 2,
    },
  },
  makeLesson(
    "L04",
    "걸음 박자",
    "한 박에 한 번. 준비 박자를 듣고 여덟 번 연주해요.",
    "challenge",
    ["C4:1 C4:1 C4:1 C4:1", "C4:1 C4:1 C4:1 C4:1"],
    { kind: "challenge", minTp: 6, minPitchF1: 0.7 },
  ),
  makeLesson(
    "L05",
    "같은 음을 다시",
    "짧은 두 음은 손을 떼고 다시 눌러요. 먼저 기다림 연습도 해 보세요.",
    "challenge",
    ["C4:0.5 C4:0.5 D4:1 E4:2", "C4:0.5 C4:0.5 D4:1 E4:2"],
    { kind: "challenge", minTp: 6, minPitchF1: 0.7 },
  ),
  makeLesson(
    "L06",
    "소리를 기다려요",
    "손을 떼어도 여운은 남아요. 다음 음의 시작까지 기다려요.",
    "challenge",
    ["C4:2 D4:2", "E4:4"],
    { kind: "challenge", minTp: 3, maxFp: 1, minPitchF1: 0.7 },
  ),
  makeLesson(
    "L07",
    "왼쪽과 오른쪽",
    "왼쪽과 오른쪽을 오가며 여덟 음을 찾아요.",
    "wait",
    ["G3:1 A3:1 D4:1 E4:1", "G3:1 A3:1 D4:1 E4:1"],
    { kind: "sequence-complete", targetEvents: 8 },
  ),
  makeLesson(
    "L08",
    "쉬는 것도 음악",
    "쉼표에서는 새로 누르지 않고 울림을 들어요.",
    "challenge",
    ["C4:1 R:1 C4:1 R:1", "C4:1 R:1 C4:1 R:1"],
    { kind: "challenge", minTp: 3, minRestPassed: 3, minPitchF1: 0.7 },
  ),
  {
    ...makeLesson(
      "L09",
      "다섯 음 산책",
      "다섯 음의 곡을 처음부터 끝까지 천천히 확인해요.",
      "wait",
      [],
      { kind: "sequence-complete", targetEvents: songs[2].events.length },
    ),
    bpm: songs[2].bpm,
    events: songs[2].events,
    songId: "S03",
    task: { kind: "song", songId: "S03" },
  },
  makeLesson(
    "L10",
    "높은 도 찾기",
    "낮은 도와 높은 도의 옥타브 점을 비교해요.",
    "wait",
    ["C4:2 C5:2", "C5:2 C4:2", "C4:2 C5:2", "C5:2 C4:2"],
    { kind: "sequence-complete", targetEvents: 8 },
  ),
  makeLesson(
    "L11",
    "두 음의 인사",
    "서로 다른 두 음을 함께 연주해요. 순서대로 찾기도 선택할 수 있어요.",
    "wait",
    ["[C4,E4]:2 [G3,D4]:2", "[F3,C4]:2 [C4,E4]:2"],
    { kind: "sequence-complete", targetEvents: 4 },
    "together",
  ),
  {
    ...makeLesson(
      "L12",
      "작은 연주회",
      "원하는 곡을 선택해 끝까지 연주해요. 음 75% 이상과 정확도 70%를 목표로 해요.",
      "challenge",
      [],
      { kind: "challenge", minRecall: 0.75, minPitchF1: 0.7 },
    ),
    bpm: songs[0].bpm,
    events: songs[0].events,
    songId: "S01",
    task: { kind: "song", songId: "S01" },
  },
];
export function lessonSong(lesson: Lesson, selectedSongId?: string): Song {
  if (lesson.task.kind === "song")
    return (
      songs.find(
        (s) =>
          s.id ===
          (lesson.id === "L12"
            ? (selectedSongId ?? lesson.songId)
            : lesson.songId),
      ) ?? songs[0]
    );
  const totalTicks = lesson.events.reduce(
    (end, e) => Math.max(end, e.tick + e.durationTicks),
    0,
  );
  return {
    id: lesson.id,
    title: lesson.title,
    description: lesson.description,
    bpm: lesson.bpm,
    bars: totalTicks / BAR_TICKS,
    totalTicks,
    events: lesson.events,
    difficulty: 1,
    color: colors[0],
    contentVersion: 1,
  };
}
export interface LessonEvidence {
  completed?: boolean;
  waitChordPolicy?: string;
  tp?: number;
  fp?: number;
  recall?: number;
  pitchF1?: number;
  restPassed?: number;
  waitCompletedEvents?: number;
  distinctKeys?: number;
  mode?: string;
}
export function isLessonComplete(
  lesson: Lesson,
  evidence: LessonEvidence,
): boolean {
  const c = lesson.completion;
  if (c.kind === "distinct-keys")
    return (evidence.distinctKeys ?? 0) >= (c.targetEvents ?? 3);
  if (!evidence.completed) return false;
  if (c.kind === "sequence-complete")
    return (
      (evidence.waitCompletedEvents ?? 0) >=
      (c.targetEvents ?? lesson.events.length)
    );
  return (
    (evidence.pitchF1 ?? 0) >= (c.minPitchF1 ?? 0.7) &&
    (evidence.tp ?? 0) >= (c.minTp ?? 0) &&
    (evidence.fp ?? 0) <= (c.maxFp ?? Infinity) &&
    (evidence.recall ?? 0) >= (c.minRecall ?? 0) &&
    (evidence.restPassed ?? 0) >= (c.minRestPassed ?? 0)
  );
}

export const lessonPassed = isLessonComplete;
