/**
 * Game Analyzer — Screen 1 from the design doc.
 *
 * Manual entry of game scores to estimate player position.
 * Computes knowledge and buzzer estimates from correct/wrong counts.
 * Shows DD wager analysis and places user on the strategy space.
 *
 * J-Archive URL fetch deferred to V2 (requires CORS proxy).
 *
 * E-7: also hosts the equity mini-chart (DD & FJ details advanced
 * section) — the plan's chosen host; GameDetail does NOT get it (no
 * per-DD data model there, deferred to TODOS).
 */

import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import {
  queryV, equityWager, buildValueTable,
  type ValueTable, type EquityWagerYou,
} from '../sim/value-function';
import { DEFAULT_CONFIG, mulberry32 } from '../sim/sim-engine';
import { OPPONENT_PROFILES } from '../sim/opponent-models';
import type { JArchiveGameResponse, JArchiveDDEvent, GameRecord } from '../lib/jarchive';
import {
  backtestHeadline, ARM_LABELS, BACKTEST_ARMS,
  type BacktestResult, type BacktestArm, type ArmEstimate,
} from '../sim/backtest';

export interface GameEstimate {
  knowledge: number;   // b × p composite
  buzzerSpeed: number; // activity rate proxy
  correct: number;
  wrong: number;
  coryat: number;
  ddWager?: number;
  ddCorrect?: boolean;
  fjWager?: number;
  fjCorrect?: boolean;
}

/** What "Backtest this game" sends to the worker (sim-worker.ts's
 *  `backtestGame` message, minus the type tag). */
export interface BacktestRequest {
  record: GameRecord;
  seat: number;
  valueTable?: ValueTable;
}

/** Runs a backtest and reports back; returns a cancel function. Injected
 *  so tests can feed a fixture result without a real Worker — the default
 *  (`workerBacktestRunner`) posts `backtestGame` to a dedicated worker. */
export type BacktestRunner = (
  req: BacktestRequest,
  hooks: {
    onProgress: (pct: number) => void;
    onResult: (result: BacktestResult) => void;
    onError: (message: string) => void;
  },
) => () => void;

interface Props {
  onEstimate: (estimate: GameEstimate) => void;
  /** App's cached V-table (E-2), when Optimal (equity) has been built on
   *  the Explorer tab — the equity mini-chart reuses it instead of
   *  building its own when present (E-7 item 5's documented choice). */
  sharedValueTable?: ValueTable;
  /** Override how "Backtest this game" runs (tests). */
  backtestRunner?: BacktestRunner;
}

/**
 * Default backtest runner: one dedicated worker per run (terminated on
 * cancel or completion), so a backtest never queues behind the persistent
 * all-games worker in App.tsx, and its `cancel` message can't interrupt an
 * in-flight All Games sweep. The V(S) table is structured-cloned across —
 * a few hundred KB, once per click.
 */
const workerBacktestRunner: BacktestRunner = (req, hooks) => {
  const worker = new Worker(new URL('../sim/sim-worker.ts', import.meta.url), { type: 'module' });
  let finished = false;
  const finish = () => { finished = true; worker.terminate(); };
  worker.onmessage = (e: MessageEvent) => {
    const msg = e.data;
    if (finished) return;
    if (msg.type === 'backtestProgress') hooks.onProgress(msg.pct);
    else if (msg.type === 'backtestResult') { finish(); hooks.onResult(msg.result); }
    else if (msg.type === 'backtestError') { finish(); hooks.onError(msg.message); }
  };
  worker.onerror = () => {
    if (finished) return;
    finish();
    hooks.onError('The backtest worker crashed.');
  };
  worker.postMessage({ type: 'backtestGame', record: req.record, seat: req.seat, valueTable: req.valueTable, requestId: 1 });
  return () => {
    if (finished) return;
    worker.postMessage({ type: 'cancel' });
    finish();
  };
};

/** Absurd-input ceiling for the free-text DD/FJ wager fields (E-7's
 *  "existing input validation gap fixed in passing" — GameAnalyzer.tsx:55
 *  parsed to NaN unguarded). Real Jeopardy scores essentially never exceed
 *  this mid-game, so it's a generous but real bound, not an arbitrary one. */
const ABSURD_WAGER_CEILING = 100000;

/** Parses a free-text wager field into a clamped numeric value + an
 *  optional inline hint. Empty string ⇒ no value, no hint (field untouched
 *  is not an error). Shared by DD and FJ wager fields (E-7 item 6). */
function parseWagerInput(raw: string): { value: number | null; hint: string | null } {
  if (raw.trim() === '') return { value: null, hint: null };
  const n = Number(raw);
  if (!Number.isFinite(n)) return { value: null, hint: 'Enter a valid number' };
  if (n < 0) return { value: 0, hint: "Wager can't be negative — clamped to $0" };
  if (n > ABSURD_WAGER_CEILING) {
    return { value: ABSURD_WAGER_CEILING, hint: `That's an unusually high wager — clamped to $${ABSURD_WAGER_CEILING.toLocaleString()}` };
  }
  return { value: n, hint: null };
}

/** A deliberately tiny V(S) table (E-7 item 5's lazy fallback, when App
 *  hasn't built one for Optimal mode yet) — 64 cells × 5 rollouts = 320
 *  rollouts, built synchronously on the main thread in well under a frame.
 *  Coarser than DEFAULT_VALUE_TABLE_DIMS on purpose: this is a "preview"
 *  curve for a single advanced-section chart, not the validated equity
 *  layer, and the assumptions below (opponents tied with you, mid-DJ) are
 *  a generic stand-in — GameAnalyzer has no live 3-player game state to
 *  query, unlike the Explorer's HeatMap/all-games consumers. */
const MINI_VALUE_TABLE_DIMS = {
  skillKnowledge: { min: 0, max: 1, n: 2 },
  skillBuzzer: { min: 0, max: 1, n: 2 },
  yourShare: { min: 0, max: 1.5, n: 3 },
  leaderRatio: { min: 0, max: 2, n: 3 },
  thirdRatio: { min: 0, max: 2, n: 3 },
  cluesRemaining: { min: 0, max: 30, n: 3 },
};
const MINI_TABLE_SEED = 0xA11CE;
/** Assumed clues remaining in DJ for the preview chart's scenario (a
 *  generic "mid-Double-Jeopardy" DD, since GameAnalyzer has no real
 *  clue-by-clue state). */
const ASSUMED_CLUES_REMAINING = 15;

/** Rotate a 3-player score/name tuple so `seat` sits at index 0 — the
 *  layout `equityWager`/`queryV` expect ("your" score first). */
function rotateToSeat<T>(arr: readonly T[], seat: number): [T, T, T] {
  const rest = arr.filter((_, i) => i !== seat);
  return [arr[seat], rest[0], rest[1]];
}

export function GameAnalyzer({ onEstimate, sharedValueTable, backtestRunner = workerBacktestRunner }: Props) {
  const [correct, setCorrect] = useState(18);
  const [wrong, setWrong] = useState(3);
  const [coryat, setCoryat] = useState(16000);
  const [ddWagerRaw, setDdWagerRaw] = useState<string>('');
  const [ddCorrect, setDdCorrect] = useState(true);
  const [fjWagerRaw, setFjWagerRaw] = useState<string>('');
  const [fjCorrect, setFjCorrect] = useState(true);
  const [confidence, setConfidence] = useState(0.55); // E-7: 50–95%, default 55% (the paper's worked example)
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  // J-Archive import.
  const [jarchiveGameId, setJarchiveGameId] = useState('');
  const [jarchiveStatus, setJarchiveStatus] = useState<'idle' | 'loading'>('idle');
  const [jarchiveError, setJarchiveError] = useState<string | null>(null);
  const [jarchiveGame, setJarchiveGame] = useState<JArchiveGameResponse | null>(null);
  const [jarchiveContestant, setJarchiveContestant] = useState<string | null>(null);

  // "Backtest this game" (TASKS.md Phase 3).
  const [backtestStatus, setBacktestStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [backtestProgress, setBacktestProgress] = useState(0);
  const [backtestResult, setBacktestResult] = useState<BacktestResult | null>(null);
  const [backtestError, setBacktestError] = useState<string | null>(null);
  const backtestCancelRef = useRef<(() => void) | null>(null);

  const ddWagerParsed = parseWagerInput(ddWagerRaw);
  const fjWagerParsed = parseWagerInput(fjWagerRaw);

  const cancelBacktest = useCallback(() => {
    backtestCancelRef.current?.();
    backtestCancelRef.current = null;
    setBacktestStatus('idle');
    setBacktestProgress(0);
  }, []);

  // Any in-flight backtest dies with the component.
  useEffect(() => () => { backtestCancelRef.current?.(); }, []);

  const handleLoadJArchive = useCallback(async () => {
    const trimmed = jarchiveGameId.trim();
    if (trimmed === '') {
      setJarchiveError('Enter a J-Archive game ID first, e.g. 9501');
      return;
    }
    setJarchiveStatus('loading');
    setJarchiveError(null);
    setJarchiveGame(null);
    setJarchiveContestant(null);

    try {
      const res = await fetch(`/api/jarchive?game=${encodeURIComponent(trimmed)}`);
      const raw = await res.text();

      // `npm run dev` doesn't serve /api by itself (see README's "Local
      // dev: J-Archive import" section) — without `vercel dev` behind the
      // Vite proxy, this request comes back as Vite's HTML shell instead
      // of our route's JSON/plain-text response. Detect that by content,
      // not status, since the shell itself is a 200.
      if (raw.trimStart().startsWith('<')) {
        setJarchiveStatus('idle');
        setJarchiveError("J-Archive import isn't available in this dev server. Try the deployed site, or run `vercel dev` alongside `npm run dev` (see README).");
        return;
      }

      if (!res.ok) {
        setJarchiveStatus('idle');
        setJarchiveError(raw || `Couldn't load game ${trimmed} (HTTP ${res.status}).`);
        return;
      }

      const data = JSON.parse(raw) as JArchiveGameResponse;
      setJarchiveGame(data);
      setJarchiveStatus('idle');
    } catch {
      setJarchiveStatus('idle');
      setJarchiveError('Network error loading from J-Archive. Check your connection and try again.');
    }
  }, [jarchiveGameId]);

  const handlePickContestant = useCallback((name: string) => {
    const c = jarchiveGame?.contestants.find(x => x.name === name);
    if (!c) return;
    // A backtest belongs to one contestant — drop it when the pick changes.
    backtestCancelRef.current?.();
    backtestCancelRef.current = null;
    setBacktestStatus('idle');
    setBacktestResult(null);
    setBacktestError(null);
    setJarchiveContestant(name);
    setCorrect(c.correct);
    setWrong(c.wrong);
    setCoryat(c.coryat);
  }, [jarchiveGame]);

  const yourDailyDoubles: JArchiveDDEvent[] = useMemo(() => {
    if (!jarchiveGame || !jarchiveContestant) return [];
    return jarchiveGame.dailyDoubles.filter(dd => dd.who === jarchiveContestant);
  }, [jarchiveGame, jarchiveContestant]);

  const handleBacktest = useCallback(() => {
    if (!jarchiveGame?.record || !jarchiveContestant) return;
    const seat = jarchiveGame.players.indexOf(jarchiveContestant);
    if (seat < 0) return;
    backtestCancelRef.current?.();
    setBacktestStatus('running');
    setBacktestProgress(0);
    setBacktestResult(null);
    setBacktestError(null);
    backtestCancelRef.current = backtestRunner(
      { record: jarchiveGame.record, seat, valueTable: sharedValueTable },
      {
        onProgress: pct => setBacktestProgress(pct),
        onResult: result => {
          backtestCancelRef.current = null;
          setBacktestResult(result);
          setBacktestStatus('done');
        },
        onError: message => {
          backtestCancelRef.current = null;
          setBacktestError(message);
          setBacktestStatus('error');
        },
      },
    );
  }, [jarchiveGame, jarchiveContestant, sharedValueTable, backtestRunner]);

  const handleSubmit = useCallback(() => {
    // Knowledge = accuracy when buzzing (epsilon smoothing)
    const knowledge = correct / (correct + wrong + 1);

    // Buzzer = activity rate (attempts / total clues)
    const buzzerSpeed = Math.min((correct + wrong) / 60, 0.95);

    const estimate: GameEstimate = {
      knowledge,
      buzzerSpeed,
      correct,
      wrong,
      coryat,
    };

    if (ddWagerParsed.value !== null) {
      estimate.ddWager = ddWagerParsed.value;
      estimate.ddCorrect = ddCorrect;
    }
    if (fjWagerParsed.value !== null) {
      estimate.fjWager = fjWagerParsed.value;
      estimate.fjCorrect = fjCorrect;
    }

    onEstimate(estimate);
    setSubmitted(true);
  }, [correct, wrong, coryat, ddWagerParsed.value, ddCorrect, fjWagerParsed.value, fjCorrect, onEstimate]);

  // Pre-computed estimates for display
  const estKnowledge = correct / (correct + wrong + 1);
  const estBuzzer = Math.min((correct + wrong) / 60, 0.95);

  // E-7: lazy fallback V-table, only built when no shared (Optimal-mode)
  // table exists yet — see MINI_VALUE_TABLE_DIMS's doc above. Memoized on
  // sharedValueTable's identity so it isn't rebuilt on every keystroke.
  const fallbackTable = useMemo(() => {
    if (sharedValueTable) return null;
    return buildValueTable(OPPONENT_PROFILES.average, DEFAULT_CONFIG, mulberry32(MINI_TABLE_SEED), {
      dims: MINI_VALUE_TABLE_DIMS,
      rolloutsPerCell: 5,
      blurRadius: 1,
    });
  }, [sharedValueTable]);

  const equityTable = sharedValueTable ?? fallbackTable ?? undefined;
  const equitySource: 'shared' | 'fallback' = sharedValueTable ? 'shared' : 'fallback';

  // Equity curve: only meaningful once a valid (non-NaN) DD wager exists —
  // "chart never renders from NaN" (E-7 item 6).
  const equityCurve = useMemo(() => {
    if (!equityTable || ddWagerParsed.value === null) return null;
    const you: EquityWagerYou = { knowledge: estKnowledge, buzzerSpeed: estBuzzer };
    // Generic scenario (documented above): opponents assumed tied with you,
    // mid-Double-Jeopardy. Your "current score" proxy is the entered
    // Coryat (excl. DD/FJ) — the closest thing GameAnalyzer has to a
    // score-at-DD-time (real score-at-DD data doesn't exist, per E-1).
    const scores: [number, number, number] = [Math.max(coryat, 0), Math.max(coryat, 0), Math.max(coryat, 0)];
    const cluesRemainingAfter = ASSUMED_CLUES_REMAINING;

    const MIN_WAGER = 5;
    const maxWager = Math.max(scores[0], MIN_WAGER);
    const points: { wager: number; equity: number }[] = [];
    const N = 24;
    for (let i = 0; i < N; i++) {
      const wager = Math.round(MIN_WAGER + ((maxWager - MIN_WAGER) * i) / (N - 1));
      const winV = queryV(equityTable, { knowledge: estKnowledge, buzzerSpeed: estBuzzer, scores: [scores[0] + wager, scores[1], scores[2]], cluesRemaining: cluesRemainingAfter });
      const loseV = queryV(equityTable, { knowledge: estKnowledge, buzzerSpeed: estBuzzer, scores: [scores[0] - wager, scores[1], scores[2]], cluesRemaining: cluesRemainingAfter });
      const equity = confidence * winV + (1 - confidence) * loseV;
      points.push({ wager, equity });
    }

    const optimalWager = equityWager(you, scores, cluesRemainingAfter, confidence, equityTable);
    const optimalEquity = confidence * queryV(equityTable, { knowledge: estKnowledge, buzzerSpeed: estBuzzer, scores: [scores[0] + optimalWager, scores[1], scores[2]], cluesRemaining: cluesRemainingAfter })
      + (1 - confidence) * queryV(equityTable, { knowledge: estKnowledge, buzzerSpeed: estBuzzer, scores: [scores[0] - optimalWager, scores[1], scores[2]], cluesRemaining: cluesRemainingAfter });
    const yourWager = ddWagerParsed.value;
    const yourEquity = confidence * queryV(equityTable, { knowledge: estKnowledge, buzzerSpeed: estBuzzer, scores: [scores[0] + yourWager, scores[1], scores[2]], cluesRemaining: cluesRemainingAfter })
      + (1 - confidence) * queryV(equityTable, { knowledge: estKnowledge, buzzerSpeed: estBuzzer, scores: [scores[0] - yourWager, scores[1], scores[2]], cluesRemaining: cluesRemainingAfter });

    return { points, optimalWager, optimalEquity, yourWager, yourEquity };
  }, [equityTable, ddWagerParsed.value, coryat, estKnowledge, estBuzzer, confidence]);

  // "You bet $X. Equity-optimal was $Y." for each real Daily Double the
  // selected J-Archive contestant hit. Uses the same table/confidence as
  // the mini chart above (equityTable — shared Optimal-mode table when
  // built on the Explorer, else the lazy fallback), since a real DD's
  // pre-buzz confidence isn't recoverable from J-Archive.
  const ddOptimalWagers = useMemo(() => {
    if (!jarchiveGame || !jarchiveContestant || yourDailyDoubles.length === 0) return null;
    if (!equityTable) return null;
    const seat = jarchiveGame.players.indexOf(jarchiveContestant);
    if (seat < 0) return null;

    const you: EquityWagerYou = { knowledge: estKnowledge, buzzerSpeed: estBuzzer };
    // The game record (when the API response carries one) knows the exact
    // board left after each DD, which lets equityWager's lock guard refuse a
    // table wager that would give away a guaranteed lead. Match the DD to
    // its record step by round + taker + scores-before; fall back to the
    // unguarded lookup when there is no record.
    const steps = jarchiveGame.record?.steps ?? [];
    return yourDailyDoubles.map(dd => {
      const scores = rotateToSeat(dd.allScoresBefore, seat);
      const step = steps.find(st =>
        st.isDD && st.round === dd.round && st.ddPlayer === seat &&
        st.before.length === 3 && st.before.every((v, i) => v === dd.allScoresBefore[i]));
      const lock = step
        ? { remainingClueValues: step.remainingValuesAfter, remainingDDs: step.remainingDDsAfter, round: dd.round }
        : undefined;
      const optimalWager = equityWager(you, scores, dd.cluesRemainingAfter, confidence, equityTable, lock);
      return { dd, optimalWager };
    });
  }, [jarchiveGame, jarchiveContestant, yourDailyDoubles, equityTable, estKnowledge, estBuzzer, confidence]);

  return (
    <div style={{
      background: 'var(--bg-panel)',
      border: '1px solid var(--border)',
      borderRadius: 8,
      overflow: 'hidden',
      maxWidth: 420,
    }}>
      <div style={{
        padding: '16px 20px',
        borderBottom: '1px solid var(--border)',
      }}>
        <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-h)' }}>
          Enter Your Game
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>
          Enter your stats to see where you sit in the strategy space
        </div>
      </div>

      <div style={{ padding: '16px 20px' }}>
        {/* J-Archive import */}
        <div style={{ marginBottom: 16 }}>
          <label style={labelStyle}>Load from J-Archive</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type="text"
              inputMode="numeric"
              value={jarchiveGameId}
              onChange={e => setJarchiveGameId(e.target.value)}
              placeholder="Game ID, e.g. 9501"
              style={{ ...inputStyle, flex: 1 }}
              aria-label="J-Archive game ID"
            />
            <button
              onClick={handleLoadJArchive}
              disabled={jarchiveStatus === 'loading'}
              style={{
                padding: '6px 14px',
                border: '1px solid var(--accent)',
                borderRadius: 4,
                background: 'var(--accent)',
                color: '#fff',
                fontSize: 13,
                fontWeight: 600,
                cursor: jarchiveStatus === 'loading' ? 'default' : 'pointer',
                opacity: jarchiveStatus === 'loading' ? 0.7 : 1,
                whiteSpace: 'nowrap',
              }}
            >
              {jarchiveStatus === 'loading' ? 'Loading…' : 'Load'}
            </button>
          </div>
          {jarchiveError && (
            <div style={hintStyle}>{jarchiveError}</div>
          )}

          {jarchiveGame && (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>
                {jarchiveGame.title || `Game ${jarchiveGame.gameId}`} — which contestant are you?
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {jarchiveGame.contestants.map(c => (
                  <ToggleButton
                    key={c.name}
                    label={c.name}
                    active={jarchiveContestant === c.name}
                    onClick={() => handlePickContestant(c.name)}
                  />
                ))}
              </div>
            </div>
          )}

          {jarchiveGame && jarchiveContestant && (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-h)', marginBottom: 4 }}>
                {jarchiveContestant}'s Daily Doubles
              </div>
              {yourDailyDoubles.length === 0 ? (
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {jarchiveContestant} didn't hit a Daily Double in this game.
                </div>
              ) : !equityTable ? (
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  Build the Optimal (equity) strategy in the Explorer to see this.
                </div>
              ) : (
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: 'var(--text-h)' }}>
                  {ddOptimalWagers?.map(({ dd, optimalWager }, i) => (
                    <li key={i} style={{ marginBottom: 4 }}>
                      {dd.round} round: you bet ${dd.wager.toLocaleString()}. Equity-optimal was ${optimalWager.toLocaleString()}.
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {jarchiveGame && jarchiveContestant && jarchiveGame.record && (
            <div style={{ marginTop: 12 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button
                  onClick={backtestStatus === 'running' ? cancelBacktest : handleBacktest}
                  style={{
                    padding: '6px 14px',
                    border: '1px solid var(--accent)',
                    borderRadius: 4,
                    background: backtestStatus === 'running' ? 'transparent' : 'var(--accent)',
                    color: backtestStatus === 'running' ? 'var(--accent)' : '#fff',
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {backtestStatus === 'running' ? 'Cancel' : backtestStatus === 'done' ? 'Backtest again' : 'Backtest this game'}
                </button>
                {backtestStatus === 'running' && (
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }} role="status">
                    Backtesting… {Math.round(backtestProgress * 100)}%
                  </span>
                )}
              </div>
              {backtestStatus === 'idle' && (
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                  Replays this game with different Daily Double wagers and rolls the rest forward 1,500 times each.
                  {sharedValueTable ? '' : ' Equity wagers use a direct wager search here; build Optimal (equity) in the Explorer to use its table.'}
                </div>
              )}
              {backtestStatus === 'error' && (
                <div style={hintStyle}>Backtest failed: {backtestError}</div>
              )}
              {backtestStatus === 'done' && backtestResult && (
                <BacktestReport result={backtestResult} />
              )}
            </div>
          )}
        </div>

        {/* Core stats */}
        <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
          <NumberInput
            label="Correct"
            value={correct}
            onChange={setCorrect}
            min={0}
            max={60}
          />
          <NumberInput
            label="Wrong"
            value={wrong}
            onChange={setWrong}
            min={0}
            max={30}
          />
          <NumberInput
            label="Coryat (excl. DD/FJ)"
            value={coryat}
            onChange={setCoryat}
            min={-10000}
            max={50000}
            step={200}
          />
        </div>

        {/* Live estimate preview */}
        <div style={{
          display: 'flex',
          gap: 16,
          padding: '10px 12px',
          background: 'var(--bg)',
          borderRadius: 6,
          marginBottom: 16,
          fontSize: 13,
        }}>
          <div>
            <span style={{ color: 'var(--text-muted)' }}>Est. Knowledge: </span>
            <span style={{ fontWeight: 600, color: 'var(--text-h)', fontFamily: 'monospace' }}>
              {Math.round(estKnowledge * 100)}%
            </span>
          </div>
          <div>
            <span style={{ color: 'var(--text-muted)' }}>Est. Buzzer: </span>
            <span style={{ fontWeight: 600, color: 'var(--text-h)', fontFamily: 'monospace' }}>
              {Math.round(estBuzzer * 100)}%
            </span>
          </div>
        </div>

        {/* Advanced: DD and FJ */}
        <button
          onClick={() => setShowAdvanced(!showAdvanced)}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--accent)',
            cursor: 'pointer',
            fontSize: 13,
            padding: 0,
            marginBottom: showAdvanced ? 12 : 0,
          }}
        >
          {showAdvanced ? 'Hide' : 'Show'} DD & FJ details
        </button>

        {showAdvanced && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', gap: 12, marginBottom: 4 }}>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>DD Wager ($)</label>
                <input
                  type="number"
                  value={ddWagerRaw}
                  onChange={e => setDdWagerRaw(e.target.value)}
                  placeholder="e.g. 5000"
                  style={inputStyle}
                />
              </div>
              <div style={{ flex: 1, display: 'flex', alignItems: 'flex-end', gap: 8 }}>
                <ToggleButton
                  label="Correct"
                  active={ddCorrect}
                  onClick={() => setDdCorrect(true)}
                />
                <ToggleButton
                  label="Wrong"
                  active={!ddCorrect}
                  onClick={() => setDdCorrect(false)}
                />
              </div>
            </div>
            {ddWagerParsed.hint && (
              <div style={hintStyle}>{ddWagerParsed.hint}</div>
            )}

            {/* E-7: confidence slider, adjacent to the DD wager field —
                its output drives the equity mini-chart live. */}
            <div style={{ marginTop: 8, marginBottom: 8 }}>
              <label style={{ ...labelStyle, display: 'flex', justifyContent: 'space-between' }}>
                <span>Confidence you'd get it right</span>
                <span style={{ color: 'var(--text-h)', fontWeight: 700 }}>{Math.round(confidence * 100)}%</span>
              </label>
              <input
                type="range"
                min={50}
                max={95}
                value={Math.round(confidence * 100)}
                onChange={e => setConfidence(parseInt(e.target.value, 10) / 100)}
                style={{ width: '100%', accentColor: 'var(--accent)' }}
                aria-label="Confidence you'd get the Daily Double right"
                aria-valuemin={50}
                aria-valuemax={95}
                aria-valuenow={Math.round(confidence * 100)}
                aria-valuetext={`${Math.round(confidence * 100)}%`}
              />
            </div>

            <EquityMiniChart
              curve={equityCurve}
              yourWager={ddWagerParsed.value}
              tableSource={equitySource}
            />

            <div style={{ display: 'flex', gap: 12, marginTop: 12 }}>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>FJ Wager ($)</label>
                <input
                  type="number"
                  value={fjWagerRaw}
                  onChange={e => setFjWagerRaw(e.target.value)}
                  placeholder="e.g. 8000"
                  style={inputStyle}
                />
                {fjWagerParsed.hint && (
                  <div style={hintStyle}>{fjWagerParsed.hint}</div>
                )}
              </div>
              <div style={{ flex: 1, display: 'flex', alignItems: 'flex-end', gap: 8 }}>
                <ToggleButton
                  label="Correct"
                  active={fjCorrect}
                  onClick={() => setFjCorrect(true)}
                />
                <ToggleButton
                  label="Wrong"
                  active={!fjCorrect}
                  onClick={() => setFjCorrect(false)}
                />
              </div>
            </div>
          </div>
        )}

        {/* Submit */}
        <button
          onClick={handleSubmit}
          style={{
            width: '100%',
            padding: '10px 16px',
            background: 'var(--accent)',
            color: '#fff',
            border: 'none',
            borderRadius: 6,
            fontSize: 14,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          {submitted ? 'Update Position' : 'See Where You Sit'}
        </button>

        {/* P-3: the old "Your marker has been placed on the Explorer."
            message rendered here — in the tab the user just left, where
            nobody could see it. Removed; the Explorer now shows the
            pulsing YOU marker plus the journey-bridge link instead. */}

        {/* Quick presets */}
        <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-muted)' }}>
          Quick presets:{' '}
          <PresetButton label="Ben's Game" onClick={() => {
            setCorrect(20); setWrong(2); setCoryat(15600);
            setDdWagerRaw('5000'); setDdCorrect(true);
            setShowAdvanced(true);
          }} />
          {' '}
          <PresetButton label="Average Player" onClick={() => {
            setCorrect(12); setWrong(4); setCoryat(10000);
          }} />
          {' '}
          <PresetButton label="Strong Player" onClick={() => {
            setCorrect(22); setWrong(2); setCoryat(22000);
          }} />
        </div>
      </div>
    </div>
  );
}

// --- Subcomponents ---

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 11,
  color: 'var(--text-muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.3px',
  marginBottom: 4,
};

const hintStyle: React.CSSProperties = {
  fontSize: 11,
  color: '#dc2626',
  marginTop: 4,
};

const CHART_W = 320;
const CHART_H = 160;
const CHART_PAD = { top: 10, right: 10, bottom: 24, left: 40 };

/**
 * E-7 equity mini-chart — ~320×160 SVG, equity vs wager, inside GameAnalyzer's
 * "DD & FJ details" advanced section. Rendered only when a valid DD wager
 * is entered (E-7 item 5/6: "chart never renders from NaN").
 */
function EquityMiniChart({
  curve, yourWager, tableSource,
}: {
  curve: { points: { wager: number; equity: number }[]; optimalWager: number; optimalEquity: number; yourWager: number; yourEquity: number } | null;
  yourWager: number | null;
  tableSource: 'shared' | 'fallback';
}) {
  if (yourWager === null) {
    return (
      <div style={{
        marginTop: 8, padding: '20px 12px', textAlign: 'center',
        fontSize: 12, color: 'var(--text-muted)', background: 'var(--bg)', borderRadius: 6,
      }}>
        Select Optimal (equity) on the Explorer tab or enter a DD wager to see the curve
      </div>
    );
  }

  if (!curve) {
    // Prompt/skeleton state — table not ready yet (shouldn't normally
    // happen since the fallback table builds synchronously, but keeps the
    // UI-states table's "no-table" row honest if that ever changes).
    return (
      <div style={{ marginTop: 8, padding: '20px 12px', textAlign: 'center', fontSize: 12, color: 'var(--text-muted)' }}>
        Computing equity curve...
      </div>
    );
  }

  const { points, optimalWager, optimalEquity, yourEquity } = curve;
  const maxWager = points[points.length - 1]?.wager || 1;
  const minEquity = Math.min(...points.map(p => p.equity), yourEquity, optimalEquity);
  const maxEquity = Math.max(...points.map(p => p.equity), yourEquity, optimalEquity);
  const equitySpan = Math.max(maxEquity - minEquity, 0.001);

  const innerW = CHART_W - CHART_PAD.left - CHART_PAD.right;
  const innerH = CHART_H - CHART_PAD.top - CHART_PAD.bottom;

  const xOf = (w: number) => CHART_PAD.left + (w / maxWager) * innerW;
  const yOf = (eq: number) => CHART_PAD.top + innerH - ((eq - minEquity) / equitySpan) * innerH;

  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xOf(p.wager).toFixed(1)} ${yOf(p.equity).toFixed(1)}`).join(' ');

  const deltaPp = Math.round((optimalEquity - yourEquity) * 1000) / 10;
  const copy = `You bet $${yourWager.toLocaleString()}. Optimal: $${optimalWager.toLocaleString()} (${deltaPp >= 0 ? '+' : ''}${deltaPp}pp equity).`;

  return (
    <div style={{ marginTop: 8 }}>
      <svg
        width={CHART_W}
        height={CHART_H}
        role="img"
        aria-label={`Equity versus wager curve. Your wager: $${yourWager.toLocaleString()}, estimated win equity ${(yourEquity * 100).toFixed(1)}%. Optimal wager: $${optimalWager.toLocaleString()}, estimated win equity ${(optimalEquity * 100).toFixed(1)}%.`}
        style={{ background: 'var(--bg)', borderRadius: 6, border: '1px solid var(--border)' }}
      >
        {/* axes */}
        <line x1={CHART_PAD.left} y1={CHART_PAD.top} x2={CHART_PAD.left} y2={CHART_H - CHART_PAD.bottom} stroke="var(--border)" />
        <line x1={CHART_PAD.left} y1={CHART_H - CHART_PAD.bottom} x2={CHART_W - CHART_PAD.right} y2={CHART_H - CHART_PAD.bottom} stroke="var(--border)" />
        <text x={CHART_PAD.left} y={CHART_H - 6} fontSize={9} fill="var(--text-muted)">$0</text>
        <text x={CHART_W - CHART_PAD.right} y={CHART_H - 6} fontSize={9} fill="var(--text-muted)" textAnchor="end">${maxWager.toLocaleString()}</text>

        {/* equity curve */}
        <path d={pathD} fill="none" stroke="var(--accent, #58a6ff)" strokeWidth={2} />

        {/* optimal marker */}
        <circle cx={xOf(optimalWager)} cy={yOf(optimalEquity)} r={4} fill="#26a641" stroke="#fff" strokeWidth={1} />
        <text x={xOf(optimalWager)} y={yOf(optimalEquity) - 8} fontSize={9} fontWeight={600} fill="#26a641" textAnchor="middle">optimal</text>

        {/* your wager marker */}
        <circle cx={xOf(Math.min(yourWager, maxWager))} cy={yOf(yourEquity)} r={4} fill="#f5d442" stroke="#333" strokeWidth={1} />
        <text x={xOf(Math.min(yourWager, maxWager))} y={CHART_H - CHART_PAD.bottom + 16} fontSize={9} fontWeight={600} fill="var(--text-h)" textAnchor="middle">you</text>
      </svg>
      <div style={{ fontSize: 12, color: 'var(--text-h)', marginTop: 6, fontWeight: 500 }}>
        {copy}
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
        {tableSource === 'shared'
          ? "Using the Explorer's Optimal (equity) strategy table."
          : 'Using a small preview table (generic mid-game scenario, tied opponents) — select Optimal (equity) on the Explorer tab for the validated version.'}
      </div>
    </div>
  );
}

const money = (n: number) => (n < 0 ? `-$${Math.abs(n).toLocaleString()}` : `$${n.toLocaleString()}`);
const percent = (v: number) => `${Math.round(v * 100)}%`;

/** One table cell of the backtest: "$w → 44%", plus the paired delta
 *  against the actual wager for the other arms. */
function BacktestCell({ est, arm }: { est: ArmEstimate | null; arm: BacktestArm }) {
  if (!est) return <td style={backtestCellStyle}><span style={{ color: 'var(--text-muted)' }}>skipped</span></td>;
  const delta = Math.round(est.deltaVsActual * 100);
  const sign = delta > 0 ? '+' : '';
  return (
    <td style={backtestCellStyle}>
      <span style={{ fontFamily: 'monospace' }}>{money(est.wager)}</span>
      <span style={{ color: 'var(--text-muted)' }}> → </span>
      <span style={{ fontWeight: 600 }}>{percent(est.winRate)}</span>
      {arm !== 'actual' && (
        <span style={{ fontSize: 10, color: delta > 0 ? '#26a641' : delta < 0 ? '#dc2626' : 'var(--text-muted)', marginLeft: 4 }}>
          ({sign}{delta})
        </span>
      )}
    </td>
  );
}

const backtestCellStyle: React.CSSProperties = {
  padding: '4px 6px',
  fontSize: 11,
  whiteSpace: 'nowrap',
  borderBottom: '1px solid var(--border)',
  color: 'var(--text-h)',
};

/**
 * "Backtest this game" result: a headline in plain words, one row per
 * Daily Double you hit (wager → win chance per arm), the whole-game line,
 * and the judgment calls that applied.
 */
function BacktestReport({ result }: { result: BacktestResult }) {
  const headline = backtestHeadline(result);
  if (result.rows.length === 0 || !result.summary) {
    return (
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }} data-testid="backtest-headline">
        {headline}
      </div>
    );
  }
  const summary = result.summary;
  const columns: { arm: BacktestArm; label: string }[] = BACKTEST_ARMS.map(arm => ({ arm, label: ARM_LABELS[arm] }));
  const pm = Math.max(1, Math.round((summary.arms.equity?.deltaSe ?? summary.arms.actual?.se ?? 0.01) * 100));
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-h)', marginBottom: 6 }} data-testid="backtest-headline">
        {headline}
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%' }} aria-label="Backtest results by Daily Double">
          <thead>
            <tr>
              <th style={{ ...backtestCellStyle, textAlign: 'left', color: 'var(--text-muted)', fontWeight: 500 }}>Daily Double</th>
              {columns.map(c => (
                <th key={c.arm} style={{ ...backtestCellStyle, textAlign: 'left', color: 'var(--text-muted)', fontWeight: 500 }}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map(row => (
              <tr key={row.stepIndex}>
                <td style={backtestCellStyle}>
                  {row.round === 'J' ? 'Jeopardy' : 'Double Jeopardy'}, {money(row.clueValue)} clue
                  <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                    you had {money(row.scoreBefore)}, {row.cluesRemainingAfter} clues left
                  </div>
                </td>
                {columns.map(c => <BacktestCell key={c.arm} est={row.arms[c.arm]} arm={c.arm} />)}
              </tr>
            ))}
            <tr>
              <td style={{ ...backtestCellStyle, fontWeight: 600 }}>
                Whole game
                <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 400 }}>from {summary.fromLabel}</div>
              </td>
              {columns.map(c => <BacktestCell key={c.arm} est={summary.arms[c.arm]} arm={c.arm} />)}
            </tr>
          </tbody>
        </table>
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>
        Win chance per arm; in parentheses, the change against your actual wager in points (paired rollouts, give or take about {pm}).
      </div>
      <details style={{ marginTop: 6 }}>
        <summary style={{ fontSize: 11, color: 'var(--accent)', cursor: 'pointer' }}>How this was computed</summary>
        <ul style={{ margin: '4px 0 0', paddingLeft: 16, fontSize: 10, color: 'var(--text-muted)' }}>
          {result.notes.map((n, i) => <li key={i} style={{ marginBottom: 2 }}>{n}</li>)}
        </ul>
      </details>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '6px 8px',
  border: '1px solid var(--border)',
  borderRadius: 4,
  background: 'var(--bg)',
  color: 'var(--text-h)',
  fontSize: 14,
  fontFamily: 'monospace',
};

function NumberInput({ label, value, onChange, min, max, step = 1 }: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
}) {
  return (
    <div style={{ flex: 1 }}>
      <label style={labelStyle}>{label}</label>
      <input
        type="number"
        value={value}
        onChange={e => {
          const v = parseInt(e.target.value, 10);
          if (!isNaN(v)) onChange(Math.max(min, Math.min(max, v)));
        }}
        min={min}
        max={max}
        step={step}
        style={inputStyle}
        aria-label={label}
      />
    </div>
  );
}

function ToggleButton({ label, active, onClick }: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '6px 10px',
        border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
        borderRadius: 4,
        background: active ? 'var(--accent)' : 'transparent',
        color: active ? '#fff' : 'var(--text-muted)',
        fontSize: 12,
        cursor: 'pointer',
        fontWeight: active ? 600 : 400,
      }}
    >
      {label}
    </button>
  );
}

function PresetButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: 'none',
        border: 'none',
        color: 'var(--accent)',
        cursor: 'pointer',
        fontSize: 12,
        padding: 0,
        textDecoration: 'underline',
      }}
    >
      {label}
    </button>
  );
}
