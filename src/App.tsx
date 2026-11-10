import { useState, useEffect, useRef, useCallback } from "react";
import {
  Leaf,
  Music2,
  BookOpen,
  Flower2,
  Settings2,
  Play,
  Pause,
  ArrowLeft,
  ArrowRight,
  Check,
  Volume2,
  Maximize,
  Minimize,
  RotateCcw,
  Headphones,
  Star,
  ChevronRight,
  SlidersHorizontal,
  X,
  CheckCircle2,
  Clock3,
  Repeat2,
  Sprout,
  Sun,
  HelpCircle,
} from "lucide-react";
import {
  keys,
  songs,
  lessons,
  noteByMidi,
  lessonSong,
  lessonPassed,
  requiredSpan,
} from "./domain/content";
import type { Song } from "./domain/content";
import Instrument from "./components/Instrument";
import type { LayoutMode, LabelMode } from "./components/Instrument";
import Cat from "./components/Cat";
import Calibration, { calibrationProfileId } from "./components/Calibration";
import { audio } from "./engine/audio";
import { Session } from "./engine/session";
import type { SessionView, PlayMode } from "./engine/session";
import { evaluateBadges } from "./engine/judgment";
import {
  getSettings,
  saveSettings,
  loadProgress,
  saveAttempt,
  completeLesson,
  resetProgress,
  getCalibration,
} from "./storage/progress";
import type { SavedAttempt } from "./storage/progress";

type Page = "play" | "learn" | "songs" | "garden";
const emptyProgress = {
  lessonIds: [] as string[],
  cats: [] as string[],
  best: {} as Record<string, SavedAttempt>,
  attempts: [] as SavedAttempt[],
};
const catNames = ["귤이", "양말이", "새싹이", "달이", "별이"];
const catIds = ["cat-mikan", "cat-socks", "cat-leaf", "cat-moon", "cat-star"];
const modeNames = {
  free: "자유 연주",
  listen: "시범 듣기",
  wait: "따라 연주",
  challenge: "곡 도전",
};
const initView: SessionView = {
  state: "ready",
  tick: 0,
  count: 0,
  feedback: "",
  progress: 0,
  eventIndex: 0,
};
export default function App() {
  const [page, setPage] = useState<Page>("play");
  const [headerMenu, setHeaderMenu] = useState<"mode" | "controls" | null>(null);
  const [selected, setSelected] = useState(songs[0]);
  const [mode, setMode] = useState<PlayMode>("free");
  const [tempo, setTempo] = useState(1);
  const [guide, setGuide] = useState<"guided" | "current-only" | "off">(
    "guided",
  );
  const [layout, setLayout] = useState<LayoutMode>(() =>
    innerWidth < 700 ? "pads" : "physical-all",
  );
  const [label, setLabel] = useState<LabelMode>("number");
  const [volume, setVolume] = useState(0.6);
  const [metronome, setMetronome] = useState(true);
  const [reduced, setReduced] = useState(
    matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [offset, setOffset] = useState(0);
  const [policy, setPolicy] = useState<"sequential" | "together">("sequential");
  const [width, setWidth] = useState(innerWidth);
  const [instrumentWidth, setInstrumentWidth] = useState(Math.max(0, innerWidth - 52));
  const [progress, setProgress] = useState(emptyProgress);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [help, setHelp] = useState(false);
  const [view, setView] = useState<SessionView>(initView);
  const [sound, setSound] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [focus, setFocus] = useState(false);
  const [lessonId, setLessonId] = useState<string | null>(null);
  const [result, setResult] = useState<SavedAttempt | null>(null);
  const [saved, setSaved] = useState(false);
  const [reward, setReward] = useState<string | null>(null);
  const [freeNote, setFreeNote] = useState("");
  const [freeCount, setFreeCount] = useState(0);
  const [loop, setLoop] = useState(false);
  const [section, setSection] = useState(-1);
  const [calibrating, setCalibrating] = useState(false);

  const session = useRef<Session | null>(null);
  const current = useRef({
    selected,
    mode,
    tempo,
    guide,
    layout,
    lessonId,
    policy,
  });
  current.current = { selected, mode, tempo, guide, layout, lessonId, policy };
  const startSequence = useRef(0);
  const freeKeys = useRef(new Set<number>());
  const lastStart = useRef(0);
  const hadGuide = useRef(false);
  const mainRef = useRef<HTMLElement>(null);
  const instrumentPanelRef = useRef<HTMLElement>(null);
  const refresh = () =>
    loadProgress()
      .then(setProgress)
      .catch(() =>
        setError(
          "이 브라우저에서 기록을 읽지 못했어요. 연주는 계속할 수 있어요.",
        ),
      );
  useEffect(() => {
    getSettings()
      .then((s) => {
        setVolume(s.volume);
        setLabel(s.labelMode);
        setMetronome(s.metronome);
        setReduced(s.reducedMotion);
        setSelected(songs.find((song) => song.id === s.lastSongId) ?? songs[0]);
        audio.setVolume(s.volume);
      })
      .catch(() => {});
    void refresh();
    return () => {
      session.current?.dispose();
    };
  }, []);
  useEffect(() => {
    const resize = () => {
      setWidth(innerWidth);
      session.current?.pause(
        "화면 크기가 바뀌었어요. 배치를 확인하고 이어서 연주해요.",
      );
    };
    const hidden = () => {
      if (document.hidden)
        session.current?.pause(
          "잠시 자리를 비웠네요. 같은 구간부터 이어서 연주해요.",
        );
    };
    const blur = () => session.current?.pause("다시 준비되면 이어서 연주해요.");
    addEventListener("resize", resize);
    addEventListener("blur", blur);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      removeEventListener("resize", resize);
      removeEventListener("blur", blur);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, []);
  useEffect(() => {
    const back = () => {
      session.current?.dispose();
      session.current = null;
      setMode("free");
      setView(initView);
      setPage("play");
      setResult(null);
    };
    addEventListener("popstate", back);
    return () => removeEventListener("popstate", back);
  }, []);
  useEffect(() => {
    const panel = instrumentPanelRef.current;
    if (!panel) return;
    const measure = () => {
      const styles = getComputedStyle(panel);
      setInstrumentWidth(
        panel.clientWidth - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight),
      );
    };
    measure();
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setInstrumentWidth(entry.contentRect.width);
    });
    observer.observe(panel);
    return () => observer.disconnect();
  }, [page, focus]);
  useEffect(() => {
    if (!settingsOpen && !help && !result && !calibrating) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = document.querySelector<HTMLElement>("[role=dialog]");
    const focusable = () =>
      Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]',
        ) ?? [],
      ).filter((el) => el.offsetParent !== null);
    focusable()[0]?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSettingsOpen(false);
        setHelp(false);
        setCalibrating(false);
        setResult(null);
        e.preventDefault();
      }
      if (e.key === "Tab") {
        const items = focusable();
        if (!items.length) return;
        const first = items[0],
          last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          last.focus();
          e.preventDefault();
        } else if (!e.shiftKey && document.activeElement === last) {
          first.focus();
          e.preventDefault();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, [settingsOpen, help, !!result, calibrating]);
  useEffect(() => {
    const change = () => setFocus(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", change);
    return () => document.removeEventListener("fullscreenchange", change);
  }, []);
  const prepare = async () => {
    setLoading(true);
    setError("");
    try {
      await audio.unlock();
      await audio.prepare();
      audio.setVolume(volume);
      audio.freezeTimingMode();
      const profile = await getCalibration(
        calibrationProfileId(
          audio.timingMode,
          audio.context?.sampleRate ?? 44100,
        ),
      ).catch(() => undefined);
      setOffset(profile?.offsetMs ?? 0);
      audio.releaseTimingMode();
      setSound(true);
      return true;
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "소리를 준비하지 못했어요. 다시 시도해 주세요.",
      );
      return false;
    } finally {
      setLoading(false);
    }
  };
  const navigate = (p: Page) => {
    setHeaderMenu(null);
    startSequence.current++;
    session.current?.dispose();
    session.current = null;
    setView(initView);
    setResult(null);
    setLessonId(null);
    setMode("free");
    setPage(p);
    history.pushState({}, "", `#${p}`);
  };
  const persistResult = async (a: SavedAttempt) => {
    setSaved(false);
    try {
      const stored = await saveAttempt(a);
      setSaved(true);
      setReward(stored.rewardedCat);
      if (a.scope === "song")
        savePrefs({ lastSongId: a.songId, lastMode: a.mode });
      void refresh();
    } catch {
      setError(
        "이번 기록은 저장되지 않았어요. 결과를 닫기 전에 다시 저장해 주세요.",
      );
    }
  };
  const finish = useCallback(() => {
    const s = session.current;
    if (!s) return;
    const c = current.current;
    if (c.mode === "listen") {
      s.dispose();
      session.current = null;
      setView(initView);
      return;
    }
    const wait = c.mode === "wait";
    const jr = s.judge.result();
    const lesson = lessons.find((l) => l.id === c.lessonId);
    const completedLesson = lesson
      ? lessonPassed(lesson, {
          ...jr,
          completed: wait ? s.wait.completed : jr.completed,
          waitCompletedEvents: s.wait.completedEvents,
          distinctKeys: freeKeys.current.size,
          waitChordPolicy: c.policy,
        })
      : false;
    const whole =
      !(s.config.startTick ?? 0) &&
      s.config.endTick === undefined &&
      !s.config.loop &&
      songs.some((song) => song.id === c.selected.id);
    const badges = wait
      ? []
      : evaluateBadges(jr, {
          completed: whole && jr.completed,
          guideLevel: hadGuide.current ? "guided" : "off",
          timingQuality: s.degraded ? "degraded" : "normal",
          interruptionCount: s.interrupted,
          scope: whole ? "song" : "segment",
        } as Parameters<typeof evaluateBadges>[1]);
    const a: SavedAttempt = {
      attemptId: crypto.randomUUID(),
      songId: c.selected.id,
      mode: wait ? "wait" : "challenge",
      completed: wait ? s.wait.completed : jr.completed,
      scope: whole ? "song" : "segment",
      score: wait ? null : jr.score,
      recall: wait ? undefined : jr.recall,
      badges,
      earnedBadges: badges,
      lessonId: completedLesson ? (c.lessonId ?? undefined) : undefined,
      lessonCompleted: completedLesson,
      waitCompletedEvents: wait ? s.wait.completedEvents : undefined,
      waitTotalEvents: wait ? c.selected.events.length : undefined,
      songContentVersion: c.selected.contentVersion,
      tuningId: "c-major-f3-e6-v1",
      tuningVersion: 1,
      judgmentVersion: 1,
      assistFlags: [...s.assistFlags],
      tempoScale: c.tempo,
      guideLevel: c.guide,
      layoutMode: c.layout,
      timingMode: s.timingMode ?? audio.timingMode,
      timingQuality: s.degraded ? "degraded" : "normal",
      calibrationOffsetMs: s.config.offsetMs,
      interruptionCount: s.interrupted,
      startedAtISO: new Date(lastStart.current).toISOString(),
      endedAtISO: new Date().toISOString(),
      ...(!wait
        ? {
            tp: jr.tp,
            fp: jr.fp,
            fn: jr.fn,
            pitchF1: jr.pitchF1,
            rhythmMean: jr.rhythmMean,
            restTotal: jr.restTotal,
            restPassed: jr.restPassed,
            chordTotal: jr.chordTotal,
            chordTogether: jr.chordTogether,
            segmentSummaries: jr.segmentSummaries,
          }
        : {
            tp: null,
            fp: null,
            fn: null,
            pitchF1: null,
            rhythmMean: null,
            waitChordPolicy: c.policy,
            waitAttempts: s.wait.attempts,
          }),
    };
    setResult(a);
    setReward(null);
    void persistResult(a);
  }, [section, loop, offset]);
  const start = async (
    m: PlayMode = mode,
    song: Song = selected,
    id: string | null = lessonId,
    opts?: {
      startTick?: number;
      endTick?: number;
      loop?: boolean;
      policy?: "sequential" | "together";
    },
  ) => {
    const startId = ++startSequence.current;
    session.current?.dispose();
    session.current = null;
    setResult(null);
    setError("");
    setMode(m);
    setSelected(song);
    setLessonId(id);
    setPage("play");
    setSaved(false);
    freeKeys.current.clear();
    lastStart.current = Date.now();
    hadGuide.current = guide !== "off";
    current.current = {
      selected: song,
      mode: m,
      tempo,
      guide,
      layout,
      lessonId: id,
      policy,
    };
    if (m === "free") {
      setView({ ...initView, state: "playing" });
      await prepare();
      return;
    }
    setView({ ...initView, state: "loading" });
    if (!(await prepare())) { setView({ ...initView, state: "error" }); return; }
    if (startId !== startSequence.current) return;
    audio.freezeTimingMode();
    const profile = await getCalibration(
      calibrationProfileId(
        audio.timingMode,
        audio.context?.sampleRate ?? 44100,
      ),
    ).catch(() => undefined);
    const measuredOffset = profile?.offsetMs ?? 0;
    setOffset(measuredOffset);
    if (startId !== startSequence.current) return;
    const s = new Session({
      song,
      mode: m,
      tempo,
      offsetMs: measuredOffset,
      metronome,
      policy,
      ...opts,
    });
    session.current = s;
    s.onChange = setView;
    s.onFinish = finish;
    await s.start();
    setSound(audio.ready);
  };
  const pluck = (midi: number, perfMs: number) => {
    if (!audio.ready || audio.context?.state !== "running") {
      if (mode === "free" && !loading)
        void prepare().then((ok) => {
          if (ok) pluck(midi, performance.now());
        });
      return;
    }
    if (mode !== "listen" && view.state !== "paused" && view.state !== "result")
      audio.play(midi);
    setFreeNote(`${noteByMidi(midi)?.solfege} · ${noteByMidi(midi)?.noteName}`);
    setFreeCount((n) => n + 1);
    if (mode === "free" && lessonId) {
      freeKeys.current.add(midi);
      const l = lessons.find((l) => l.id === lessonId);
      if (
        l &&
        lessonPassed(l, {
          completed: true,
          distinctKeys: freeKeys.current.size,
        })
      ) {
        void completeLesson(l.id)
          .then(refresh)
          .catch(() => setError("레슨 기록을 저장하지 못했어요."));
        setLessonId(null);
        setSelected(songs[0]);
        setFreeNote("첫 레슨 완료! 서로 다른 세 음을 찾았어요.");
      }
    }
    session.current?.pluck(midi, perfMs);
  };
  const openLesson = (id: string) => {
    setHeaderMenu(null);
    const l = lessons.find((l) => l.id === id)!;
    const song = lessonSong(l, selected.id);
    setSelected(song);
    setLessonId(id);
    setSection(-1);
    setLoop(false);
    setPolicy(l.waitChordPolicy);
    if (width < 700) setLayout("pads");
    void start(l.mode === "explore" ? "free" : l.mode, song, id, {
      policy: l.waitChordPolicy,
    });
  };
  const chooseSong = (song: Song) => {
    setHeaderMenu("controls");
    session.current?.dispose();
    session.current = null;
    setSelected(song);
    setLessonId(null);
    setMode("wait");
    setView(initView);
    setSection(-1);
    setLoop(false);
    setPage("play");
    if (width < 700) setLayout("pads");
  };
  const change = (fn: () => void) => {
    session.current?.pause(
      "설정이 바뀌었어요. 새 설정으로 이 구간을 다시 시작해요.",
    );
    fn();
  };
  const replay = (m = mode) => {
    setHeaderMenu(null);
    void start(
      m,
      selected,
      lessonId,
      section >= 0
        ? {
            startTick: section * 3840,
            endTick: Math.min((section + 1) * 3840, selected.totalTicks),
            loop,
          }
        : loop
          ? { startTick: 0, endTick: selected.totalTicks, loop: true }
          : undefined,
    );
  };
  const toggleFullscreen = async () => {
    if (focus || document.fullscreenElement) {
      if (document.fullscreenElement)
        await document.exitFullscreen().catch(() => {});
      setFocus(false);
    } else {
      setFocus(true);
      await mainRef.current?.parentElement?.requestFullscreen?.().catch(() => {});
    }
  };
  const savePrefs = (patch: Record<string, unknown>) => {
    void saveSettings(patch).catch(() => setError("설정을 저장하지 못했어요."));
  };
  const active = view.state === "playing" || view.state === "countin";
  const lesson = lessons.find((l) => l.id === lessonId);
  const focusSpan = requiredSpan(selected.events);
  const rangeIndices = selected.events.flatMap((e) =>
    e.midi.map((m) => noteByMidi(m)!.physicalIndex),
  );
  const range: [number, number] = rangeIndices.length
    ? [Math.min(...rangeIndices), Math.max(...rangeIndices)]
    : [8, 14];
  const focusAllowed = focusSpan <= Math.floor((instrumentWidth + 4) / 48);
  let target: number[] = [];
  let next: number[] = [];
  if (mode === "wait" && session.current) {
    target = session.current.wait.currentEvent?.midi ?? [];
    next = selected.events[session.current.wait.currentIndex + 1]?.midi ?? [];
  } else if (mode !== "free") {
    const i = selected.events.findIndex(
      (e) => e.tick + e.durationTicks > view.tick,
    );
    target = selected.events[Math.max(i, 0)]?.midi ?? [];
    next = selected.events[i + 1]?.midi ?? [];
  }
  const duration = Math.round(
    ((selected.totalTicks / 480) * 60) / selected.bpm,
  );
  return (
    <div
      className={`app ${focus ? "is-focus" : ""} ${reduced ? "reduced-motion" : ""}`}
    >
      <header className="site-header">
        <button
          className="brand"
          onClick={() => navigate("play")}
          aria-label="칼림바 정원 홈"
        >
          <span className="brand-mark">
            <Leaf size={23} />
          </span>
          <span>
            칼림바 정원<small>A LITTLE MELODY, A LITTLE JOY</small>
          </span>
        </button>
        <nav aria-label="주 메뉴">
          {(
            [
              { id: "play", icon: Music2, label: "연주하기" },
              { id: "learn", icon: BookOpen, label: "차근차근 배우기" },
              { id: "songs", icon: Headphones, label: "곡 둘러보기" },
              { id: "garden", icon: Flower2, label: "나의 정원" },
            ] as const
          ).map((n) => (
            <button
              key={n.id}
              className={page === n.id ? "active" : ""}
              onClick={() => navigate(n.id)}
            >
              <n.icon size={17} />
              <span>
                {width < 360 && n.id === "learn" ? "배우기" : n.label}
              </span>
            </button>
          ))}
        </nav>
        <div className="header-tools">
          {page === "play" && <><button className="header-menu-button" aria-expanded={headerMenu === "mode"} onClick={() => setHeaderMenu(headerMenu === "mode" ? null : "mode")}>연주 모드</button><button className="header-menu-button" aria-expanded={headerMenu === "controls"} onClick={() => setHeaderMenu(headerMenu === "controls" ? null : "controls")}>연주 설정</button><button className="icon-button" aria-label="도움말" onClick={() => { session.current?.pause(); setHelp(true); }}><HelpCircle size={19}/></button></>}
          <span className="local-badge">
            <span />이 기기에 저장
          </span>
          <button
            className="icon-button"
            onClick={() => {
              session.current?.pause();
              setSettingsOpen(true);
            }}
            aria-label="설정"
          >
            <Settings2 size={21} />
          </button>
        </div>
      </header>
      <main ref={mainRef}>
        {error && (
          <div className="error-banner" role="alert">
            {error}
            <button onClick={() => setError("")} aria-label="알림 닫기">
              <X size={17} />
            </button>
          </div>
        )}
        {page === "play" && (
          <>
            <div className="page-intro">
              <div>
                <div className="eyebrow">
                  <span /> YOUR SMALL MUSICAL GARDEN
                </div>
                <h1>
                  {lesson ? (
                    lesson.title
                  ) : mode === "free" ? (
                    <>
                      한 음씩, 마음이 <em>쉬어가는 시간.</em>
                    </>
                  ) : (
                    selected.title
                  )}
                </h1>
                <p>
                  {lesson
                    ? lesson.description
                    : mode === "free"
                      ? "고양이와 함께 가볍게 튕겨보세요. 오늘의 멜로디는 여기서 시작해요."
                      : "먼저 듣고, 천천히 따라 하고, 나만의 속도로 완성해 보세요."}
                </p>
              </div>
              <button
                className="text-button"
                onClick={() => {
                  session.current?.pause();
                  setHelp(true);
                }}
              >
                <HelpCircle size={17} /> 처음이신가요?
              </button>
            </div>
            <div className="play-workspace">
              <aside className={`left-rail header-popover ${headerMenu === "mode" ? "menu-open" : ""}`} aria-label="연주 모드 메뉴">
                <button className="popover-close" onClick={() => setHeaderMenu(null)} aria-label="연주 모드 메뉴 닫기"><X size={18}/></button>
                <div className="section-label">PLAY MODE</div>
                <div className="mode-list">
                  {(["free", "wait", "challenge"] as const).map((m, i) => (
                    <button
                      key={m}
                      className={mode === m ? "chosen" : ""}
                      onClick={() => {
                        startSequence.current++;
                        session.current?.dispose();
                        session.current = null;
                        setResult(null);
                        setMode(m);
                        setView(initView);
                        setLessonId(null);
                        setHeaderMenu(m === "free" ? null : "controls");
                      }}
                    >
                      <span className="mode-icon">
                        {i === 0 ? (
                          <Music2 size={20} />
                        ) : i === 1 ? (
                          <Sprout size={20} />
                        ) : (
                          <Star size={20} />
                        )}
                      </span>
                      <span>
                        <b>{modeNames[m]}</b>
                        <small>
                          {
                            [
                              "마음 가는 대로 연주해요",
                              "정답 음을 찾을 때까지 기다려요",
                              "박자에 맞춰 한 곡을 완성해요",
                            ][i]
                          }
                        </small>
                      </span>
                    </button>
                  ))}
                </div>
                <div className="rail-note">
                  <span className="tiny-leaf">
                    <Leaf size={18} />
                  </span>
                  <p>
                    잘하지 않아도 괜찮아요.
                    <br />한 음을 찾는 것부터
                    <br />
                    음악이 시작되니까요.
                  </p>
                  <span className="note-line" />
                </div>
                <div className="tuning-label">
                  <span>C MAJOR · 21 KEYS</span>
                  <small>F3–E6 · 가운데 낮은 파</small>
                </div>
              </aside>
              <section ref={instrumentPanelRef} className="instrument-panel" aria-label="칼림바 연주">
                <div className="instrument-toolbar">
                  <div className="segmented">
                    {(["physical-all", "physical-focus", "pads"] as const).map(
                      (l, i) => (
                        <button
                          key={l}
                          disabled={l === "physical-focus" && !focusAllowed}
                          title={
                            l === "physical-focus" && !focusAllowed
                              ? `이 곡은 ${focusSpan}개 물리키 폭이 필요해요. 큰 버튼을 이용해 주세요.`
                              : undefined
                          }
                          className={layout === l ? "active" : ""}
                          onClick={() => change(() => setLayout(l))}
                        >
                          {["악기 전체", "음역 확대", "큰 버튼"][i]}
                        </button>
                      ),
                    )}
                  </div>
                  <span className="mobile-transport">
                    {active && mode !== "free" && (
                      <button
                        className="icon-button"
                        aria-label="연주 일시정지"
                        onClick={() => session.current?.pause()}
                      >
                        <Pause size={17} />
                      </button>
                    )}
                    <button
                      className="icon-button"
                      onClick={() => void toggleFullscreen()}
                      aria-label={focus ? "집중 화면 닫기" : "집중 화면"}
                    >
                      {focus ? <Minimize size={17} /> : <Maximize size={17} />}
                    </button>
                  </span>
                </div>
                <div className="instrument-status" aria-live="polite">
                  {view.state === "countin" ? (
                    <span className="count-in">
                      {view.count} <small>준비해요</small>
                    </span>
                  ) : view.state === "paused" ? (
                    <span>잠시 쉬어 가는 중</span>
                  ) : mode === "free" ? (
                    <>
                      <span className="status-dot" />
                      {freeNote || "나만의 멜로디를 들려주세요"}
                    </>
                  ) : guide === "off" ? (
                    <span>이제 혼자 연주해 볼까요?</span>
                  ) : (
                    <span>
                      {target.length
                        ? target.map((m) => noteByMidi(m)?.solfege).join(" + ")
                        : "쉼표 · 소리의 여운을 들어요"}
                    </span>
                  )}
                </div>
                <Instrument
                  layout={layout}
                  range={range}
                  labelMode={label}
                  targetMidi={target}
                  nextMidi={next}
                  guide={guide}
                  onPluck={pluck}
                  disabled={mode !== "free" && !active}
                  reducedMotion={reduced}
                />
                <div className="instrument-caption">
                  <span>
                    <span className="status-dot" />
                    {sound ? "소리 준비 완료" : "첫 음을 누르면 소리가 켜져요"}
                  </span>
                  <span>
                    {layout === "pads"
                      ? "물리키 순서 · 21개의 큰 버튼"
                      : "길게 누르지 않고, 가볍게 한 번"}
                    <Music2 size={13} />
                  </span>
                </div>
              </section>
              <aside className={`practice-panel header-popover ${headerMenu === "controls" ? "menu-open" : ""}`} aria-label="연주 설정 메뉴">
                <button className="popover-close" onClick={() => setHeaderMenu(null)} aria-label="연주 설정 메뉴 닫기"><X size={18}/></button>
                <div className="section-label">
                  {mode === "free" ? "A MOMENT FOR YOU" : "YOUR PRACTICE"}
                </div>
                {mode === "free" ? (
                  <>
                    <div className="cat-moment">
                      <Cat variant="cat-mikan" size={116} />
                      <span className="hello-note">안녕, 오늘도 반가워!</span>
                    </div>
                    <h2>
                      작은 소리로 채우는
                      <br />
                      나만의 시간
                    </h2>
                    <p className="muted">
                      키를 누르면 음이 울려요.
                      <br />두 손으로 누르면 화음이 돼요.
                    </p>
                    <button
                      className="primary"
                      onClick={() => void prepare()}
                      disabled={loading}
                    >
                      {loading
                        ? "소리 준비 중…"
                        : sound
                          ? "소리 다시 연결하기"
                          : "소리 켜고 시작하기"}
                      <Volume2 size={18} />
                    </button>
                    <div className="free-stat">
                      <span>오늘 튕긴 음</span>
                      <b>
                        {freeCount}
                        <small> 번</small>
                      </b>
                    </div>
                    <button
                      className="lesson-promo"
                      onClick={() => openLesson("L01")}
                    >
                      <span>
                        <small>처음이라면 여기서</small>
                        <b>첫 번째 음을 만나봐요</b>
                      </span>
                      <ArrowRight size={20} />
                    </button>
                  </>
                ) : (
                  <>
                    <div className="song-heading">
                      <span className="song-index">
                        {lessonId ?? selected.id}
                      </span>
                      <h2>{selected.title}</h2>
                      <p>
                        <Clock3 size={14} />
                        {duration}초 <span /> {selected.bpm} BPM <span />{" "}
                        {selected.bars}마디
                      </p>
                    </div>
                    <label className="control-label">연주 속도</label>
                    <div className="segmented speed">
                      {[0.5, 0.75, 1].map((t) => (
                        <button
                          className={tempo === t ? "active" : ""}
                          key={t}
                          onClick={() => change(() => setTempo(t))}
                        >
                          {t === 1 ? "원래 속도" : `${t}×`}
                        </button>
                      ))}
                    </div>
                    <label className="control-label" htmlFor="guide">
                      음 안내
                    </label>
                    <select
                      id="guide"
                      value={guide}
                      onChange={(e) =>
                        change(() => {
                          setGuide(e.target.value as typeof guide);
                          if (e.target.value !== "off") hadGuide.current = true;
                        })
                      }
                    >
                      <option value="guided">현재 음 + 다음 음</option>
                      <option value="current-only">현재 음만</option>
                      <option value="off">안내 없이 혼자</option>
                    </select>
                    {lessonId === "L11" && (
                      <>
                        <label className="control-label" htmlFor="chord-policy">
                          화음 연습
                        </label>
                        <select
                          id="chord-policy"
                          value={policy}
                          onChange={(e) =>
                            change(() =>
                              setPolicy(e.target.value as typeof policy),
                            )
                          }
                        >
                          <option value="sequential">한 음씩 찾아보기</option>
                          <option value="together">
                            400ms 안에 함께 누르기
                          </option>
                        </select>
                      </>
                    )}
                    <div className="practice-progress">
                      <div>
                        <span>
                          {view.state === "ready"
                            ? "준비되면 시작해요"
                            : view.state === "paused"
                              ? "일시정지"
                              : modeNames[mode]}
                        </span>
                        <b>{Math.round(view.progress * 100)}%</b>
                      </div>
                      <div className="progress-track">
                        <i style={{ width: `${view.progress * 100}%` }} />
                      </div>
                    </div>
                    {view.state === "paused" ? (
                      <>
                        <p className="pause-reason">{view.reason}</p>
                        <button
                          className="primary"
                          onClick={() => {
                            const s = session.current;
                            if (s) {
                              s.config.tempo = tempo;
                              s.config.metronome = metronome;
                              s.config.offsetMs = offset;
                              s.config.policy = policy;
                              setHeaderMenu(null);
                              void s.resume();
                            }
                          }}
                        >
                          <Play size={17} />이 구간부터 이어서
                        </button>
                      </>
                    ) : active ? (
                      <button
                        className="primary"
                        onClick={() => session.current?.pause()}
                      >
                        <Pause size={17} />
                        잠깐 쉬기
                      </button>
                    ) : (
                      <button
                        className="primary"
                        disabled={view.state === "loading"}
                        onClick={() =>
                          replay(mode === "listen" ? "wait" : mode)
                        }
                      >
                        <Play size={17} />
                        {view.state === "loading"
                          ? "소리 준비 중…"
                          : mode === "challenge"
                            ? "곡 도전 시작"
                            : "천천히 따라 연주"}
                      </button>
                    )}
                    <div className="secondary-actions">
                      <button onClick={() => void start("listen")}>
                        <Headphones size={16} />
                        시범 듣기
                      </button>
                      <button onClick={() => replay()}>
                        <RotateCcw size={16} />
                        처음부터
                      </button>
                    </div>
                    <details className="section-settings">
                      <summary>
                        <Repeat2 size={15} />
                        틀린 구간만 연습하기
                      </summary>
                      <select
                        aria-label="연습 구간"
                        value={section}
                        onChange={(e) =>
                          change(() => setSection(Number(e.target.value)))
                        }
                      >
                        <option value={-1}>곡 전체</option>
                        {Array.from(
                          { length: Math.ceil(selected.bars / 2) },
                          (_, i) => (
                            <option key={i} value={i}>
                              {i * 2 + 1}–{Math.min(selected.bars, i * 2 + 2)}
                              마디
                            </option>
                          ),
                        )}
                      </select>
                      <label className="check-label">
                        <input
                          type="checkbox"
                          checked={loop}
                          onChange={(e) =>
                            change(() => setLoop(e.target.checked))
                          }
                        />
                        선택 구간 반복
                      </label>
                      <button className="text-button" onClick={() => replay()}>
                        이 구간 시작
                        <ArrowRight size={14} />
                      </button>
                    </details>
                    <div className="feedback" role="status">
                      {view.feedback || "틀려도 괜찮아요. 다시 찾아보세요."}
                    </div>
                  </>
                )}
                <div className="volume-control">
                  <Volume2 size={16} />
                  <input
                    aria-label="음량"
                    type="range"
                    min="0"
                    max="1"
                    step=".01"
                    value={volume}
                    onChange={(e) => {
                      const v = +e.target.value;
                      setVolume(v);
                      audio.setVolume(v);
                      savePrefs({ volume: v });
                    }}
                  />
                  <span>{Math.round(volume * 100)}</span>
                </div>
              </aside>
            </div>
            <section className="below-play">
              <div>
                <span className="eyebrow">NEXT LITTLE STEP</span>
                <h3>한 곡이 되는 작은 시작</h3>
                <p>짧은 멜로디를 완성하면 정원에 고양이가 찾아와요.</p>
              </div>
              <button
                className="mini-song"
                onClick={() => chooseSong(songs[0])}
              >
                <span className="mini-art">
                  <Cat size={56} />
                </span>
                <span>
                  <small>첫 번째 추천곡 · 32초</small>
                  <b>고양이의 첫 인사</b>
                </span>
                <span className="round-arrow">
                  <ArrowRight size={19} />
                </span>
              </button>
              <button className="text-button" onClick={() => navigate("songs")}>
                모든 곡 보기
                <ArrowRight size={17} />
              </button>
            </section>
          </>
        )}
        {page === "learn" && (
          <section className="content-page">
            <div className="eyebrow">ONE NOTE AT A TIME</div>
            <h1>
              차근차근, <em>나만의 속도로.</em>
            </h1>
            <p className="page-subtitle">
              열두 번의 작은 발견. 처음부터 배워도, 궁금한 곳부터 시작해도
              좋아요.
            </p>
            <div className="learning-summary">
              <Cat size={87} variant="cat-leaf" />
              <div>
                <b>오늘도 한 걸음 자라는 중</b>
                <p>{progress.lessonIds.length} / 12 레슨 완료</p>
                <div className="progress-track">
                  <i
                    style={{
                      width: `${(progress.lessonIds.length / 12) * 100}%`,
                    }}
                  />
                </div>
              </div>
              <Sprout size={28} />
            </div>
            <div className="lesson-grid">
              {lessons.map((l, i) => (
                <button
                  key={l.id}
                  className={`lesson-card ${progress.lessonIds.includes(l.id) ? "complete" : ""}`}
                  onClick={() => openLesson(l.id)}
                >
                  <div className="lesson-number">
                    {progress.lessonIds.includes(l.id) ? (
                      <Check size={20} />
                    ) : (
                      String(i + 1).padStart(2, "0")
                    )}
                  </div>
                  <div>
                    <small>
                      {i < 3
                        ? "음의 위치"
                        : i < 8
                          ? "리듬과 쉼표"
                          : "한 곡 완성하기"}
                    </small>
                    <h3>{l.title}</h3>
                    <p>{l.description}</p>
                  </div>
                  <ArrowRight size={20} />
                </button>
              ))}
            </div>
          </section>
        )}
        {page === "songs" && (
          <section className="content-page">
            <div className="eyebrow">FIVE LITTLE MELODIES</div>
            <h1>
              오늘의 멜로디를 <em>골라볼까요?</em>
            </h1>
            <p className="page-subtitle">
              한 곡에 30~45초. 짧고 다정한 다섯 곡을 준비했어요.
            </p>
            <div className="song-grid">
              {songs.map((s, i) => (
                <button
                  className="song-card"
                  key={s.id}
                  onClick={() => chooseSong(s)}
                >
                  <div className={`song-art art-${i}`}>
                    <span className="song-art-number">0{i + 1}</span>
                    <span className="art-sun" />
                    <span className="art-hill" />
                    <span className="art-hill second" />
                    <Cat variant={catIds[i]} size={142} />
                    <span className="art-flower">✳</span>
                    <span className="song-length">
                      {Math.round(((s.totalTicks / 480) * 60) / s.bpm)}초
                    </span>
                  </div>
                  <div className="song-card-body">
                    <div className="difficulty">
                      {Array.from({ length: 3 }, (_, j) => (
                        <i key={j} className={j < s.difficulty ? "on" : ""} />
                      ))}
                      <span>
                        {
                          ["입문", "기초", "도전"][
                            Math.min(s.difficulty - 1, 2)
                          ]
                        }
                      </span>
                    </div>
                    <h2>{s.title}</h2>
                    <p>{s.description}</p>
                    <div className="song-card-bottom">
                      <span>
                        {s.bpm} BPM · {s.bars}마디
                      </span>
                      <span className="round-arrow">
                        <Play size={15} />
                      </span>
                    </div>
                  </div>
                </button>
              ))}
            </div>
            <div className="gentle-tip">
              <Leaf size={19} />
              <p>
                처음에는 <b>따라 연주</b>로 음을 찾고, 익숙해지면 <b>곡 도전</b>
                에서 박자를 맞춰보세요.
              </p>
            </div>
          </section>
        )}
        {page === "garden" && (
          <section className="content-page garden-page">
            <div className="eyebrow">GROWING WITH YOUR MELODIES</div>
            <h1>
              당신의 음악이 머무는 <em>작은 정원.</em>
            </h1>
            <p className="page-subtitle">
              다섯 멜로디, 다섯 친구. 완주한 만큼 정원이 조금씩 자라나요.
            </p>
            <div className="garden-scene">
              <div className="garden-sky">
                <Sun size={46} />
                <span className="cloud c1" />
                <span className="cloud c2" />
              </div>
              <div className="garden-hill" />
              <div className="garden-cats">
                {catIds.map((id, i) => (
                  <div
                    className={`garden-slot ${progress.cats.includes(id) ? "unlocked" : ""}`}
                    key={id}
                  >
                    {progress.cats.includes(id) ? (
                      <Cat variant={id} size={130} />
                    ) : (
                      <div className="empty-cat">
                        <Cat variant={id} size={100} />
                        <span>?</span>
                      </div>
                    )}
                    <b>
                      {progress.cats.includes(id)
                        ? catNames[i]
                        : "기다리는 친구"}
                    </b>
                    <span>{songs[i].title}</span>
                  </div>
                ))}
              </div>
              <div className="garden-floor">
                <Flower2 />
                <Sprout />
                <Flower2 />
                <Sprout />
                <Flower2 />
              </div>
            </div>
            <div className="garden-summary">
              <span>
                <b>{progress.cats.length}</b> / 5 친구가 찾아왔어요
              </span>
              <button className="primary" onClick={() => navigate("songs")}>
                멜로디로 초대하기
                <ArrowRight size={17} />
              </button>
            </div>
            <p className="garden-rule">
              따라 연주를 끝까지 마치거나, 곡 도전에서 절반 이상의 음을 맞히면
              새 친구를 만나요.
            </p>
          </section>
        )}
      </main>
      <footer>
        <span>
          <Leaf size={14} />
          작은 소리, 자라는 마음.
        </span>
        <span>21 KEYS · ENDLESS LITTLE POSSIBILITIES</span>
        <button
          onClick={() => {
            session.current?.pause();
            setSettingsOpen(true);
          }}
        >
          소리와 연주 설정
          <SlidersHorizontal size={13} />
        </button>
      </footer>
      {result && (
        <div className="modal-backdrop" role="presentation">
          <section
            className="modal result-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="result-title"
          >
            <button
              className="modal-close icon-button"
              onClick={() => {
                setResult(null);
                setView(initView);
              }}
              aria-label="결과 닫기"
            >
              <X />
            </button>
            <Cat variant={reward ?? "cat-mikan"} mood="celebrate" size={112} />
            <div className="eyebrow">A LITTLE MORE MUSIC IN YOU</div>
            <h2 id="result-title">
              {result.mode === "wait"
                ? "한 곡을 차근차근 완성했어요!"
                : "멋진 작은 연주회였어요!"}
            </h2>
            <p>
              {selected.title} ·{" "}
              {result.mode === "wait"
                ? "음의 위치를 하나씩 익혔어요."
                : "잘한 부분을 기억하고, 어려운 곳은 천천히."}
            </p>
            {result.mode === "challenge" ? (
              <>
                <div className="result-stars">
                  {["pitch", "rhythm", "independent"].map((b, i) => (
                    <span
                      key={b}
                      className={
                        (result.badges ?? []).includes(b) ? "earned" : ""
                      }
                    >
                      <Star
                        size={31}
                        fill={
                          (result.badges ?? []).includes(b)
                            ? "currentColor"
                            : "none"
                        }
                      />
                      <small>{["음 정확도", "리듬", "혼자 연주"][i]}</small>
                    </span>
                  ))}
                </div>
                <div className="result-metrics">
                  <div>
                    <b>
                      {Number(result.tp ?? 0)}
                      <small>
                        {" "}
                        / {Number(result.tp ?? 0) + Number(result.fn ?? 0)}
                      </small>
                    </b>
                    <span>맞힌 음</span>
                  </div>
                  <div>
                    <b>{Number(result.fp ?? 0)}</b>
                    <span>추가 입력</span>
                  </div>
                  <div>
                    <b>
                      {result.rhythmMean === null
                        ? "—"
                        : Math.round(Number(result.rhythmMean) * 100) + "%"}
                    </b>
                    <span>
                      {result.rhythmMean === null
                        ? "평가할 정답음 없음"
                        : "맞힌 음의 리듬"}
                    </span>
                  </div>
                </div>
                <p className="result-score">
                  {result.score}점 · 음 정확도{" "}
                  {Math.round(Number(result.pitchF1) * 100)}%
                </p>
              </>
            ) : (
              <div className="wait-success">
                <CheckCircle2 size={25} />
                {result.waitCompletedEvents}개 이벤트를 확인했어요.{" "}
                {result.waitChordPolicy === "sequential" &&
                selected.events.some((e) => e.midi.length === 2)
                  ? "화음은 한 음씩 찾았어요."
                  : ""}
              </div>
            )}
            {reward && (
              <div className="reward-note">
                <Flower2 size={20} />
                {catNames[catIds.indexOf(reward)]}가 정원에 찾아왔어요!
              </div>
            )}
            <div className="save-status">
              {saved ? (
                <>
                  <Check size={14} />이 기기에 기록했어요
                </>
              ) : (
                <button
                  className="text-button"
                  onClick={() => void persistResult(result)}
                >
                  기록 다시 저장하기
                </button>
              )}
            </div>
            <div className="modal-actions">
              <button
                className="secondary"
                onClick={() => {
                  setResult(null);
                  const summaries = result.segmentSummaries as {startTick:number;fp:number;fn:number}[] | undefined;
                  const worst = summaries?.reduce((a,b)=>b.fp+b.fn>a.fp+a.fn?b:a);
                  setSection(worst ? Math.floor(worst.startTick/3840) : 0);
                  setMode("wait");
                  setView(initView);
                }}
              >
                두 마디씩 다시 연습
              </button>
              <button
                className="primary"
                onClick={() => {
                  setResult(null);
                  navigate(reward ? "garden" : "songs");
                }}
              >
                {reward ? "정원 보러 가기" : "다음 멜로디 찾기"}
                <ArrowRight size={17} />
              </button>
            </div>
          </section>
        </div>
      )}
      {settingsOpen && (
        <div className="modal-backdrop">
          <section
            className="modal settings-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
          >
            <button
              className="modal-close icon-button"
              aria-label="설정 닫기"
              onClick={() => setSettingsOpen(false)}
            >
              <X />
            </button>
            <div className="eyebrow">MAKE YOURSELF COMFORTABLE</div>
            <h2 id="settings-title">편안하게 연주해요</h2>
            <label className="control-label">음 이름 표시</label>
            <div className="segmented">
              {(["number", "solfege", "letter"] as const).map((l, i) => (
                <button
                  key={l}
                  className={label === l ? "active" : ""}
                  onClick={() => {
                    setLabel(l);
                    savePrefs({ labelMode: l });
                  }}
                >
                  {["숫자악보", "계이름", "영문 음"][i]}
                </button>
              ))}
            </div>
            <label className="toggle-row">
              <span>
                <b>메트로놈</b>
                <small>도전과 시범에 박자를 들려줘요.</small>
              </span>
              <input
                type="checkbox"
                checked={metronome}
                onChange={(e) => {
                  setMetronome(e.target.checked);
                  savePrefs({ metronome: e.target.checked });
                }}
              />
            </label>
            <label className="toggle-row">
              <span>
                <b>동작 줄이기</b>
                <small>움직임을 줄이고 정적인 강조를 사용해요.</small>
              </span>
              <input
                type="checkbox"
                checked={reduced}
                onChange={(e) => {
                  setReduced(e.target.checked);
                  savePrefs({ reducedMotion: e.target.checked });
                }}
              />
            </label>
            <div className="setting-divider" />
            <h3>박자 지연 보정</h3>
            <p className="muted">
              현재 보정 {Math.round(offset)}ms. 출력 지연 자체를 줄이는 기능은
              아니에요. 스피커나 유선 이어폰을 권해요.
            </p>
            <button
              className="secondary"
              onClick={() => {
                setSettingsOpen(false);
                setCalibrating(true);
              }}
            >
              16번 탭으로 맞추기
              <Clock3 size={16} />
            </button>
            <div className="setting-divider" />
            <p className="small-note">
              음색: 직접 제작한 물리 모델 합성 칼림바 21음.
              <br />
              진도는 이 브라우저에 저장돼요. 브라우저 데이터를 지우면 기록도
              사라져요.
            </p>
            <button
              className="danger-text"
              onClick={() => {
                if (confirm("이 기기에 저장한 진도와 고양이를 모두 지울까요?"))
                  void resetProgress().then(refresh);
              }}
            >
              이 기기 진도 초기화
            </button>
          </section>
        </div>
      )}
      {help && (
        <div className="modal-backdrop">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="help-title"
          >
            <button
              className="modal-close icon-button"
              aria-label="도움말 닫기"
              onClick={() => setHelp(false)}
            >
              <X />
            </button>
            <Cat size={88} />
            <h2 id="help-title">첫 음만 찾으면 돼요</h2>
            <div className="help-steps">
              <p>
                <b>01</b>
                <span>
                  소리를 켜고 키를 가볍게 한 번 누르세요. 떼어도 여운은 남아요.
                </span>
              </p>
              <p>
                <b>02</b>
                <span>
                  휴대폰에서는 큰 버튼이 편해요. 숫자는 계이름이며, 작은 점은
                  옥타브예요.
                </span>
              </p>
              <p>
                <b>03</b>
                <span>
                  따라 연주는 기다려줘요. 익숙해지면 곡 도전으로 박자를
                  맞춰보세요.
                </span>
              </p>
            </div>
            <p className="small-note">
              가운데 가장 낮은 음은 파(F3), 도(C4)는 13번 키예요. 키보드는 좌우
              방향키로 선택하고 Enter·Space로 연주해요.
            </p>
            <button
              className="primary"
              onClick={() => {
                setHelp(false);
                openLesson("L01");
              }}
            >
              첫 레슨 시작
              <ArrowRight size={17} />
            </button>
          </section>
        </div>
      )}
      {calibrating && (
        <Calibration
          onClose={() => setCalibrating(false)}
          onApplied={setOffset}
        />
      )}
    </div>
  );
}
