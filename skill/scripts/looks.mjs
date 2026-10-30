// Visual "looks" for VidGen videos: canvas, title-card and caption treatment applied around the REAL screenshots.
// Original VidGen designs; moods only (no third-party templates, logos or trade dress). Used by render.mjs and look-preview.mjs.
// status "ready" = rendered today; "planned" = described in references/looks.md, needs a new render engine.

const esc = (t) => String(t ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

export const LOOKS = {
  noir: {
    name: 'Noir Glide', status: 'ready',
    mood: 'Dark, cinematic, premium. Near-black canvas, one glowing brand accent, product floating in a lit window.',
    canvas: (b) => `radial-gradient(70% 55% at 50% 0%, ${b.primary}55 0%, #0A0A0C 62%), #0A0A0C`,
    titleBg: (b) => `radial-gradient(60% 50% at 50% 45%, ${b.primary}40 0%, #0A0A0C 70%), #0A0A0C`, titleSolid: '#0A0A0C',
    titleColor: '#F5F5F7', titleWeight: 800, titleTracking: '-0.03em', titleGlow: (b) => `0 0 40px ${b.primary}99`,
    capBg: 'linear-gradient(180deg,rgba(255,255,255,.14),rgba(255,255,255,.04)),rgba(12,12,16,.72)', capColor: '#F5F5F7', capSolid: '#16161B',
    capBorder: '1px solid rgba(255,255,255,.16)', style: 'device',
  },
  porcelain: {
    name: 'Porcelain Keynote', status: 'ready',
    mood: 'Bright keynote stage. Warm off-white canvas, bold black type, product shown big with soft shadows.',
    canvas: () => 'radial-gradient(90% 70% at 50% 20%, #FFFFFF 0%, #F1EDE6 70%), #F1EDE6',
    titleBg: () => 'radial-gradient(80% 60% at 50% 40%, #FFFFFF 0%, #EFEAE2 75%), #EFEAE2', titleSolid: '#F1EDE6',
    titleColor: '#111111', titleWeight: 800, titleTracking: '-0.035em',
    capBg: '#111111', capColor: '#FFFFFF', capSolid: '#111111', capBorder: 'none', style: 'device',
  },
  'mint-noir': {
    name: 'Mint Noir', status: 'ready',
    mood: 'Calm graphite surfaces, a single mint accent, one italic-serif highlight word in each headline.',
    canvas: () => 'radial-gradient(80% 60% at 50% 0%, #1E2422 0%, #0F1112 65%), #0F1112',
    titleBg: () => 'radial-gradient(70% 55% at 50% 40%, #1B201E 0%, #0F1112 72%), #0F1112', titleSolid: '#0F1112',
    titleColor: '#F2F4F3', titleWeight: 750, titleTracking: '-0.025em', accent: '#3DDC97',
    highlightLast: true, capBg: 'rgba(17,19,20,.9)', capColor: '#3DDC97', capSolid: '#111314', capBorder: '1px solid #3DDC9766', style: 'device',
  },
  soft: {
    name: 'Soft Calm', status: 'ready',
    mood: 'Friendly and reassuring. Warm peach-to-lavender gradient, rounded type, gentle shapes.',
    canvas: () => 'linear-gradient(160deg, #FFE6D3 0%, #F6DCEB 48%, #E4E0FF 100%)',
    titleBg: () => 'linear-gradient(160deg, #FFE6D3 0%, #F6DCEB 48%, #E4E0FF 100%)', titleSolid: '#F6DCEB',
    titleColor: '#24213F', titleWeight: 750, titleTracking: '-0.015em', font: "ui-rounded,'SF Pro Rounded','Nunito',system-ui",
    capBg: '#FFFFFF', capColor: '#24213F', capSolid: '#FFFFFF', capBorder: 'none', capRadius: 999, style: 'device',
  },
  'glyph-glitch': { name: 'Glyph Glitch', status: 'planned', mood: 'Hype film: ASCII/dot-matrix glyphs, tracking-mark distortion, very fast cuts between real screens.' },
  pixel: { name: 'Pixel Story', status: 'planned', mood: 'Pixel-art scenes with typewriter captions; night, mono or bright block-world palettes.' },
  crew: { name: 'Crew Build', status: 'planned', mood: 'Cute characters "build" the promo live in an editor, revealing the real screenshots and features.' },
  editorial: { name: 'Editorial Bold', status: 'planned', mood: 'Magazine-style: huge left-aligned headlines over full-bleed product imagery.' },
};
export const READY_LOOKS = Object.keys(LOOKS).filter((k) => LOOKS[k].status === 'ready');

// Everything render.mjs needs to dress a video. No look = VidGen's original brand-colored treatment (unchanged).
export function theme(brand, lookId) {
  if (lookId != null && !READY_LOOKS.includes(lookId)) {
    const l = LOOKS[lookId];
    throw new Error(l ? `look "${lookId}" (${l.name}) is planned, not available yet — ready: ${READY_LOOKS.join(', ')}` : `look "${lookId}" — use one of ${READY_LOOKS.join(', ')}`);
  }
  const L = lookId ? LOOKS[lookId] : null;
  if (!L) {
    return {
      canvas: `radial-gradient(120% 90% at 50% 0%, ${brand.primary}cc 0%, ${brand.background} 70%)`,
      titleBg: `radial-gradient(circle at 50% 40%, ${brand.primary}55, ${brand.background} 65%)`,
      titleColor: '#fff', titleWeight: 800, titleTracking: '-0.02em', titleGlow: 'none', font: null, accentBar: brand.primary,
      capBg: `${brand.primary}e0`, capColor: '#fff', capBorder: 'none', capRadius: null, style: 'screen', highlight: esc,
      contrast: [['white text on brand primary (caption box)', '#ffffff', brand.primary], ['white text on brand background (title cards)', '#ffffff', brand.background]],
    };
  }
  const accent = L.accent ?? brand.primary;
  return {
    canvas: L.canvas(brand), titleBg: L.titleBg(brand), titleColor: L.titleColor, titleWeight: L.titleWeight, titleTracking: L.titleTracking,
    titleGlow: L.titleGlow ? L.titleGlow(brand) : 'none', font: L.font ?? null, accentBar: accent,
    capBg: L.capBg, capColor: L.capColor, capBorder: L.capBorder, capRadius: L.capRadius ?? null, style: L.style,
    // Mint Noir: last word of a headline in italic serif, accent-colored.
    highlight: L.highlightLast ? (t) => { const w = String(t ?? '').trim().split(/\s+/); const last = w.pop(); return `${esc(w.join(' '))} <em style="font-family:Georgia,'Times New Roman',serif;font-style:italic;font-weight:500;color:${accent}">${esc(last)}</em>`; } : esc,
    contrast: [[`${L.name} caption text`, L.capColor, L.capSolid], [`${L.name} title text`, L.titleColor, L.titleSolid]],
  };
}
