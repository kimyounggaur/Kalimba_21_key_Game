import {
  songs,
  keys,
  lessons,
  validateSong,
  lessonSong,
  requiredSpan,
} from "../src/domain/content";
const errors = songs.flatMap((s) => validateSong(s));
if (keys.length !== 21 || lessons.length !== 12 || songs.length !== 5)
  errors.push("Content count mismatch");
const expectedEvents = [0, 4, 12, 8, 8, 3, 8, 8, 36, 8, 4, 22];
const metrics = songs.map((s) => ({
  id: s.id,
  bars: s.bars,
  ticks: s.totalTicks,
  seconds: ((s.totalTicks / 480) * 60) / s.bpm,
  events: s.events.length,
  slots: s.events.reduce((sum, e) => sum + e.midi.length, 0),
  rests: s.events.filter((e) => !e.midi.length).length,
  chords: s.events.filter((e) => e.midi.length === 2).length,
  physicalSpan: requiredSpan(s.events),
}));
for (const [index, lesson] of lessons.entries()) {
  if (lesson.events.length !== expectedEvents[index])
    errors.push(`${lesson.id}: incomplete lesson pattern`);
  if (lesson.mode !== "explore")
    errors.push(...validateSong(lessonSong(lesson)));
  if (lesson.id === "L09" && lessonSong(lesson, "S01").id !== "S03")
    errors.push("L09 must refer to S03");
  if (lesson.id === "L12")
    for (const song of songs)
      errors.push(...validateSong(lessonSong(lesson, song.id)));
}
if (errors.length) throw new Error(errors.join("\n"));
console.log(
  `Validated ${keys.length} keys, ${songs.length} songs, ${lessons.length} lessons.`,
);
console.table(metrics);
