import { DIMENSIONS, type DimensionName } from '../sim/dimensions';

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

const PLAYER_DIMS: DimensionName[] = ['knowledge', 'buzzerSpeed', 'ddAggression'];

export function GamesControls({
  position, onPositionChange, xAxis, yAxis,
  pinnedValues, onPinnedChange, includeFJ, onFJChange,
}: Props) {
  const getValue = (dim: DimensionName): number => {
    if (dim === xAxis) return position.x;
    if (dim === yAxis) return position.y;
    return pinnedValues[dim] ?? DIMENSIONS[dim].defaultValue;
  };

  const setValue = (dim: DimensionName, v: number) => {
    if (dim === xAxis) {
      onPositionChange({ ...position, x: v });
    } else if (dim === yAxis) {
      onPositionChange({ ...position, y: v });
    } else {
      onPinnedChange(dim, v);
    }
  };

  return (
    <div className="games-controls">
      {PLAYER_DIMS.map(dim => {
        const d = DIMENSIONS[dim];
        const val = getValue(dim);
        const pct = Math.round(val * 100);
        return (
          <label key={dim} className="gc-slider">
            <span className="gc-label">{d.label.split('(')[0].trim()}</span>
            <input
              type="range"
              min={0}
              max={100}
              value={pct}
              onChange={e => setValue(dim, parseInt(e.target.value, 10) / 100)}
            />
            <span className="gc-value">{pct}%</span>
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
