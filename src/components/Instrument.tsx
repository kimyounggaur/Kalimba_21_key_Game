import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { keys, type NoteKey } from "../domain/content";
import "./instrument.css";

export type LayoutMode = "physical-all" | "physical-focus" | "pads";
export type LabelMode = "number" | "solfege" | "letter";
export interface InstrumentProps {
  layout: LayoutMode;
  range?: [number, number];
  labelMode: LabelMode;
  targetMidi: number[];
  nextMidi?: number[];
  guide: "guided" | "current-only" | "off";
  onPluck: (
    midi: number,
    perfMs: number,
    source: "pointer" | "keyboard" | "accessibility",
  ) => void;
  disabled?: boolean;
  reducedMotion?: boolean;
}

const centers = [
  109, 181, 251, 324, 393, 462, 532, 603, 675, 745, 816, 886, 958, 1027, 1098,
  1167, 1238, 1309, 1380, 1450, 1520,
];
const ends = [
  1004, 1026, 1068, 1105, 1153, 1200, 1251, 1302, 1352, 1442, 1483, 1400, 1332,
  1260, 1215, 1161, 1113, 1065, 1041, 1005, 973,
];
const IMAGE_WIDTH = 1587;
const IMAGE_HEIGHT = 2048;

function NoteLabel({ note, mode }: { note: NoteKey; mode: LabelMode }) {
  return (
    <span className={`note-label note-label--${mode}`}>
      {mode === "number" && (
        <span className="note-dots note-dots--above" aria-hidden="true">
          {note.octaveDots > 0 ? "•".repeat(note.octaveDots) : "\u00a0"}
        </span>
      )}
      <span>
        {mode === "number"
          ? note.scaleDegree
          : mode === "letter"
            ? note.noteName
            : note.solfege}
      </span>
      {mode === "number" && (
        <span className="note-dots note-dots--below" aria-hidden="true">
          {note.octaveDots < 0 ? "•" : "\u00a0"}
        </span>
      )}
    </span>
  );
}

/** One pointerdown = one pluck. Release changes visual state, never the audio envelope. */
export function Instrument({
  layout,
  range = [1, 21],
  labelMode,
  targetMidi,
  nextMidi = [],
  guide,
  onPluck,
  disabled = false,
  reducedMotion = false,
}: InstrumentProps) {
  const [active, setActive] = useState<Set<number>>(new Set());
  const [flashed, setFlashed] = useState<Set<number>>(new Set());
  const [focusIndex, setFocusIndex] = useState(12);
  const pointers = useRef(new Map<number, number>());
  const pressedKeys = useRef(new Set<string>());
  const buttons = useRef(new Map<number, HTMLButtonElement>());
  const flashTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const callback = useRef(onPluck);
  callback.current = onPluck;
  const shown =
    layout === "physical-focus"
      ? keys.slice(Math.max(0, range[0] - 1), Math.min(21, range[1]))
      : keys;
  const target = guide === "off" ? [] : targetMidi;
  const next = guide === "guided" ? nextMidi : [];

  const clearInputs = () => {
    pointers.current.clear();
    pressedKeys.current.clear();
    setActive(new Set());
  };
  useEffect(() => {
    const clear = () => clearInputs();
    window.addEventListener("blur", clear);
    window.addEventListener("resize", clear);
    const visibility = () => {
      if (document.hidden) clear();
    };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("blur", clear);
      window.removeEventListener("resize", clear);
      document.removeEventListener("visibilitychange", visibility);
      pointers.current.clear();
      pressedKeys.current.clear();
      flashTimers.current.forEach(clearTimeout);
    };
  }, []);
  useEffect(() => {
    clearInputs();
  }, [layout, range[0], range[1], disabled]);

  function syncActive() {
    setActive(new Set(pointers.current.values()));
  }
  function pluck(
    note: NoteKey,
    perfMs: number,
    source: "pointer" | "keyboard" | "accessibility",
  ) {
    if (disabled) return;
    callback.current(
      note.midi,
      Number.isFinite(perfMs) && Math.abs(perfMs - performance.now()) < 60000
        ? perfMs
        : performance.now(),
      source,
    );
    const old = flashTimers.current.get(note.midi);
    if (old) clearTimeout(old);
    setFlashed((prev) => new Set([...prev, note.midi]));
    flashTimers.current.set(
      note.midi,
      setTimeout(() => {
        setFlashed((prev) => {
          const n = new Set(prev);
          n.delete(note.midi);
          return n;
        });
        flashTimers.current.delete(note.midi);
      }, 145),
    );
  }
  function down(event: PointerEvent<HTMLButtonElement>, note: NoteKey) {
    if (disabled || event.button !== 0 || pointers.current.has(event.pointerId))
      return;
    event.preventDefault();
    pointers.current.set(event.pointerId, note.midi);
    syncActive();
    setFocusIndex(note.physicalIndex - 1);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* pointer may already be cancelled */
    }
    pluck(note, event.timeStamp, "pointer");
  }
  function release(event: PointerEvent<HTMLButtonElement>) {
    pointers.current.delete(event.pointerId);
    syncActive();
  }
  function keyboard(event: KeyboardEvent<HTMLButtonElement>, note: NoteKey) {
    if (
      event.key === "ArrowLeft" ||
      event.key === "ArrowRight" ||
      event.key === "Home" ||
      event.key === "End"
    ) {
      event.preventDefault();
      const current = shown.findIndex((n) => n.midi === note.midi);
      const index =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? shown.length - 1
            : Math.max(
                0,
                Math.min(
                  shown.length - 1,
                  current + (event.key === "ArrowRight" ? 1 : -1),
                ),
              );
      const nextNote = shown[index];
      setFocusIndex(nextNote.physicalIndex - 1);
      buttons.current.get(nextNote.midi)?.focus();
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (event.repeat || pressedKeys.current.has(event.key)) return;
      pressedKeys.current.add(event.key);
      pluck(note, event.timeStamp, "keyboard");
    }
  }
  function button(
    note: NoteKey,
    variant: "physical" | "focus" | "pad",
    style?: CSSProperties,
  ) {
    const highlighted = target.includes(note.midi);
    const following = next.includes(note.midi);
    const held = active.has(note.midi);
    const isFlashed = flashed.has(note.midi);
    const visibleFocusIndex = shown.some(
      (k) => k.physicalIndex - 1 === focusIndex,
    )
      ? focusIndex
      : shown[0]?.physicalIndex - 1;
    return (
      <button
        key={note.id}
        type="button"
        className={`instrument-key instrument-key--${variant}${highlighted ? " is-target" : ""}${following ? " is-next" : ""}${held ? " is-held" : ""}${isFlashed ? " is-plucked" : ""}`}
        style={style}
        ref={(el) => {
          if (el) buttons.current.set(note.midi, el);
          else buttons.current.delete(note.midi);
        }}
        data-midi={note.midi}
        data-key-id={note.keyId}
        data-physical-index={note.physicalIndex}
        disabled={disabled}
        tabIndex={note.physicalIndex - 1 === visibleFocusIndex ? 0 : -1}
        aria-label={`${note.solfege}, ${note.noteName}, 물리키 ${note.physicalIndex}번${highlighted ? ", 지금 연주할 음" : ""}`}
        onPointerDown={(event) => down(event, note)}
        onPointerUp={release}
        onPointerCancel={release}
        onLostPointerCapture={release}
        onKeyDown={(event) => keyboard(event, note)}
        onKeyUp={(event) => {
          pressedKeys.current.delete(event.key);
        }}
        onClick={(event) => {
          if (event.detail === 0 && !pressedKeys.current.size)
            pluck(note, event.timeStamp, "accessibility");
        }}
        onFocus={() => setFocusIndex(note.physicalIndex - 1)}
      >
        <span className="key-target-marker" aria-hidden="true">
          {highlighted ? "◆" : following ? "·" : ""}
        </span>
        <NoteLabel note={note} mode={labelMode} />
        {variant !== "physical" && (
          <small className="key-position">
            {note.noteName} <span>#{note.physicalIndex}</span>
          </small>
        )}
      </button>
    );
  }
  const map = (
    <svg
      className="instrument-minimap"
      viewBox="0 180 1587 1370"
      role="img"
      aria-label="전체 칼림바에서 연주 위치"
    >
      <image href="/assets/kalimba/reference.png" width="1587" height="2048" />
      {keys.map((note, i) => (
        <rect
          key={note.id}
          x={centers[i] - 25}
          y="660"
          width="50"
          height={ends[i] - 660}
          rx="20"
          fill={
            active.has(note.midi) || flashed.has(note.midi)
              ? "#f5c868"
              : target.includes(note.midi)
                ? "#2ad2b1"
                : "transparent"
          }
          opacity=".83"
          stroke={target.includes(note.midi) ? "#fff7d6" : "transparent"}
          strokeWidth="8"
        />
      ))}
      {layout === "physical-focus" && (
        <rect
          x={centers[range[0] - 1] - 34}
          y="660"
          width={centers[range[1] - 1] - centers[range[0] - 1] + 68}
          height="845"
          rx="20"
          fill="none"
          stroke="#f7cd75"
          strokeWidth="16"
        />
      )}
    </svg>
  );

  return (
    <div
      className={`instrument instrument--${layout}${reducedMotion ? " reduce-motion" : ""}`}
      aria-label="21키 칼림바 연주 영역"
    >
      {layout === "physical-all" ? (
        <div className="physical-instrument">
          <img
            className="original-kalimba"
            src="/assets/kalimba/reference.png"
            alt="고양이 무늬 녹색 21키 칼림바"
            draggable={false}
          />
          <svg
            className="physical-glow"
            viewBox="0 0 1587 2048"
            aria-hidden="true"
          >
            {keys.map((note, i) => (
              <rect
                key={note.id}
                x={centers[i] - 22}
                y="614"
                width="44"
                height={ends[i] - 614}
                rx="22"
                className={`${target.includes(note.midi) ? "tine-target " : ""}${next.includes(note.midi) ? "tine-next " : ""}${active.has(note.midi) || flashed.has(note.midi) ? "tine-plucked" : ""}`}
              />
            ))}
          </svg>
          {keys.map((note, i) =>
            button(note, "physical", {
              left: `${((centers[i] - 25) / IMAGE_WIDTH) * 100}%`,
              top: `${(720 / IMAGE_HEIGHT) * 100}%`,
              width: `${(50 / IMAGE_WIDTH) * 100}%`,
              height: `${((ends[i] - 720) / IMAGE_HEIGHT) * 100}%`,
            }),
          )}
        </div>
      ) : (
        <>
          <div className="instrument-map-row">
            {map}
            <div className="instrument-map-copy">
              <span>
                {layout === "pads" ? "큰 버튼 연주" : "실물 위치 확대"}
              </span>
              <small>
                {layout === "pads"
                  ? "키 1 → 21 · 물리 위치 순서"
                  : `물리키 ${range[0]} → ${range[1]} · 고정 음역`}
              </small>
              <small>한 번 톡, 소리는 자연스럽게</small>
            </div>
          </div>
          {layout === "pads" ? (
            <div
              className="kalimba-pads"
              role="group"
              aria-label="물리키 순서의 21개 큰 버튼"
            >
              {keys.map((note) => button(note, "pad"))}
            </div>
          ) : (
            <div
              className="focus-tines"
              role="group"
              aria-label={`물리키 ${range[0]}부터 ${range[1]}까지 확대`}
            >
              <div className="focus-bridge" aria-hidden="true" />
              {shown.map((note) =>
                button(note, "focus", {
                  "--tine-height": `${210 + ((ends[note.physicalIndex - 1] - 973) / 510) * 140}px`,
                } as CSSProperties),
              )}
            </div>
          )}
        </>
      )}
      <p className="instrument-access-hint">
        방향키로 선택 · Enter / Space로 연주
      </p>
    </div>
  );
}
export default Instrument;
