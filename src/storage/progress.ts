/** Browser-local storage. Successful promises resolve only after transaction completion. */
export interface Settings {
  volume: number;
  labelMode: "number" | "solfege" | "letter";
  reducedMotion: boolean;
  metronome: boolean;
  guideLevel: "guided" | "current-only" | "off";
  lastSongId: string;
  lastMode: "free" | "wait" | "challenge";
  [key: string]: unknown;
}

export const defaultSettings: Settings = {
  volume: 0.6,
  labelMode: "number",
  reducedMotion: false,
  metronome: true,
  guideLevel: "guided",
  lastSongId: "S01",
  lastMode: "free",
};

export interface SavedAttempt {
  attemptId: string;
  songId: string;
  mode: "wait" | "challenge";
  completed: boolean;
  scope?: "song" | "segment";
  recall?: number;
  score?: number | null;
  badges?: string[];
  earnedBadges?: string[];
  lessonId?: string;
  /** Set only after the lesson's own completion predicate has passed. */
  lessonCompleted?: boolean;
  waitCompletedEvents?: number;
  waitTotalEvents?: number;
  endedAtISO?: string;
  startedAtISO?: string;
  songContentVersion?: number;
  tuningVersion?: number;
  tuningId?: string;
  judgmentVersion?: string | number;
  tempoScale?: number;
  guideLevel?: string;
  layoutMode?: string;
  timingMode?: string;
  timingQuality?: string;
  inputLog?: unknown[];
  [key: string]: unknown;
}

export interface CalibrationProfile {
  id: string;
  timingMode: "output-timestamp" | "render-clock";
  offsetMs: number;
  sampleRate: number;
  measuredAtISO?: string;
  outputKind?: "speaker" | "wired" | "bluetooth" | "unknown";
  [key: string]: unknown;
}

export interface ProgressSnapshot {
  lessonIds: string[];
  cats: string[];
  best: Record<string, SavedAttempt>;
  attempts: SavedAttempt[];
}

interface ProgressRecord {
  progressKey: string;
  lessonId?: string;
  attempt?: SavedAttempt;
}

const DB_NAME = "kalimba-garden";
const DB_VERSION = 1;
const STORES = [
  "settings",
  "calibrationProfiles",
  "attempts",
  "progress",
  "rewardLedger",
  "collection",
] as const;
const RESULT_STORES = ["attempts", "progress", "rewardLedger", "collection"];
const CAT_BY_SONG: Record<string, string> = {
  S01: "cat-mikan",
  S02: "cat-socks",
  S03: "cat-leaf",
  S04: "cat-moon",
  S05: "cat-star",
};
let opening: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  if (opening) return opening;
  opening = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(
        new Error(
          "이 브라우저에서는 저장할 수 없어요. 이번 기록은 저장되지 않았어요.",
        ),
      );
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    let blocked = false;
    request.onupgradeneeded = () => {
      const db = request.result;
      // Additive migrations preserve every existing store and record.
      const keyPaths: Record<string, string> = {
        settings: "id",
        calibrationProfiles: "id",
        attempts: "attemptId",
        progress: "progressKey",
        rewardLedger: "rewardKey",
        collection: "itemId",
      };
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name))
          db.createObjectStore(name, { keyPath: keyPaths[name] });
      }
    };
    request.onerror = () =>
      reject(request.error ?? new Error("저장소를 열지 못했어요."));
    request.onblocked = () => {
      blocked = true;
      reject(new Error("이전 버전의 탭을 닫은 뒤 다시 저장해 주세요."));
    };
    request.onsuccess = () => {
      const db = request.result;
      if (blocked) {
        db.close();
        return;
      }
      db.onversionchange = () => {
        db.close();
        opening = undefined;
        if (typeof window !== "undefined")
          window.dispatchEvent(new Event("kalimba-storage-versionchange"));
      };
      db.onclose = () => {
        opening = undefined;
      };
      resolve(db);
    };
  });
  opening.catch(() => {
    opening = undefined;
  });
  return opening;
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () =>
      reject(
        tx.error ??
          new Error("이번 기록은 저장되지 않았어요. 다시 시도해 주세요."),
      );
    tx.onabort = () =>
      reject(
        tx.error ??
          new Error("이번 기록은 저장되지 않았어요. 다시 시도해 주세요."),
      );
  });
}

function valueOf<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("저장된 기록을 읽지 못했어요."));
  });
}

export async function getSettings(): Promise<Settings> {
  const db = await openDatabase();
  const tx = db.transaction("settings", "readonly");
  const done = transactionDone(tx);
  const record = (await valueOf(
    tx.objectStore("settings").get("singleton"),
  )) as Partial<Settings> | undefined;
  await done;
  return { ...defaultSettings, ...record };
}

export async function saveSettings(
  partial: Partial<Settings>,
): Promise<Settings> {
  const db = await openDatabase();
  const tx = db.transaction("settings", "readwrite");
  const done = transactionDone(tx);
  let settings: Settings = { ...defaultSettings };
  const store = tx.objectStore("settings");
  const read = store.get("singleton");
  read.onsuccess = () => {
    settings = { ...defaultSettings, ...read.result, ...partial };
    settings.volume = Number.isFinite(settings.volume)
      ? Math.min(1, Math.max(0, settings.volume))
      : 0.6;
    store.put({ ...settings, id: "singleton" });
  };
  await done;
  return settings;
}

/** All comparison dimensions remain stable across sessions; cosmetic content changes cannot grant cats again. */
export function comparisonKey(attempt: SavedAttempt): string {
  return JSON.stringify([
    attempt.songId,
    attempt.songContentVersion ?? 1,
    attempt.tuningId ?? "c-major-f3-e6-v1",
    attempt.tuningVersion ?? 1,
    attempt.judgmentVersion ?? 1,
    attempt.mode,
    attempt.tempoScale ?? 1,
    attempt.guideLevel ?? "guided",
    attempt.layoutMode ?? "pads",
    attempt.timingMode ?? "render-clock",
    attempt.timingQuality ?? "normal",
  ]);
}

export function rewardEligible(attempt: SavedAttempt): boolean {
  if (
    !attempt.completed ||
    attempt.scope === "segment" ||
    !CAT_BY_SONG[attempt.songId]
  )
    return false;
  if (attempt.mode === "challenge")
    return Number.isFinite(attempt.recall) && (attempt.recall ?? 0) >= 0.5;
  return (
    (attempt.waitTotalEvents ?? 0) > 0 &&
    attempt.waitCompletedEvents === attempt.waitTotalEvents
  );
}

function persistedAttempt(attempt: SavedAttempt): SavedAttempt {
  if (
    !attempt.attemptId ||
    !attempt.songId ||
    !["wait", "challenge"].includes(attempt.mode)
  ) {
    throw new Error("저장할 연주 기록이 올바르지 않아요.");
  }
  return {
    ...attempt,
    endedAtISO: attempt.endedAtISO ?? new Date().toISOString(),
    ...(attempt.inputLog ? { inputLog: attempt.inputLog.slice(-1000) } : {}),
  };
}

export interface SaveAttemptResult {
  saved: true;
  alreadySaved: boolean;
  rewardedCat: string | null;
}

export async function saveAttempt(
  input: SavedAttempt,
): Promise<SaveAttemptResult> {
  const attempt = persistedAttempt(input);
  const db = await openDatabase();
  const tx = db.transaction(RESULT_STORES, "readwrite");
  const done = transactionDone(tx);
  const attempts = tx.objectStore("attempts");
  const progress = tx.objectStore("progress");
  const result: SaveAttemptResult = {
    saved: true,
    alreadySaved: false,
    rewardedCat: null,
  };
  let writeError: unknown;
  const existing = attempts.get(attempt.attemptId);
  existing.onsuccess = () => {
    if (existing.result) {
      result.alreadySaved = true;
      return;
    }
    try {
      attempts.add(attempt);
      if (attempt.lessonId && attempt.lessonCompleted) {
        progress.put({
          progressKey: `lesson:${attempt.lessonId}`,
          lessonId: attempt.lessonId,
          completedAtISO: attempt.endedAtISO,
        });
      }
      if (
        attempt.mode === "challenge" &&
        attempt.completed &&
        attempt.scope !== "segment" &&
        Number.isFinite(attempt.score)
      ) {
        const key = `song:${attempt.songId}:${comparisonKey(attempt)}`;
        const best = progress.get(key);
        best.onsuccess = () => {
          const prior: SavedAttempt | undefined = best.result?.attempt;
          const winner =
            !prior || (attempt.score ?? 0) > (prior.score ?? 0)
              ? attempt
              : prior;
          const badges = [
            ...new Set([
              ...(prior?.badges ?? prior?.earnedBadges ?? []),
              ...(attempt.badges ?? attempt.earnedBadges ?? []),
            ]),
          ];
          progress.put({
            progressKey: key,
            attempt: { ...winner, badges, earnedBadges: badges },
          });
        };
      }
      if (rewardEligible(attempt)) {
        const rewardKey = `${attempt.songId}:first-clear:reward-v1`;
        const ledger = tx.objectStore("rewardLedger");
        const known = ledger.get(rewardKey);
        known.onsuccess = () => {
          if (known.result) return;
          const itemId = CAT_BY_SONG[attempt.songId];
          ledger.add({
            rewardKey,
            itemId,
            attemptId: attempt.attemptId,
            earnedAtISO: attempt.endedAtISO,
          });
          tx.objectStore("collection").put({
            itemId,
            earnedAtISO: attempt.endedAtISO,
          });
          result.rewardedCat = itemId;
        };
      }
      // Bound detailed local history without deleting progress, rewards, or best attempts.
      const all = attempts.getAll();
      all.onsuccess = () => {
        const sorted = (all.result as SavedAttempt[]).sort((a, b) =>
          (b.endedAtISO ?? "").localeCompare(a.endedAtISO ?? ""),
        );
        for (const old of sorted.slice(200)) attempts.delete(old.attemptId);
        for (const old of sorted.slice(20, 200)) {
          if (old.inputLog) {
            const summary = { ...old };
            delete summary.inputLog;
            attempts.put(summary);
          }
        }
      };
    } catch (error) {
      writeError = error;
      tx.abort();
    }
  };
  try {
    await done;
  } catch (error) {
    throw writeError ?? error;
  }
  return result;
}

export async function loadProgress(): Promise<ProgressSnapshot> {
  const db = await openDatabase();
  const tx = db.transaction(["progress", "collection", "attempts"], "readonly");
  const done = transactionDone(tx);
  const [records, collection, attempts] = await Promise.all([
    valueOf(tx.objectStore("progress").getAll()) as Promise<ProgressRecord[]>,
    valueOf(tx.objectStore("collection").getAll()) as Promise<
      { itemId: string }[]
    >,
    valueOf(tx.objectStore("attempts").getAll()) as Promise<SavedAttempt[]>,
  ]);
  await done;
  const best: Record<string, SavedAttempt> = {};
  for (const record of records)
    if (record.attempt) best[record.progressKey] = record.attempt;
  return {
    lessonIds: records
      .filter((r) => !!r.lessonId)
      .map((r) => r.lessonId!)
      .sort(),
    cats: collection.map((item) => item.itemId).sort(),
    best,
    attempts: attempts.sort((a, b) =>
      (b.endedAtISO ?? "").localeCompare(a.endedAtISO ?? ""),
    ),
  };
}

export async function completeLesson(id: string): Promise<void> {
  if (!/^L\d\d$/.test(id)) throw new Error("레슨 ID가 올바르지 않아요.");
  const db = await openDatabase();
  const tx = db.transaction("progress", "readwrite");
  const done = transactionDone(tx);
  tx.objectStore("progress").put({
    progressKey: `lesson:${id}`,
    lessonId: id,
    completedAtISO: new Date().toISOString(),
  });
  await done;
}

/** UI must request explicit user confirmation before calling this destructive operation. */
export async function resetProgress(): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction([...STORES], "readwrite");
  const done = transactionDone(tx);
  for (const store of STORES) tx.objectStore(store).clear();
  await done;
}

export async function saveCalibration(
  profile: CalibrationProfile,
): Promise<void> {
  if (
    !profile.id ||
    !Number.isFinite(profile.offsetMs) ||
    Math.abs(profile.offsetMs) > 250 ||
    !Number.isFinite(profile.sampleRate) ||
    profile.sampleRate <= 0
  ) {
    throw new Error("보정값을 저장할 수 없어요. 다시 측정해 주세요.");
  }
  const db = await openDatabase();
  const tx = db.transaction("calibrationProfiles", "readwrite");
  const done = transactionDone(tx);
  tx.objectStore("calibrationProfiles").put({
    ...profile,
    measuredAtISO: profile.measuredAtISO ?? new Date().toISOString(),
  });
  await done;
}

export async function getCalibration(
  id: string,
): Promise<CalibrationProfile | undefined> {
  const db = await openDatabase();
  const tx = db.transaction("calibrationProfiles", "readonly");
  const done = transactionDone(tx);
  const profile = (await valueOf(
    tx.objectStore("calibrationProfiles").get(id),
  )) as CalibrationProfile | undefined;
  await done;
  return profile;
}
