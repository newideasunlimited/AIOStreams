import { Router, Request, Response } from 'express';

const router: Router = Router();

const LABELS: Record<string, string> = {
  'ustv-priority-comedy-central': 'Comedy Central',
  'ustv-priority-adult-swim': 'Adult Swim',
  'ustv-priority-phx-abc15': 'ABC15 Phoenix',
  'ustv-priority-phx-fox10': 'FOX 10 Phoenix',
  'ustv-priority-phx-12news': '12News Phoenix',
  'ustv-priority-phx-azfamily': "Arizona's Family",
};

router.get('/live-tv/:id.svg', (req: Request, res: Response) => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = decodeURIComponent(rawId || '');
  const label = (LABELS[id] || 'Live TV')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.type('image/svg+xml').send(`
    <svg xmlns="http://www.w3.org/2000/svg" width="600" height="900" viewBox="0 0 600 900">
      <rect width="600" height="900" fill="#111827"/>
      <rect x="36" y="36" width="528" height="828" rx="28" fill="#1f2937"/>
      <text x="300" y="310" text-anchor="middle" font-family="sans-serif" font-size="66" font-weight="700" fill="#ffffff">LIVE TV</text>
      <text x="300" y="510" text-anchor="middle" font-family="sans-serif" font-size="34" font-weight="600" fill="#f3f4f6">${label}</text>
      <text x="300" y="790" text-anchor="middle" font-family="sans-serif" font-size="22" fill="#9ca3af">MASTER ADD-ON</text>
    </svg>
  `);
});

export default router;
