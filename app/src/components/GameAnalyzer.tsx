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

import { useState, useCallback, useMemo } from 'react';
import {
  queryV, equityWager, buildValueTable,
  type ValueTable, type EquityWagerYou,
} from '../sim/value-function';
import { DEFAULT_CONFIG, mulberry32 } from '../sim/sim-engine';
import { OPPONENT_PROFILES } from '../sim/opponent-models';

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

interface Props {
  onEstimate: (estimate: GameEstimate) => void;
  /** App's cached V-table (E-2), when Optimal (equity) has been built on
   *  the Explorer tab — the equity mini-chart reuses it instead of
   *  building its own when present (E-7 item 5's documented choice). */
  sharedValueTable?: ValueTable;
}

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

export function GameAnalyzer({ onEstimate, sharedValueTable }: Props) {
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

  const ddWagerParsed = parseWagerInput(ddWagerRaw);
  const fjWagerParsed = parseWagerInput(fjWagerRaw);

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
