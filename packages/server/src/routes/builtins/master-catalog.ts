import { Router, Request, Response, NextFunction } from 'express';
import { fromUrlSafeBase64, makeRequest } from '@aiostreams/core';

const router: Router = Router();
const TMDB_API = 'https://api.themoviedb.org/3';
const IMAGE_BASE = 'https://image.tmdb.org/t/p/w500';
const BACKDROP_BASE = 'https://image.tmdb.org/t/p/original';

interface MasterCatalogConfig {
  apiKey?: string;
  accessToken?: string;
  language?: string;
  includeAdult?: boolean;
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parseConfig(encodedConfig: string): MasterCatalogConfig {
  const config = JSON.parse(fromUrlSafeBase64(encodedConfig));
  if (!config.apiKey && !config.accessToken) {
    throw new Error('Master catalogs require a TMDB API key or access token');
  }
  return config;
}

function tmdbUrl(
  path: string,
  config: MasterCatalogConfig,
  params: Record<string, string | number | boolean | undefined> = {}
): URL {
  const url = new URL(`${TMDB_API}${path}`);
  if (config.apiKey) url.searchParams.set('api_key', config.apiKey);
  url.searchParams.set('language', config.language || 'en-US');
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url;
}

async function tmdbRequest<T>(
  path: string,
  config: MasterCatalogConfig,
  params: Record<string, string | number | boolean | undefined> = {}
): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (config.accessToken) headers.Authorization = `Bearer ${config.accessToken}`;

  const response = await makeRequest(tmdbUrl(path, config, params).toString(), {
    timeout: 10000,
    headers,
  });
  if (!response.ok) {
    throw new Error(`TMDB request failed: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

function yearFrom(value?: string | null): string | undefined {
  if (!value) return undefined;
  return value.slice(0, 4) || undefined;
}

function mapCatalogItem(item: any, type: 'movie' | 'series') {
  const name = type === 'movie' ? item.title : item.name;
  const date = type === 'movie' ? item.release_date : item.first_air_date;
  return {
    id: `tmdb:${item.id}`,
    type,
    name,
    poster: item.poster_path ? `${IMAGE_BASE}${item.poster_path}` : undefined,
    background: item.backdrop_path
      ? `${BACKDROP_BASE}${item.backdrop_path}`
      : undefined,
    description: item.overview || undefined,
    releaseInfo: yearFrom(date),
    imdbRating:
      typeof item.vote_average === 'number' && item.vote_average > 0
        ? item.vote_average.toFixed(1)
        : undefined,
  };
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
      const catalogs = [
        ['movie', 'master.trending.movie', 'Master • Trending Movies'],
        ['series', 'master.trending.series', 'Master • Trending Series'],
        ['movie', 'master.popular.movie', 'Master • Popular Movies'],
        ['series', 'master.popular.series', 'Master • Popular Series'],
        ['movie', 'master.top.movie', 'Master • Top Rated Movies'],
        ['series', 'master.top.series', 'Master • Top Rated Series'],
      ].map(([type, id, name]) => ({
        type,
        id,
        name,
        extra: [{ name: 'skip', isRequired: false }],
      }));

      res.json({
        id: 'com.newideasunlimited.master.catalogs',
        version: '1.0.0',
        name: 'Master Add-On',
        description: 'Native discovery catalogs served by the self-hosted Master Add-On.',
        resources: ['catalog', 'meta'],
        types: ['movie', 'series'],
        catalogs,
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
      const config = parseConfig(encodedConfig);
      const type = firstParam(req.params.type) === 'series' ? 'series' : 'movie';
      const extras = parseExtras(firstParam(req.params.extras));
      const skip = Math.max(0, Number(extras.skip || 0) || 0);
      const page = Math.floor(skip / 20) + 1;
      const includeAdult = config.includeAdult ?? false;

      let path: string;
      switch (firstParam(req.params.id)) {
        case 'master.trending.movie':
          path = '/trending/movie/week';
          break;
        case 'master.trending.series':
          path = '/trending/tv/week';
          break;
        case 'master.popular.movie':
          path = '/movie/popular';
          break;
        case 'master.popular.series':
          path = '/tv/popular';
          break;
        case 'master.top.movie':
          path = '/movie/top_rated';
          break;
        case 'master.top.series':
          path = '/tv/top_rated';
          break;
        default:
          res.json({ metas: [] });
          return;
      }

      const data = await tmdbRequest<{ results: any[] }>(path, config, {
        page,
        include_adult: includeAdult,
      });
      res.json({
        metas: (data.results || []).map((item) => mapCatalogItem(item, type)),
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
      const config = parseConfig(encodedConfig);
      const type = firstParam(req.params.type) === 'series' ? 'series' : 'movie';
      const idValue = firstParam(req.params.id) || '';
      const idMatch = idValue.match(/^tmdb:(\d+)(?::(\d+):(\d+))?$/);
      if (!idMatch) {
        res.json({ meta: null });
        return;
      }
      const tmdbId = idMatch[1];

      if (type === 'movie') {
        const item = await tmdbRequest<any>(`/movie/${tmdbId}`, config, {
          append_to_response: 'external_ids',
        });
        res.json({
          meta: {
            ...mapCatalogItem(item, 'movie'),
            runtime: item.runtime ? `${item.runtime} min` : undefined,
            genres: Array.isArray(item.genres)
              ? item.genres.map((g: any) => g.name)
              : undefined,
          },
        });
        return;
      }

      const item = await tmdbRequest<any>(`/tv/${tmdbId}`, config, {
        append_to_response: 'external_ids',
      });
      const seasons = (item.seasons || [])
        .filter((season: any) => season.season_number >= 0 && season.episode_count > 0)
        .map((season: any) => season.season_number);

      const seasonData = await Promise.all(
        seasons.map((season: number) =>
          tmdbRequest<any>(`/tv/${tmdbId}/season/${season}`, config).catch(() => null)
        )
      );
      const videos = seasonData.flatMap((season: any) =>
        (season?.episodes || []).map((episode: any) => ({
          id: `tmdb:${tmdbId}:${episode.season_number}:${episode.episode_number}`,
          title: episode.name || `Episode ${episode.episode_number}`,
          season: episode.season_number,
          episode: episode.episode_number,
          released: episode.air_date ? `${episode.air_date}T00:00:00.000Z` : undefined,
          thumbnail: episode.still_path
            ? `${IMAGE_BASE}${episode.still_path}`
            : undefined,
          overview: episode.overview || undefined,
        }))
      );

      res.json({
        meta: {
          ...mapCatalogItem(item, 'series'),
          genres: Array.isArray(item.genres)
            ? item.genres.map((g: any) => g.name)
            : undefined,
          videos,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
