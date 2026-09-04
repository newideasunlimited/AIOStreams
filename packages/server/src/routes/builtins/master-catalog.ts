import { Router, Request, Response, NextFunction } from 'express';
import {
  decodeAdultId,
  encodeAdultId,
  fetchAdultCatalog,
  fromUrlSafeBase64,
  MASTER_ADULT_ID_PREFIX,
  type AdultTorrentItem,
} from '@aiostreams/core';

const router: Router = Router();
const MASTER_PORN_CATALOG_ID = 'master.porn';

interface MasterCatalogConfig {
  language?: string;
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parseConfig(encodedConfig: string): MasterCatalogConfig {
  return JSON.parse(fromUrlSafeBase64(encodedConfig));
}

function parseExtras(extras?: string): Record<string, string> {
  if (!extras) return {};
  return Object.fromEntries(
    extras
      .split('&')
      .map((entry) => entry.split('=').map(decodeURIComponent))
      .filter((parts) => parts.length === 2) as [string, string][]
  );
}

router.get(
  '/:encodedConfig/manifest.json',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const encodedConfig = firstParam(req.params.encodedConfig);
      if (!encodedConfig) throw new Error('Missing Master catalog configuration');
      parseConfig(encodedConfig);

      res.json({
        id: 'com.newideasunlimited.master.catalogs',
        version: '1.1.1',
        name: 'Master Add-On',
        description: 'Porn catalog served by the self-hosted Master Add-On.',
        resources: ['catalog', 'meta'],
        types: ['movie'],
        catalogs: [
          {
            type: 'movie',
            id: MASTER_PORN_CATALOG_ID,
            name: 'Porn',
            extra: [
              { name: 'skip', isRequired: false },
              { name: 'search', isRequired: false },
              {
                name: 'genre',
                options: ['Latest', 'VR', 'JAV'],
                isRequired: false,
              },
            ],
          },
        ],
        behaviorHints: { configurable: false, configurationRequired: false },
      });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/:encodedConfig/catalog/:type/:id{/:extras}.json',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const encodedConfig = firstParam(req.params.encodedConfig);
      if (!encodedConfig) throw new Error('Missing Master catalog configuration');
      parseConfig(encodedConfig);

      if (firstParam(req.params.id) !== MASTER_PORN_CATALOG_ID) {
        res.json({ metas: [] });
        return;
      }

      const extras = parseExtras(firstParam(req.params.extras));
      const skip = Math.max(0, Number(extras.skip || 0) || 0);
      const search = extras.search || undefined;
      const genre = extras.genre || undefined;
      const items = await fetchAdultCatalog(search, genre, skip);

      res.json({
        metas: items.map((item: AdultTorrentItem) => ({
          id: encodeAdultId(item),
          type: 'movie',
          name: item.title,
          description: `${item.indexer} • ${item.seeders} seeders${
            item.size ? ` • ${(item.size / 1024 ** 3).toFixed(2)} GB` : ''
          }`,
          posterShape: 'landscape',
        })),
      });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/:encodedConfig/meta/:type/:id.json',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const encodedConfig = firstParam(req.params.encodedConfig);
      if (!encodedConfig) throw new Error('Missing Master catalog configuration');
      parseConfig(encodedConfig);

      const id = firstParam(req.params.id) || '';
      if (!id.startsWith(MASTER_ADULT_ID_PREFIX)) {
        res.json({ meta: null });
        return;
      }

      const item = decodeAdultId(id);
      if (!item) {
        res.json({ meta: null });
        return;
      }

      res.json({
        meta: {
          id,
          type: 'movie',
          name: item.title,
          description: `${item.indexer} • ${item.seeders} seeders${
            item.size ? ` • ${(item.size / 1024 ** 3).toFixed(2)} GB` : ''
          }`,
          posterShape: 'landscape',
          videos: [],
          behaviorHints: {},
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
