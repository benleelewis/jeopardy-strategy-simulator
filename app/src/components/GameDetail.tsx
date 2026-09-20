import { useRef, useEffect, useState } from 'react';
import type { GameData } from './ContributionGraph';
import { calibrateOpponent } from '../sim/calibrate';
import type { DDEvent } from '../sim/sim-engine';
import { GameReplay } from './GameReplay';

export interface SimRun {
  scores: [number, number, number];
  winner: number;
  history?: [number, number, number][];
  ddEvents?: DDEvent[];
}

interface Props {
  game: GameData;
  index: number;
  winRate: number | undefined;
  onClose: () => void;
  simResults: SimRun[] | null;
}

const sectionStyle: React.CSSProperties = {
  padding: '12px 16px',
  borderBottom: '1px solid var(--border)',
};

const PLAYER_COLORS = ['var(--cg-5, #f5d442)', 'var(--cg-3, #1a3ba8)', 'var(--text-muted)'];

function ScoreChart({ history, winner }: { history: [number, number, number][]; winner: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || history.length === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = 200;
    const h = 48;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.scale(dpr, dpr);

    // Find score range
    let minS = 0;
    let maxS = 0;
    for (const step of history) {
      for (const s of step) {
        minS = Math.min(minS, s);
        maxS = Math.max(maxS, s);
      }
    }
    const range = maxS - minS || 1;
    const pad = 2;

    ctx.clearRect(0, 0, w, h);

    // Draw zero line
    const zeroY = h - pad - ((0 - minS) / range) * (h - 2 * pad);
    ctx.strokeStyle = 'var(--border)';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(0, zeroY);
    ctx.lineTo(w, zeroY);
    ctx.stroke();

    // Draw each player's score progression
    // Use getComputedStyle for CSS variable colors
    const computed = getComputedStyle(canvas);
    const colors = [
      computed.getPropertyValue('--cg-5').trim() || '#f5d442',
      computed.getPropertyValue('--cg-3').trim() || '#1a3ba8',
      computed.getPropertyValue('--text-muted').trim() || '#8b949e',
    ];

    for (let p = 2; p >= 0; p--) { // draw player 0 (you) last so it's on top
      ctx.strokeStyle = colors[p];
      ctx.lineWidth = p === 0 ? 2 : 1;
      ctx.globalAlpha = p === 0 ? 1 : 0.5;
      ctx.beginPath();
      for (let i = 0; i < history.length; i++) {
        const x = (i / (history.length - 1)) * w;
        const y = h - pad - ((history[i][p] - minS) / range) * (h - 2 * pad);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }, [history, winner]);

  return <canvas ref={canvasRef} style={{ display: 'block' }} />;
}

export function GameDetail({ game, index, winRate, onClose, simResults }: Props) {
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const dollars = (v: number) => `$${Math.max(0, v).toLocaleString()}`;

  const calibrated = game.o.map(opp => calibrateOpponent(opp));
  const wins = simResults?.filter(r => r.winner === 0).length ?? 0;
  const total = simResults?.length ?? 0;

  // Phase 1D: "Watch this game" replays the first of the already-run
  // simulations (it already carries full history + ddEvents — see
  // sim-worker.ts's simSingleGameDetail handler). Closing over a different
  // game resets this — via React's "adjust state during render" pattern
  // (not an effect) so an in-flight replay never survives a game switch and
  // GameReplay's own unmount cleanup runs before the new game's content
  // paints.
  const [watching, setWatching] = useState(false);
  const [watchingForIndex, setWatchingForIndex] = useState(index);
  if (watchingForIndex !== index) {
    setWatchingForIndex(index);
    setWatching(false);
  }
  const replayRun = simResults?.[0] ?? null;
  const playerNames: [string, string, string] = ['You', game.o[0].n, game.o[1].n];

  return (
    <div style={{
      background: 'var(--bg-panel)',
      border: '1px solid var(--border)',
      borderRadius: 8,
      overflow: 'hidden',
      maxWidth: 520,
    }}>
      <div style={{
        ...sectionStyle,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}>
        <div>
          <div style={{ fontWeight: 600, color: 'var(--text-h)', fontSize: 14 }}>
            Season {game.s} — {game.d}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Game #{index + 1}
          </div>
        </div>
        <button
          onClick={onClose}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--text-muted)',
            cursor: 'pointer',
            fontSize: 18,
            padding: '2px 6px',
          }}
        >
          x
        </button>
      </div>

      <div style={sectionStyle}>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 8 }}>
          Opponents
        </div>
        {game.o.map((opp, i) => {
          const cal = calibrated[i];
          return (
            <div key={i} style={{
              padding: '6px 0',
              borderBottom: i === 0 ? '1px solid var(--border)' : 'none',
            }}>
              <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}>
                <div style={{
                  fontWeight: 500,
                  color: PLAYER_COLORS[i + 1],
                  fontSize: 13,
                }}>
                  {opp.n}
                </div>
                <div style={{
                  fontWeight: 700,
                  color: 'var(--text-h)',
                  fontSize: 16,
                  fontFamily: 'monospace',
                }}>
                  {dollars(opp.c)}
                </div>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'monospace', marginTop: 2 }}>
                Acc:{pct(cal.p)} Buzz:{pct(cal.b)} FJ:{opp.fj ? 'Y' : 'N'}
              </div>
            </div>
          );
        })}
      </div>

      {/* Simulation Results */}
      <div style={{ ...sectionStyle, borderBottom: watching && replayRun ? undefined : 'none' }}>
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 8,
        }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Simulations
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {replayRun && !watching && (
              <button
                onClick={() => setWatching(true)}
                style={{
                  background: 'none',
                  border: '1px solid var(--border)',
                  color: 'var(--accent, var(--text-h))',
                  borderRadius: 4,
                  padding: '3px 8px',
                  fontSize: 11,
                  cursor: 'pointer',
                }}
              >
                Watch this game
              </button>
            )}
            <div style={{
              fontSize: 13,
              fontWeight: 700,
              color: (simResults ? wins / total : (winRate ?? 0)) > 0.5 ? 'var(--cg-5, #f5d442)'
                : (simResults ? wins / total : (winRate ?? 0)) > 0.33 ? 'var(--cg-4, #c5a028)'
                : 'var(--cg-3, #1a3ba8)',
            }}>
              {simResults ? `Won ${wins}/${total}` : winRate !== undefined ? `${Math.round(winRate * 100)}%` : '...'}
            </div>
          </div>
        </div>

        {!simResults ? (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', padding: 8 }}>
            Simulating...
          </div>
        ) : (
          <div style={{ fontSize: 12, fontFamily: 'monospace' }}>
            {/* Header */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: '24px 1fr 1fr 1fr 36px 200px',
              gap: 4,
              padding: '2px 0 4px',
              borderBottom: '1px solid var(--border)',
              color: 'var(--text-muted)',
              fontSize: 10,
              textTransform: 'uppercase',
              alignItems: 'center',
            }}>
              <span>#</span>
              <span>You</span>
              <span>{game.o[0].n.split(' ')[0]}</span>
              <span>{game.o[1].n.split(' ')[0]}</span>
              <span></span>
              <span>Score Path</span>
            </div>
            {/* Rows */}
            {simResults.map((run, i) => {
              const won = run.winner === 0;
              return (
                <div key={i} style={{
                  display: 'grid',
                  gridTemplateColumns: '24px 1fr 1fr 1fr 36px 200px',
                  gap: 4,
                  padding: '3px 0',
                  borderBottom: i < simResults.length - 1 ? '1px solid var(--border)' : 'none',
                  color: won ? 'var(--text-h)' : 'var(--text-muted)',
                  fontWeight: won ? 600 : 400,
                  alignItems: 'center',
                }}>
                  <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>{i + 1}</span>
                  <span>{dollars(run.scores[0])}</span>
                  <span>{dollars(run.scores[1])}</span>
                  <span>{dollars(run.scores[2])}</span>
                  <span style={{
                    color: won ? 'var(--cg-5, #f5d442)' : 'var(--text-muted)',
                    fontWeight: 600,
                    fontSize: 10,
                  }}>
                    {won ? 'WIN' : 'Loss'}
                  </span>
                  <span>
                    {run.history && run.history.length > 0 ? (
                      <ScoreChart history={run.history} winner={run.winner} />
                    ) : (
                      <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>—</span>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {watching && replayRun && (
        <GameReplay run={replayRun} playerNames={playerNames} onClose={() => setWatching(false)} />
      )}
    </div>
  );
}
