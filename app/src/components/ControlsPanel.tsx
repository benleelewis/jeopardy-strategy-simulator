import { DIMENSIONS, type DimensionName } from '../sim/dimensions';

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
  // Pinned dimensions = all dimensions that aren't currently axes
  const pinnedDims = Object.entries(DIMENSIONS)
    .filter(([name]) => name !== xAxis && name !== yAxis);

  return (
    <div>
      <div style={{ ...sectionStyle, fontWeight: 600, fontSize: '14px', color: 'var(--text-h)' }}>
        Pinned Dimensions
      </div>

      {pinnedDims.map(([name, dim]) => {
        const value = pinnedValues[name] ?? dim.defaultValue;
        const pct = Math.round(value * 100);
        return (
          <div key={name} style={sectionStyle}>
            <label style={{ ...labelStyle, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <span>{dim.label}</span>
              <span style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-h)' }}>{pct}%</span>
            </label>
            <input
              type="range"
              min={dim.range[0] * 100}
              max={dim.range[1] * 100}
              value={value * 100}
              onChange={(e) => onPinnedChange(name, parseInt(e.target.value) / 100)}
              style={{ width: '100%', accentColor: 'var(--accent)' }}
              aria-label={dim.label}
              aria-valuemin={dim.range[0] * 100}
              aria-valuemax={dim.range[1] * 100}
              aria-valuenow={pct}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-muted)', marginTop: 2 }}>
              <span>{Math.round(dim.range[0] * 100)}%</span>
              <span>{Math.round(dim.range[1] * 100)}%</span>
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
