/**
 * Strategy oracle — "What to work on" (TODOS.md "P3 — Strategy-oracle full
 * ranking", design doc Screen 3).
 *
 * At the current Explorer position, every knob is moved by one realistic
 * step (sim/oracle.ts decides the steps) and the rows are ranked by how
 * much the win rate would change. Runs in its own worker via the
 * `computeOracle` message (sim-worker.ts), the way MarginalReturns owns
 * its worker: a change to the inputs terminates any in-flight run, waits
 * ORACLE_DEBOUNCE_MS, then posts a fresh one.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { DIMENSIONS, fractionToValue, type DimensionName } from '../sim/dimensions';
import { ORACLE_DEBOUNCE_MS, type OracleRow } from '../sim/oracle';
import type { SimConfig } from '../sim/sim-engine';

interface Props {
  xAxis: DimensionName;
  yAxis: DimensionName;
  /** [0,1] fractions along each axis (App state). */
  position: { x: number; y: number };
  pinnedValues: Record<string, number>;
  config: SimConfig;
  /** Explorer's refined games-per-cell — the oracle's budget scales with it. */
  gamesPerCell: number;
}

const GREEN = '#26a641';
const RED = '#dc2626';

/** A result or progress report, tagged with the inputs it belongs to. The
 *  tag is the identity of `inputsKey` below, so "is this current?" is a
 *  reference comparison and no state has to be reset inside the effect. */
interface Tagged<T> { key: object; value: T }

interface OracleOutcome { rows: OracleRow[]; gamesPerEstimate: number }

export function StrategyOracle({ xAxis, yAxis, position, pinnedValues, config, gamesPerCell }: Props) {
  const [result, setResult] = useState<Tagged<OracleOutcome> | null>(null);
  const [progress, setProgress] = useState<Tagged<number> | null>(null);
  const workerRef = useRef<Worker | null>(null);

  const xVal = fractionToValue(DIMENSIONS[xAxis], position.x);
  const yVal = fractionToValue(DIMENSIONS[yAxis], position.y);

  // Fresh identity whenever any input changes — the run's tag. The deps
  // ARE the point here (the memo body reads none of them on purpose), so
  // the exhaustive-deps "unnecessary dependency" warning is expected.
  const inputsKey = useMemo(
    () => ({}),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [xAxis, yAxis, xVal, yVal, pinnedValues, config, gamesPerCell],
  );

  useEffect(() => {
    // Any change cancels the in-flight run outright: terminating the
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
        if (msg.type === 'oracleProgress') {
          setProgress({ key: inputsKey, value: msg.pct });
        } else if (msg.type === 'oracleResult') {
          setResult({ key: inputsKey, value: { rows: msg.rows, gamesPerEstimate: msg.gamesPerEstimate } });
          worker.terminate();
          if (workerRef.current === worker) workerRef.current = null;
        }
      };

      worker.postMessage({
        type: 'computeOracle',
        xAxis,
        yAxis,
        xVal,
        yVal,
        pinnedValues,
        config,
        gamesPerCell,
      });
    }, ORACLE_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, [inputsKey, xAxis, yAxis, xVal, yVal, pinnedValues, config, gamesPerCell]);

  const rows = result?.value.rows ?? null;
  const gamesPerEstimate = result?.value.gamesPerEstimate ?? null;
  const busy = result?.key !== inputsKey;
  const status: 'waiting' | 'computing' | 'done' = !busy
    ? 'done'
    : progress?.key === inputsKey ? 'computing' : 'waiting';
  const pct = progress?.key === inputsKey ? progress.value : 0;

  // The worker already ranks; sort again so the panel is right even if a
  // caller (or test) hands it rows in another order.
  const sorted = useMemo(
    () => (rows ? [...rows].sort((a, b) => b.delta - a.delta) : null),
    [rows],
  );

  return (
    <div
      data-testid="strategy-oracle"
      style={{
        padding: '16px',
        background: 'var(--bg-panel)',
        borderRadius: 8,
        border: '1px solid var(--border)',
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-h)', marginBottom: 12 }}>
        What to work on
        {busy && (
          <span
            role="status"
            aria-live="polite"
            style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: 12 }}
          >
            {' '}{status === 'computing' && pct > 0
              ? `working out… ${Math.round(pct * 100)}%`
              : 'working out…'}
          </span>
        )}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
        One realistic change to each setting, ranked by how much it moves your
        win rate from here. Greyed rows are inside the simulation's noise.
      </div>

      {sorted ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            // Keep the last answer visible while the next one computes.
            opacity: busy ? 0.55 : 1,
            transition: 'opacity 150ms',
          }}
        >
          {sorted.map((row, i) => (
            <OracleRowView key={row.dimension} row={row} isTop={i === 0 && row.significant && row.delta > 0} />
          ))}
          {gamesPerEstimate !== null && (
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>
              Each change simulated over {gamesPerEstimate.toLocaleString()} games.
              The ± is two standard errors.
            </div>
          )}
        </div>
      ) : (
        <div style={{ color: 'var(--text-muted)', fontSize: 13, textAlign: 'center', padding: 12 }}>
          {busy ? 'Working out what to change…' : 'Move the marker to see what to work on'}
        </div>
      )}
    </div>
  );
}

function OracleRowView({ row, isTop }: { row: OracleRow; isTop: boolean }) {
  const pp = row.delta * 100;
  const halfWidth = 2 * row.se * 100;
  const noisy = !row.significant;
  const positive = pp > 0;
  const deltaColor = noisy ? 'var(--text-muted)' : positive ? GREEN : RED;
  const sign = pp > 0 ? '+' : pp < 0 ? '−' : '';

  return (
    <div
      data-testid="oracle-row"
      data-dimension={row.dimension}
      data-noisy={noisy ? 'true' : 'false'}
      aria-label={`${row.label}: ${row.currentLabel} to ${row.suggestedLabel}, ${sign}${Math.abs(pp).toFixed(1)} percentage points${noisy ? ', within noise' : ''}`}
      style={{
        padding: '4px 0',
        borderLeft: isTop ? `3px solid ${GREEN}` : '3px solid transparent',
        paddingLeft: isTop ? 8 : 11,
        opacity: noisy ? 0.5 : 1,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <div
          style={{
            fontSize: 12,
            fontWeight: isTop ? 600 : 400,
            color: isTop ? 'var(--text-h)' : 'var(--text-muted)',
            minWidth: 0,
          }}
        >
          {row.label}
        </div>
        <div
          style={{
            fontSize: 11,
            fontFamily: 'monospace',
            fontWeight: isTop ? 700 : 400,
            color: deltaColor,
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}
        >
          {sign}{Math.abs(pp).toFixed(1)} ± {halfWidth.toFixed(1)} pp
        </div>
      </div>
      <div style={{ fontSize: 11, fontFamily: 'monospace', color: 'var(--text-muted)', opacity: 0.85 }}>
        {!row.atBest
          ? `${row.currentLabel} → ${row.suggestedLabel}`
          : row.suggestedLabel !== row.currentLabel && row.delta < 0
            ? `${row.currentLabel} is best here — ${row.suggestedLabel} would cost you`
            : `${row.currentLabel} is best here`}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
        {row.why}
      </div>
    </div>
  );
}
