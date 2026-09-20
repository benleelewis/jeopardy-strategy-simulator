import { useRef, useEffect, useState } from 'react';
import type { GameData } from './ContributionGraph';
import { calibrateOpponent } from '../sim/calibrate';
import type { DDEvent } from '../sim/sim-engine';
import { equityWager, type ValueTable, type EquityWagerYou } from '../sim/value-function';
import { GameReplay } from './GameReplay';

/**
 * "What if you had wagered differently?" (TASKS.md Phase 1F) — one
 * `whatIfWager` worker reply, shaped for direct render. `ddEventIndex` ties
 * it back to the row it was requested from (see `WhatIfRow` below); a
 * mismatched `gameIndex` (a reply arriving after the selected game changed)
 * is the caller's (App.tsx's) responsibility to have already dropped.
 */
export interface WhatIfResult {
  gameIndex: number;
  ddEventIndex: number;
  actualWager: number;
  whatIfWagerAmount: number;
  actualWinRate: number;
  whatIfWinRate: number;
  /** whatIfWinRate - actualWinRate, in [-1, 1]. */
  diff: number;
  /** Paired standard error of `diff`, in the same [0, 1] units. */
  se: number;
}

export interface SimRun {
  scores: [number, number, number];
  winner: number;
  history?: [number, number, number][];
  ddEvents?: DDEvent[];
}

/**
 * TODOS "P2 — GameDetail DD event rows": one seeded simulateGame's DD events
 * plus the "you" skill the worker used to produce them — everything the
 * Daily Doubles section needs to recompute an equity-optimal wager per
 * "you" row via the app's existing value function (`equityWager`).
 */
export interface DDGameDetail {
  gameIndex: number;
  ddEvents: DDEvent[];
  you: EquityWagerYou;
}

interface Props {
  game: GameData;
  index: number;
  winRate: number | undefined;
  onClose: () => void;
  simResults: SimRun[] | null;
  /** One seeded game's DD events (TODOS item), keyed to `index` by the
   *  caller — null while the worker's simulateGameDetail sim is in flight. */
  ddDetail?: DDGameDetail | null;
  /** App's cached V-table (E-2), when Optimal (equity) has been built on the
   *  Explorer tab — reused here exactly like GameAnalyzer's equity mini-chart
   *  (see App.tsx's `cachedValueTable`). Undefined ⇒ the equity-optimal
   *  column shows a build-it-first hint instead of blocking. */
  valueTable?: ValueTable;
  /**
   * "What if you had wagered differently?" (Phase 1F). Fired when the user
   * clicks "What if" on a "you" Daily Double row — `ddEventIndex` is this
   * row's index into `ddDetail.ddEvents`. The caller (App.tsx) owns the
   * worker and builds the full `whatIfWager` message from its own closure
   * (axes/config/opponent profiles); this component only reports the row
   * and the typed wager.
   */
  onWhatIfWager?: (ddEventIndex: number, whatIfWagerAmount: number) => void;
  /** `ddEventIndex` of the row currently awaiting a `whatIfWager` reply, or
   *  null/undefined. The caller clears this when the reply lands or the
   *  request is superseded (e.g. the selected game changed). */
  whatIfPendingIndex?: number | null;
  /** Most recent `whatIfWager` reply to render, already filtered by the
   *  caller to this game (a stale reply for a previous game must never
   *  reach this prop). */
  whatIfResult?: WhatIfResult | null;
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

export function GameDetail({
  game, index, winRate, onClose, simResults, ddDetail, valueTable,
  onWhatIfWager, whatIfPendingIndex, whatIfResult,
}: Props) {
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const dollars = (v: number) => `$${Math.max(0, v).toLocaleString()}`;

  const calibrated = game.o.map(opp => calibrateOpponent(opp));
  const wins = simResults?.filter(r => r.winner === 0).length ?? 0;
  const total = simResults?.length ?? 0;

  // Only trust ddDetail when it's for THIS game — App.tsx fires the sim
  // async on click; a fast re-click before the previous result lands must
  // not show the wrong game's DD events.
  const ddForThisGame = ddDetail && ddDetail.gameIndex === index ? ddDetail : null;
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
      <div style={sectionStyle}>
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

      {/* Daily Doubles — TODOS "P2 — GameDetail DD event rows" */}
      <div style={{ ...sectionStyle, borderBottom: 'none' }}>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 8 }}>
          Daily Doubles
        </div>
        <DailyDoubles
          game={game}
          ddDetail={ddForThisGame}
          valueTable={valueTable}
          dollars={dollars}
          onWhatIfWager={onWhatIfWager}
          whatIfPendingIndex={ddForThisGame ? whatIfPendingIndex : null}
          whatIfResult={ddForThisGame && whatIfResult?.gameIndex === ddForThisGame.gameIndex ? whatIfResult : null}
        />
      </div>
      {watching && replayRun && (
        <GameReplay run={replayRun} playerNames={playerNames} onClose={() => setWatching(false)} />
      )}
    </div>
  );
}

/**
 * One row per DD event from a single seeded simulation of this game
 * (TODOS "P2 — GameDetail DD event rows"). "You" rows get an extra
 * Equity-optimal wager column, computed via the app's existing value
 * function (`equityWager`) at that DD's recorded score-state.
 */
function DailyDoubles({
  game, ddDetail, valueTable, dollars, onWhatIfWager, whatIfPendingIndex, whatIfResult,
}: {
  game: GameData;
  ddDetail: DDGameDetail | null;
  valueTable: ValueTable | undefined;
  dollars: (v: number) => string;
  onWhatIfWager?: (ddEventIndex: number, whatIfWagerAmount: number) => void;
  whatIfPendingIndex?: number | null;
  whatIfResult?: WhatIfResult | null;
}) {
  if (!ddDetail) {
    return (
      <div style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', padding: 8 }}>
        Simulating...
      </div>
    );
  }

  if (ddDetail.ddEvents.length === 0) {
    return (
      <div style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', padding: 8 }}>
        No Daily Doubles recorded for this simulation.
      </div>
    );
  }

  const whoLabel = (player: number) => player === 0 ? 'You' : game.o[player - 1].n.split(' ')[0];

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: 'monospace' }}>
      <thead>
        <tr style={{ borderBottom: '1px solid var(--border)', color: 'var(--text-muted)', fontSize: 10, textTransform: 'uppercase' }}>
          <th style={thStyle}>Rd</th>
          <th style={thStyle}>Value</th>
          <th style={thStyle}>Who</th>
          <th style={thStyle}>Before</th>
          <th style={thStyle}>Wager</th>
          <th style={thStyle}>Result</th>
          <th style={thStyle}>After</th>
          <th style={thStyle}>Equity-optimal wager</th>
          <th style={thStyle}>What if?</th>
        </tr>
      </thead>
      <tbody>
        {ddDetail.ddEvents.map((ev, i) => {
          const isYou = ev.player === 0;
          const last = i === ddDetail.ddEvents.length - 1;
          const rowBorder = last ? 'none' : '1px solid var(--border)';

          let equityCell: React.ReactNode = '—';
          let diffCopy: string | null = null;
          let optimalWager: number | null = null;

          if (isYou) {
            if (!valueTable) {
              equityCell = (
                <span style={{ color: 'var(--text-muted)', fontFamily: 'inherit', fontWeight: 400 }}>
                  Build the Optimal (equity) strategy in the Explorer to see this
                </span>
              );
            } else if (ev.scoresBefore !== undefined && ev.cluesRemainingAfter !== undefined && ev.adjustedP !== undefined) {
              optimalWager = equityWager(
                ddDetail.you, ev.scoresBefore, ev.cluesRemainingAfter, ev.adjustedP, valueTable,
              );
              equityCell = dollars(optimalWager);
              const diff = ev.wager - optimalWager;
              if (Math.abs(diff) > 500) {
                diffCopy = `You wagered ${dollars(Math.abs(diff))} ${diff > 0 ? 'more' : 'less'} than the equity-optimal ${dollars(optimalWager)}.`;
              }
            }
          }

          // What-if replay (Phase 1F) needs the same resume fields the
          // equity-optimal recompute above needs — additive/optional on
          // DDEvent, so an older seeded result missing them just hides the
          // control for that row rather than resuming from a guess.
          const canWhatIf = isYou && ev.scoresBefore !== undefined && ev.cluesRemainingAfter !== undefined;

          // Keyed by (gameIndex, i) rather than just `i` so switching to a
          // different game — which reuses the same row indices — remounts
          // WhatIfRow's local wager-input state instead of carrying over the
          // previous game's typed value.
          const rowKey = `${ddDetail.gameIndex}-${i}`;

          return (
            <tr key={rowKey} style={{
              borderBottom: rowBorder,
              color: isYou ? 'var(--text-h)' : 'var(--text-muted)',
              fontWeight: isYou ? 600 : 400,
            }}>
              <td style={tdStyle}>{ev.round}</td>
              <td style={tdStyle}>{ev.clueValue !== undefined ? dollars(ev.clueValue) : '—'}</td>
              <td style={tdStyle}>{whoLabel(ev.player)}</td>
              <td style={tdStyle}>{dollars(ev.scoreBefore)}</td>
              <td style={tdStyle}>{dollars(ev.wager)}</td>
              <td style={{
                ...tdStyle,
                color: ev.correct ? 'var(--cg-5, #f5d442)' : 'var(--cg-3, #1a3ba8)',
                fontWeight: 600,
              }}>
                {ev.correct ? 'Correct' : 'Wrong'}
              </td>
              <td style={tdStyle}>{dollars(ev.scoreAfter)}</td>
              <td style={{ ...tdStyle, fontFamily: 'sans-serif', fontSize: 11 }}>
                {equityCell}
                {diffCopy && (
                  <div style={{ marginTop: 2, color: 'var(--text-h)', fontWeight: 500 }}>
                    {diffCopy}
                  </div>
                )}
              </td>
              <td style={{ ...tdStyle, fontFamily: 'sans-serif', fontSize: 11, minWidth: 160 }}>
                {canWhatIf ? (
                  <WhatIfRow
                    ddEventIndex={i}
                    event={ev}
                    optimalWager={optimalWager}
                    pending={whatIfPendingIndex === i}
                    result={whatIfResult && whatIfResult.ddEventIndex === i ? whatIfResult : null}
                    onWhatIfWager={onWhatIfWager}
                    dollars={dollars}
                  />
                ) : null}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * "What if you had wagered differently?" (TASKS.md Phase 1F). Inline
 * control on a "you" Daily Double row: a wager input (defaulting to the
 * wager actually made, clamped to the real-rules range) and a "What if"
 * button that reports the typed wager up to the caller (App.tsx owns the
 * worker round-trip). Renders the caller's most recent result for this row
 * once it arrives, and a one-line note when the typed wager matches the
 * equity-optimal one (only computable when `optimalWager` is available —
 * i.e. a V-table is cached).
 */
function WhatIfRow({
  ddEventIndex, event, optimalWager, pending, result, onWhatIfWager, dollars,
}: {
  ddEventIndex: number;
  event: DDEvent;
  optimalWager: number | null;
  pending: boolean;
  result: WhatIfResult | null;
  onWhatIfWager?: (ddEventIndex: number, whatIfWagerAmount: number) => void;
  dollars: (v: number) => string;
}) {
  // Real-rules DD wager bounds: at least $5, at most the greater of your
  // score going in or the clue's own face value.
  const minWager = 5;
  const maxWager = Math.max(minWager, event.scoreBefore, event.clueValue ?? 0);
  const [wagerInput, setWagerInput] = useState(String(event.wager));

  const parsedWager = Math.round(Number(wagerInput));
  const clampedWager = Number.isFinite(parsedWager)
    ? Math.min(maxWager, Math.max(minWager, parsedWager))
    : event.wager;

  const pp = (v: number) => Math.round(v * 100);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <span style={{ color: 'var(--text-muted)' }}>$</span>
        <input
          type="number"
          aria-label={`What-if wager for Daily Double ${ddEventIndex}`}
          min={minWager}
          max={maxWager}
          value={wagerInput}
          onChange={e => setWagerInput(e.target.value)}
          style={{
            width: 72,
            fontSize: 11,
            fontFamily: 'monospace',
            background: 'var(--bg-panel)',
            color: 'var(--text-h)',
            border: '1px solid var(--border)',
            borderRadius: 3,
            padding: '2px 4px',
          }}
        />
        <button
          onClick={() => onWhatIfWager?.(ddEventIndex, clampedWager)}
          disabled={pending}
          style={{
            background: 'none',
            border: '1px solid var(--border)',
            color: 'var(--accent, var(--text-h))',
            borderRadius: 4,
            padding: '2px 8px',
            fontSize: 11,
            cursor: pending ? 'default' : 'pointer',
            opacity: pending ? 0.6 : 1,
          }}
        >
          {pending ? 'Simulating…' : 'What if'}
        </button>
      </div>
      {result && (
        <div style={{ color: 'var(--text-h)' }}>
          Win chance: {pp(result.actualWinRate)}% with your {dollars(result.actualWager)} → {pp(result.whatIfWinRate)}% with {dollars(result.whatIfWagerAmount)}
          {' '}({result.diff >= 0 ? '+' : ''}{pp(result.diff)} ± {pp(result.se)} pp)
          {optimalWager !== null && Math.abs(result.whatIfWagerAmount - optimalWager) < 5 && (
            <div>This is the equity-optimal wager for this state.</div>
          )}
        </div>
      )}
    </div>
  );
}

const thStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: '2px 6px 4px 0',
};

const tdStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: '3px 6px 3px 0',
  verticalAlign: 'top',
};
