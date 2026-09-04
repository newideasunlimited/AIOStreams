import { Request, Response, NextFunction } from 'express';

/**
 * Master Add-On is a private self-hosted instance. Application-level request
 * throttling only causes the owner's Stremio clients to rate-limit each other,
 * especially when several clients share one public/proxy IP. Keep the exported
 * middleware names for route compatibility, but make every limiter a no-op.
 */
const noRateLimit = (_req: Request, _res: Response, next: NextFunction) => next();

const userApiRateLimiter = noRateLimit;
const userCreateRateLimiter = noRateLimit;
const linkedAccountsRateLimiter = noRateLimit;
const communityApiRateLimiter = noRateLimit;
const streamApiRateLimiter = noRateLimit;
const formatApiRateLimiter = noRateLimit;
const catalogApiRateLimiter = noRateLimit;
const animeApiRateLimiter = noRateLimit;
const stremioStreamRateLimiter = noRateLimit;
const stremioCatalogRateLimiter = noRateLimit;
const stremioManifestRateLimiter = noRateLimit;
const stremioSubtitleRateLimiter = noRateLimit;
const stremioMetaRateLimiter = noRateLimit;
const staticRateLimiter = noRateLimit;
const loginRateLimiter = noRateLimit;
const oidcRateLimiter = noRateLimit;

export {
  userApiRateLimiter,
  userCreateRateLimiter,
  linkedAccountsRateLimiter,
  communityApiRateLimiter,
  streamApiRateLimiter,
  formatApiRateLimiter,
  catalogApiRateLimiter,
  animeApiRateLimiter,
  stremioStreamRateLimiter,
  stremioCatalogRateLimiter,
  stremioManifestRateLimiter,
  stremioSubtitleRateLimiter,
  stremioMetaRateLimiter,
  staticRateLimiter,
  loginRateLimiter,
  oidcRateLimiter,
};
