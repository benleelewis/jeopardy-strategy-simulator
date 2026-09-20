import { useEffect, useMemo, useRef, useState } from 'react';
import * as d3 from 'd3';
import type { DDEvent } from '../sim/sim-engine';
import { buildFrames } from './replayFrames';

/**
 * Phase 1D — "Watch this game": a clue-by-clue animated replay of one
 * already-simulated game (see GameDetail's "Watch this game" button, which
 * hands this component one entry from `simSingleGameDetailResult`). The
 * frame-by-frame script (Daily Double flashes, inferred board control, FJ
 * wager/reveal sequencing) lives in `replayFrames.ts` — split out so this
 * file only exports the component (react-refresh/only-export-components).
 */

export interface ReplayRun {
  scores: [number, number, number];
  winner: number;
  history?: [number, number, number][];
  ddEvents?: DDEvent[];
}

interface Props {
  run: ReplayRun;
  /** [you, opponent1, opponent2] — same order as `run.scores`. */
  playerNames: [string, string, string];
  onClose?: () => void;
}

const BAR_COLORS = ['var(--cg-5, #f5d442)', 'var(--cg-3, #1a3ba8)', 'var(--text-muted)'];
const SPEEDS = [0.5, 1, 2] as const;

export function GameReplay({ run, playerNames, onClose }: Props) {
  const frames = useMemo(
    () => buildFrames(run.history ?? [], run.ddEvents ?? [], playerNames),
    [run, playerNames],
  );

  const [frameIndex, setFrameIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const barRefs = [useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null)];

  const clearTimer = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  // Reset to the first frame whenever a different run is handed in (e.g. a
  // new game was picked while the replay was open).
  useEffect(() => {
    clearTimer();
    setFrameIndex(0);
    setPlaying(true);
  }, [run]);

  // Advance one frame per timer tick while playing. This is the ONLY timer
  // GameReplay owns; it's cleared on every dependency change and again here
  // on unmount, so `vi.getTimerCount()` returns to 0 once the component (or
  // the whole replay) goes away — see GameReplay.test.tsx.
  useEffect(() => {
    if (!playing) return undefined;
    if (frameIndex >= frames.length - 1) {
      setPlaying(false);
      return undefined;
    }
    const delay = Math.max(0, frames[frameIndex].durationMs / speed);
    timerRef.current = setTimeout(() => {
      setFrameIndex(i => Math.min(i + 1, frames.length - 1));
    }, delay);
    return clearTimer;
  }, [playing, frameIndex, speed, frames]);

  useEffect(() => clearTimer, []);

  const maxScore = useMemo(() => {
    let m = 500;
    for (const f of frames) for (const s of f.scores) m = Math.max(m, s);
    return m;
  }, [frames]);

  const frame = frames[Math.min(frameIndex, frames.length - 1)];

  // Set each bar's target width via a D3 selection. The actual smoothing is
  // done by a CSS `transition` on `.replay-bar-fill` (disabled under
  // `prefers-reduced-motion: reduce`, same pattern as `.you-pulse` in
  // App.css) rather than d3's own timer-driven `.transition()` — that keeps
  // this component's timer footprint to the single setTimeout above instead
  // of also depending on jsdom's requestAnimationFrame behavior in tests.
  useEffect(() => {
    if (!frame) return;
    frame.scores.forEach((s, p) => {
      const el = barRefs[p].current;
      if (!el) return;
      const pct = Math.max(2, Math.min(100, (Math.max(s, 0) / maxScore) * 100));
      d3.select(el).style('width', `${pct}%`);
    });
    // barRefs are stable refs; only the frame's scores should retrigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame, maxScore]);

  if (frames.length === 0) {
    return null;
  }

  const ended = frameIndex >= frames.length - 1 && !playing;

  const handlePlayPause = () => {
    if (ended) {
      setFrameIndex(0);
      setPlaying(true);
      return;
    }
    setPlaying(p => !p);
  };

  const handleRestart = () => {
    clearTimer();
    setFrameIndex(0);
    setPlaying(true);
  };

  const handleScrub = (e: React.ChangeEvent<HTMLInputElement>) => {
    clearTimer();
    setPlaying(false);
    setFrameIndex(Number(e.target.value));
  };

  const progressLabel = frame.round === 'Final Jeopardy'
    ? 'Final Jeopardy'
    : `${frame.round}, clue ${frame.clueNumber} of ${frame.totalClues}`;

  return (
    <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border)' }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        marginBottom: 8,
      }}>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          Watch this game
        </div>
        {onClose && (
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12 }}
          >
            Hide replay
          </button>
        )}
      </div>

      <div aria-label={progressLabel} style={{ fontSize: 12, fontFamily: 'var(--mono)', color: 'var(--text-h)', marginBottom: 8 }}>
        {progressLabel}
        {frame.round !== 'Final Jeopardy' && frame.controller !== undefined && (
          <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}> · {playerNames[frame.controller]} has control</span>
        )}
      </div>

      <div className="replay-bars">
        {frame.scores.map((s, p) => {
          const flashing = frame.ddFlash?.player === p || frame.fjReveal?.player === p || frame.winnerReveal === p;
          return (
            <div key={p} className="replay-bar-row">
              <span className="replay-bar-name" style={{ color: BAR_COLORS[p] }}>{playerNames[p]}</span>
              <div className="replay-bar-track">
                <div
                  ref={barRefs[p]}
                  className={`replay-bar-fill${flashing ? ' replay-bar-flash' : ''}`}
                  style={{ background: BAR_COLORS[p] }}
                />
              </div>
              <span className="replay-bar-score" style={{ color: 'var(--text-h)' }}>
                ${Math.max(0, s).toLocaleString()}
              </span>
            </div>
          );
        })}
      </div>

      <div className="replay-caption" role="status" style={{ minHeight: 18, fontSize: 12, color: 'var(--text-h)', margin: '8px 0' }}>
        {frame.caption ?? ' '}
      </div>

      {frame.fjWagers && (
        <div style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--text-muted)', marginBottom: 8 }}>
          {playerNames.map((n, p) => `${n}: $${frame.fjWagers![p].toLocaleString()}`).join(' · ')}
        </div>
      )}

      <div className="replay-controls">
        <button onClick={handlePlayPause}>{ended ? 'Watch again' : playing ? 'Pause' : 'Play'}</button>
        <button onClick={handleRestart}>Restart</button>
        <div className="replay-speed" role="group" aria-label="Playback speed">
          {SPEEDS.map(s => (
            <button
              key={s}
              onClick={() => setSpeed(s)}
              aria-pressed={speed === s}
              className={speed === s ? 'replay-speed-active' : ''}
            >
              {s}x
            </button>
          ))}
        </div>
        <input
          type="range"
          aria-label="Replay scrubber"
          min={0}
          max={frames.length - 1}
          value={frameIndex}
          onChange={handleScrub}
          style={{ flex: 1, accentColor: 'var(--accent)' }}
        />
      </div>
    </div>
  );
}
