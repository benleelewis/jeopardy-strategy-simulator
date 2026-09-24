/**
 * "Your Number" — the headline from Screen 1.5.
 *
 * "If you played every game of Jeopardy ever aired, how many would you win?"
 * Shows overall win rate, win streak, and a histogram of per-game win rates.
 */

import { useMemo, useRef, useEffect, useState } from 'react';
import { DIMENSIONS, fractionToValue } from '../sim/dimensions';

interface Props {
  winRates: number[];
  isSimulating: boolean;
}

// ─── Share card (P3 — Your Number share card) ───────────────────────

const APP_URL = 'jeopardy-strategy-simulator.vercel.app';

export interface ShareCardData {
  /** Overall win rate, as a [0,1] fraction. */
  winRate: number;
  totalGames: number;
  favored: number;
  tossUp: number;
  underdog: number;
  bins: number[];
  maxBin: number;
  /** Knowledge (b×p) axis value currently in play, [0,1]. */
  knowledge: number;
  /** Buzzer speed axis value currently in play, [0,1]. */
  buzzerSpeed: number;
}

export interface ShareCardColors {
  cg1: string;
  cg2: string;
  cg3: string;
  cg4: string;
  cg5: string;
  bg: string;
  textH: string;
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.trim().replace('#', '');
  const full = clean.length === 3 ? clean.split('').map(c => c + c).join('') : clean;
  const n = parseInt(full, 16);
  if (full.length !== 6 || Number.isNaN(n)) return [128, 128, 128];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function withAlpha(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Bucket a win-rate percentage onto one of the app's 5 --cg-1..--cg-5
 * swatches, using the SAME breakpoints as the All Games legend (<15,
 * 15-25, 25-40, 40-55, >55 — see the ContributionGraph legend text).
 * The cg colors are a discrete 5-step palette (dark navy → bright gold),
 * not a smooth gradient — continuously RGB-interpolating between them
 * (e.g. cg3's blue and cg4's gold-brown) produces muddy in-between hues
 * that appear nowhere else in the app, so this always returns one of the
 * 5 swatches verbatim instead of blending.
 */
function winRateColor(colors: ShareCardColors, winRatePct: number): string {
  if (winRatePct < 15) return colors.cg1;
  if (winRatePct < 25) return colors.cg2;
  if (winRatePct < 40) return colors.cg3;
  if (winRatePct < 55) return colors.cg4;
  return colors.cg5;
}

/**
 * Pure canvas renderer for the "Your Number" share card — a 1200×630 PNG
 * (Open Graph size). Exported (and kept side-effect-free apart from the
 * canvas draw calls) so it can be unit-tested and driven headlessly
 * without going through the Share button's click/share/download plumbing.
 */
// eslint-disable-next-line react-refresh/only-export-components -- test-only export, see YourNumber.test.tsx
export function renderShareCard(canvas: HTMLCanvasElement, data: ShareCardData, colors: ShareCardColors): void {
  const W = 1200;
  const H = 630;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Background
  ctx.fillStyle = colors.bg;
  ctx.fillRect(0, 0, W, H);

  // Eyebrow
  ctx.textAlign = 'center';
  ctx.fillStyle = withAlpha(colors.textH, 0.6);
  ctx.font = '600 26px system-ui, sans-serif';
  ctx.fillText('JEOPARDY STRATEGY SIMULATOR', W / 2, 66);

  // Headline win rate — colored via the same navy→gold legend buckets the
  // page's contribution graph uses, instead of a hardcoded red/green. A
  // dark bucket (cg1/cg2) can land close in luminance to a dark theme's own
  // --bg (e.g. the Jeopardy theme's royal-blue background), so a thin
  // --text-h outline rides under the fill purely for contrast — it doesn't
  // change which swatch is "the" headline color.
  const winRatePct = data.winRate * 100;
  const headlineText = `${Math.round(winRatePct)}%`;
  ctx.font = '800 160px system-ui, sans-serif';
  ctx.lineWidth = 4;
  ctx.strokeStyle = withAlpha(colors.textH, 0.35);
  ctx.strokeText(headlineText, W / 2, 236);
  ctx.fillStyle = winRateColor(colors, winRatePct);
  ctx.fillText(headlineText, W / 2, 236);

  // Subtitle
  ctx.fillStyle = colors.textH;
  ctx.font = '500 32px system-ui, sans-serif';
  ctx.fillText(`win rate across ${data.totalGames.toLocaleString()} real Jeopardy games`, W / 2, 284);

  // Favored / Toss-up / Underdog tiles — matches the page's own >50% /
  // 30-50% / <30% split (StatBox), mapped onto the brightest/middle/
  // darkest cg swatch rather than a hardcoded green/yellow/red.
  const tiles = [
    { label: 'FAVORED', value: data.favored, color: colors.cg5 },
    { label: 'TOSS-UP', value: data.tossUp, color: colors.cg3 },
    { label: 'UNDERDOG', value: data.underdog, color: colors.cg1 },
  ];
  const tileW = 260;
  const tileGap = 40;
  const tilesTotalW = tiles.length * tileW + (tiles.length - 1) * tileGap;
  const tilesStartX = (W - tilesTotalW) / 2;
  const tileY = 330;
  const tileH = 110;

  for (const tile of tiles) {
    const i = tiles.indexOf(tile);
    const x = tilesStartX + i * (tileW + tileGap);

    ctx.fillStyle = withAlpha(colors.textH, 0.06);
    ctx.fillRect(x, tileY, tileW, tileH);
    ctx.strokeStyle = withAlpha(colors.textH, 0.15);
    ctx.lineWidth = 1;
    ctx.strokeRect(x, tileY, tileW, tileH);

    ctx.fillStyle = tile.color;
    ctx.font = '700 42px system-ui, sans-serif';
    ctx.fillText(tile.value.toLocaleString(), x + tileW / 2, tileY + 58);

    ctx.fillStyle = withAlpha(colors.textH, 0.7);
    ctx.font = '600 17px system-ui, sans-serif';
    ctx.fillText(tile.label, x + tileW / 2, tileY + 90);
  }

  // Distribution histogram, redrawn at card scale
  const histX = 140;
  const histY = 480;
  const histW = W - histX * 2;
  const histBaselineY = histY + 90;
  const histMaxBarH = 90;
  const barGap = 4;
  const barCount = data.bins.length;
  const barW = (histW - barGap * (barCount - 1)) / barCount;

  ctx.textAlign = 'left';
  ctx.fillStyle = withAlpha(colors.textH, 0.55);
  ctx.font = '400 17px system-ui, sans-serif';
  ctx.fillText('Win rate distribution', histX, histY - 10);

  for (let i = 0; i < barCount; i++) {
    const barH = data.maxBin > 0 ? (data.bins[i] / data.maxBin) * histMaxBarH : 0;
    const x = histX + i * (barW + barGap);
    // Each bin covers [i*10, (i+1)*10)% — bucket by its midpoint so a bin
    // straddling a legend breakpoint still reads as one clean swatch.
    const binMidpointPct = (i + 0.5) * (100 / barCount);
    ctx.fillStyle = winRateColor(colors, binMidpointPct);
    ctx.fillRect(x, histBaselineY - barH, barW, barH);
  }
  ctx.strokeStyle = withAlpha(colors.textH, 0.3);
  ctx.beginPath();
  ctx.moveTo(histX, histBaselineY);
  ctx.lineTo(histX + histW, histBaselineY);
  ctx.stroke();

  // Knowledge / buzzer speed values used, right-aligned above the histogram
  ctx.textAlign = 'right';
  ctx.fillStyle = withAlpha(colors.textH, 0.8);
  ctx.font = '500 20px system-ui, sans-serif';
  ctx.fillText(
    `Knowledge ${Math.round(data.knowledge * 100)}%  ·  Buzzer Speed ${Math.round(data.buzzerSpeed * 100)}%`,
    histX + histW,
    histY - 10,
  );

  // Footer: app URL
  ctx.textAlign = 'center';
  ctx.fillStyle = withAlpha(colors.textH, 0.5);
  ctx.font = '500 24px system-ui, sans-serif';
  ctx.fillText(APP_URL, W / 2, H - 36);
}

/**
 * Reconstruct the knowledge/buzzerSpeed values currently in play from the
 * URL hash App.tsx keeps live-synced via `history.replaceState` (its own
 * encodeState/decodeState) — the only channel available to this component
 * without threading new props through App.tsx, which is out of this work
 * item's file zone. Falls back to each dimension's default when the hash
 * is empty/unparseable (e.g. tests, which render YourNumber standalone).
 */
function readKnobsFromHash(): { knowledge: number; buzzerSpeed: number } {
  const fallback = {
    knowledge: DIMENSIONS.knowledge.defaultValue,
    buzzerSpeed: DIMENSIONS.buzzerSpeed.defaultValue,
  };
  if (typeof window === 'undefined' || !window.location.hash || window.location.hash.length < 2) {
    return fallback;
  }

  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const x = parseFloat(params.get('x') || '');
  const y = parseFloat(params.get('y') || '');
  const xa = params.get('xa');
  const ya = params.get('ya');

  const resolve = (dim: 'knowledge' | 'buzzerSpeed'): number => {
    if (xa === dim && !Number.isNaN(x)) {
      return fractionToValue(DIMENSIONS[dim], Math.max(0, Math.min(1, x)));
    }
    if (ya === dim && !Number.isNaN(y)) {
      return fractionToValue(DIMENSIONS[dim], Math.max(0, Math.min(1, y)));
    }
    const pinned = parseFloat(params.get(`p_${dim}`) || '');
    return Number.isNaN(pinned) ? DIMENSIONS[dim].defaultValue : pinned;
  };

  return { knowledge: resolve('knowledge'), buzzerSpeed: resolve('buzzerSpeed') };
}

function readCssColors(el: Element | null): ShareCardColors {
  const computed = el ? getComputedStyle(el) : null;
  const cssVar = (name: string, fallback: string) => {
    const v = computed?.getPropertyValue(name).trim();
    return v || fallback;
  };
  return {
    cg1: cssVar('--cg-1', '#060a30'),
    cg2: cssVar('--cg-2', '#0a1566'),
    cg3: cssVar('--cg-3', '#1a3ba8'),
    cg4: cssVar('--cg-4', '#c5a028'),
    cg5: cssVar('--cg-5', '#f5d442'),
    bg: cssVar('--bg', '#fafafa'),
    textH: cssVar('--text-h', '#111827'),
  };
}

type ShareStatus = 'idle' | 'shared' | 'saved' | 'error';

interface ShareButtonProps {
  winRate: number;
  totalGames: number;
  favored: number;
  tossUp: number;
  underdog: number;
  bins: number[];
  maxBin: number;
}

function ShareButton(props: ShareButtonProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<ShareStatus>('idle');
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const flashStatus = (s: ShareStatus) => {
    setStatus(s);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setStatus('idle'), 2000);
  };

  const handleShare = async () => {
    const { knowledge, buzzerSpeed } = readKnobsFromHash();
    const colors = readCssColors(containerRef.current);
    const data: ShareCardData = {
      winRate: props.winRate,
      totalGames: props.totalGames,
      favored: props.favored,
      tossUp: props.tossUp,
      underdog: props.underdog,
      bins: props.bins,
      maxBin: props.maxBin,
      knowledge,
      buzzerSpeed,
    };

    const canvas = document.createElement('canvas');
    renderShareCard(canvas, data, colors);

    canvas.toBlob(async blob => {
      if (!blob) {
        flashStatus('error');
        return;
      }
      const file = new File([blob], 'jeopardy-your-number.png', { type: 'image/png' });

      const canShareFile = typeof navigator.share === 'function'
        && (typeof navigator.canShare !== 'function' || navigator.canShare({ files: [file] }));

      if (canShareFile) {
        try {
          await navigator.share({
            files: [file],
            title: 'My Jeopardy Number',
            text: `I'd win ${Math.round(props.winRate * 100)}% of Jeopardy games`,
          });
          flashStatus('shared');
          return;
        } catch {
          // User cancelled, or the platform refused — fall back to download.
        }
      }

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'jeopardy-your-number.png';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      flashStatus('saved');
    }, 'image/png');
  };

  return (
    <div ref={containerRef} style={{ marginTop: 12, textAlign: 'center' }}>
      <button type="button" className="share-button" onClick={handleShare}>
        Share your number
      </button>
      {status !== 'idle' && (
        <span className="share-status" role="status">
          {status === 'shared' ? 'Shared!' : status === 'saved' ? 'Saved!' : "Couldn't share"}
        </span>
      )}
    </div>
  );
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
        <div style={{
          fontSize: 12,
          color: 'var(--text-muted)',
          marginTop: 2,
        }}>
          against each game's real opponents
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

      {/* Share card (P3) — not shown until win rates exist, i.e. never
          before this point in the component (see the early return above). */}
      <ShareButton
        winRate={stats.overall}
        totalGames={stats.total}
        favored={stats.won}
        tossUp={stats.tossUp}
        underdog={stats.lost}
        bins={stats.bins}
        maxBin={stats.maxBin}
      />
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
