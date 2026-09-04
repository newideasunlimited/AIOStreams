import { Router, Request, Response, NextFunction } from 'express';
import {
  MasterNativeAddon,
  fromUrlSafeBase64,
  decodeAdultId,
  encodeAdultId,
  fetchAdultCatalog,
  resolveAdultItem,
  resolveAdultDirectStreams,
  MASTER_ADULT_GENRES,
  MASTER_ADULT_CATALOG_ID,
  MASTER_ADULT_ID_PREFIX,
  config as appConfig,
  type AdultTorrentItem,
} from '@aiostreams/core';

const router: Router = Router();

interface ManifestParams {
  encodedConfig?: string;
}

function createAddon(encodedConfig: string | undefined, clientIp?: string) {
  return new MasterNativeAddon(
    encodedConfig
      ? JSON.parse(fromUrlSafeBase64(encodedConfig))
      : undefined,
    clientIp
  );
}

function publicBaseUrl(): string {
  return appConfig.bootstrap.baseUrl?.replace(/\/$/, '') || '';
}

function posterUrl(id: string): string | undefined {
  const base = publicBaseUrl();
  return base
    ? `${base}/builtins/master-native/poster/${encodeURIComponent(id)}.svg`
    : undefined;
}

function adultMeta(item: AdultTorrentItem) {
  const id = encodeAdultId(item);
  const fallbackDescription = `${item.indexer}${item.seeders ? ` • ${item.seeders} seeders` : ''}${
    item.size ? ` • ${(item.size / 1024 ** 3).toFixed(2)} GB` : ''
  }`;
  return {
    id,
    type: 'movie',
    name: item.title,
    description: item.description || fallbackDescription,
    poster: item.poster || posterUrl(id),
    background: item.poster,
    posterShape: item.poster ? 'landscape' : 'poster',
    genres: item.tags ?? [],
    runtime: item.duration,
    website: item.detailUrl,
    behaviorHints: { adult: true },
  };
}

function parseAdultExtras(extra?: string) {
  const params = new URLSearchParams(extra ?? '');
  return {
    skip: Math.max(0, Number(params.get('skip') ?? 0) || 0),
    search: params.get('search') || undefined,
    genre: params.get('genre') || undefined,
  };
}

async function getAdultCatalog(extra?: string) {
  const { skip, search, genre } = parseAdultExtras(extra);
  const items = await fetchAdultCatalog(search, genre, skip);
  return items.map(adultMeta);
}

function getStremioManifest(addon: MasterNativeAddon) {
  const manifest = addon.getManifest();
  return {
    ...manifest,
    types: [...new Set((manifest.types ?? []).map((type) =>
      type === 'adult' ? 'movie' : type
    ))],
    catalogs: (manifest.catalogs ?? []).map((catalog) =>
      catalog.id === MASTER_ADULT_CATALOG_ID
        ? {
            ...catalog,
            type: 'movie',
            name: 'Porn',
            extra: [
              { name: 'skip' },
              { name: 'search' },
              {
                name: 'genre',
                options: [...MASTER_ADULT_GENRES],
                isRequired: false,
              },
            ],
          }
        : catalog
    ),
    resources: manifest.resources.map((resource) => {
      if (typeof resource === 'string') return resource;
      if (!resource.types?.includes('adult')) return resource;
      return {
        ...resource,
        types: resource.types.map((type) => type === 'adult' ? 'movie' : type),
      };
    }),
    behaviorHints: {
      ...(manifest.behaviorHints ?? {}),
      adult: true,
      p2p: true,
    },
  };
}

router.get(
  '/:encodedConfig/manifest.json',
  async (
    req: Request<ManifestParams>,
    res: Response,
    next: NextFunction
  ) => {
    const { encodedConfig } = req.params;
    try {
      const addon = createAddon(encodedConfig, req.userIp);
      res.json(getStremioManifest(addon));
    } catch (error) {
      next(error);
    }
  }
);

interface ResourceParams {
  encodedConfig?: string;
  type: string;
  id: string;
}

interface CatalogParams extends ResourceParams {
  extra?: string;
}

router.get(
  '/:encodedConfig/catalog/:type/:id.json',
  async (
    req: Request<CatalogParams>,
    res: Response,
    next: NextFunction
  ) => {
    const { encodedConfig, type, id } = req.params;
    try {
      if (id === MASTER_ADULT_CATALOG_ID) {
        res.json({ metas: await getAdultCatalog() });
        return;
      }

      const addon = createAddon(encodedConfig, req.userIp);
      const metas = await addon.getCatalog(type, id);
      res.json({ metas });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/:encodedConfig/catalog/:type/:id/:extra.json',
  async (
    req: Request<CatalogParams>,
    res: Response,
    next: NextFunction
  ) => {
    const { encodedConfig, type, id, extra } = req.params;
    try {
      if (id === MASTER_ADULT_CATALOG_ID) {
        res.json({ metas: await getAdultCatalog(extra) });
        return;
      }

      const addon = createAddon(encodedConfig, req.userIp);
      const metas = await addon.getCatalog(type, id, extra);
      res.json({ metas });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/:encodedConfig/meta/:type/:id.json',
  async (
    req: Request<ResourceParams>,
    res: Response,
    next: NextFunction
  ) => {
    const { encodedConfig, type, id } = req.params;
    try {
      if (id.startsWith(MASTER_ADULT_ID_PREFIX)) {
        const item = decodeAdultId(id);
        res.json({ meta: item ? adultMeta(item) : null });
        return;
      }

      const addon = createAddon(encodedConfig, req.userIp);
      const meta = await addon.getMeta(type, id);
      res.json({ meta });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/:encodedConfig/stream/:type/:id.json',
  async (
    req: Request<ResourceParams>,
    res: Response,
    next: NextFunction
  ) => {
    const { encodedConfig, type, id } = req.params;
    try {
      if (id.startsWith(MASTER_ADULT_ID_PREFIX)) {
        const item = decodeAdultId(id);
        if (!item) {
          res.json({ streams: [] });
          return;
        }

        if (item.sourceKind === 'direct') {
          const directStreams = await resolveAdultDirectStreams(item);
          const streams = directStreams.map((stream) => ({
            name: `Master • ${stream.name}`,
            title: item.title,
            url: stream.url,
            behaviorHints: {
              notWebReady: true,
              bingeGroup: `master-adult-direct-${item.indexer}-${item.sourceId || 'video'}`,
              proxyHeaders: {
                request: {
                  'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
                  ...(stream.referer ? { Referer: stream.referer } : {}),
                },
              },
            },
          }));
          res.json({ streams });
          return;
        }

        const resolved = await resolveAdultItem(item);
        if (!resolved?.hash) {
          res.json({ streams: [] });
          return;
        }

        const resolvedId = encodeAdultId(resolved);
        const addon = createAddon(encodedConfig, req.userIp);
        let debridStreams: any[] = [];
        try {
          debridStreams = await addon.getStreams('adult', resolvedId);
        } catch {
          debridStreams = [];
        }

        const directStream = {
          name: 'Master • Direct Torrent',
          title: `${resolved.title}\n${resolved.indexer}${resolved.seeders ? ` • ${resolved.seeders} seeders` : ''}`,
          infoHash: resolved.hash,
          behaviorHints: {
            bingeGroup: `master-adult-${resolved.hash}`,
          },
        };

        res.json({ streams: [directStream, ...debridStreams] });
        return;
      }

      const addon = createAddon(encodedConfig, req.userIp);
      const streams = await addon.getStreams(type, id);
      res.json({ streams });
    } catch (error) {
      next(error);
    }
  }
);

router.get('/poster/:id.svg', (req: Request, res: Response) => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = decodeURIComponent(rawId || '');
  const item = decodeAdultId(id);
  const title = (item?.title || 'Adult').slice(0, 110);
  const escaped = title
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  const words = escaped.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > 24 && current) {
      lines.push(current);
      current = word;
      if (lines.length === 4) break;
    } else {
      current = next;
    }
  }
  if (current && lines.length < 5) lines.push(current);

  const tspans = lines
    .map((line, index) => `<tspan x="300" dy="${index === 0 ? 0 : 52}">${line}</tspan>`)
    .join('');

  res.type('image/svg+xml').send(`
    <svg xmlns="http://www.w3.org/2000/svg" width="600" height="900" viewBox="0 0 600 900">
      <rect width="600" height="900" fill="#171722"/>
      <rect x="36" y="36" width="528" height="828" rx="28" fill="#242435"/>
      <text x="300" y="165" text-anchor="middle" font-family="sans-serif" font-size="34" font-weight="700" fill="#ffffff">MASTER</text>
      <text x="300" y="220" text-anchor="middle" font-family="sans-serif" font-size="25" fill="#b8b8c8">ADULT</text>
      <text x="300" y="410" text-anchor="middle" font-family="sans-serif" font-size="31" fill="#ffffff">${tspans}</text>
      <text x="300" y="805" text-anchor="middle" font-family="sans-serif" font-size="20" fill="#9c9caf">${item?.indexer || 'Local source'}</text>
    </svg>
  `);
});

export default router;
