import { useEffect, useId, useState } from "react";

/** The scene painted behind the sidebar brand and inside the send buttons. */
export type StageArt = "blueprint" | "pixel" | "off";

const KEY = "polly.stage";

function read(): StageArt {
  try {
    const v = localStorage.getItem(KEY);
    return v === "blueprint" || v === "off" ? v : "pixel";
  } catch {
    return "pixel";
  }
}

const listeners = new Set<(a: StageArt) => void>();

export function setStageArt(art: StageArt): void {
  try {
    if (art === "pixel") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, art);
  } catch {
    /* storage can be unavailable */
  }
  listeners.forEach((l) => l(art));
}

export function useStageArt(): [StageArt, (a: StageArt) => void] {
  const [art, setArt] = useState<StageArt>(read);
  useEffect(() => {
    listeners.add(setArt);
    return () => {
      listeners.delete(setArt);
    };
  }, []);
  return [art, setStageArt];
}

// A very wide canvas at a fixed 96-unit height: the art scales with the
// element's height, and a wider sidebar reveals more scene instead of zooming.
const VIEW_BOX = "0 0 8192 96";
// The send button shows a slice a little way in, past the scene's left edge.
const BUTTON_VIEW_BOX = "104 0 8192 96";

/** The sidebar's header art, fading into the sidebar below it. */
export function SidebarStage({
  art,
}: {
  art: Exclude<StageArt, "off">;
}): React.JSX.Element {
  return (
    <div className="sidebar-stage" aria-hidden>
      {art === "pixel" ? <Pixel /> : <Blueprint />}
    </div>
  );
}

/** The same scene, cropped to fill a send button. Renders nothing when off. */
export function SendArt(): React.JSX.Element | null {
  const [art] = useStageArt();
  if (art === "off") return null;
  return (
    <span className="send-art" aria-hidden>
      {art === "pixel" ? <Pixel compact /> : <Blueprint compact />}
    </span>
  );
}

/** SVG ids must be unique per instance; useId's output isn't a valid id on its own. */
function useIds<K extends string>(...names: K[]): Record<K, string> {
  const base = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  return Object.fromEntries(
    names.map((n) => [n, `stage${base}-${n}`]),
  ) as Record<K, string>;
}

const color = (v: string): React.CSSProperties => ({ stopColor: `var(${v})` });

/* ---------- blueprint: violet drafting paper with Polly drawn on it ---------- */

function Blueprint({
  compact = false,
}: {
  compact?: boolean;
}): React.JSX.Element {
  const id = useIds(
    "paper",
    "glowA",
    "glowB",
    "glowC",
    "glows",
    "minor",
    "major",
    "ruler",
    "notes",
  );
  return (
    <svg
      data-stage="blueprint"
      fill="none"
      preserveAspectRatio="xMinYMin slice"
      viewBox={compact ? BUTTON_VIEW_BOX : VIEW_BOX}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient
          id={id.paper}
          x1="40"
          y1="0"
          x2="250"
          y2="96"
          gradientUnits="userSpaceOnUse"
          spreadMethod="reflect"
        >
          <stop style={color("--stage-bp-deep")} />
          <stop offset="0.55" style={color("--stage-bp-mid")} />
          <stop offset="1" style={color("--stage-bp-light")} />
        </linearGradient>
        <radialGradient
          id={id.glowA}
          cx="0"
          cy="0"
          r="1"
          gradientUnits="userSpaceOnUse"
          gradientTransform="translate(152 8) rotate(140) scale(118 80)"
        >
          <stop style={color("--stage-bp-highlight")} stopOpacity="0.42" />
          <stop
            offset="0.5"
            style={color("--stage-bp-secondary")}
            stopOpacity="0.16"
          />
          <stop offset="1" style={color("--stage-bp-deep")} stopOpacity="0" />
        </radialGradient>
        <radialGradient
          id={id.glowB}
          cx="0"
          cy="0"
          r="1"
          gradientUnits="userSpaceOnUse"
          gradientTransform="translate(470 50) rotate(165) scale(150 90)"
        >
          <stop style={color("--stage-bp-rose")} stopOpacity="0.36" />
          <stop offset="1" style={color("--stage-bp-deep")} stopOpacity="0" />
        </radialGradient>
        <radialGradient
          id={id.glowC}
          cx="0"
          cy="0"
          r="1"
          gradientUnits="userSpaceOnUse"
          gradientTransform="translate(690 16) rotate(145) scale(130 86)"
        >
          <stop style={color("--stage-bp-sky")} stopOpacity="0.3" />
          <stop offset="1" style={color("--stage-bp-deep")} stopOpacity="0" />
        </radialGradient>
        <pattern
          id={id.glows}
          width="768"
          height="96"
          patternUnits="userSpaceOnUse"
        >
          <rect width="768" height="96" fill={`url(#${id.glowA})`} />
          <rect width="768" height="96" fill={`url(#${id.glowB})`} />
          <rect width="768" height="96" fill={`url(#${id.glowC})`} />
        </pattern>
        <pattern
          id={id.minor}
          width="8"
          height="8"
          patternUnits="userSpaceOnUse"
        >
          <path
            d="M8 0H0V8"
            style={{ stroke: "var(--stage-bp-grid)" }}
            strokeOpacity="0.13"
            strokeWidth="0.5"
          />
        </pattern>
        <pattern
          id={id.major}
          width="32"
          height="32"
          patternUnits="userSpaceOnUse"
        >
          <path
            d="M32 0H0V32"
            style={{ stroke: "var(--stage-bp-grid)" }}
            strokeOpacity="0.26"
            strokeWidth="0.6"
          />
        </pattern>
        <pattern
          id={id.ruler}
          width="32"
          height="6"
          patternUnits="userSpaceOnUse"
        >
          <path
            d="M4 0V2.5M12 0V2.5M20 0V4.5M28 0V2.5"
            style={{ stroke: "var(--stage-bp-line)" }}
            strokeOpacity="0.5"
            strokeWidth="0.5"
          />
        </pattern>
        <pattern
          id={id.notes}
          width="768"
          height="96"
          patternUnits="userSpaceOnUse"
        >
          {/* Polly's mark, drafted: the body, the visor, the two eyes. */}
          <g
            style={{ stroke: "var(--stage-bp-line)" }}
            strokeWidth="0.6"
            strokeOpacity="0.55"
            transform="translate(108 40) scale(0.72)"
          >
            <path
              d="M0 20C0 9 9 0 20 0H46C57 0 66 9 66 20V40H20C9 40 0 31 0 20Z"
              strokeDasharray="3 2.5"
            />
            <rect
              x="7.5"
              y="7.5"
              width="51"
              height="25"
              rx="12.5"
              strokeOpacity="0.4"
            />
            <circle cx="20" cy="20" r="6.25" />
            <circle cx="47.5" cy="20" r="6.25" />
            <path
              d="M20 10V30M10 20H30M47.5 10V30M37.5 20H57.5"
              strokeOpacity="0.3"
              strokeWidth="0.4"
            />
          </g>
          <g
            style={{ stroke: "var(--stage-bp-line)" }}
            strokeLinecap="round"
            strokeWidth="0.6"
            strokeOpacity="0.55"
          >
            {/* dimension lines around the drawing, and a few more across the sheet */}
            <path d="M108 76H155.5" strokeDasharray="4 3" />
            <path d="M108 73V79M155.5 73V79" />
            <path d="M100 40V68.8" strokeDasharray="3 3" strokeOpacity="0.45" />
            <path d="M97 40H103M97 68.8H103" strokeOpacity="0.45" />
            <path
              d="M330 30H414"
              strokeDasharray="3.5 5"
              strokeOpacity="0.45"
            />
            <path d="M330 27V33M414 27V33" strokeOpacity="0.45" />
            <path d="M520 48V82" strokeDasharray="5 3" strokeOpacity="0.4" />
            <path d="M517 48H523M517 82H523" strokeOpacity="0.4" />
            <path d="M596 68H722" strokeDasharray="7 4" strokeOpacity="0.5" />
            <path d="M596 65V71M722 65V71" strokeOpacity="0.5" />
          </g>
          <g
            style={{ stroke: "var(--stage-bp-line)" }}
            strokeLinecap="round"
            strokeWidth="0.6"
            strokeOpacity="0.55"
          >
            {/* registration marks */}
            <path d="M88 20H94M91 17V23" />
            <path d="M232 52H238M235 49V55" />
            <path d="M468 70H476M472 66V74" />
            <path d="M744 44H752M748 40V48" />
          </g>
          <g
            style={{ stroke: "var(--stage-bp-line)" }}
            strokeWidth="0.6"
            strokeOpacity="0.32"
          >
            <circle cx="262" cy="30" r="13" strokeDasharray="3.5 4" />
            <path
              d="M262 25V35M257 30H267"
              strokeOpacity="0.6"
              strokeWidth="0.4"
            />
            <circle cx="420" cy="64" r="10" strokeDasharray="2.5 3.5" />
            <circle cx="650" cy="30" r="15" strokeDasharray="4 5" />
            <path
              d="M650 24V36M644 30H656"
              strokeOpacity="0.6"
              strokeWidth="0.4"
            />
          </g>
        </pattern>
      </defs>

      <rect width="100%" height="96" fill={`url(#${id.paper})`} />
      <rect width="100%" height="96" fill={`url(#${id.glows})`} />
      <rect width="100%" height="96" fill={`url(#${id.minor})`} />
      <rect width="100%" height="96" fill={`url(#${id.major})`} />
      <rect width="100%" height="6" fill={`url(#${id.ruler})`} />
      {!compact && <rect width="100%" height="96" fill={`url(#${id.notes})`} />}
    </svg>
  );
}

/* ---------- pixel: an 8-bit violet glow, like Polly's robot avatars ---------- */

// The scene is a 252×96 tile of 3-unit pixels. Each pixel's brightness comes
// from a soft glow in the top right plus a slow diagonal swell, and is drawn in
// one of three violets by ordered (Bayer) dithering, the way old consoles faked
// gradients with a handful of colors. Below the brand the scene ends the same
// way: over the last rows each pixel climbs a finer ladder of tones toward the
// sidebar colour and then drops out, on its own dithered schedule, so the
// scene melts into the sidebar instead of fading through a muddy band.
const PX = 3;
const COLS = 84;
const ROWS = 33;
const TILE = COLS * PX;
const HEIGHT = ROWS * PX;
const END_ROWS = 10;

/** Darkest to palest. The scene uses the three violets; the ending also steps
 *  through the blends between them and toward the sidebar. */
const TONES = [
  "var(--stage-px-deep)",
  "color-mix(in srgb, var(--stage-px-deep), var(--stage-px-mid))",
  "var(--stage-px-mid)",
  "color-mix(in srgb, var(--stage-px-mid), var(--stage-px-light))",
  "var(--stage-px-light)",
  "color-mix(in srgb, var(--stage-px-light) 55%, var(--sidebar))",
  "color-mix(in srgb, var(--stage-px-light) 22%, var(--sidebar))",
];
const DEEP = 0;
const MID = 2;
const LIGHT = 4;
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/** Pixels that slowly light up and dim, each on its own beat: [column, row]. */
const GLOWS: [number, number][] = [
  [16, 1],
  [24, 2],
  [37, 3],
  [45, 1],
  [39, 6],
  [29, 7],
  [41, 9],
  [20, 10],
  [44, 12],
  [33, 12],
  [50, 13],
  [31, 17],
  [52, 17],
  [38, 19],
];

let layers: string[] | null = null;

/** The dithered tile as one path per tone, built once; runs of a tone share a rect. */
function pixelLayers(): string[] {
  if (layers) return layers;
  const out = TONES.map(() => "");
  for (let r = 0; r < ROWS; r++) {
    // 0 above the ending, rising to 1 at the bottom edge
    const end = Math.max(0, (r - (ROWS - END_ROWS) + 0.5) / END_ROWS);
    let run = -1;
    let start = 0;
    for (let c = 0; c <= COLS; c++) {
      let tone = -1;
      if (c < COLS) {
        const x = c * PX + PX / 2;
        const y = r * PX + PX / 2;
        const t = (BAYER[(r % 4) * 4 + (c % 4)] + 0.5) / 16;
        // a second, shifted threshold paces each pixel's climb at the end
        const t2 = (BAYER[((r + 2) % 4) * 4 + ((c + 1) % 4)] + 0.5) / 16;
        // distance to the glow, wrapped so the tile repeats without a seam
        const dx = Math.min(Math.abs(x - 150), TILE - Math.abs(x - 150));
        const glow = Math.exp(-((dx / 92) ** 2 + ((y - 2) / 56) ** 2));
        const swell = 0.12 * Math.sin((2 * Math.PI * x) / (TILE / 2) + y / 18);
        if (glow * 1.2 - 0.45 + swell * 0.5 > t) tone = LIGHT;
        else if (glow - 0.02 + swell > t) tone = MID;
        else tone = DEEP;
        if (end > 0) {
          // lighter pixels reach the palest tone sooner, as in a real gradient,
          // but every pixel drops out on the same schedule so the edge stays level
          // eased in: the first rows barely change, the last ones move fastest
          const lift = end ** 1.5 * (TONES.length + 1) + t2;
          tone =
            Math.floor(lift) >= TONES.length
              ? -1
              : Math.min(Math.floor(tone + lift), TONES.length - 1);
        }
      }
      if (tone !== run) {
        if (run >= 0) {
          const w = (c - start) * PX;
          out[run] += `M${start * PX} ${r * PX}h${w}v${PX}h${-w}z`;
        }
        run = tone;
        start = c;
      }
    }
  }
  layers = out;
  return layers;
}

function Pixel({ compact = false }: { compact?: boolean }): React.JSX.Element {
  const id = useIds("tile", "halo");
  const layers = pixelLayers();
  return (
    <svg
      data-stage="pixel"
      fill="none"
      preserveAspectRatio="xMinYMin slice"
      // the button gets a 32-unit window, so its pixels stay chunky at 32px
      viewBox={compact ? "108 12 8192 32" : `0 0 8192 ${HEIGHT}`}
      shapeRendering="crispEdges"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <pattern
          id={id.tile}
          width={TILE}
          height={HEIGHT}
          patternUnits="userSpaceOnUse"
        >
          {layers.map((d, i) => (
            <path key={i} d={d} style={{ fill: TONES[i] }} />
          ))}
        </pattern>
        {/* the soft light around a glowing pixel */}
        <filter id={id.halo} x="-150%" y="-150%" width="400%" height="400%">
          <feGaussianBlur stdDeviation="2.6" />
        </filter>
      </defs>

      <rect width="100%" height={HEIGHT} fill={`url(#${id.tile})`} />

      <g style={{ fill: "var(--stage-px-spark)" }}>
        {GLOWS.map(([c, r], i) => (
          <g
            key={`${c}-${r}`}
            className="px-glow"
            style={{
              animationDuration: `${3.4 + ((i * 0.7) % 2.6)}s`,
              animationDelay: `${-((i * 1.3) % 5)}s`,
            }}
          >
            <rect
              x={(c - 1) * PX}
              y={(r - 1) * PX}
              width={PX * 3}
              height={PX * 3}
              filter={`url(#${id.halo})`}
              fillOpacity="0.6"
            />
            <rect x={c * PX} y={r * PX} width={PX} height={PX} />
          </g>
        ))}
      </g>
    </svg>
  );
}
