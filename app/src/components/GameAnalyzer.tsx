/**
 * Game Analyzer — Screen 1 from the design doc.
 *
 * Manual entry of game scores to estimate player position.
 * Computes knowledge and buzzer estimates from correct/wrong counts.
 * Shows DD wager analysis and places user on the strategy space.
 *
 * J-Archive URL fetch deferred to V2 (requires CORS proxy).
 */

import { useState, useCallback } from 'react';

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
}

export function GameAnalyzer({ onEstimate }: Props) {
  const [correct, setCorrect] = useState(18);
  const [wrong, setWrong] = useState(3);
  const [coryat, setCoryat] = useState(16000);
  const [ddWager, setDdWager] = useState<string>('');
  const [ddCorrect, setDdCorrect] = useState(true);
  const [fjWager, setFjWager] = useState<string>('');
  const [fjCorrect, setFjCorrect] = useState(true);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [submitted, setSubmitted] = useState(false);

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

    if (ddWager) {
      estimate.ddWager = parseInt(ddWager, 10);
      estimate.ddCorrect = ddCorrect;
    }
    if (fjWager) {
      estimate.fjWager = parseInt(fjWager, 10);
      estimate.fjCorrect = fjCorrect;
    }

    onEstimate(estimate);
    setSubmitted(true);
  }, [correct, wrong, coryat, ddWager, ddCorrect, fjWager, fjCorrect, onEstimate]);

  // Pre-computed estimates for display
  const estKnowledge = correct / (correct + wrong + 1);
  const estBuzzer = Math.min((correct + wrong) / 60, 0.95);

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
            <div style={{ display: 'flex', gap: 12, marginBottom: 8 }}>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>DD Wager ($)</label>
                <input
                  type="number"
                  value={ddWager}
                  onChange={e => setDdWager(e.target.value)}
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
            <div style={{ display: 'flex', gap: 12 }}>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>FJ Wager ($)</label>
                <input
                  type="number"
                  value={fjWager}
                  onChange={e => setFjWager(e.target.value)}
                  placeholder="e.g. 8000"
                  style={inputStyle}
                />
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
            setDdWager('5000'); setDdCorrect(true);
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
