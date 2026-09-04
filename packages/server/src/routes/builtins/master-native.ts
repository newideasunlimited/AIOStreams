import { Router, Request, Response, NextFunction } from 'express';
import {
  MasterNativeAddon,
  fromUrlSafeBase64,
} from '@aiostreams/core';

const router: Router = Router();

const MASTER_ADULT_CATALOG_ID = 'master-adult';
const MASTER_ADULT_ID_PREFIX = 'aiostreams::adult.';

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

/**
 * Stremio's UI does not consistently surface arbitrary custom content types.
 * Master keeps adult as a distinct internal type, but advertises the catalog
 * as `movie` so it appears as a normal home/discover row. Requests for the
 * Master adult catalog/IDs are translated back to the internal adult type.
 */
function getStremioManifest(addon: MasterNativeAddon) {
  const manifest = addon.getManifest();
  return {
    ...manifest,
    types: [...new Set((manifest.types ?? []).map((type) =>
      type === 'adult' ? 'movie' : type
    ))],
    catalogs: (manifest.catalogs ?? []).map((catalog) =>
      catalog.id === MASTER_ADULT_CATALOG_ID
        ? { ...catalog, type: 'movie', name: 'Porn' }
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
  };
}

function toStremioMetaType<T extends { id: string; type: string }>(item: T): T {
  return item.id.startsWith(MASTER_ADULT_ID_PREFIX)
    ? { ...item, type: 'movie' }
    : item;
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
      const addon = createAddon(encodedConfig, req.userIp);
      const internalType = id === MASTER_ADULT_CATALOG_ID ? 'adult' : type;
      const metas = await addon.getCatalog(internalType, id);
      res.json({ metas: metas.map(toStremioMetaType) });
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
      const addon = createAddon(encodedConfig, req.userIp);
      const internalType = id === MASTER_ADULT_CATALOG_ID ? 'adult' : type;
      const metas = await addon.getCatalog(internalType, id, extra);
      res.json({ metas: metas.map(toStremioMetaType) });
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
      const addon = createAddon(encodedConfig, req.userIp);
      const internalType = id.startsWith(MASTER_ADULT_ID_PREFIX) ? 'adult' : type;
      const meta = await addon.getMeta(internalType, id);
      res.json({ meta: toStremioMetaType(meta) });
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
      const addon = createAddon(encodedConfig, req.userIp);
      const internalType = id.startsWith(MASTER_ADULT_ID_PREFIX) ? 'adult' : type;
      const streams = await addon.getStreams(internalType, id);
      res.json({ streams });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
