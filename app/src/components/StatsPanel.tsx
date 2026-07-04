import { DIMENSIONS, fractionToValue, type DimensionName } from '../sim/dimensions';

interface Props {
  position: { x: number; y: number };
  winRate: number | null;
  xAxis: DimensionName;
  yAxis: DimensionName;
}

const sectionStyle: React.CSSProperties = {
  padding: '16px 20px',
  borderBottom: '1px solid var(--border)',
};

export function StatsPanel({ position, winRate, xAxis, yAxis }: Props) {
  // Win rate is always a percentage regardless of which axes are active.
  const pct = (v: number) => `${Math.round(v * 100)}%`;

  const xDim = DIMENSIONS[xAxis];
  const yDim = DIMENSIONS[yAxis];

  // Position values speak each dimension's own units via format() —
  // P-1's load-bearing fix: a dollars axis (expectedCoryat) must never
  // render through the percent formatter above.
  const xDisplay = xDim.format(fractionToValue(xDim, position.x));
  const yDisplay = yDim.format(fractionToValue(yDim, position.y));

  // Bottleneck logic only applies to Knowledge × Buzzer axes
  const showBottleneck = xAxis === 'knowledge' && yAxis === 'buzzerSpeed';
  let bottleneck = '';
  if (showBottleneck) {
    const kLow = position.x < 0.5;
    const bLow = position.y < 0.5;
    if (kLow && !bLow) bottleneck = 'Knowledge is your bottleneck';
    else if (!kLow && bLow) bottleneck = 'Buzzer speed is your bottleneck';
    else if (kLow && bLow) bottleneck = 'Both need improvement';
    else bottleneck = 'Balanced';
  }

  return (
    <div>
      <div style={{ ...sectionStyle, fontWeight: 600, fontSize: '14px', color: 'var(--text-h)' }}>
        Your Position
      </div>

      <div style={sectionStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              {xDim.label}
            </div>
            <div style={{ fontSize: '24px', fontWeight: 700, color: 'var(--text-h)' }}>{xDisplay}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              {yDim.label}
            </div>
            <div style={{ fontSize: '24px', fontWeight: 700, color: 'var(--text-h)' }}>{yDisplay}</div>
          </div>
        </div>

        <div style={{
          textAlign: 'center',
          padding: '12px',
          background: 'var(--bg)',
          borderRadius: 8,
          marginBottom: 8,
        }}>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Win Rate
          </div>
          <div style={{
            fontSize: '36px',
            fontWeight: 800,
            color: winRate === null ? 'var(--text-muted)'
              : winRate > 0.5 ? '#16a34a'
              : winRate > 0.33 ? '#eab308'
              : '#dc2626',
          }}>
            {winRate === null ? '...' : pct(winRate)}
          </div>
        </div>

        {showBottleneck && (
          <div style={{ fontSize: '13px', color: 'var(--text-muted)', textAlign: 'center' }}>
            {bottleneck}
          </div>
        )}
      </div>
    </div>
  );
}
