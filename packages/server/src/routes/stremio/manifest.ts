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
import { MASTER_CATALOGS } from './master-native-resources.js';

const logger = createLogger('server');
const router: Router = Router();

export default router;

const MASTER_MANIFEST_VERSION = '2.1.0';

const manifest = async (config?: UserData): Promise<Manifest> => {
  let addonId = appConfig.branding.addonId;
  if (config) {
    addonId = addonId += `.${userScopeIdSuffix(config)}`;
  }
  let catalogs: Manifest['catalogs'] = [];
  let resources: Manifest['resources'] = [];
  let addonCatalogs: Manifest['addonCatalogs'] = [];
  if (config) {
    const aiostreams = new AIOStreams(config, { skipFailedAddons: true });

    await aiostreams.initialise();

    catalogs = aiostreams.getCatalogs();
    resources = aiostreams.getResources();
    addonCatalogs = aiostreams.getAddonCatalogs();
  }

  const masterIds = new Set(MASTER_CATALOGS.map((catalog) => catalog.id));
  catalogs = [
    ...catalogs.filter((catalog) => !masterIds.has(catalog.id as any)),
    ...MASTER_CATALOGS,
  ] as Manifest['catalogs'];

  const requiredResources = ['catalog', 'meta', 'stream'] as const;
  for (const required of requiredResources) {
    if (!resources.some((resource) => resource === required)) {
      resources.push(required as any);
    }
  }

  const resourceTypes = resources.reduce((types, resource) => {
    const values = typeof resource === 'string' ? [] : resource.types;
    return [...new Set([...types, ...values])];
  }, [] as string[]);

  return {
    name: config?.addonName || appConfig.branding.addonName,
    id: addonId,
    version:
      appConfig.bootstrap.version === 'unknown'
        ? MASTER_MANIFEST_VERSION
        : appConfig.bootstrap.version,
    description: config?.addonDescription || appConfig.bootstrap.description,
    catalogs,
    resources,
    types: [...new Set([...resourceTypes, 'movie', 'tv', 'other'])],
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
      res.status(200).json(await manifest(req.userData));
    } catch (error) {
      logger.error(`Failed to generate manifest: ${error}`);
      next(new APIError(constants.ErrorCode.INTERNAL_SERVER_ERROR));
    }
  }
);
