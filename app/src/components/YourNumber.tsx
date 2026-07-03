/**
 * "Your Number" — the headline from Screen 1.5.
 *
 * "If you played every game of Jeopardy ever aired, how many would you win?"
 * Shows overall win rate, win streak, and a histogram of per-game win rates.
 */

import { useMemo, useRef, useEffect } from 'react';

interface Props {
  winRates: number[];
  isSimulating: boolean;
}

export function YourNumber({ winRates, isSimulating }: Props) {
  const stats = useMemo(() => {
    if (winRates.length === 0) return null;

    const overall = winRates.reduce((a, b) => a + b, 0) / winRates.length;

    // Win streak: longest consecutive wins (win = winRate > 0.5 for that game)
    let maxStreak = 0;
    let currentStreak = 0;
    for (const wr of winRates) {
      if (wr > 0.5) {
        currentStreak++;
        maxStreak = Math.max(maxStreak, currentStreak);
      } else {
        currentStreak = 0;
      }
    }

    // Games won / lost / toss-up
    const won = winRates.filter(wr => wr > 0.5).length;
    const lost = winRates.filter(wr => wr < 0.3).length;
    const tossUp = winRates.length - won - lost;

    // Histogram bins (0-10%, 10-20%, ..., 90-100%)
    const bins = new Array(10).fill(0);
    for (const wr of winRates) {
      const bin = Math.min(9, Math.floor(wr * 10));
      bins[bin]++;
    }
    const maxBin = Math.max(...bins);

    return { overall, maxStreak, won, lost, tossUp, bins, maxBin, total: winRates.length };
  }, [winRates]);

  if (!stats) {
    return (
      <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)' }}>
        {isSimulating ? 'Simulating...' : 'No data yet'}
      </div>
    );
  }

  return (
    <div style={{ marginBottom: 24 }}>
      {/* Headline number */}
      <div style={{
        textAlign: 'center',
        padding: '20px 16px 12px',
        background: 'var(--bg-panel)',
        borderRadius: 8,
        border: '1px solid var(--border)',
        marginBottom: 16,
      }}>
        <div style={{
          fontSize: 13,
          color: 'var(--text-muted)',
          marginBottom: 4,
          lineHeight: 1.4,
        }}>
          If you played every game of Jeopardy ever aired...
        </div>
        <div style={{
          fontSize: 48,
          fontWeight: 800,
          color: stats.overall > 0.5 ? '#16a34a'
            : stats.overall > 0.33 ? '#eab308'
            : '#dc2626',
          lineHeight: 1.1,
        }}>
          {Math.round(stats.overall * 100)}%
        </div>
        <div style={{
          fontSize: 14,
          color: 'var(--text-muted)',
          marginTop: 4,
        }}>
          win rate across {stats.total.toLocaleString()} games
          {isSimulating && <span style={{ color: '#26a641' }}> (refining...)</span>}
        </div>
      </div>

      {/* Quick stats row */}
      <div style={{
        display: 'flex',
        gap: 8,
        marginBottom: 16,
      }}>
        <StatBox label="Favored" value={stats.won.toLocaleString()} sublabel="games >50%" color="#16a34a" />
        <StatBox label="Toss-up" value={stats.tossUp.toLocaleString()} sublabel="games 30-50%" color="#eab308" />
        <StatBox label="Underdog" value={stats.lost.toLocaleString()} sublabel="games <30%" color="#dc2626" />
        <StatBox label="Best Streak" value={String(stats.maxStreak)} sublabel="consecutive" color="var(--accent, #58a6ff)" />
      </div>

      {/* Histogram */}
      <Histogram bins={stats.bins} maxBin={stats.maxBin} />
    </div>
  );
}

function StatBox({ label, value, sublabel, color }: {
  label: string;
  value: string;
  sublabel: string;
  color: string;
}) {
  return (
    <div style={{
      flex: 1,
      padding: '10px 8px',
      background: 'var(--bg-panel)',
      borderRadius: 6,
      border: '1px solid var(--border)',
      textAlign: 'center',
    }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.3px' }}>
        {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 700, color, lineHeight: 1.3 }}>
        {value}
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
        {sublabel}
      </div>
    </div>
  );
}

function Histogram({ bins, maxBin }: { bins: number[]; maxBin: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const W = 320;
    const H = 80;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    ctx.scale(dpr, dpr);

    const computed = getComputedStyle(canvas);
    const bg = computed.getPropertyValue('--bg').trim() || '#0d1117';
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    const barWidth = (W - 20) / bins.length;
    const barGap = 2;
    const maxH = H - 20;

    const colors = [
      '#161b22', '#0e4429', '#0e4429', '#006d32', '#006d32',
      '#26a641', '#26a641', '#39d353', '#39d353', '#39d353',
    ];

    for (let i = 0; i < bins.length; i++) {
      const barH = maxBin > 0 ? (bins[i] / maxBin) * maxH : 0;
      const x = 10 + i * barWidth + barGap / 2;
      ctx.fillStyle = colors[i];
      ctx.fillRect(x, H - 14 - barH, barWidth - barGap, barH);
    }

    // Labels
    ctx.font = '9px monospace';
    ctx.textAlign = 'center';
    const labelColor = computed.getPropertyValue('--text-muted').trim() || '#8b949e';
    ctx.fillStyle = labelColor;
    for (let i = 0; i < bins.length; i++) {
      const x = 10 + i * barWidth + barWidth / 2;
      ctx.fillText(`${i * 10}`, x, H - 2);
    }
  }, [bins, maxBin]);

  return (
    <div>
      <div style={{
        fontSize: 12,
        color: 'var(--text-muted)',
        marginBottom: 4,
        fontWeight: 500,
      }}>
        Win Rate Distribution
      </div>
      <canvas
        ref={canvasRef}
        style={{
          display: 'block',
          borderRadius: 4,
          border: '1px solid var(--border)',
          width: '100%',
          maxWidth: 320,
        }}
      />
    </div>
  );
}
