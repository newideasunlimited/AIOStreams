import express, { Express } from 'express';
import {
  userApi,
  profilesApi,
  healthApi,
  statusApi,
  formatApi,
  catalogApi,
  postersApi,
  gdriveApi,
  debridApi,
  searchApi,
  animeApi,
  proxyApi,
  templatesApi,
  syncApi,
  linkedAccountsApi,
  authApi,
  dashboardApi,
  usenetApi,
  communityApi,
} from './routes/api/index.js';
import {
  configure,
  manifest,
  stream,
  catalog,
  meta,
  subtitle,
  addonCatalog,
  alias,
} from './routes/stremio/index.js';
import {
  manifest as chillLinkManifest,
  streams as chillLinkStreams,
} from './routes/chilllink/index.js';
import seanimeExtensionsRouter from './routes/seanime/extensions.js';
import sabnzbdRouter from './routes/api/sabnzbd.js';
import publicBlocklistRouter from './routes/blocklist.js';
import publicCommunityRouter from './routes/community.js';
import { createNabRouter } from './routes/api/nab.js';
import {
  gdrive,
  torboxSearch,
  torznab,
  newznab,
  prowlarr,
  knaben,
  eztv,
  therarbg,
  torrentGalaxy,
  seadex,
  easynews,
  masterNative,
  library,
} from './routes/builtins/index.js';
import {
  ipMiddleware,
  loggerMiddleware,
  userDataMiddleware,
  errorMiddleware,
  corsMiddleware,
  staticRateLimiter,
  linkedAccountsRateLimiter,
  communityApiRateLimiter,
  internalMiddleware,
  requireSessionIfAuthRequired,
} from './middlewares/index.js';
import { isTrustedIp } from './middlewares/ip.js';

import {
  config as appConfig,
  constants,
  createLogger,
  Env,
  VARIANT_PATH_ROUTE,
} from '@aiostreams/core';
import { StremioTransformer } from '@aiostreams/core';
import { createResponse } from './utils/responses.js';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
const app: Express = express();
app.set('trust proxy', (addr: string) => isTrustedIp(addr));
const logger = createLogger('server');

export enum StaticFiles {
  DOWNLOAD_FAILED = 'download_failed.mp4',
  DOWNLOADING = 'downloading.mp4',
  UNAVAILABLE_FOR_LEGAL_REASONS = 'unavailable_for_legal_reasons.mp4',
  STORE_LIMIT_EXCEEDED = 'store_limit_exceeded.mp4',
  CONTENT_PROXY_LIMIT_REACHED = 'content_proxy_limit_reached.mp4',
  INTERNAL_SERVER_ERROR = '500.mp4',
  TOO_MANY_REQUESTS = '429.mp4',
  FORBIDDEN = '403.mp4',
  UNAUTHORIZED = '401.mp4',
  NO_MATCHING_FILE = 'no_matching_file.mp4',
  PAYMENT_REQUIRED = 'payment_required.mp4',
  OK = '200.mp4',
}

export function mapDebridErrorToStaticFile(code: string | undefined): string {
  switch (code) {
    case 'UNAVAILABLE_FOR_LEGAL_REASONS':
      return StaticFiles.UNAVAILABLE_FOR_LEGAL_REASONS;
    case 'STORE_LIMIT_EXCEEDED':
      return StaticFiles.STORE_LIMIT_EXCEEDED;
    case 'PAYMENT_REQUIRED':
      return StaticFiles.PAYMENT_REQUIRED;
    case 'TOO_MANY_ACTIVE_CONNECTIONS':
      return StaticFiles.CONTENT_PROXY_LIMIT_REACHED;
    case 'TOO_MANY_REQUESTS':
      return StaticFiles.TOO_MANY_REQUESTS;
    case 'FORBIDDEN':
      return StaticFiles.FORBIDDEN;
    case 'UNAUTHORIZED':
      return StaticFiles.UNAUTHORIZED;
    case 'UNPROCESSABLE_ENTITY':
    case 'UNSUPPORTED_MEDIA_TYPE':
    case 'STORE_MAGNET_INVALID':
    case 'DOWNLOAD_FAILED':
    case 'BAD_GATEWAY':
    case 'GONE':
      return StaticFiles.DOWNLOADING;
    case 'NO_MATCHING_FILE':
      return StaticFiles.NO_MATCHING_FILE;
    case 'SERVICE_UNAVAILABLE':
      return StaticFiles.DOWNLOAD_FAILED;
    case 'TIMEOUT':
      return StaticFiles.DOWNLOADING;
    default:
      return StaticFiles.INTERNAL_SERVER_ERROR;
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const frontendRoot = path.join(__dirname, '../../frontend/dist');
export const staticRoot = path.join(__dirname, './static');

app.use(ipMiddleware);
app.use(loggerMiddleware);
let jsonParser: express.RequestHandler | undefined;
app.use((req, res, next) => {
  jsonParser ??= express.json({ limit: appConfig.api.maxJsonBodySize });
  jsonParser(req, res, next);
});
app.use(express.urlencoded({ extended: true }));

if (appConfig.bootstrap.nodeEnv === 'development') {
  logger.info('CORS enabled for all origins in development');
  app.use(corsMiddleware);
}

const apiRouter = express.Router();
apiRouter.use('/user', userApi);
apiRouter.use('/profiles', profilesApi);
apiRouter.use('/health', healthApi);
apiRouter.use('/status', statusApi);
apiRouter.use('/format', formatApi);
apiRouter.use('/catalogs', catalogApi);
apiRouter.use('/posters', postersApi);
apiRouter.use('/oauth/exchange/gdrive', gdriveApi);
apiRouter.use('/debrid', debridApi);
apiRouter.use(
  '/search',
  (req, res, next) => {
    if (!appConfig.api.enableSearchApi) {
      res.status(403).json({ error: 'Search API is disabled', success: false });
      return;
    }
    next();
  },
  searchApi
);
apiRouter.use('/anime', animeApi);
apiRouter.use('/proxy', proxyApi);
apiRouter.use('/templates', templatesApi);
apiRouter.use('/sync', syncApi);
apiRouter.use('/linked-accounts', linkedAccountsRateLimiter, linkedAccountsApi);
apiRouter.use('/community', communityApiRateLimiter, communityApi);
apiRouter.use('/auth', authApi);
apiRouter.use('/dashboard', dashboardApi);
apiRouter.use('/usenet', usenetApi);
apiRouter.use('/sabnzbd', sabnzbdRouter);
apiRouter.use('/newznab', createNabRouter('newznab'));
apiRouter.use('/torznab', createNabRouter('torznab'));
apiRouter.use((req, res) => {
  res.status(404).json(
    createResponse({
      success: false,
      detail: 'Not Found',
    })
  );
});

app.use(`/api/v${constants.API_VERSION}`, apiRouter);

// Stremio is a chatty client: one browse/play action can fan out into many
// manifest/catalog/meta/stream requests, and TV/web/desktop clients can all
// share one apparent IP behind Cloudflare. This private self-hosted build must
// never reject normal playback because of AIOStreams' own request counters.
// Keep auth/API/static protections, but do not rate-limit Stremio resources.
const stremioRouter = express.Router({ mergeParams: true });
stremioRouter.use(corsMiddleware);
stremioRouter.use('/manifest.json', manifest);
stremioRouter.use('/stream', stream);
stremioRouter.use('/configure', requireSessionIfAuthRequired, configure);
stremioRouter.use('/u', alias);

const stremioAuthRouter = express.Router({ mergeParams: true });
stremioAuthRouter.use(corsMiddleware);
stremioAuthRouter.use(userDataMiddleware);
stremioAuthRouter.use('/manifest.json', manifest);
stremioAuthRouter.use('/stream', stream);
stremioAuthRouter.use('/configure', requireSessionIfAuthRequired, configure);
stremioAuthRouter.use('/meta', meta);
stremioAuthRouter.use('/catalog', catalog);
stremioAuthRouter.use('/subtitles', subtitle);
stremioAuthRouter.use('/addon_catalog', addonCatalog);

app.use('/stremio', stremioRouter);
app.use(
  `/stremio/:uuid/:encryptedPassword${VARIANT_PATH_ROUTE}`,
  stremioAuthRouter
);
app.use('/stremio/:uuid/:encryptedPassword', stremioAuthRouter);

const chillLinkRouter = express.Router({ mergeParams: true });
chillLinkRouter.use(corsMiddleware);
chillLinkRouter.use(userDataMiddleware);
chillLinkRouter.use('/manifest', chillLinkManifest);
chillLinkRouter.use('/streams', chillLinkStreams);
app.use(
  `/chilllink/:uuid/:encryptedPassword${VARIANT_PATH_ROUTE}`,
  chillLinkRouter
);
app.use('/chilllink/:uuid/:encryptedPassword', chillLinkRouter);

const seanimeRouter = express.Router({ mergeParams: true });
seanimeRouter.use(corsMiddleware);
seanimeRouter.use(seanimeExtensionsRouter);
app.use('/seanime', seanimeRouter);

const builtinsRouter = express.Router();
builtinsRouter.use(internalMiddleware);
builtinsRouter.use('/gdrive', gdrive);
builtinsRouter.use('/torbox-search', torboxSearch);
builtinsRouter.use('/torznab', torznab);
builtinsRouter.use('/newznab', newznab);
builtinsRouter.use('/prowlarr', prowlarr);
builtinsRouter.use('/knaben', knaben);
builtinsRouter.use('/eztv', eztv);
builtinsRouter.use('/therarbg', therarbg);
builtinsRouter.use('/torrent-galaxy', torrentGalaxy);
builtinsRouter.use('/seadex', seadex);
builtinsRouter.use('/easynews', easynews);
builtinsRouter.use('/master-native', masterNative);
builtinsRouter.use('/library', library);
app.use('/builtins', builtinsRouter);

app.use('/blocklist', publicBlocklistRouter);
app.use('/community', publicCommunityRouter);

app.use(
  '/assets',
  express.static(path.join(frontendRoot, 'assets'), {
    immutable: true,
    maxAge: '1y',
  })
);

app.get('/logo.png', staticRateLimiter, (req, res, next) => {
  const filePath = path.resolve(
    frontendRoot,
    appConfig.branding.alternateDesign ? 'logo_alt.png' : 'logo.png'
  );
  if (filePath.startsWith(frontendRoot) && fs.existsSync(filePath)) {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.sendFile(filePath);
    return;
  }
  next();
});
app.get(
  [
    '/favicon.ico',
    '/manifest.json',
    '/web-app-manifest-192x192.png',
    '/web-app-manifest-512x512.png',
    '/apple-icon.png',
    '/mini-nightly-white.png',
    '/mini-stable-white.png',
    '/icon0.svg',
    '/icon1.png',
    '/logo_alt.png',
  ],
  staticRateLimiter,
  express.static(frontendRoot, { index: false, maxAge: '1h' })
);

app.use('/static', corsMiddleware, express.static(staticRoot));

app.get(
  '{/:config}/stream/:type/:id.json',
  (req, res) => {
    const baseUrl =
      appConfig.bootstrap.baseUrl ||
      `${req.protocol}://${req.hostname}${
        req.hostname === 'localhost' ? `:${appConfig.bootstrap.port}` : ''
      }`;
    res.json({
      streams: [
        StremioTransformer.createErrorStream({
          errorDescription:
            'AIOStreams v2 requires you to reconfigure. Please click this stream to reconfigure.',
          errorUrl: `${baseUrl}/stremio/configure`,
        }),
      ],
    });
  }
);

app.get('{/:config}/configure', (req, res) => {
  res.redirect('/stremio/configure');
});

app.get('/configure', (req, res) => {
  res.redirect('/stremio/configure');
});

const SPA_STATIC_ROUTES = [
  '/',
  '/login',
  '/oauth/callback/gdrive',
  '/splashscreen',
  '/stremio/configure',
];

const SPA_DYNAMIC_PATTERNS: RegExp[] = [
  /^\/stremio\/[^/]+\/[^/]+\/configure$/,
  /^\/dashboard(\/.*)?$/,
];

function isValidSpaRoute(routePath: string): boolean {
  if (SPA_STATIC_ROUTES.includes(routePath)) {
    return true;
  }
  return SPA_DYNAMIC_PATTERNS.some((pattern) => pattern.test(routePath));
}

app.get('*splat', staticRateLimiter, (req, res, next) => {
  if (req.method !== 'GET' || !req.accepts('html')) {
    next();
    return;
  }
  const indexPath = path.join(frontendRoot, 'index.html');
  if (fs.existsSync(indexPath)) {
    const status = isValidSpaRoute(req.path) ? 200 : 404;
    res
      .status(status)
      .setHeader('Cache-Control', 'no-cache')
      .sendFile(indexPath);
    return;
  }
  next();
});

app.use(errorMiddleware);

export default app;
