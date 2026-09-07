import { Router, Request, Response } from 'express';

const router: Router = Router();

type CardTheme = {
  label: string;
  short: string;
  subtitle: string;
  background: string;
  panel: string;
  accent: string;
};

const THEMES: Record<string, CardTheme> = {
  'ustv-priority-comedy-central': {
    label: 'Comedy Central',
    short: 'CC',
    subtitle: 'PLUTO TV',
    background: '#f4f4f4',
    panel: '#111111',
    accent: '#ffffff',
  },
  'ustv-priority-adult-swim': {
    label: 'Adult Swim',
    short: '[as]',
    subtitle: 'LIVE STREAM',
    background: '#050505',
    panel: '#111111',
    accent: '#ffffff',
  },
  'ustv-priority-phx-abc15': {
    label: 'ABC15 Phoenix',
    short: '15',
    subtitle: 'KNXV • PHOENIX',
    background: '#092b55',
    panel: '#0f3d73',
    accent: '#ffffff',
  },
  'ustv-priority-phx-fox10': {
    label: 'FOX 10 Phoenix',
    short: '10',
    subtitle: 'KSAZ • PHOENIX',
    background: '#082a54',
    panel: '#b5121b',
    accent: '#ffffff',
  },
  'ustv-priority-phx-12news': {
    label: '12News Phoenix',
    short: '12',
    subtitle: 'KPNX • PHOENIX',
    background: '#101820',
    panel: '#d71920',
    accent: '#ffffff',
  },
  'ustv-priority-phx-azfamily': {
    label: "Arizona's Family",
    short: 'AZ',
    subtitle: '3TV • CBS5 • PHOENIX',
    background: '#18243a',
    panel: '#31598a',
    accent: '#ffffff',
  },
};

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

router.get('/live-tv/:id.svg', (req: Request, res: Response) => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = decodeURIComponent(rawId || '');
  const theme = THEMES[id] ?? {
    label: 'Live TV',
    short: 'TV',
    subtitle: 'MASTER ADD-ON',
    background: '#111827',
    panel: '#1f2937',
    accent: '#ffffff',
  };

  const label = escapeXml(theme.label);
  const short = escapeXml(theme.short);
  const subtitle = escapeXml(theme.subtitle);

  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.type('image/svg+xml').send(`
    <svg xmlns="http://www.w3.org/2000/svg" width="600" height="900" viewBox="0 0 600 900">
      <rect width="600" height="900" fill="${theme.background}"/>
      <rect x="34" y="34" width="532" height="832" rx="36" fill="${theme.panel}"/>
      <rect x="64" y="64" width="472" height="472" rx="32" fill="${theme.background}" opacity="0.92"/>
      <text x="300" y="365" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="170" font-weight="900" fill="${theme.accent}">${short}</text>
      <text x="300" y="640" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="42" font-weight="800" fill="${theme.accent}">${label}</text>
      <text x="300" y="705" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="24" font-weight="600" fill="${theme.accent}" opacity="0.8">${subtitle}</text>
      <line x1="120" y1="760" x2="480" y2="760" stroke="${theme.accent}" opacity="0.25" stroke-width="2"/>
      <text x="300" y="815" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="20" fill="${theme.accent}" opacity="0.6">LIVE • MASTER ADD-ON</text>
    </svg>
  `);
});

export default router;
