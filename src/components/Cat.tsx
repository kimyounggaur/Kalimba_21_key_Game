export interface CatProps {
  variant?: string;
  mood?: "idle" | "celebrate";
  size?: number;
}
const palettes: Record<string, { body: string; ear: string; stripe: string }> =
  {
    "cat-mikan": { body: "#eeb662", ear: "#f8d5ac", stripe: "#d19348" },
    "cat-socks": { body: "#f4efe1", ear: "#eabcb4", stripe: "#2d4138" },
    "cat-leaf": { body: "#a5bc97", ear: "#e2b9ad", stripe: "#75996c" },
    "cat-moon": { body: "#c6c9ce", ear: "#e2bfbd", stripe: "#8d99a5" },
    "cat-star": { body: "#c9b3ce", ear: "#efd0b8", stripe: "#9b84aa" },
  };
export function Cat({
  variant = "cat-mikan",
  mood = "idle",
  size = 90,
}: CatProps) {
  const p = palettes[variant] ?? palettes["cat-mikan"];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 120 120"
      fill="none"
      aria-hidden="true"
      style={{ overflow: "visible" }}
    >
      <ellipse cx="61" cy="108" rx="34" ry="6" fill="#2d473318" />
      <path
        d="M84 86c24 8 25-17 15-17"
        stroke={p.body}
        strokeWidth="12"
        strokeLinecap="round"
      />
      <path d="M35 67c-10 16-10 37 4 39h43c13-3 13-22 2-39" fill={p.body} />
      <path
        d="M36 80c-4 11-3 24 2 26M83 80c4 11 4 24-1 26"
        stroke={p.stripe}
        strokeOpacity=".4"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <path
        d="M30 46 25 14c0-4 4-5 7-3l24 19M89 46l6-31c1-5-3-6-7-3L67 30"
        fill={p.body}
      />
      <path d="m31 33-2-17 17 15M78 31l12-14-2 18" fill={p.ear} />
      <path
        d="M26 52c0-21 15-30 34-30s35 10 35 30c0 23-15 36-35 36S26 75 26 52"
        fill={p.body}
      />
      <path
        d="m49 26 3 10M59 24v12M69 26l-3 10"
        stroke={p.stripe}
        strokeWidth="3"
        strokeLinecap="round"
      />
      {mood === "celebrate" ? (
        <>
          <path
            d="m39 54 5-4 5 4M71 54l5-4 5 4"
            stroke="#273b30"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : (
        <>
          <ellipse cx="44" cy="53" rx="3.2" ry="4.6" fill="#273b30" />
          <ellipse cx="76" cy="53" rx="3.2" ry="4.6" fill="#273b30" />
        </>
      )}
      <ellipse cx="60" cy="63" rx="4" ry="3" fill="#5d3c32" />
      <path
        d="M60 65v3m0 0c-2 6-9 4-9 0m9 0c2 6 9 4 9 0"
        stroke="#5d3c32"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="m18 59 16 3m-17 6 17-1m53-5 16-3m-15 8 16 1"
        stroke="#465447"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <ellipse cx="36" cy="64" rx="6" ry="3" fill="#e6967e" opacity=".35" />
      <ellipse cx="84" cy="64" rx="6" ry="3" fill="#e6967e" opacity=".35" />
      <path
        d="M51 91c3 5 15 5 18 0"
        stroke={p.stripe}
        strokeOpacity=".4"
        strokeWidth="3"
        strokeLinecap="round"
      />
      {variant === "cat-socks" && (
        <>
          <path
            d="M32 101h14v6H36a4 4 0 0 1-4-6M75 101h13a5 5 0 0 1-5 6h-8"
            fill="#fffdf2"
          />
          <path d="m26 16 3 21 15-8" fill="#34443d" />
        </>
      )}
      {mood === "celebrate" && (
        <>
          <path d="m9 21 2 5 5 2-5 2-2 5-2-5-5-2 5-2Z" fill="#d6a64f" />
          <path d="m110 38 2 4 4 2-4 2-2 4-2-4-4-2 4-2Z" fill="#d6a64f" />
        </>
      )}
    </svg>
  );
}
export default Cat;
