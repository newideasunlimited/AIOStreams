import { Router, Request, Response, NextFunction } from 'express';
import {
  AIOStreams,
  AIOStreamResponse,
  config as appConfig,
  createLogger,
  StremioTransformer,
  Cache,
  IdParser,
  decodeAdultId,
  resolveAdultDirectStreams,
  MASTER_ADULT_ID_PREFIX,
} from '@aiostreams/core';
import { resolveEpornerCurrent } from '../builtins/eporner-resolver.js';
import { trackResource } from '../../middlewares/analytics.js';

const router: Router = Router();

const logger = createLogger('server');
const DIRECT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

router.use(trackResource('stream'));

interface StreamParams {
  type: string;
  id: string;
}

router.get(
  '/:type/:id.json',
  async (
    req: Request<StreamParams>,
    res: Response<AIOStreamResponse>,
    next: NextFunction
  ) => {
    // Check if we have user data (set by middleware in authenticated routes)
    if (!req.userData) {
      // Return a response indicating configuration is needed
      res.status(200).json(
        StremioTransformer.createDynamicError('stream', {
          errorDescription: 'Please configure the addon first',
        })
      );
      return;
    }

    const { type, id } = req.params;

    // Master adult catalog IDs are already complete source records. Route them
    // directly instead of sending them through the normal movie/TV aggregator,
    // whose metadata matching/filtering is designed for IMDB/TMDB IDs and can
    // discard custom adult IDs before the built-in provider is reached.
    if (id.startsWith(MASTER_ADULT_ID_PREFIX)) {
      try {
        const item = decodeAdultId(id);
        if (!item || item.sourceKind !== 'direct') {
          res.status(200).json({ streams: [] } as any);
          return;
        }

        const directStreams =
          item.indexer === 'EPorner'
            ? await resolveEpornerCurrent(item)
            : await resolveAdultDirectStreams(item);

        const streams = directStreams.map((stream) => ({
          name: `Master • ${stream.name}`,
          title: item.title,
          url: stream.url,
          behaviorHints: {
            bingeGroup: `master-adult-direct-${item.indexer}-${item.sourceId || 'video'}`,
            proxyHeaders: {
              request: {
                'User-Agent': DIRECT_USER_AGENT,
                ...(stream.referer ? { Referer: stream.referer } : {}),
              },
            },
          },
        }));

        res.status(200).json({ streams } as any);
        return;
      } catch (error) {
        logger.error('Master adult direct stream resolution failed', error);
        res.status(200).json({ streams: [] } as any);
        return;
      }
    }

    const transformer = new StremioTransformer(req.userData);

    const provideSetting = appConfig.api.provideStreamData;
    const provideStreamData =
      provideSetting === null
        ? (req.headers['user-agent']?.includes('AIOStreams/') ?? false)
        : typeof provideSetting === 'boolean'
          ? provideSetting
          : provideSetting.includes(req.requestIp || '');

    try {
      const aiostreams = await new AIOStreams(req.userData).initialise();

      const disableAutoplay = await aiostreams.shouldStopAutoPlay(type, id);

      const response = await aiostreams.getStreams(id, type);
      const streamContext = aiostreams.getStreamContext();

      if (!streamContext) {
        throw new Error('Stream context not available');
      }

      res
        .status(200)
        .json(
          await transformer.transformStreams(
            response,
            streamContext.toFormatterContext(response.data.streams),
            { provideStreamData, disableAutoplay }
          )
        );
    } catch (error) {
      let errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      let errors = [
        {
          description: errorMessage,
        },
      ];
      if (transformer.showError('stream', errors)) {
        logger.error(
          `Unexpected error during stream retrieval: ${errorMessage}`,
          error
        );
        res.status(200).json(
          StremioTransformer.createDynamicError('stream', {
            errorDescription: errorMessage,
          })
        );
        return;
      }
      next(error);
    }
  }
);

export default router;
