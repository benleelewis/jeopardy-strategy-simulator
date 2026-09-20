/**
 * All Games "Gain from optimal play" colour mode (TODOS "P2 — All Games
 * optimal-vs-actual delta coloring"): the headline, the status line while
 * the V-table builds / the delta sweep runs, and the diverging legend.
 * Rendered in place of the win-rate subtitle + legend only while that mode
 * is selected — the default mode's header is untouched.
 */
import { useMemo } from 'react';
import { GAIN_LEGEND, gainMeans, type GainData } from './gain';

export type GainTableStatus = 'idle' | 'building' | 'ready' | 'failed';

interface Props {
  /** Paired per-game arms from the delta sweep; null until the first pass lands. */
  gain: GainData | null;
  /** 0-1 while a delta pass is running, null when idle. */
  progress: number | null;
  /** V-table (equity wagering) build state for the current knobs. */
  tableStatus: GainTableStatus;
  /** 0-1 build progress, meaningful while `tableStatus === 'building'`. */
  tableProgress: number;
}

export function GainHeader({ gain, progress, tableStatus, tableProgress }: Props) {
  const means = useMemo(() => gainMeans(gain), [gain]);

  let status: string | null = null;
  if (tableStatus === 'building') {
    status = `Building the optimal-wagering table… ${Math.round(tableProgress * 100)}%`;
  } else if (tableStatus === 'failed') {
    status = 'Optimal-wagering table unavailable — the gain cannot be computed.';
  } else if (!means) {
    status = progress !== null
      ? `Computing gain from optimal play… ${Math.round(progress * 100)}%`
      : 'Computing gain from optimal play…';
  }

  return (
    <div className="games-header">
      {means ? (
        <p className="games-subtitle gain-headline" role="status">
          Optimal wagering and DD seeking would {means.to >= means.from ? 'lift' : 'move'} you from{' '}
          <strong>{Math.round(means.from * 100)}%</strong> to{' '}
          <strong>{Math.round(means.to * 100)}%</strong> across {means.total.toLocaleString()} games.
          {progress !== null && (
            <span className="sim-status"> Refining… {Math.round(progress * 100)}%</span>
          )}
        </p>
      ) : (
        <p className="games-subtitle" role="status">
          <span className="sim-status">{status}</span>
        </p>
      )}
      <p className="games-subtitle">
        Every regular-season game, colored by how much equity wagering and Daily Double seeking
        would change your win rate in that game (same random draws for both, so the difference is
        the strategy).
      </p>
      <div className="games-legend">
        <span className="legend-label">Gain from optimal play:</span>
        {GAIN_LEGEND.map(({ cssVar, fallback, label }) => (
          <span key={label} className="legend-item">
            <span className="legend-swatch" style={{ background: `var(${cssVar}, ${fallback})` }} />
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}
