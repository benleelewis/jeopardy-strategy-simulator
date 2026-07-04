import { DIMENSIONS, getPinnedDimNames, valueToFraction, fractionToValue, type DimensionName } from '../sim/dimensions';

interface Props {
  xAxis: DimensionName;
  yAxis: DimensionName;
  pinnedValues: Record<string, number>;
  onPinnedChange: (name: string, value: number) => void;
  includeFJ: boolean;
  onFJChange: (v: boolean) => void;
  theme: 'clean' | 'jeopardy';
  onThemeChange: (t: 'clean' | 'jeopardy') => void;
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

export function ControlsPanel({
  xAxis, yAxis,
  pinnedValues, onPinnedChange,
  includeFJ, onFJChange,
  theme, onThemeChange,
}: Props) {
  // Pinned dimensions for the current axis pair (P-1: several dims write
  // the same Player fields, so only the dims that actually apply for these
  // axes are rendered — same source of truth buildSimParams uses).
  const pinnedDims = getPinnedDimNames(xAxis, yAxis)
    .map(name => [name, DIMENSIONS[name]] as const);

  return (
    <div>
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
        return (
          <div key={name} style={sectionStyle}>
            <label style={{ ...labelStyle, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <span>{dim.label}</span>
              <span style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-h)' }}>{dim.format(value)}</span>
            </label>
            <input
              type="range"
              min={0}
              max={1000}
              value={sliderPos}
              onChange={(e) => onPinnedChange(name, fractionToValue(dim, parseInt(e.target.value, 10) / 1000))}
              style={{ width: '100%', accentColor: 'var(--accent)' }}
              aria-label={dim.label}
              aria-valuemin={dim.range[0]}
              aria-valuemax={dim.range[1]}
              aria-valuenow={value}
              aria-valuetext={dim.format(value)}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-muted)', marginTop: 2 }}>
              <span>{dim.format(dim.range[0])}</span>
              <span>{dim.format(dim.range[1])}</span>
            </div>
          </div>
        );
      })}

      <div style={sectionStyle}>
        <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={includeFJ}
            onChange={(e) => onFJChange(e.target.checked)}
          />
          Include Final Jeopardy
        </label>
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
