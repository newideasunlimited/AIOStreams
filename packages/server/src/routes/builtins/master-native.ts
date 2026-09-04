import { Router, Request, Response, NextFunction } from 'express';
import {
  MasterNativeAddon,
  fromUrlSafeBase64,
} from '@aiostreams/core';

const router: Router = Router();

interface ManifestParams {
  encodedConfig?: string;
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
      const addon = new MasterNativeAddon(
        encodedConfig
          ? JSON.parse(fromUrlSafeBase64(encodedConfig))
          : undefined,
        req.userIp
      );
      res.json(addon.getManifest());
    } catch (error) {
      next(error);
    }
  }
);

interface StreamParams {
  encodedConfig?: string;
  type: string;
  id: string;
}

router.get(
  '/:encodedConfig/stream/:type/:id.json',
  async (
    req: Request<StreamParams>,
    res: Response,
    next: NextFunction
  ) => {
    const { encodedConfig, type, id } = req.params;
    try {
      const addon = new MasterNativeAddon(
        encodedConfig
          ? JSON.parse(fromUrlSafeBase64(encodedConfig))
          : undefined,
        req.userIp
      );
      const streams = await addon.getStreams(type, id);
      res.json({ streams });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
