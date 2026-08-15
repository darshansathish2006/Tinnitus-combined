/**
 * Visualisations, all hand-built SVG.
 *
 * No charting library: the audiogram has to follow clinical convention exactly
 * (log-frequency abscissa, inverted dB ordinate, red circles for right and blue
 * crosses for left), and every other chart here has to sit inside the same
 * instrument-panel language. A general-purpose library would fight both.
 *
 * Colours are read from CSS custom properties rather than hard-coded, so light
 * and dark themes are handled without any JS.
 */

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { fmt } from "./ui";

/* ------------------------------------------------------------------------- */
/* Audiogram                                                                  */
/* ------------------------------------------------------------------------- */
const AUDIO_FREQS = [125, 250, 500, 1000, 2000, 4000, 8000];
const AUDIO_TICKS = [-10, 0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120];

/** WHO 2021 grade bands, shaded behind the trace. */
const GRADE_BANDS = [
  { from: -10, to: 20, label: "Normal" },
  { from: 20, to: 35, label: "Mild" },
  { from: 35, to: 50, label: "Moderate" },
  { from: 50, to: 65, label: "Mod-severe" },
  { from: 65, to: 80, label: "Severe" },
  { from: 80, to: 120, label: "Profound" },
];

export function Audiogram({
  audiogram,
  pitchHz,
  notchHz,
  height = 340,
  showBands = true,
  showLegend = true,
}: {
  audiogram: Record<string, Record<string, number>> | null | undefined;
  pitchHz?: number | null;
  notchHz?: number | null;
  height?: number;
  showBands?: boolean;
  showLegend?: boolean;
}) {
  const pad = { top: 26, right: 20, bottom: 34, left: 46 };
  const width = 620;
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const fMin = Math.log2(110);
  const fMax = Math.log2(9200);
  const x = (hz: number) => pad.left + ((Math.log2(hz) - fMin) / (fMax - fMin)) * plotW;
  const y = (db: number) => pad.top + ((db + 10) / 130) * plotH;

  const series = (["right", "left"] as const).map((ear) => {
    const raw = audiogram?.[ear] ?? {};
    const points = Object.entries(raw)
      .map(([hz, db]) => ({ hz: Number(hz), db: Number(db) }))
      .filter((p) => Number.isFinite(p.hz) && Number.isFinite(p.db) && p.hz >= 110 && p.hz <= 9200)
      .sort((a, b) => a.hz - b.hz);
    return { ear, points, color: ear === "right" ? "var(--ear-right)" : "var(--ear-left)" };
  });

  const hasData = series.some((s) => s.points.length > 0);

  return (
    <figure style={{ margin: 0 }}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        style={{ width: "100%", height: "auto" }}
        role="img"
        aria-label="Pure tone audiogram"
      >
        {showBands &&
          GRADE_BANDS.map((band, i) => (
            <rect
              key={band.label}
              x={pad.left}
              y={y(band.from)}
              width={plotW}
              height={y(band.to) - y(band.from)}
              fill={i % 2 === 0 ? "var(--paper-sunken)" : "var(--paper-deep)"}
              opacity={0.55}
            />
          ))}

        {/* Normal-hearing reference: everything above 20 dB HL. */}
        <rect
          x={pad.left}
          y={y(-10)}
          width={plotW}
          height={y(20) - y(-10)}
          fill="var(--ok)"
          opacity={0.08}
        />

        {AUDIO_TICKS.map((db) => (
          <g key={db}>
            <line
              x1={pad.left}
              x2={pad.left + plotW}
              y1={y(db)}
              y2={y(db)}
              stroke="var(--line)"
              strokeWidth={db % 20 === 0 ? 1 : 0.5}
              opacity={db % 20 === 0 ? 0.9 : 0.45}
            />
            {db % 20 === 0 && (
              <text
                x={pad.left - 8}
                y={y(db) + 3.5}
                textAnchor="end"
                fill="var(--ink-4)"
                fontSize="9"
                fontFamily="var(--font-mono)"
              >
                {db}
              </text>
            )}
          </g>
        ))}

        {AUDIO_FREQS.map((hz) => (
          <g key={hz}>
            <line
              x1={x(hz)}
              x2={x(hz)}
              y1={pad.top}
              y2={pad.top + plotH}
              stroke="var(--line)"
              strokeWidth={0.6}
              opacity={0.55}
            />
            <text
              x={x(hz)}
              y={height - 12}
              textAnchor="middle"
              fill="var(--ink-4)"
              fontSize="9"
              fontFamily="var(--font-mono)"
            >
              {hz >= 1000 ? `${hz / 1000}k` : hz}
            </text>
          </g>
        ))}

        {/* Tinnitus pitch marker — the whole point of overlaying it here is to
            show the match sitting in the region of loss. */}
        {pitchHz && pitchHz >= 110 && pitchHz <= 9200 && (
          <g>
            <line
              x1={x(pitchHz)}
              x2={x(pitchHz)}
              y1={pad.top}
              y2={pad.top + plotH}
              stroke="var(--signal)"
              strokeWidth={1.5}
              strokeDasharray="4 3"
            />
            <rect
              x={x(pitchHz) - 26}
              y={pad.top - 20}
              width={52}
              height={15}
              fill="var(--signal)"
              rx={1}
            />
            <text
              x={x(pitchHz)}
              y={pad.top - 9}
              textAnchor="middle"
              fill="var(--on-signal)"
              fontSize="9"
              fontWeight="700"
              fontFamily="var(--font-mono)"
            >
              {fmt.hz(pitchHz)}Hz
            </text>
          </g>
        )}

        {notchHz && notchHz !== pitchHz && notchHz >= 110 && notchHz <= 9200 && (
          <line
            x1={x(notchHz)}
            x2={x(notchHz)}
            y1={pad.top}
            y2={pad.top + plotH}
            stroke="var(--warn)"
            strokeWidth={1}
            strokeDasharray="2 4"
          />
        )}

        {series.map(({ ear, points, color }) => {
          if (!points.length) return null;
          const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.hz)},${y(p.db)}`).join(" ");
          return (
            <g key={ear}>
              <path d={path} fill="none" stroke={color} strokeWidth={1.6} />
              {points.map((p) =>
                ear === "right" ? (
                  // Right ear: red circle (clinical convention).
                  <circle
                    key={p.hz}
                    cx={x(p.hz)}
                    cy={y(p.db)}
                    r={4.5}
                    fill="var(--paper-raised)"
                    stroke={color}
                    strokeWidth={1.8}
                  />
                ) : (
                  // Left ear: blue cross.
                  <g key={p.hz} stroke={color} strokeWidth={1.8}>
                    <line x1={x(p.hz) - 4.2} y1={y(p.db) - 4.2} x2={x(p.hz) + 4.2} y2={y(p.db) + 4.2} />
                    <line x1={x(p.hz) + 4.2} y1={y(p.db) - 4.2} x2={x(p.hz) - 4.2} y2={y(p.db) + 4.2} />
                  </g>
                )
              )}
            </g>
          );
        })}

        <rect
          x={pad.left}
          y={pad.top}
          width={plotW}
          height={plotH}
          fill="none"
          stroke="var(--line-strong)"
          strokeWidth={1}
        />

        <text
          x={pad.left - 34}
          y={pad.top + plotH / 2}
          fill="var(--ink-3)"
          fontSize="9"
          fontWeight="700"
          letterSpacing="0.12em"
          textAnchor="middle"
          transform={`rotate(-90 ${pad.left - 34} ${pad.top + plotH / 2})`}
        >
          dB HL
        </text>

        {!hasData && (
          <text
            x={pad.left + plotW / 2}
            y={pad.top + plotH / 2}
            textAnchor="middle"
            fill="var(--ink-4)"
            fontSize="12"
          >
            No audiometric data
          </text>
        )}
      </svg>

      {showLegend && (
        <figcaption className="row row--tight" style={{ marginTop: "var(--s2)", fontSize: "var(--fs-micro)" }}>
          <span className="row row--tight">
            <svg width="14" height="14" aria-hidden="true">
              <circle cx="7" cy="7" r="4.5" fill="none" stroke="var(--ear-right)" strokeWidth="1.8" />
            </svg>
            <span className="dim">Right (AC)</span>
          </span>
          <span className="row row--tight">
            <svg width="14" height="14" aria-hidden="true">
              <g stroke="var(--ear-left)" strokeWidth="1.8">
                <line x1="3" y1="3" x2="11" y2="11" />
                <line x1="11" y1="3" x2="3" y2="11" />
              </g>
            </svg>
            <span className="dim">Left (AC)</span>
          </span>
          {pitchHz && (
            <span className="row row--tight">
              <svg width="14" height="14" aria-hidden="true">
                <line x1="7" y1="1" x2="7" y2="13" stroke="var(--signal)" strokeWidth="1.5" strokeDasharray="3 2" />
              </svg>
              <span className="dim">Tinnitus pitch</span>
            </span>
          )}
        </figcaption>
      )}
    </figure>
  );
}

/* ------------------------------------------------------------------------- */
/* Spectrum (delivered therapy spectrum + filter response)                    */
/* ------------------------------------------------------------------------- */
export function SpectrumChart({
  frequencies,
  series,
  notchHz,
  height = 220,
  yMin = -60,
  yMax = 6,
  tinnitusHz,
}: {
  frequencies: number[];
  series: { label: string; values: number[]; color: string; dashed?: boolean; fill?: boolean }[];
  notchHz?: number | null;
  tinnitusHz?: number | null;
  height?: number;
  yMin?: number;
  yMax?: number;
}) {
  const pad = { top: 16, right: 14, bottom: 28, left: 40 };
  const width = 620;
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  if (!frequencies.length) return null;
  const fMin = Math.log2(Math.max(frequencies[0], 20));
  const fMax = Math.log2(frequencies[frequencies.length - 1]);
  const x = (hz: number) => pad.left + ((Math.log2(Math.max(hz, 20)) - fMin) / (fMax - fMin)) * plotW;
  const y = (db: number) => pad.top + ((yMax - Math.max(yMin, Math.min(yMax, db))) / (yMax - yMin)) * plotH;

  const gridFreqs = [63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000].filter(
    (f) => f >= frequencies[0] && f <= frequencies[frequencies.length - 1]
  );
  const gridDbs = [0, -10, -20, -30, -40, -50, -60].filter((d) => d >= yMin && d <= yMax);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: "100%", height: "auto" }} role="img" aria-label="Delivered spectrum">
      {gridDbs.map((db) => (
        <g key={db}>
          <line x1={pad.left} x2={pad.left + plotW} y1={y(db)} y2={y(db)} stroke="var(--line)" strokeWidth={0.5} opacity={0.6} />
          <text x={pad.left - 6} y={y(db) + 3} textAnchor="end" fill="var(--ink-4)" fontSize="8.5" fontFamily="var(--font-mono)">
            {db}
          </text>
        </g>
      ))}
      {gridFreqs.map((hz) => (
        <g key={hz}>
          <line x1={x(hz)} x2={x(hz)} y1={pad.top} y2={pad.top + plotH} stroke="var(--line)" strokeWidth={0.5} opacity={0.5} />
          <text x={x(hz)} y={height - 10} textAnchor="middle" fill="var(--ink-4)" fontSize="8.5" fontFamily="var(--font-mono)">
            {hz >= 1000 ? `${hz / 1000}k` : hz}
          </text>
        </g>
      ))}

      {notchHz && (
        <line x1={x(notchHz)} x2={x(notchHz)} y1={pad.top} y2={pad.top + plotH} stroke="var(--signal)" strokeWidth={1.2} strokeDasharray="4 3" />
      )}
      {tinnitusHz && tinnitusHz !== notchHz && (
        <line x1={x(tinnitusHz)} x2={x(tinnitusHz)} y1={pad.top} y2={pad.top + plotH} stroke="var(--crit)" strokeWidth={1} strokeDasharray="2 3" />
      )}

      {series.map((s) => {
        const points = s.values.map((v, i) => `${x(frequencies[i])},${y(v)}`);
        return (
          <g key={s.label}>
            {s.fill && (
              <polygon
                points={`${pad.left},${pad.top + plotH} ${points.join(" ")} ${pad.left + plotW},${pad.top + plotH}`}
                fill={s.color}
                opacity={0.14}
              />
            )}
            <polyline
              points={points.join(" ")}
              fill="none"
              stroke={s.color}
              strokeWidth={1.7}
              strokeDasharray={s.dashed ? "5 3" : undefined}
            />
          </g>
        );
      })}

      <rect x={pad.left} y={pad.top} width={plotW} height={plotH} fill="none" stroke="var(--line-strong)" />
      <text
        x={pad.left - 30}
        y={pad.top + plotH / 2}
        fill="var(--ink-3)"
        fontSize="8.5"
        fontWeight="700"
        letterSpacing="0.1em"
        textAnchor="middle"
        transform={`rotate(-90 ${pad.left - 30} ${pad.top + plotH / 2})`}
      >
        dB
      </text>
    </svg>
  );
}

/* ------------------------------------------------------------------------- */
/* Trend chart                                                                */
/* ------------------------------------------------------------------------- */
export interface TrendPoint {
  date: string;
  [key: string]: string | number | null | undefined;
}

export function TrendChart({
  points,
  series,
  height = 240,
  yMax = 10,
  yMin = 0,
  yLabel = "0–10",
  markers,
}: {
  points: TrendPoint[];
  series: { key: string; label: string; color: string; width?: number; dashed?: boolean; dots?: boolean; fill?: boolean }[];
  height?: number;
  yMax?: number;
  yMin?: number;
  yLabel?: string;
  markers?: { date: string; label: string; color?: string }[];
}) {
  const pad = { top: 16, right: 16, bottom: 30, left: 34 };
  const width = 620;
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  if (points.length < 2) {
    return (
      <div className="meta" style={{ padding: "var(--s6)", textAlign: "center" }}>
        Not enough data yet — at least two entries are needed to draw a trend.
      </div>
    );
  }

  const times = points.map((p) => new Date(p.date).getTime());
  const tMin = Math.min(...times);
  const tMax = Math.max(...times);
  const x = (t: number) => pad.left + (tMax === tMin ? 0.5 : (t - tMin) / (tMax - tMin)) * plotW;
  const y = (v: number) => pad.top + ((yMax - Math.max(yMin, Math.min(yMax, v))) / (yMax - yMin)) * plotH;

  const yTicks = 5;
  const dateLabels = [0, Math.floor(points.length / 2), points.length - 1];

  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: "100%", height: "auto" }} role="img" aria-label="Trend over time">
      {Array.from({ length: yTicks + 1 }, (_, i) => {
        const v = yMin + ((yMax - yMin) * i) / yTicks;
        return (
          <g key={i}>
            <line x1={pad.left} x2={pad.left + plotW} y1={y(v)} y2={y(v)} stroke="var(--line)" strokeWidth={0.5} opacity={0.6} />
            <text x={pad.left - 6} y={y(v) + 3} textAnchor="end" fill="var(--ink-4)" fontSize="8.5" fontFamily="var(--font-mono)">
              {Math.round(v)}
            </text>
          </g>
        );
      })}

      {markers?.map((m, i) => {
        const t = new Date(m.date).getTime();
        if (t < tMin || t > tMax) return null;
        return (
          <g key={i}>
            <line x1={x(t)} x2={x(t)} y1={pad.top} y2={pad.top + plotH} stroke={m.color ?? "var(--signal)"} strokeWidth={1} strokeDasharray="3 3" />
            <text x={x(t) + 3} y={pad.top + 9} fill={m.color ?? "var(--signal)"} fontSize="8" fontWeight="700">
              {m.label}
            </text>
          </g>
        );
      })}

      {series.map((s) => {
        const valid = points
          .map((p) => ({ t: new Date(p.date).getTime(), v: p[s.key] }))
          .filter((d) => typeof d.v === "number" && Number.isFinite(d.v)) as { t: number; v: number }[];
        if (valid.length < 2) return null;
        const coords = valid.map((d) => `${x(d.t)},${y(d.v)}`);
        return (
          <g key={s.key}>
            {s.fill && (
              <polygon
                points={`${x(valid[0].t)},${pad.top + plotH} ${coords.join(" ")} ${x(valid[valid.length - 1].t)},${pad.top + plotH}`}
                fill={s.color}
                opacity={0.12}
              />
            )}
            <polyline
              points={coords.join(" ")}
              fill="none"
              stroke={s.color}
              strokeWidth={s.width ?? 1.6}
              strokeDasharray={s.dashed ? "4 3" : undefined}
              strokeLinejoin="round"
            />
            {s.dots &&
              valid.map((d, i) => <circle key={i} cx={x(d.t)} cy={y(d.v)} r={2} fill={s.color} opacity={0.75} />)}
          </g>
        );
      })}

      {dateLabels.map((i) => (
        <text
          key={i}
          x={x(times[i])}
          y={height - 10}
          textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"}
          fill="var(--ink-4)"
          fontSize="8.5"
          fontFamily="var(--font-mono)"
        >
          {new Date(points[i].date).toLocaleDateString(undefined, { day: "2-digit", month: "short" })}
        </text>
      ))}

      <rect x={pad.left} y={pad.top} width={plotW} height={plotH} fill="none" stroke="var(--line-strong)" />
      <text
        x={pad.left - 26}
        y={pad.top + plotH / 2}
        fill="var(--ink-3)"
        fontSize="8"
        fontWeight="700"
        letterSpacing="0.1em"
        textAnchor="middle"
        transform={`rotate(-90 ${pad.left - 26} ${pad.top + plotH / 2})`}
      >
        {yLabel}
      </text>
    </svg>
  );
}

export function ChartLegend({ items }: { items: { label: string; color: string; dashed?: boolean }[] }) {
  return (
    <div className="row row--tight" style={{ fontSize: "var(--fs-micro)" }}>
      {items.map((item) => (
        <span key={item.label} className="row row--tight">
          <svg width="16" height="8" aria-hidden="true">
            <line
              x1="0"
              y1="4"
              x2="16"
              y2="4"
              stroke={item.color}
              strokeWidth="2"
              strokeDasharray={item.dashed ? "4 3" : undefined}
            />
          </svg>
          <span className="dim">{item.label}</span>
        </span>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* Shapley waterfall                                                          */
/* ------------------------------------------------------------------------- */
/**
 * Per-patient attribution chart.
 *
 * Bars run from the cohort baseline to this patient's prediction, so the
 * clinician can read *why* the number is what it is. Because the backend enforces
 * local accuracy, the bars sum exactly to the gap — the chart cannot mislead by
 * omitting a contribution.
 */
export function ShapWaterfall({
  drivers,
  baseline,
  prediction,
  asPercent = false,
  unit = "",
  height,
}: {
  drivers: {
    key: string;
    label: string;
    display_value: string;
    contribution: number;
    polarity: "adverse" | "protective";
    measured: boolean;
  }[];
  baseline: number;
  prediction: number;
  asPercent?: boolean;
  unit?: string;
  height?: number;
}) {
  const shown = drivers.slice(0, 8);
  if (!shown.length) return <p className="meta">No attribution available.</p>;

  const maxAbs = Math.max(...shown.map((d) => Math.abs(d.contribution)), 1e-6);
  const rowH = 26;
  const labelW = 190;
  const barW = 190;
  const valueW = 92;
  const width = labelW + barW + valueW;
  const chartH = height ?? shown.length * rowH + 8;
  const centre = labelW + barW / 2;
  const scale = (v: number) => (v / maxAbs) * (barW / 2 - 4);

  return (
    <div className="stack stack-2">
      <div className="row row--between" style={{ fontSize: "var(--fs-micro)" }}>
        <span className="dim">
          Cohort baseline{" "}
          <span className="mono" style={{ color: "var(--ink-2)" }}>
            {asPercent ? `${(baseline * 100).toFixed(1)}%` : baseline.toFixed(2)}
          </span>
        </span>
        <span className="dim">
          This patient{" "}
          <span className="mono" style={{ color: "var(--signal-ink)", fontWeight: 700 }}>
            {asPercent ? `${(prediction * 100).toFixed(1)}%` : `${prediction.toFixed(2)}${unit}`}
          </span>
        </span>
      </div>

      <svg viewBox={`0 0 ${width} ${chartH}`} style={{ width: "100%", height: "auto" }} role="img" aria-label="Feature attribution">
        <line x1={centre} x2={centre} y1={0} y2={chartH} stroke="var(--line-strong)" strokeWidth={1} />
        {shown.map((d, i) => {
          const yTop = i * rowH + 4;
          const length = scale(Math.abs(d.contribution));
          const positive = d.contribution > 0;
          const color = d.polarity === "adverse" ? "var(--crit)" : "var(--ok)";
          return (
            <g key={d.key}>
              <text
                x={labelW - 8}
                y={yTop + rowH / 2 + 1}
                textAnchor="end"
                fill={d.measured ? "var(--ink-2)" : "var(--ink-4)"}
                fontSize="10"
              >
                {d.label.length > 30 ? `${d.label.slice(0, 29)}…` : d.label}
              </text>
              <rect
                x={positive ? centre : centre - length}
                y={yTop + 4}
                width={Math.max(length, 1)}
                height={rowH - 12}
                fill={color}
                opacity={d.measured ? 0.85 : 0.4}
                rx={1}
              />
              <text
                x={labelW + barW + 6}
                y={yTop + rowH / 2 + 1}
                fill="var(--ink-3)"
                fontSize="9.5"
                fontFamily="var(--font-mono)"
              >
                {d.display_value}
              </text>
            </g>
          );
        })}
      </svg>

      <div className="row row--tight" style={{ fontSize: "var(--fs-micro)" }}>
        <span className="row row--tight">
          <span className="dot" style={{ background: "var(--crit)" }} />
          <span className="dim">Increases risk</span>
        </span>
        <span className="row row--tight">
          <span className="dot" style={{ background: "var(--ok)" }} />
          <span className="dim">Protective</span>
        </span>
        <span className="dim">· Faded bars = value not measured</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* Radial gauge                                                               */
/* ------------------------------------------------------------------------- */
export function RadialGauge({
  value,
  max = 100,
  label,
  sublabel,
  size = 160,
  tone = "signal",
  ticks = 10,
}: {
  value: number | null;
  max?: number;
  label?: string;
  sublabel?: string;
  size?: number;
  tone?: "signal" | "data" | "ok" | "warn" | "crit";
  ticks?: number;
}) {
  const stroke = 9;
  const r = (size - stroke * 2 - 14) / 2;
  const cx = size / 2;
  const cy = size / 2 + 6;
  // 240-degree sweep, like an analogue meter rather than a full donut.
  const startAngle = -210;
  const sweep = 240;
  const frac = value === null ? 0 : Math.max(0, Math.min(1, value / max));

  const polar = (angleDeg: number, radius: number) => {
    const a = (angleDeg * Math.PI) / 180;
    return { x: cx + radius * Math.cos(a), y: cy + radius * Math.sin(a) };
  };
  const arc = (fromFrac: number, toFrac: number, radius: number) => {
    const a0 = startAngle + sweep * fromFrac;
    const a1 = startAngle + sweep * toFrac;
    const p0 = polar(a0, radius);
    const p1 = polar(a1, radius);
    const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
    return `M ${p0.x} ${p0.y} A ${radius} ${radius} 0 ${large} 1 ${p1.x} ${p1.y}`;
  };

  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      style={{ width: size, height: size, maxWidth: "100%" }}
      role="img"
      aria-label={`${label ?? "Gauge"}: ${value ?? "not available"} of ${max}`}
    >
      <path d={arc(0, 1, r)} fill="none" stroke="var(--paper-deep)" strokeWidth={stroke} strokeLinecap="butt" />
      {Array.from({ length: ticks + 1 }, (_, i) => {
        const f = i / ticks;
        const inner = polar(startAngle + sweep * f, r - stroke / 2 - 3);
        const outer = polar(startAngle + sweep * f, r - stroke / 2 - (i % 5 === 0 ? 9 : 6));
        return (
          <line
            key={i}
            x1={inner.x}
            y1={inner.y}
            x2={outer.x}
            y2={outer.y}
            stroke="var(--line-strong)"
            strokeWidth={i % 5 === 0 ? 1.2 : 0.7}
          />
        );
      })}
      {value !== null && (
        <path d={arc(0, frac, r)} fill="none" stroke={`var(--${tone})`} strokeWidth={stroke} strokeLinecap="butt" />
      )}
      <text
        x={cx}
        y={cy + 4}
        textAnchor="middle"
        fill={value === null ? "var(--ink-4)" : "var(--ink)"}
        fontSize={size * 0.24}
        fontWeight="600"
        fontFamily="var(--font-mono)"
      >
        {value === null ? "—" : Math.round(value * 10) / 10}
      </text>
      {label && (
        <text x={cx} y={cy + 24} textAnchor="middle" fill="var(--ink-3)" fontSize="9" fontWeight="700" letterSpacing="0.1em">
          {label.toUpperCase()}
        </text>
      )}
      {sublabel && (
        <text x={cx} y={cy + 38} textAnchor="middle" fill={`var(--${tone})`} fontSize="10" fontWeight="600">
          {sublabel}
        </text>
      )}
    </svg>
  );
}

/* ------------------------------------------------------------------------- */
/* Tinnitus fingerprint                                                       */
/* ------------------------------------------------------------------------- */
/**
 * The spectral signature, drawn as a polar plot.
 *
 * Each of the 48 bins is one radial spoke across 125 Hz to 16 kHz, so the shape
 * encodes both the percept (a peak at the matched pitch) and the hearing profile
 * (elevation across the loss region). Two patients with the same pitch but
 * different audiograms produce visibly different figures — which is what makes it
 * usable as an identity the patient recognises as *theirs*, and as the basis for
 * cohort similarity search.
 */
export function Fingerprint({
  signature,
  size = 200,
  showScale = true,
  pitchHz,
}: {
  signature: number[] | null | undefined;
  size?: number;
  showScale?: boolean;
  pitchHz?: number | null;
}) {
  const bins = signature ?? [];
  const cx = size / 2;
  const cy = size / 2;
  const rMin = size * 0.13;
  const rMax = size * 0.44;

  const path = useMemo(() => {
    if (!bins.length) return "";
    return (
      bins
        .map((v, i) => {
          const angle = (i / bins.length) * Math.PI * 2 - Math.PI / 2;
          const r = rMin + (rMax - rMin) * Math.max(0, Math.min(1, v));
          return `${i === 0 ? "M" : "L"}${(cx + r * Math.cos(angle)).toFixed(2)},${(cy + r * Math.sin(angle)).toFixed(2)}`;
        })
        .join(" ") + " Z"
    );
  }, [bins, cx, cy, rMin, rMax]);

  if (!bins.length) {
    return (
      <div className="meta" style={{ width: size, height: size, display: "grid", placeItems: "center" }}>
        No signature
      </div>
    );
  }

  const peakIndex = bins.indexOf(Math.max(...bins));
  const peakAngle = (peakIndex / bins.length) * Math.PI * 2 - Math.PI / 2;

  return (
    <svg viewBox={`0 0 ${size} ${size}`} style={{ width: size, height: size, maxWidth: "100%" }} role="img" aria-label="Tinnitus spectral signature">
      {[0.25, 0.5, 0.75, 1].map((f) => (
        <circle key={f} cx={cx} cy={cy} r={rMin + (rMax - rMin) * f} fill="none" stroke="var(--line)" strokeWidth={0.5} opacity={0.6} />
      ))}
      {/* Octave spokes at 125 / 500 / 2k / 8k, giving the plot a readable scale. */}
      {[0, 0.25, 0.5, 0.75].map((f, i) => {
        const angle = f * Math.PI * 2 - Math.PI / 2;
        const label = ["125", "500", "2k", "8k"][i];
        return (
          <g key={f}>
            <line
              x1={cx + rMin * Math.cos(angle)}
              y1={cy + rMin * Math.sin(angle)}
              x2={cx + (rMax + 4) * Math.cos(angle)}
              y2={cy + (rMax + 4) * Math.sin(angle)}
              stroke="var(--line)"
              strokeWidth={0.5}
            />
            {showScale && (
              <text
                x={cx + (rMax + 14) * Math.cos(angle)}
                y={cy + (rMax + 14) * Math.sin(angle) + 3}
                textAnchor="middle"
                fill="var(--ink-4)"
                fontSize="7.5"
                fontFamily="var(--font-mono)"
              >
                {label}
              </text>
            )}
          </g>
        );
      })}

      <path d={path} fill="var(--signal)" fillOpacity={0.2} stroke="var(--signal)" strokeWidth={1.4} strokeLinejoin="round" />
      <circle cx={cx} cy={cy} r={rMin - 3} fill="var(--paper-sunken)" stroke="var(--line-strong)" strokeWidth={0.7} />

      <line
        x1={cx + rMin * Math.cos(peakAngle)}
        y1={cy + rMin * Math.sin(peakAngle)}
        x2={cx + (rMax + 2) * Math.cos(peakAngle)}
        y2={cy + (rMax + 2) * Math.sin(peakAngle)}
        stroke="var(--crit)"
        strokeWidth={1.3}
      />
      {pitchHz && (
        <text x={cx} y={cy + 3} textAnchor="middle" fill="var(--ink-2)" fontSize="9" fontFamily="var(--font-mono)" fontWeight="700">
          {fmt.hz(pitchHz)}
        </text>
      )}
    </svg>
  );
}

/* ------------------------------------------------------------------------- */
/* Residual inhibition recovery curve                                         */
/* ------------------------------------------------------------------------- */
export function RiCurve({
  trace,
  depthPct,
  durationS,
  height = 180,
}: {
  trace: { t: number; loudness_pct: number }[];
  depthPct?: number | null;
  durationS?: number | null;
  height?: number;
}) {
  const pad = { top: 16, right: 16, bottom: 26, left: 36 };
  const width = 520;
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  if (trace.length < 2) return <p className="meta">Residual inhibition not measured.</p>;

  const tMax = Math.max(...trace.map((p) => p.t), 60);
  const x = (t: number) => pad.left + (t / tMax) * plotW;
  const y = (pct: number) => pad.top + ((120 - Math.max(0, Math.min(120, pct))) / 120) * plotH;

  const line = trace.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.t)},${y(p.loudness_pct)}`).join(" ");

  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: "100%", height: "auto" }} role="img" aria-label="Residual inhibition recovery">
      {/* 100% = pre-masking baseline; the whole measurement is the dip below it. */}
      <line x1={pad.left} x2={pad.left + plotW} y1={y(100)} y2={y(100)} stroke="var(--ink-3)" strokeWidth={1} strokeDasharray="4 3" />
      <text x={pad.left + plotW - 2} y={y(100) - 4} textAnchor="end" fill="var(--ink-3)" fontSize="8">
        baseline
      </text>
      <line x1={pad.left} x2={pad.left + plotW} y1={y(90)} y2={y(90)} stroke="var(--line)" strokeWidth={0.5} />

      {[0, 25, 50, 75, 100].map((pct) => (
        <text key={pct} x={pad.left - 6} y={y(pct) + 3} textAnchor="end" fill="var(--ink-4)" fontSize="8" fontFamily="var(--font-mono)">
          {pct}
        </text>
      ))}
      {[0, 15, 30, 45, 60].filter((t) => t <= tMax).map((t) => (
        <g key={t}>
          <line x1={x(t)} x2={x(t)} y1={pad.top} y2={pad.top + plotH} stroke="var(--line)" strokeWidth={0.4} opacity={0.5} />
          <text x={x(t)} y={height - 9} textAnchor="middle" fill="var(--ink-4)" fontSize="8" fontFamily="var(--font-mono)">
            {t}s
          </text>
        </g>
      ))}

      <polygon
        points={`${x(0)},${y(100)} ${trace.map((p) => `${x(p.t)},${y(p.loudness_pct)}`).join(" ")} ${x(trace[trace.length - 1].t)},${y(100)}`}
        fill="var(--data)"
        opacity={0.16}
      />
      <path d={line} fill="none" stroke="var(--data)" strokeWidth={1.9} strokeLinejoin="round" />
      {trace.map((p, i) => (
        <circle key={i} cx={x(p.t)} cy={y(p.loudness_pct)} r={2.4} fill="var(--data)" />
      ))}

      {durationS ? (
        <g>
          <line x1={x(durationS)} x2={x(durationS)} y1={pad.top} y2={pad.top + plotH} stroke="var(--signal)" strokeWidth={1} strokeDasharray="3 2" />
          <text x={x(durationS) + 3} y={pad.top + 10} fill="var(--signal)" fontSize="8" fontWeight="700">
            {durationS.toFixed(0)}s
          </text>
        </g>
      ) : null}

      {depthPct !== null && depthPct !== undefined && (
        <text x={pad.left + 6} y={pad.top + 12} fill="var(--ink-2)" fontSize="9" fontFamily="var(--font-mono)" fontWeight="700">
          depth {depthPct.toFixed(0)}%
        </text>
      )}

      <rect x={pad.left} y={pad.top} width={plotW} height={plotH} fill="none" stroke="var(--line-strong)" />
    </svg>
  );
}

/* ------------------------------------------------------------------------- */
/* Distribution + reliability                                                 */
/* ------------------------------------------------------------------------- */
/* `Sparkline` lived here until the overview stopped being an analytics screen.
   It had exactly one caller — the trend rows on the patient dashboard — and
   nothing else has ever wanted a 90x22 inline trend, so it went with them
   rather than staying as an unreferenced export. */

export function DistributionBars({
  data,
  tone = "data",
  height = 90,
}: {
  data: { label: string; count: number }[];
  tone?: "data" | "signal";
  height?: number;
}) {
  const max = Math.max(...data.map((d) => d.count), 1);
  return (
    <div className="stack stack-1">
      <div className="row row--nowrap" style={{ alignItems: "flex-end", height, gap: 4 }}>
        {data.map((d) => (
          <div key={d.label} style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "flex-end", height: "100%" }}>
            <span className="mono center" style={{ fontSize: "var(--fs-micro)", color: "var(--ink-3)" }}>
              {d.count}
            </span>
            <div
              style={{
                height: `${(d.count / max) * 100}%`,
                minHeight: d.count > 0 ? 2 : 0,
                background: `var(--${tone})`,
                opacity: 0.75,
                borderRadius: 1,
              }}
            />
          </div>
        ))}
      </div>
      <div className="row row--nowrap" style={{ gap: 4 }}>
        {data.map((d) => (
          <span key={d.label} className="center dim" style={{ flex: 1, fontSize: "var(--fs-micro)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
            {d.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * Reliability (calibration) plot. Points on the diagonal mean a predicted 30%
 * risk really did occur 30% of the time — the property that makes a probability
 * usable in a clinic rather than just a ranking score.
 */
export function ReliabilityPlot({
  bins,
  size = 190,
}: {
  bins: { bin: string; n: number; predicted: number; observed: number }[];
  size?: number;
}) {
  const pad = 26;
  const plot = size - pad * 2;
  const x = (v: number) => pad + v * plot;
  const y = (v: number) => pad + (1 - v) * plot;
  const maxN = Math.max(...bins.map((b) => b.n), 1);

  return (
    <svg viewBox={`0 0 ${size} ${size}`} style={{ width: size, height: size, maxWidth: "100%" }} role="img" aria-label="Calibration reliability plot">
      <line x1={x(0)} y1={y(0)} x2={x(1)} y2={y(1)} stroke="var(--ink-4)" strokeWidth={1} strokeDasharray="4 3" />
      {[0, 0.5, 1].map((v) => (
        <g key={v}>
          <line x1={pad} x2={pad + plot} y1={y(v)} y2={y(v)} stroke="var(--line)" strokeWidth={0.4} />
          <line x1={x(v)} x2={x(v)} y1={pad} y2={pad + plot} stroke="var(--line)" strokeWidth={0.4} />
          <text x={pad - 5} y={y(v) + 3} textAnchor="end" fill="var(--ink-4)" fontSize="7.5" fontFamily="var(--font-mono)">
            {v}
          </text>
          <text x={x(v)} y={size - 8} textAnchor="middle" fill="var(--ink-4)" fontSize="7.5" fontFamily="var(--font-mono)">
            {v}
          </text>
        </g>
      ))}
      <polyline
        points={bins.map((b) => `${x(b.predicted)},${y(b.observed)}`).join(" ")}
        fill="none"
        stroke="var(--data)"
        strokeWidth={1.4}
      />
      {bins.map((b) => (
        <circle key={b.bin} cx={x(b.predicted)} cy={y(b.observed)} r={2 + (b.n / maxN) * 4} fill="var(--data)" opacity={0.8} />
      ))}
      <rect x={pad} y={pad} width={plot} height={plot} fill="none" stroke="var(--line-strong)" />
      <text x={pad + plot / 2} y={size - 1} textAnchor="middle" fill="var(--ink-3)" fontSize="7.5" fontWeight="700" letterSpacing="0.08em">
        PREDICTED
      </text>
      <text
        x={9}
        y={pad + plot / 2}
        textAnchor="middle"
        fill="var(--ink-3)"
        fontSize="7.5"
        fontWeight="700"
        letterSpacing="0.08em"
        transform={`rotate(-90 9 ${pad + plot / 2})`}
      >
        OBSERVED
      </text>
    </svg>
  );
}

/* ------------------------------------------------------------------------- */
/* Live analyser visualiser                                                   */
/* ------------------------------------------------------------------------- */
/** Static bar rendering of a spectrum snapshot — driven by the therapy player. */
export function SpectrumBars({
  data,
  height = 54,
  bars = 48,
  tone = "signal",
}: {
  data: Uint8Array | null;
  height?: number;
  bars?: number;
  tone?: "signal" | "data";
}) {
  const values: number[] = [];
  if (data && data.length) {
    // Group linear FFT bins into log-spaced display bars, so the visualiser
    // matches how the spectrum is actually perceived.
    for (let i = 0; i < bars; i++) {
      const lo = Math.floor(Math.pow(data.length, i / bars));
      const hi = Math.max(lo + 1, Math.floor(Math.pow(data.length, (i + 1) / bars)));
      let sum = 0;
      for (let j = lo; j < hi && j < data.length; j++) sum += data[j];
      values.push(sum / Math.max(1, hi - lo) / 255);
    }
  }

  return (
    <div className="row row--nowrap" style={{ gap: 1, height, alignItems: "flex-end" }} aria-hidden="true">
      {(values.length ? values : Array.from({ length: bars }, () => 0)).map((v, i) => (
        <div
          key={i}
          style={{
            flex: 1,
            height: `${Math.max(2, v * 100)}%`,
            background: `var(--${tone})`,
            opacity: 0.25 + v * 0.75,
            borderRadius: 1,
            transition: "height 60ms linear",
          }}
        />
      ))}
    </div>
  );
}

/* `StatRow` was also removed here. It had no callers before this change either —
   `Readout` in components/ui.tsx does the same job and is what every screen
   actually reached for. */

/* ------------------------------------------------------------------------- */
/* Masking curve                                                              */
/* ------------------------------------------------------------------------- */
/**
 * Minimum masking level against frequency.
 *
 * The clinically important reading is the *shape*, not any single point: a flat
 * curve means broadband sound will cover the percept and a masker can be placed
 * anywhere, while a sharp minimum means the band has to sit on the tinnitus to
 * work. So the region below the curve is filled — that is the "masked" side, the
 * levels at which the tinnitus is covered — and the region above it left open.
 * Reading the fill as "everything down here works" is the intuition the chart is
 * built to give.
 *
 * Frequency is on a log axis, matching the audiogram, so a masking curve and an
 * audiogram can be read against one another without mentally rescaling.
 * Untested frequencies break the line rather than being interpolated across.
 */
export function MaskingCurve({
  curve,
  referenceDb,
  referenceHz,
  height = 300,
  maxSafeDb = 85,
}: {
  curve: { hz: number; threshold_db: number | null; masked: boolean | null; tested: boolean }[];
  referenceDb?: number | null;
  referenceHz?: number | null;
  height?: number;
  maxSafeDb?: number;
}) {
  const { t } = useTranslation();
  const pad = { top: 24, right: 18, bottom: 40, left: 48 };
  const width = 620;
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const fMin = Math.log2(200);
  const fMax = Math.log2(10000);
  const dbMax = 100;
  const x = (hz: number) => pad.left + ((Math.log2(hz) - fMin) / (fMax - fMin)) * plotW;
  const y = (db: number) => pad.top + ((dbMax - Math.max(0, Math.min(dbMax, db))) / dbMax) * plotH;

  const measured = curve.filter(
    (p): p is typeof p & { threshold_db: number } => p.threshold_db !== null && p.masked === true
  );
  const unmaskable = curve.filter((p) => p.tested && p.masked === false);

  if (measured.length === 0) {
    return <p className="meta">{t("masking.chart.noData")}</p>;
  }

  const line = measured.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.hz)},${y(p.threshold_db)}`).join(" ");
  // The masked region is everything *below* the curve — lower level than the
  // threshold does not cover the percept, so the fill runs down to the axis.
  const area =
    `M${x(measured[0].hz)},${y(0)} ` +
    measured.map((p) => `L${x(p.hz)},${y(p.threshold_db)}`).join(" ") +
    ` L${x(measured[measured.length - 1].hz)},${y(0)} Z`;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      style={{ width: "100%", height: "auto" }}
      role="img"
      aria-label={t("masking.chart.label")}
    >
      {/* dB gridlines */}
      {[0, 20, 40, 60, 80, 100].map((db) => (
        <g key={db}>
          <line
            x1={pad.left}
            x2={pad.left + plotW}
            y1={y(db)}
            y2={y(db)}
            stroke="var(--line)"
            strokeWidth={0.4}
            opacity={0.55}
          />
          <text
            x={pad.left - 6}
            y={y(db) + 3}
            textAnchor="end"
            fill="var(--ink-4)"
            fontSize="8"
            fontFamily="var(--font-mono)"
          >
            {db}
          </text>
        </g>
      ))}

      {/* frequency ticks */}
      {curve.map((p) => (
        <g key={p.hz}>
          <line
            x1={x(p.hz)}
            x2={x(p.hz)}
            y1={pad.top}
            y2={pad.top + plotH}
            stroke="var(--line)"
            strokeWidth={0.35}
            opacity={0.45}
          />
          <text
            x={x(p.hz)}
            y={height - 22}
            textAnchor="middle"
            fill="var(--ink-4)"
            fontSize="8"
            fontFamily="var(--font-mono)"
          >
            {p.hz >= 1000 ? `${p.hz / 1000}k` : p.hz}
          </text>
        </g>
      ))}

      {/* The level above which a masker stops being a treatment and starts
          being an exposure. Drawn so an out-of-range threshold is visibly out
          of range rather than just a high number. */}
      {maxSafeDb < dbMax && (
        <g>
          <rect
            x={pad.left}
            y={pad.top}
            width={plotW}
            height={Math.max(0, y(maxSafeDb) - pad.top)}
            fill="var(--crit)"
            opacity={0.07}
          />
          <line
            x1={pad.left}
            x2={pad.left + plotW}
            y1={y(maxSafeDb)}
            y2={y(maxSafeDb)}
            stroke="var(--crit)"
            strokeWidth={1}
            strokeDasharray="4 3"
          />
        </g>
      )}

      <path d={area} fill="var(--data)" opacity={0.16} />
      <path d={line} fill="none" stroke="var(--data)" strokeWidth={2} strokeLinejoin="round" />

      {measured.map((p) => (
        <circle
          key={p.hz}
          cx={x(p.hz)}
          cy={y(p.threshold_db)}
          r={p.hz === referenceHz ? 4.5 : 3}
          fill={p.hz === referenceHz ? "var(--signal)" : "var(--data)"}
          stroke={p.hz === referenceHz ? "var(--on-signal)" : "none"}
          strokeWidth={p.hz === referenceHz ? 1.2 : 0}
        />
      ))}

      {/* Frequencies that would not mask at any deliverable level. Marked with
          a cross at the ceiling rather than omitted — "we tried and it did not
          work" is the finding that contraindicates masking therapy. */}
      {unmaskable.map((p) => (
        <g key={`x-${p.hz}`} stroke="var(--crit)" strokeWidth={1.6}>
          <line x1={x(p.hz) - 4} x2={x(p.hz) + 4} y1={y(dbMax) + 6} y2={y(dbMax) + 14} />
          <line x1={x(p.hz) + 4} x2={x(p.hz) - 4} y1={y(dbMax) + 6} y2={y(dbMax) + 14} />
        </g>
      ))}

      {/* The reference level — the minimum of the curve. */}
      {referenceDb !== null && referenceDb !== undefined && referenceHz ? (
        <g>
          <line
            x1={pad.left}
            x2={pad.left + plotW}
            y1={y(referenceDb)}
            y2={y(referenceDb)}
            stroke="var(--signal)"
            strokeWidth={1}
            strokeDasharray="3 2"
          />
          <text
            x={pad.left + 5}
            y={y(referenceDb) - 5}
            fill="var(--signal-ink)"
            fontSize="9"
            fontWeight="700"
            fontFamily="var(--font-mono)"
          >
            {referenceDb.toFixed(0)} dB · {referenceHz >= 1000 ? `${referenceHz / 1000}k` : referenceHz} Hz
          </text>
        </g>
      ) : null}

      <text
        x={pad.left + plotW / 2}
        y={height - 6}
        textAnchor="middle"
        fill="var(--ink-3)"
        fontSize="9"
      >
        {t("masking.chart.xAxis")}
      </text>

      <rect x={pad.left} y={pad.top} width={plotW} height={plotH} fill="none" stroke="var(--line-strong)" />
    </svg>
  );
}
