/**
 * Marginal Returns — Screen 3 from the original design doc.
 *
 * Given your current position, which improvement across ALL dimensions
 * gives the biggest win rate boost? Identifies your bottleneck dimension.
 *
 * Computes partial derivatives: for each dimension, simulate at
 * position ± delta, measure the win rate change.
 */

import { useEffect, useState, useRef } from 'react';
import { DIMENSIONS, type DimensionName } from '../sim/dimensions';
import type { SimConfig } from '../sim/sim-engine';

interface MarginalResult {
  dimension: DimensionName;
  label: string;
  currentValue: number;
  marginalReturn: number; // win rate change per 10% improvement
}

interface Props {
  xAxis: DimensionName;
  yAxis: DimensionName;
  position: { x: number; y: number };
  pinnedValues: Record<string, number>;
  config: SimConfig;
}

export function MarginalReturns({ xAxis, yAxis, position, pinnedValues, config }: Props) {
  const [results, setResults] = useState<MarginalResult[] | null>(null);
  const [computing, setComputing] = useState(false);
  const workerRef = useRef<Worker | null>(null);

  // Get current values for all dimensions
  const currentValues: Record<string, number> = {};
  for (const [name, dim] of Object.entries(DIMENSIONS)) {
    if (name === xAxis) {
      currentValues[name] = dim.range[0] + (dim.range[1] - dim.range[0]) * position.x;
    } else if (name === yAxis) {
      currentValues[name] = dim.range[0] + (dim.range[1] - dim.range[0]) * position.y;
    } else {
      currentValues[name] = pinnedValues[name] ?? dim.defaultValue;
    }
  }

  useEffect(() => {
    // For each dimension, compute win rate at current ± delta
    // Use the worker for the sim, but since we need multiple sims,
    // we'll do them sequentially via a single worker
    if (workerRef.current) {
      workerRef.current.terminate();
    }

    setComputing(true);
    const dims = Object.entries(DIMENSIONS) as [DimensionName, typeof DIMENSIONS[DimensionName]][];
    const pending: MarginalResult[] = [];
    let completed = 0;

    const worker = new Worker(
      new URL('../sim/sim-worker.ts', import.meta.url),
      { type: 'module' },
    );
    workerRef.current = worker;

    // We'll compute each dimension's marginal return by running two win-rate sims
    // For simplicity, we'll compute them all in sequence via messages
    const queue: Array<{
      dim: DimensionName;
      label: string;
      currentVal: number;
      direction: 'plus' | 'minus';
      xVal: number;
      yVal: number;
    }> = [];

    for (const [name, dim] of dims) {
      const val = currentValues[name];
      const delta = (dim.range[1] - dim.range[0]) * 0.05; // 5% of range

      for (const dir of ['plus', 'minus'] as const) {
        const testVal = dir === 'plus'
          ? Math.min(val + delta, dim.range[1])
          : Math.max(val - delta, dim.range[0]);

        // Compute xVal/yVal for this test
        let xVal = currentValues[xAxis];
        let yVal = currentValues[yAxis];

        if (name === xAxis) {
          xVal = testVal;
        } else if (name === yAxis) {
          yVal = testVal;
        }

        queue.push({
          dim: name,
          label: dim.label,
          currentVal: val,
          direction: dir,
          xVal,
          yVal,
        });
      }
    }

    const partialResults: Record<string, { plus?: number; minus?: number }> = {};

    let queueIdx = 0;
    const sendNext = () => {
      if (queueIdx >= queue.length) return;
      const item = queue[queueIdx];

      // Build pinned values for this test
      const testPinned = { ...pinnedValues };
      if (item.dim !== xAxis && item.dim !== yAxis) {
        const dim = DIMENSIONS[item.dim];
        const val = currentValues[item.dim];
        const delta = (dim.range[1] - dim.range[0]) * 0.05;
        testPinned[item.dim] = item.direction === 'plus'
          ? Math.min(val + delta, dim.range[1])
          : Math.max(val - delta, dim.range[0]);
      }

      worker.postMessage({
        type: 'computeWinRate',
        xAxis,
        yAxis,
        xVal: item.xVal,
        yVal: item.yVal,
        pinnedValues: testPinned,
        config,
        nGames: 500,
      });
    };

    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'winRateResult') {
        const item = queue[queueIdx];
        if (!partialResults[item.dim]) partialResults[item.dim] = {};
        partialResults[item.dim][item.direction] = msg.winRate;

        queueIdx++;
        completed++;

        // Check if this dimension is complete
        const pr = partialResults[item.dim];
        if (pr.plus !== undefined && pr.minus !== undefined) {
          const dim = DIMENSIONS[item.dim];
          const delta = (dim.range[1] - dim.range[0]) * 0.05;
          const marginal = (pr.plus - pr.minus) / (2 * delta) * 0.1; // per 10% of range
          pending.push({
            dimension: item.dim,
            label: dim.label,
            currentValue: currentValues[item.dim],
            marginalReturn: marginal,
          });
        }

        if (queueIdx < queue.length) {
          sendNext();
        } else {
          // All done
          pending.sort((a, b) => Math.abs(b.marginalReturn) - Math.abs(a.marginalReturn));
          setResults(pending);
          setComputing(false);
          worker.terminate();
        }
      }
    };

    sendNext();

    return () => {
      worker.terminate();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [position.x, position.y, xAxis, yAxis, pinnedValues]);

  return (
    <div style={{
      padding: '16px',
      background: 'var(--bg-panel)',
      borderRadius: 8,
      border: '1px solid var(--border)',
    }}>
      <div style={{
        fontSize: 14,
        fontWeight: 600,
        color: 'var(--text-h)',
        marginBottom: 12,
      }}>
        Marginal Returns
        {computing && <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: 12 }}> computing...</span>}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
        Which improvement gives the biggest win rate boost?
      </div>

      {results ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {results.map((r, i) => (
            <MarginalBar key={r.dimension} result={r} isTop={i === 0} />
          ))}
        </div>
      ) : (
        <div style={{ color: 'var(--text-muted)', fontSize: 13, textAlign: 'center', padding: 12 }}>
          {computing ? 'Computing...' : 'Move the marker to see marginal returns'}
        </div>
      )}
    </div>
  );
}

function MarginalBar({ result, isTop }: { result: MarginalResult; isTop: boolean }) {
  const pct = Math.round(result.marginalReturn * 100);
  const maxWidth = 120;
  const barWidth = Math.min(maxWidth, Math.abs(pct) * 2);
  const isPositive = pct >= 0;

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '4px 0',
      borderLeft: isTop ? '3px solid #26a641' : '3px solid transparent',
      paddingLeft: isTop ? 8 : 11,
    }}>
      <div style={{
        width: 120,
        fontSize: 12,
        color: isTop ? 'var(--text-h)' : 'var(--text-muted)',
        fontWeight: isTop ? 600 : 400,
        flexShrink: 0,
      }}>
        {result.label}
      </div>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 4 }}>
        <div style={{
          height: 8,
          width: barWidth,
          background: isPositive ? '#26a641' : '#dc2626',
          borderRadius: 2,
          opacity: isTop ? 1 : 0.6,
        }} />
        <span style={{
          fontSize: 11,
          fontFamily: 'monospace',
          color: isPositive ? '#26a641' : '#dc2626',
          fontWeight: isTop ? 700 : 400,
        }}>
          {isPositive ? '+' : ''}{pct}%
        </span>
      </div>
    </div>
  );
}
