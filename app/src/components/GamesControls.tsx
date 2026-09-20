import { DIMENSIONS, getPinnedDimNames, valueToFraction, fractionToValue, type DimensionName } from '../sim/dimensions';
import type { DDStrategy } from '../sim/sim-engine';
import type { ColorMode } from './gain';

const STRATEGY_LABELS: Record<DDStrategy, string> = {
  off: 'Off',
  conservative: 'Conservative',
  aggressive: 'Aggressive',
  truedd: 'True DD',
  equity: 'Optimal (equity)',
};

interface Props {
  position: { x: number; y: number };
  onPositionChange: (pos: { x: number; y: number }) => void;
  xAxis: DimensionName;
  yAxis: DimensionName;
  pinnedValues: Record<string, number>;
  onPinnedChange: (name: string, value: number) => void;
  includeFJ: boolean;
  onFJChange: (v: boolean) => void;
  /** E-7: single source of truth lives in App.tsx / ControlsPanel — this
   *  tab only REFLECTS the current selection, it doesn't duplicate the
   *  control. */
  ddStrategy: DDStrategy;
  /** While Optimal is active, the FJ checkbox is a cache-key knob shared
   *  with ControlsPanel's lock treatment (same field, same cache key). */
  equityActive: boolean;
  /** All Games colour mode (TODOS "P2 — All Games optimal-vs-actual delta
   *  coloring"). Default 'winRate'; the control only renders when a
   *  change handler is supplied. */
  colorMode?: ColorMode;
  onColorModeChange?: (mode: ColorMode) => void;
}

const COLOR_MODE_OPTIONS: { value: ColorMode; label: string; title: string }[] = [
  { value: 'winRate', label: 'Win rate', title: 'Color each game by your simulated win rate' },
  {
    value: 'gain',
    label: 'Gain from optimal play',
    title: 'Color each game by how much optimal wagering and Daily Double seeking would change your win rate',
  },
];

export function GamesControls({
  position, onPositionChange, xAxis, yAxis,
  pinnedValues, onPinnedChange, includeFJ, onFJChange,
  ddStrategy, equityActive,
  colorMode = 'winRate', onColorModeChange,
}: Props) {
  // The dims a player can tune here: the two Explorer axes plus whatever
  // pinned dims apply for that axis pair (P-1) — minus environment dims
  // (opponent strength is not a "your player" knob on this tab, matching
  // the pre-P-1 behavior of the fixed knowledge/buzzer/DD list).
  const dims: DimensionName[] = [xAxis, yAxis, ...getPinnedDimNames(xAxis, yAxis)]
    .filter(d => DIMENSIONS[d].type !== 'environment');

  /** Real dimension value (dollars, fraction, ...) for display + format(). */
  const getValue = (dim: DimensionName): number => {
    if (dim === xAxis) return fractionToValue(DIMENSIONS[dim], position.x);
    if (dim === yAxis) return fractionToValue(DIMENSIONS[dim], position.y);
    return pinnedValues[dim] ?? DIMENSIONS[dim].defaultValue;
  };

  /** Sliders run on a normalized 0–1 fraction so any range works. */
  const setFraction = (dim: DimensionName, frac: number) => {
    if (dim === xAxis) {
      onPositionChange({ ...position, x: frac });
    } else if (dim === yAxis) {
      onPositionChange({ ...position, y: frac });
    } else {
      onPinnedChange(dim, fractionToValue(DIMENSIONS[dim], frac));
    }
  };

  return (
    <div className="games-controls">
      {dims.map(dim => {
        const d = DIMENSIONS[dim];
        const val = getValue(dim);
        const sliderPos = Math.round(valueToFraction(d, val) * 1000);
        return (
          <label key={dim} className="gc-slider">
            <span className="gc-label">{d.label.split('(')[0].trim()}</span>
            <input
              type="range"
              min={0}
              max={1000}
              value={sliderPos}
              onChange={e => setFraction(dim, parseInt(e.target.value, 10) / 1000)}
              aria-label={d.label}
              aria-valuetext={d.format(val)}
            />
            {/* Value speaks the dimension's own units (P-1) — a Coryat
                dollars dim must never render as a percent. */}
            <span className="gc-value">{d.format(val)}</span>
          </label>
        );
      })}
      <label
        className="gc-checkbox"
        style={equityActive ? { opacity: 0.4, cursor: 'default' } : undefined}
        title={equityActive ? 'Locked while Optimal is active — changing this rebuilds the strategy table (~5s)' : undefined}
      >
        <input
          type="checkbox"
          checked={includeFJ}
          disabled={equityActive}
          aria-disabled={equityActive}
          onChange={e => onFJChange(e.target.checked)}
        />
        <span>{equityActive && <span aria-hidden="true">🔒 </span>}Include FJ</span>
      </label>
      {onColorModeChange && (
        <div className="gc-color-mode" role="group" aria-label="Color mode">
          <span className="gc-label">Color</span>
          {COLOR_MODE_OPTIONS.map(opt => (
            <button
              key={opt.value}
              type="button"
              className={`gc-mode-btn ${colorMode === opt.value ? 'gc-mode-active' : ''}`}
              aria-pressed={colorMode === opt.value}
              title={opt.title}
              onClick={() => onColorModeChange(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
      {/* E-7: read-only reflection of the DD Strategy selector (ControlsPanel
          is the editable single source, on the Explorer tab). */}
      <span className="gc-strategy-badge" title="Change on the Explorer tab">
        DD Strategy: <strong>{STRATEGY_LABELS[ddStrategy]}</strong>
      </span>
    </div>
  );
}
