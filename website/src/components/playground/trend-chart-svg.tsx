"use client";

import { motion, useReducedMotion } from "framer-motion";
import type { TrendPoint } from "./playground-data";

interface TrendChartProps {
  data: TrendPoint[];
  width?: number;
  height?: number;
  delay?: number;
}

function monotoneCubic(points: { x: number; y: number }[]): string {
  if (points.length < 2) return "";
  if (points.length === 2) {
    return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;
  }

  // Simple monotone cubic spline interpolation
  const n = points.length;
  const dx: number[] = [];
  const dy: number[] = [];
  const m: number[] = [];

  for (let i = 0; i < n - 1; i++) {
    dx.push(points[i + 1].x - points[i].x);
    dy.push(points[i + 1].y - points[i].y);
    m.push(dy[i] / dx[i]);
  }

  const tangents: number[] = [m[0]];
  for (let i = 1; i < n - 1; i++) {
    if (m[i - 1] * m[i] <= 0) {
      tangents.push(0);
    } else {
      tangents.push((m[i - 1] + m[i]) / 2);
    }
  }
  tangents.push(m[n - 2]);

  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 0; i < n - 1; i++) {
    const seg = dx[i] / 3;
    const cp1x = points[i].x + seg;
    const cp1y = points[i].y + tangents[i] * seg;
    const cp2x = points[i + 1].x - seg;
    const cp2y = points[i + 1].y - tangents[i + 1] * seg;
    d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${points[i + 1].x} ${points[i + 1].y}`;
  }
  return d;
}

export function TrendChartSvg({ data, width = 500, height = 200, delay = 0 }: TrendChartProps) {
  const reduce = useReducedMotion();
  const pad = { top: 20, right: 20, bottom: 30, left: 40 };
  const w = width - pad.left - pad.right;
  const h = height - pad.top - pad.bottom;

  const scores = data.map((d) => d.score);
  const minY = Math.min(...scores) - 0.05;
  const maxY = Math.max(...scores) + 0.05;

  const points = data.map((d, i) => ({
    x: pad.left + (i / (data.length - 1)) * w,
    y: pad.top + (1 - (d.score - minY) / (maxY - minY)) * h,
  }));

  const linePath = monotoneCubic(points);
  const areaPath = `${linePath} L ${points[points.length - 1].x} ${pad.top + h} L ${points[0].x} ${pad.top + h} Z`;

  // Y-axis ticks
  const yTicks = [0.7, 0.8, 0.9];

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full"
      style={{ maxWidth: width }}
    >
      {/* Grid lines */}
      {yTicks.map((tick) => {
        const y = pad.top + (1 - (tick - minY) / (maxY - minY)) * h;
        return (
          <g key={tick}>
            <line
              x1={pad.left}
              x2={pad.left + w}
              y1={y}
              y2={y}
              stroke="var(--border-subtle)"
              strokeDasharray="4 4"
            />
            <text
              x={pad.left - 8}
              y={y + 4}
              textAnchor="end"
              className="fill-text-muted"
              fontSize={10}
              fontFamily="var(--font-mono)"
            >
              {tick.toFixed(1)}
            </text>
          </g>
        );
      })}

      {/* X-axis labels */}
      {data.map((d, i) => (
        <text
          key={d.day}
          x={points[i].x}
          y={height - 6}
          textAnchor="middle"
          className="fill-text-muted"
          fontSize={10}
          fontFamily="var(--font-mono)"
        >
          {d.day}
        </text>
      ))}

      {/* Area fill */}
      <motion.path
        d={areaPath}
        fill="url(#areaGradient)"
        initial={reduce ? {} : { opacity: 0 }}
        animate={{ opacity: 0.3 }}
        transition={{ duration: 0.8, delay: delay + 0.4 }}
      />

      {/* Line */}
      <motion.path
        d={linePath}
        fill="none"
        stroke="var(--iris-400)"
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={reduce ? {} : { pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 1.2, delay, ease: [0.22, 1, 0.36, 1] }}
      />

      {/* Dots */}
      {points.map((p, i) => (
        <motion.circle
          key={data[i].day}
          cx={p.x}
          cy={p.y}
          r={3.5}
          fill="var(--bg-card)"
          stroke="var(--iris-400)"
          strokeWidth={2}
          initial={reduce ? {} : { opacity: 0, scale: 0 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: delay + 0.3 + i * 0.08, duration: 0.2 }}
        />
      ))}

      <defs>
        <linearGradient id="areaGradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--iris-400)" stopOpacity="0.3" />
          <stop offset="100%" stopColor="var(--iris-400)" stopOpacity="0" />
        </linearGradient>
      </defs>
    </svg>
  );
}
