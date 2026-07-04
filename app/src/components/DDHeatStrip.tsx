/**
 * DD-placement heat strip — E-7 item 7.
 *
 * Explorer side panel, below MarginalReturns. 5 rows × 2 round columns
 * (J/DJ), colored by the empirical P(DD | row, round) from clue-stats.json
 * (E-1's `ddRowWeights`). Independent of V(S) — driven entirely by whether
 * clue-stats.json loaded successfully; hidden entirely (no empty skeleton)
 * when it didn't, per the plan's UI-states table.
 */

import type { ClueStats } from '../App';

interface Props {
  clueStats: ClueStats | null;
}

const ROW_LABELS = ['$200/$400', '$400/$800', '$600/$1200', '$800/$1600', '$1000/$2000'];

export function DDHeatStrip({ clueStats }: Props) {
  if (!clueStats) return null; // E-7: hidden entirely on fallback — no empty skeleton

  const { J, DJ } = clueStats.ddRowWeights;
  const max = Math.max(...J, ...DJ);
  const gameCount = clueStats.source.completeGames;

  const cellColor = (v: number) => {
    const t = max > 0 ? v / max : 0;
    // Flat panel aesthetic: single accent hue, intensity ramps with weight.
    return `rgba(88, 166, 255, ${0.12 + t * 0.75})`;
  };

  return (
    <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
      <div style={{
        fontSize: 12, fontWeight: 600, color: 'var(--text-h)',
        textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4,
      }}>
        Where DDs actually live ({gameCount.toLocaleString()} games)
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 10 }}>
        P(Daily Double | row, round) — empirical, era-normalized
      </div>
      <div
        role="table"
        aria-label="Daily Double placement probability by board row and round"
        style={{ display: 'grid', gridTemplateColumns: '90px 1fr 1fr', gap: 4 }}
      >
        <div role="row" style={{ display: 'contents' }}>
          <div role="columnheader" />
          <div role="columnheader" style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-h)', textAlign: 'center' }}>J</div>
          <div role="columnheader" style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-h)', textAlign: 'center' }}>DJ</div>
        </div>
        {ROW_LABELS.map((label, row) => (
          <div role="row" key={label} style={{ display: 'contents' }}>
            <div role="rowheader" style={{ fontSize: 10, color: 'var(--text-muted)', display: 'flex', alignItems: 'center' }}>
              {label}
            </div>
            <div
              role="cell"
              title={`J row ${row + 1}: ${(J[row] * 100).toFixed(1)}%`}
              style={{
                background: cellColor(J[row]),
                borderRadius: 4,
                padding: '6px 4px',
                textAlign: 'center',
                fontSize: 11,
                fontWeight: 600,
                color: 'var(--text-h)',
              }}
            >
              {(J[row] * 100).toFixed(1)}%
            </div>
            <div
              role="cell"
              title={`DJ row ${row + 1}: ${(DJ[row] * 100).toFixed(1)}%`}
              style={{
                background: cellColor(DJ[row]),
                borderRadius: 4,
                padding: '6px 4px',
                textAlign: 'center',
                fontSize: 11,
                fontWeight: 600,
                color: 'var(--text-h)',
              }}
            >
              {(DJ[row] * 100).toFixed(1)}%
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
