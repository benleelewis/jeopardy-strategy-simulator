import { DIMENSIONS, getPinnedDimNames, valueToFraction, fractionToValue, type DimensionName } from '../sim/dimensions';

interface Props {
  position: { x: number; y: number };
  onPositionChange: (pos: { x: number; y: number }) => void;
  xAxis: DimensionName;
  yAxis: DimensionName;
  pinnedValues: Record<string, number>;
  onPinnedChange: (name: string, value: number) => void;
  includeFJ: boolean;
  onFJChange: (v: boolean) => void;
}

export function GamesControls({
  position, onPositionChange, xAxis, yAxis,
  pinnedValues, onPinnedChange, includeFJ, onFJChange,
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
      <label className="gc-checkbox">
        <input
          type="checkbox"
          checked={includeFJ}
          onChange={e => onFJChange(e.target.checked)}
        />
        <span>Include FJ</span>
      </label>
    </div>
  );
}
