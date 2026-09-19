import { useState } from 'react';
import {
  DIMENSIONS, getPinnedDimNames, valueToFraction, fractionToValue,
  REFINED_GAMES_PER_CELL, type DimensionName, type RefinedSpeed,
} from '../sim/dimensions';
import type { DDStrategy } from '../sim/sim-engine';

export type EquityBuildStatus = 'idle' | 'building' | 'ready' | 'failed';

const SPEED_OPTIONS: { value: RefinedSpeed; label: string }[] = [
  { value: 'fast', label: 'Fast' },
  { value: 'normal', label: 'Normal' },
  { value: 'precise', label: 'Precise' },
];

interface Props {
  xAxis: DimensionName;
  yAxis: DimensionName;
  pinnedValues: Record<string, number>;
  onPinnedChange: (name: string, value: number) => void;
  includeFJ: boolean;
  onFJChange: (v: boolean) => void;
  theme: 'clean' | 'jeopardy';
  onThemeChange: (t: 'clean' | 'jeopardy') => void;
  ddStrategy: DDStrategy;
  onDdStrategyChange: (s: DDStrategy) => void;
  equityBuildStatus: EquityBuildStatus;
  equityBuildProgress: number;
  onCancelEquityBuild: () => void;
  refinedSpeed: RefinedSpeed;
  onRefinedSpeedChange: (s: RefinedSpeed) => void;
  /** P2 "DD impact difference map overlay" (TODOS.md). Off by default. */
  showDDImpact: boolean;
  onShowDDImpactChange: (v: boolean) => void;
  /** P2 "DD seeking / square-selection strategy" (TODOS.md). Your (player 0)
   *  square-selection strategy — Tesauro 2012's p_DD + 0.1·p_RC Daily
   *  Double seeking. Off (top-down) by default. */
  seekDD: boolean;
  onSeekDDChange: (v: boolean) => void;
  /** Opponents' square-selection strategy. Off by default — mirroring your
   *  choice would silently make "you seek DDs" mean "everyone seeks DDs". */
  opponentSeekDD: boolean;
  onOpponentSeekDDChange: (v: boolean) => void;
  /** Task 3: gates whether DD accuracy is scaled by the difficulty-by-row
   *  multiplier (checked/on = today's behavior, the default). */
  ddDifficultyScaling: boolean;
  onDdDifficultyScalingChange: (v: boolean) => void;
}

const sectionStyle: React.CSSProperties = {
  padding: '16px 20px',
  borderBottom: '1px solid var(--border)',
};

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: '12px',
  fontWeight: 600,
  color: 'var(--text-h)',
  marginBottom: 8,
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
};

/** E-7 cache-key knobs (E-2's spec) that live in ControlsPanel's Pinned
 *  Dimensions list and get locked while Optimal (equity) is active. Your
 *  own skill dims (knowledge/buzzerSpeed/precision/...) are NOT here — the
 *  V-table already sweeps your skill as table dimensions, never a cache
 *  key, so those stay fully interactive. */
const LOCKED_WHILE_EQUITY = new Set<string>(['opponentStrength', 'ddAggression']);

const STRATEGY_OPTIONS: { value: DDStrategy; label: string }[] = [
  { value: 'conservative', label: 'Conservative' },
  { value: 'aggressive', label: 'Aggressive' },
  { value: 'truedd', label: 'True DD' },
  { value: 'equity', label: 'Optimal (equity)' },
];

export function ControlsPanel({
  xAxis, yAxis,
  pinnedValues, onPinnedChange,
  includeFJ, onFJChange,
  theme, onThemeChange,
  ddStrategy, onDdStrategyChange,
  equityBuildStatus, equityBuildProgress, onCancelEquityBuild,
  refinedSpeed, onRefinedSpeedChange,
  showDDImpact, onShowDDImpactChange,
  seekDD, onSeekDDChange,
  opponentSeekDD, onOpponentSeekDDChange,
  ddDifficultyScaling, onDdDifficultyScalingChange,
}: Props) {
  // Pinned dimensions for the current axis pair (P-1: several dims write
  // the same Player fields, so only the dims that actually apply for these
  // axes are rendered — same source of truth buildSimParams uses).
  const pinnedDims = getPinnedDimNames(xAxis, yAxis)
    .map(name => [name, DIMENSIONS[name]] as const);

  const equityActive = ddStrategy === 'equity';

  // E-7 knob pinning: which locked knobs the user has explicitly clicked
  // "Unlock & rebuild" on, for THIS equity session. Reset whenever Optimal
  // is deselected, so re-selecting it starts locked again.
  const [manuallyUnlocked, setManuallyUnlocked] = useState<Set<string>>(new Set());
  const [unlockPromptFor, setUnlockPromptFor] = useState<string | null>(null);

  // Reset the per-session unlock state whenever Optimal is (re)selected —
  // adjusted during render (React's documented pattern for "reset state
  // when a prop changes") rather than in an effect, so re-selecting
  // Optimal always starts locked again without a cascading-render effect.
  const [prevEquityActive, setPrevEquityActive] = useState(equityActive);
  if (equityActive !== prevEquityActive) {
    setPrevEquityActive(equityActive);
    if (!equityActive) {
      setManuallyUnlocked(new Set());
      setUnlockPromptFor(null);
    }
  }

  const unlock = (name: string) => {
    setManuallyUnlocked(prev => new Set(prev).add(name));
    setUnlockPromptFor(null);
  };

  return (
    <div>
      <div style={{ ...sectionStyle, fontWeight: 600, fontSize: '14px', color: 'var(--text-h)' }}>
        DD Strategy
      </div>
      <div style={sectionStyle}>
        <DDStrategySelector
          value={ddStrategy}
          onChange={onDdStrategyChange}
          buildStatus={equityBuildStatus}
          buildProgress={equityBuildProgress}
          onCancel={onCancelEquityBuild}
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, cursor: 'pointer', fontSize: '13px', color: 'var(--text)' }}>
          <input
            type="checkbox"
            checked={showDDImpact}
            onChange={(e) => onShowDDImpactChange(e.target.checked)}
          />
          Show DD impact
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, cursor: 'pointer', fontSize: '13px', color: 'var(--text)' }}>
          <input
            type="checkbox"
            checked={seekDD}
            onChange={(e) => onSeekDDChange(e.target.checked)}
          />
          Seek Daily Doubles
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, cursor: 'pointer', fontSize: '13px', color: 'var(--text)' }}>
          <input
            type="checkbox"
            checked={opponentSeekDD}
            onChange={(e) => onOpponentSeekDDChange(e.target.checked)}
          />
          Opponents seek too
        </label>
      </div>

      <div style={{ ...sectionStyle, fontWeight: 600, fontSize: '14px', color: 'var(--text-h)' }}>
        Pinned Dimensions
      </div>

      {pinnedDims.map(([name, dim]) => {
        // pinnedValues store REAL dimension values (dollars for a Coryat
        // dim, fractions for [0,1] dims); the slider itself runs on a
        // normalized 0–1000 track so any range works, and all display
        // goes through dim.format() — never a hardcoded percent.
        const value = pinnedValues[name] ?? dim.defaultValue;
        const sliderPos = Math.round(valueToFraction(dim, value) * 1000);
        const locked = equityActive && LOCKED_WHILE_EQUITY.has(name) && !manuallyUnlocked.has(name);
        return (
          <div key={name} style={sectionStyle}>
            <label style={{ ...labelStyle, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <span>{locked && <span aria-hidden="true">🔒 </span>}{dim.label}</span>
              <span style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-h)' }}>{dim.format(value)}</span>
            </label>
            <div style={{ position: 'relative', opacity: locked ? 0.4 : 1 }}>
              <input
                type="range"
                min={0}
                max={1000}
                value={sliderPos}
                disabled={locked}
                aria-disabled={locked}
                onChange={(e) => onPinnedChange(name, fractionToValue(dim, parseInt(e.target.value, 10) / 1000))}
                style={{ width: '100%', accentColor: 'var(--accent)' }}
                aria-label={dim.label}
                aria-valuemin={dim.range[0]}
                aria-valuemax={dim.range[1]}
                aria-valuenow={value}
                aria-valuetext={dim.format(value)}
              />
              {locked && (
                // Transparent overlay: the underlying <input> is genuinely
                // disabled (a11y requirement + the "input actually
                // disabled" test), so it won't receive click/pointer
                // events to reveal the explanation — this catches them.
                <div
                  role="button"
                  tabIndex={0}
                  aria-label={`${dim.label} is locked while Optimal is active`}
                  onClick={() => setUnlockPromptFor(name)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setUnlockPromptFor(name); } }}
                  style={{ position: 'absolute', inset: 0, cursor: 'pointer' }}
                />
              )}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-muted)', marginTop: 2 }}>
              <span>{dim.format(dim.range[0])}</span>
              <span>{dim.format(dim.range[1])}</span>
            </div>
            {locked && unlockPromptFor === name && (
              <LockExplanation onUnlock={() => unlock(name)} />
            )}
          </div>
        );
      })}

      <div style={sectionStyle}>
        {(() => {
          const fjLocked = equityActive && !manuallyUnlocked.has('includeFJ');
          return (
            <>
              <label
                style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', opacity: fjLocked ? 0.4 : 1 }}
                onClick={(e) => {
                  if (fjLocked) {
                    e.preventDefault();
                    setUnlockPromptFor('includeFJ');
                  }
                }}
              >
                <input
                  type="checkbox"
                  checked={includeFJ}
                  disabled={fjLocked}
                  aria-disabled={fjLocked}
                  onChange={(e) => onFJChange(e.target.checked)}
                />
                {fjLocked && <span aria-hidden="true">🔒 </span>}
                Include Final Jeopardy
              </label>
              {fjLocked && unlockPromptFor === 'includeFJ' && (
                <LockExplanation onUnlock={() => unlock('includeFJ')} />
              )}
            </>
          );
        })()}
      </div>

      <div style={sectionStyle}>
        <label style={labelStyle}>Speed vs Accuracy</label>
        <div style={{ display: 'flex', gap: 8 }} role="group" aria-label="Speed vs Accuracy">
          {SPEED_OPTIONS.map(opt => {
            const isSelected = opt.value === refinedSpeed;
            return (
              <button
                key={opt.value}
                onClick={() => onRefinedSpeedChange(opt.value)}
                aria-pressed={isSelected}
                style={{
                  flex: 1,
                  minHeight: 44,
                  padding: '8px',
                  border: `2px solid ${isSelected ? 'var(--accent)' : 'var(--border)'}`,
                  borderRadius: 6,
                  background: isSelected ? 'var(--accent)' : 'transparent',
                  color: isSelected ? '#fff' : 'var(--text)',
                  cursor: 'pointer',
                  fontSize: '13px',
                }}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: 6 }}>
          {REFINED_GAMES_PER_CELL[refinedSpeed].toLocaleString()} games/cell on the refined pass
        </div>
      </div>

      <div style={{ ...sectionStyle, fontWeight: 600, fontSize: '14px', color: 'var(--text-h)' }}>
        Advanced
      </div>
      <div style={sectionStyle}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: '13px', color: 'var(--text)' }}>
          <input
            type="checkbox"
            checked={ddDifficultyScaling}
            onChange={(e) => onDdDifficultyScalingChange(e.target.checked)}
          />
          Scale DD accuracy by row
        </label>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: 6 }}>
          On (default): a bottom-row Daily Double is answered at reduced accuracy, like any
          other clue at that value. Off: Daily Double accuracy is your flat base precision
          (Tesauro 2012's model).
        </div>
      </div>

      <div style={sectionStyle}>
        <label style={labelStyle}>Theme</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={() => onThemeChange('clean')}
            style={{
              flex: 1,
              padding: '8px',
              border: `2px solid ${theme === 'clean' ? 'var(--accent)' : 'var(--border)'}`,
              borderRadius: 6,
              background: theme === 'clean' ? 'var(--accent)' : 'transparent',
              color: theme === 'clean' ? '#fff' : 'var(--text)',
              cursor: 'pointer',
              fontSize: '13px',
            }}
          >
            Clean
          </button>
          <button
            onClick={() => onThemeChange('jeopardy')}
            style={{
              flex: 1,
              padding: '8px',
              border: `2px solid ${theme === 'jeopardy' ? '#d4af37' : 'var(--border)'}`,
              borderRadius: 6,
              background: theme === 'jeopardy' ? '#060ce9' : 'transparent',
              color: theme === 'jeopardy' ? '#d4af37' : 'var(--text)',
              cursor: 'pointer',
              fontSize: '13px',
            }}
          >
            Jeopardy!
          </button>
        </div>
      </div>
    </div>
  );
}

/** Shared inline explanation + "Unlock & rebuild" action for a locked
 *  cache-key knob (E-7's knob-pinning spec). */
function LockExplanation({ onUnlock }: { onUnlock: () => void }) {
  return (
    <div style={{
      marginTop: 8,
      padding: '8px 10px',
      background: 'var(--bg)',
      border: '1px solid var(--border)',
      borderRadius: 6,
      fontSize: 11,
      color: 'var(--text-muted)',
    }}>
      Locked while Optimal is active — changing this rebuilds the strategy table (~5s).
      <button
        onClick={onUnlock}
        style={{
          display: 'block',
          marginTop: 6,
          background: 'none',
          border: '1px solid var(--accent)',
          color: 'var(--accent)',
          borderRadius: 4,
          padding: '5px 10px',
          cursor: 'pointer',
          fontSize: 11,
          fontWeight: 600,
          minHeight: 28,
        }}
      >
        Unlock &amp; rebuild
      </button>
    </div>
  );
}

/** E-7 DD Strategy segmented control — role="radiogroup", arrow-key nav,
 *  ≥44px touch targets, labels always visible (never placeholder-only). */
function DDStrategySelector({
  value, onChange, buildStatus, buildProgress, onCancel,
}: {
  value: DDStrategy;
  onChange: (s: DDStrategy) => void;
  buildStatus: EquityBuildStatus;
  buildProgress: number;
  onCancel: () => void;
}) {
  const selectedIdx = STRATEGY_OPTIONS.findIndex(o => o.value === value);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    let dir = 0;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') dir = 1;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') dir = -1;
    else return;
    e.preventDefault();
    const nextIdx = (selectedIdx + dir + STRATEGY_OPTIONS.length) % STRATEGY_OPTIONS.length;
    const next = STRATEGY_OPTIONS[nextIdx];
    onChange(next.value);
    // Roving tabindex: move focus to the newly-selected radio.
    requestAnimationFrame(() => {
      document.getElementById(`dd-strategy-opt-${next.value}`)?.focus();
    });
  };

  return (
    <div>
      <div
        role="radiogroup"
        aria-label="DD Strategy"
        onKeyDown={handleKeyDown}
        style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}
      >
        {STRATEGY_OPTIONS.map(opt => {
          const isSelected = opt.value === value;
          const isBuilding = opt.value === 'equity' && buildStatus === 'building';
          return (
            <button
              key={opt.value}
              id={`dd-strategy-opt-${opt.value}`}
              role="radio"
              aria-checked={isSelected}
              tabIndex={isSelected ? 0 : -1}
              onClick={() => onChange(opt.value)}
              style={{
                minHeight: 44,
                minWidth: 44,
                padding: '6px 10px',
                border: `1px solid ${isSelected ? 'var(--accent)' : 'var(--border)'}`,
                borderRadius: 6,
                background: isSelected ? 'var(--accent)' : 'transparent',
                color: isSelected ? '#fff' : 'var(--text)',
                fontSize: 12,
                fontWeight: isSelected ? 600 : 500,
                cursor: 'pointer',
                flex: '1 1 auto',
                lineHeight: 1.3,
              }}
            >
              {opt.label}
              {isBuilding && (
                <div style={{ fontSize: 10, opacity: 0.9, marginTop: 2 }}>
                  building… ▓▓░ {Math.round(buildProgress * 100)}%
                </div>
              )}
            </button>
          );
        })}
      </div>

      {value === 'equity' && buildStatus === 'building' && (
        <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ flex: 1, height: 6, background: 'var(--border)', borderRadius: 3, overflow: 'hidden' }}>
            <div
              style={{
                width: `${Math.round(buildProgress * 100)}%`,
                height: '100%',
                background: 'var(--accent)',
                transition: 'width 0.2s ease',
              }}
            />
          </div>
          <button
            onClick={onCancel}
            style={{
              minHeight: 28,
              fontSize: 11,
              background: 'none',
              border: '1px solid var(--border)',
              borderRadius: 4,
              padding: '4px 10px',
              color: 'var(--text-muted)',
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
        </div>
      )}

      {buildStatus === 'failed' && (
        <div style={{ marginTop: 8, fontSize: 11, color: '#dc2626', fontWeight: 500 }}>
          Optimal unavailable — using Aggressive
        </div>
      )}
    </div>
  );
}
