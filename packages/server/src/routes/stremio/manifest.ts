import { Router, Request, Response, NextFunction } from 'express';
import {
  AIOStreams,
  APIError,
  config as appConfig,
  constants,
  UserData,
  userScopeIdSuffix,
} from '@aiostreams/core';
import { Manifest } from '@aiostreams/core';
import { createLogger } from '@aiostreams/core';

const logger = createLogger('server');
const router: Router = Router();

export default router;

const MASTER_MANIFEST_VERSION = '99.0.115';
const MASTER_CATALOG_SUFFIX_ORDER = [
  '.master-live-tv',
  '.master-radio',
  '.master-adult',
] as const;

function putMasterCatalogsLast(catalogs: Manifest['catalogs']): Manifest['catalogs'] {
  const rank = (id: string) =>
    MASTER_CATALOG_SUFFIX_ORDER.findIndex((suffix) => id.endsWith(suffix));
  const normal = catalogs.filter((catalog) => rank(catalog.id) === -1);
  const master = catalogs
    .filter((catalog) => rank(catalog.id) !== -1)
    .sort((a, b) => rank(a.id) - rank(b.id));
  return [...normal, ...master];
}

const manifest = async (config?: UserData): Promise<Manifest> => {
  let addonId = appConfig.branding.addonId;
  if (config) addonId += `.${userScopeIdSuffix(config)}`;

  let catalogs: Manifest['catalogs'] = [];
  let resources: Manifest['resources'] = [];
  let addonCatalogs: Manifest['addonCatalogs'] = [];

  if (config) {
    const aiostreams = new AIOStreams(config, { skipFailedAddons: true });
    await aiostreams.initialise();
    catalogs = putMasterCatalogsLast(aiostreams.getCatalogs());
    resources = aiostreams.getResources();
    addonCatalogs = aiostreams.getAddonCatalogs();
  }

  return {
    name: config?.addonName || appConfig.branding.addonName,
    id: addonId,
    version: MASTER_MANIFEST_VERSION,
    description: config?.addonDescription || appConfig.bootstrap.description,
    catalogs,
    resources,
    types: resources.reduce((types, resource) => {
      const resourceTypes = typeof resource === 'string' ? [resource] : resource.types;
      return [...new Set([...types, ...resourceTypes])];
    }, [] as string[]),
    logo:
      config?.addonLogo ||
      `https://raw.githubusercontent.com/Viren070/AIOStreams/refs/heads/main/packages/frontend/public/logo${
        appConfig.branding.alternateDesign ? '_alt' : ''
      }.png`,
    behaviorHints: {
      configurable: true,
      configurationRequired: config ? false : true,
    },
    addonCatalogs,
    stremioAddonsConfig:
      appConfig.api.stremioAddonsConfigIssuer &&
      appConfig.api.stremioAddonsConfigSignature
        ? {
            issuer: appConfig.api.stremioAddonsConfigIssuer,
            signature: appConfig.api.stremioAddonsConfigSignature,
          }
        : undefined,
  };
};

router.get(
  '/',
  async (req: Request, res: Response<Manifest>, next: NextFunction) => {
    logger.info({ uuid: req.userData?.uuid }, 'received request for manifest');
    try {
      res.setHeader(
        'Cache-Control',
        'no-store, no-cache, must-revalidate, proxy-revalidate'
      );
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.status(200).json(await manifest(req.userData));
    } catch (error) {
      logger.error(`Failed to generate manifest: ${error}`);
      next(new APIError(constants.ErrorCode.INTERNAL_SERVER_ERROR));
    }
  }
);
