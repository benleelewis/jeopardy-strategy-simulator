/**
 * "How your games end" — Phase 1E (score distribution + win margin
 * histogram + variance visualization), sitting directly under StatsPanel
 * in the Explorer side panel.
 *
 * Owns its own worker request the way MarginalReturns/StrategyOracle do:
 * a change to the position/axes/pinned knobs/config terminates any
 * in-flight run, waits OUTCOMES_DEBOUNCE_MS, then posts a fresh
 * `computeOutcomes` message for N_GAMES seeded games at the resolved
 * position. sim-worker.ts's `computeOutcomes` returns, per game, your
 * score before and after Final Jeopardy plus how the game was decided
 * (a "runaway" you locked up, a "lock" an opponent held, or one FJ could
 * still swing) — see its JSDoc for the lock definition.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { DIMENSIONS, fractionToValue, type DimensionName } from '../sim/dimensions';
import type { SimConfig } from '../sim/sim-engine';
import type { OutcomeRow, OutcomesSummary } from '../sim/sim-worker';

interface Props {
  xAxis: DimensionName;
  yAxis: DimensionName;
  /** [0,1] fractions along each axis (App state). */
  position: { x: number; y: number };
  pinnedValues: Record<string, number>;
  config: SimConfig;
}

/** Matches StrategyOracle's ORACLE_DEBOUNCE_MS — same "settle before you
 *  spin up a worker" feel across the side panels. */
const OUTCOMES_DEBOUNCE_MS = 400;
/** Spec: "runs 1,000 seeded games at the current position and settings". */
const N_GAMES = 1000;

/** A result or progress report, tagged with the inputs it belongs to — see
 *  StrategyOracle for the identity-comparison rationale. */
interface Tagged<T> { key: object; value: T }

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function dollars(v: number): string {
  const sign = v < 0 ? '−' : v > 0 ? '+' : '';
  return `${sign}$${Math.round(Math.abs(v)).toLocaleString()}`;
}

function plainDollars(v: number): string {
  return `$${Math.round(Math.abs(v)).toLocaleString()}`;
}

/** Nearest-rank percentile over an ASCENDING-sorted array. */
function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = clamp(Math.round((p / 100) * (sortedAsc.length - 1)), 0, sortedAsc.length - 1);
  return sortedAsc[idx];
}

function median(values: number[]): number {
  return percentile([...values].sort((a, b) => a - b), 50);
}

interface DisplayStats {
  preFJScores: number[];
  postFJScores: number[];
  medianPreFJ: number;
  medianPostFJ: number;
  margins: number[];
  medianAbsMargin: number;
  p95Margin: number;
  p5Margin: number;
  runawayShare: number;
  lockAgainstShare: number;
  decidedShare: number;
}

function computeDisplayStats(summary: OutcomesSummary): DisplayStats {
  const rows: OutcomeRow[] = summary.outcomes;
  const preFJScores = rows.map(o => o.yourPreFJ);
  const postFJScores = rows.map(o => o.yourPostFJ);
  const margins = rows.map(o => o.margin);
  const marginsAsc = [...margins].sort((a, b) => a - b);
  const absMarginsAsc = margins.map(Math.abs).sort((a, b) => a - b);

  return {
    preFJScores,
    postFJScores,
    medianPreFJ: median(preFJScores),
    medianPostFJ: median(postFJScores),
    margins,
    medianAbsMargin: percentile(absMarginsAsc, 50),
    p95Margin: percentile(marginsAsc, 95),
    p5Margin: percentile(marginsAsc, 5),
    runawayShare: summary.runawayShare,
    lockAgainstShare: summary.lockAgainstShare,
    decidedShare: summary.decidedShare,
  };
}

export function OutcomeDistribution({ xAxis, yAxis, position, pinnedValues, config }: Props) {
  const [result, setResult] = useState<Tagged<OutcomesSummary> | null>(null);
  const [progress, setProgress] = useState<Tagged<number> | null>(null);
  const workerRef = useRef<Worker | null>(null);

  const xVal = fractionToValue(DIMENSIONS[xAxis], position.x);
  const yVal = fractionToValue(DIMENSIONS[yAxis], position.y);

  // Fresh identity whenever any input changes — the run's tag (see
  // StrategyOracle for why the exhaustive-deps warning here is expected:
  // the memo body reads none of its deps on purpose).
  const inputsKey = useMemo(
    () => ({}),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [xAxis, yAxis, xVal, yVal, pinnedValues, config],
  );

  useEffect(() => {
    // Any change cancels the in-flight run outright — terminating the
    // worker is the one cancel that cannot race with a late result.
    workerRef.current?.terminate();
    workerRef.current = null;

    const timer = setTimeout(() => {
      const worker = new Worker(
        new URL('../sim/sim-worker.ts', import.meta.url),
        { type: 'module' },
      );
      workerRef.current = worker;
      setProgress({ key: inputsKey, value: 0 });

      worker.onmessage = (e: MessageEvent) => {
        const msg = e.data;
        if (msg.type === 'outcomesProgress') {
          setProgress({ key: inputsKey, value: msg.pct });
        } else if (msg.type === 'outcomesResult') {
          setResult({
            key: inputsKey,
            value: {
              outcomes: msg.outcomes,
              runawayShare: msg.runawayShare,
              lockAgainstShare: msg.lockAgainstShare,
              decidedShare: msg.decidedShare,
            },
          });
          worker.terminate();
          if (workerRef.current === worker) workerRef.current = null;
        }
      };

      worker.postMessage({
        type: 'computeOutcomes',
        xAxis,
        yAxis,
        xVal,
        yVal,
        pinnedValues,
        config,
        nGames: N_GAMES,
      });
    }, OUTCOMES_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, [inputsKey, xAxis, yAxis, xVal, yVal, pinnedValues, config]);

  const summary = result?.value ?? null;
  const busy = result?.key !== inputsKey;
  const status: 'waiting' | 'computing' | 'done' = !busy
    ? 'done'
    : progress?.key === inputsKey ? 'computing' : 'waiting';
  const pct = progress?.key === inputsKey ? progress.value : 0;

  const stats = useMemo(() => (summary ? computeDisplayStats(summary) : null), [summary]);

  return (
    <div
      data-testid="outcome-distribution"
      style={{
        padding: '16px',
        background: 'var(--bg-panel)',
        borderRadius: 8,
        border: '1px solid var(--border)',
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-h)', marginBottom: 12 }}>
        How your games end
        {busy && (
          <span
            role="status"
            aria-live="polite"
            style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: 12 }}
          >
            {' '}{status === 'computing' && pct > 0
              ? `simulating… ${Math.round(pct * 100)}%`
              : 'simulating…'}
          </span>
        )}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
        {N_GAMES.toLocaleString()} seeded games at your current position — your score before and
        after Final Jeopardy, and how often FJ could actually change the result.
      </div>

      {stats ? (
        <div
          className="outcome-distribution-body"
          style={{ opacity: busy ? 0.55 : 1 }}
        >
          <ScoreHistogram
            preFJ={stats.preFJScores}
            postFJ={stats.postFJScores}
            medianPreFJ={stats.medianPreFJ}
            medianPostFJ={stats.medianPostFJ}
          />

          <MarginHistogram margins={stats.margins} />

          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              gap: 6,
              fontSize: 11,
              color: 'var(--text-muted)',
              margin: '4px 0 12px',
              textAlign: 'center',
            }}
          >
            <span>Runaways<br /><strong style={{ fontSize: 15, color: 'var(--text-h)' }}>{pct1(stats.runawayShare)}</strong></span>
            <span>Locks against you<br /><strong style={{ fontSize: 15, color: 'var(--text-h)' }}>{pct1(stats.lockAgainstShare)}</strong></span>
            <span>Decided by FJ<br /><strong style={{ fontSize: 15, color: 'var(--text-h)' }}>{pct1(stats.decidedShare)}</strong></span>
          </div>

          <div style={{ fontSize: 13, color: 'var(--text-h)', lineHeight: 1.5 }}>
            Half your games end within {plainDollars(stats.medianAbsMargin)} of the leader.
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-h)', lineHeight: 1.5 }}>
            Your best case (top 5%) is {dollars(stats.p95Margin)}, your worst (bottom 5%) is {dollars(stats.p5Margin)}.
          </div>
        </div>
      ) : (
        <div style={{ color: 'var(--text-muted)', fontSize: 13, textAlign: 'center', padding: 12 }}>
          {busy ? 'Simulating your games…' : 'Move the marker to see how your games end'}
        </div>
      )}
    </div>
  );
}

function pct1(v: number): string {
  return `${Math.round(v * 100)}%`;
}

// ─── Canvas helpers ──────────────────────────────────────────────────

function makeBins(values: number[], binCount: number, min: number, max: number): number[] {
  const bins = new Array(binCount).fill(0);
  const span = max - min || 1;
  for (const v of values) {
    let idx = Math.floor(((v - min) / span) * binCount);
    idx = clamp(idx, 0, binCount - 1);
    bins[idx]++;
  }
  return bins;
}

function readVar(el: Element, name: string, fallback: string): string {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v || fallback;
}

const CANVAS_W = 320;
const CANVAS_H = 110;
const BIN_COUNT = 24;

/**
 * Score histogram: your score before FJ vs. after FJ, overlaid as two
 * semi-transparent series over the same bins, with a dashed median tick
 * for each. Canvas (not D3), matching YourNumber's existing histogram.
 */
function ScoreHistogram({ preFJ, postFJ, medianPreFJ, medianPostFJ }: {
  preFJ: number[];
  postFJ: number[];
  medianPreFJ: number;
  medianPostFJ: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const W = CANVAS_W;
    const H = CANVAS_H;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.scale(dpr, dpr);

    const bg = readVar(canvas, '--bg', '#0d1117');
    const preColor = readVar(canvas, '--cg-3', '#1a3ba8');
    const postColor = readVar(canvas, '--accent', '#3b82f6');
    const mutedColor = readVar(canvas, '--text-muted', '#8b949e');

    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    const all = [...preFJ, ...postFJ];
    const min = Math.min(...all, 0);
    const max = Math.max(...all, 1);

    const preBins = makeBins(preFJ, BIN_COUNT, min, max);
    const postBins = makeBins(postFJ, BIN_COUNT, min, max);
    const maxBin = Math.max(...preBins, ...postBins, 1);

    const plotLeft = 8;
    const plotRight = W - 8;
    const plotW = plotRight - plotLeft;
    const baselineY = H - 20;
    const maxBarH = baselineY - 8;
    const barW = plotW / BIN_COUNT;

    const toX = (v: number) => plotLeft + ((v - min) / (max - min || 1)) * plotW;

    ctx.globalAlpha = 0.55;
    for (let i = 0; i < BIN_COUNT; i++) {
      const x = plotLeft + i * barW;
      const preH = maxBin > 0 ? (preBins[i] / maxBin) * maxBarH : 0;
      ctx.fillStyle = preColor;
      ctx.fillRect(x, baselineY - preH, Math.max(1, barW - 1), preH);
    }
    for (let i = 0; i < BIN_COUNT; i++) {
      const x = plotLeft + i * barW;
      const postH = maxBin > 0 ? (postBins[i] / maxBin) * maxBarH : 0;
      ctx.fillStyle = postColor;
      ctx.fillRect(x, baselineY - postH, Math.max(1, barW - 1), postH);
    }
    ctx.globalAlpha = 1;

    // Median ticks
    ctx.setLineDash([3, 2]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = preColor;
    ctx.beginPath();
    ctx.moveTo(toX(medianPreFJ), baselineY);
    ctx.lineTo(toX(medianPreFJ), 6);
    ctx.stroke();

    ctx.strokeStyle = postColor;
    ctx.beginPath();
    ctx.moveTo(toX(medianPostFJ), baselineY);
    ctx.lineTo(toX(medianPostFJ), 6);
    ctx.stroke();
    ctx.setLineDash([]);

    // Baseline + range labels
    ctx.strokeStyle = mutedColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plotLeft, baselineY);
    ctx.lineTo(plotRight, baselineY);
    ctx.stroke();

    ctx.font = '9px monospace';
    ctx.fillStyle = mutedColor;
    ctx.textAlign = 'left';
    ctx.fillText(`$${Math.round(min).toLocaleString()}`, plotLeft, H - 6);
    ctx.textAlign = 'right';
    ctx.fillText(`$${Math.round(max).toLocaleString()}`, plotRight, H - 6);
  }, [preFJ, postFJ, medianPreFJ, medianPostFJ]);

  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4, fontWeight: 500 }}>
        Your score — before and after Final Jeopardy
      </div>
      <canvas
        ref={canvasRef}
        style={{ display: 'block', borderRadius: 4, border: '1px solid var(--border)', width: '100%', maxWidth: CANVAS_W }}
      />
      <div style={{ display: 'flex', gap: 14, marginTop: 4, fontSize: 10, color: 'var(--text-muted)' }}>
        <span><Swatch varName="--cg-3" /> Before FJ (median marked)</span>
        <span><Swatch varName="--accent" /> After FJ (median marked)</span>
      </div>
    </div>
  );
}

/**
 * Win margin histogram: your final score minus the best opponent's final
 * score, zero marked. Bars colored by sign (theme's cg-1/cg-5 swatches —
 * the same dark-navy/bright-gold poles YourNumber's headline uses).
 */
function MarginHistogram({ margins }: { margins: number[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const W = CANVAS_W;
    const H = CANVAS_H;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.scale(dpr, dpr);

    const bg = readVar(canvas, '--bg', '#0d1117');
    const winColor = readVar(canvas, '--cg-5', '#f5d442');
    const lossColor = readVar(canvas, '--cg-1', '#060a30');
    const mutedColor = readVar(canvas, '--text-muted', '#8b949e');
    const headColor = readVar(canvas, '--text-h', '#f9fafb');

    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    const min = Math.min(...margins, 0);
    const max = Math.max(...margins, 0);
    const bins = makeBins(margins, BIN_COUNT, min, max);
    const maxBin = Math.max(...bins, 1);

    const plotLeft = 8;
    const plotRight = W - 8;
    const plotW = plotRight - plotLeft;
    const baselineY = H - 20;
    const maxBarH = baselineY - 8;
    const barW = plotW / BIN_COUNT;
    const span = max - min || 1;

    const toX = (v: number) => plotLeft + ((v - min) / span) * plotW;

    for (let i = 0; i < BIN_COUNT; i++) {
      const x = plotLeft + i * barW;
      const binCenter = min + (i + 0.5) * (span / BIN_COUNT);
      const h = maxBin > 0 ? (bins[i] / maxBin) * maxBarH : 0;
      ctx.fillStyle = binCenter >= 0 ? winColor : lossColor;
      ctx.fillRect(x, baselineY - h, Math.max(1, barW - 1), h);
    }

    // Baseline
    ctx.strokeStyle = mutedColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plotLeft, baselineY);
    ctx.lineTo(plotRight, baselineY);
    ctx.stroke();

    // Zero marker
    const zeroX = toX(0);
    ctx.strokeStyle = headColor;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.moveTo(zeroX, baselineY);
    ctx.lineTo(zeroX, 6);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = '9px monospace';
    ctx.fillStyle = headColor;
    ctx.textAlign = 'center';
    ctx.fillText('$0', clamp(zeroX, 14, W - 14), H - 6);
  }, [margins]);

  return (
    <div style={{ marginBottom: 4 }}>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4, fontWeight: 500 }}>
        Win margin — your score minus the best opponent
      </div>
      <canvas
        ref={canvasRef}
        style={{ display: 'block', borderRadius: 4, border: '1px solid var(--border)', width: '100%', maxWidth: CANVAS_W }}
      />
    </div>
  );
}

function Swatch({ varName }: { varName: string }) {
  return (
    <span
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: 2,
        background: `var(${varName})`,
        marginRight: 4,
      }}
    />
  );
}
