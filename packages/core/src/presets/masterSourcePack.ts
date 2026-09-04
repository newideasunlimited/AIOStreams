import { Addon, Option, Resource, UserData } from '../db/index.js';
import { constants } from '../utils/index.js';
import { Preset } from './preset.js';
import { MasterNativePreset } from './masterNative.js';
import { AnimeToshoPreset } from './animetosho.js';
import { NekoBtPreset } from './nekoBt.js';
import { SeaDexPreset } from './seadex.js';
import { LibraryPreset } from './library.js';
import { USATVNextPreset } from './usaTvNext.js';
import { ArgentinaTVPreset } from './argentinaTv.js';
import { StreamingCatalogsPreset } from './streamingCatalogs.js';
import { OpenSubtitlesPreset } from './opensubtitles.js';

/**
 * Master Source Pack
 *
 * Stremio installs one Master Add-On manifest. General movie/TV scraping is
 * handled by the self-hosted Master Native engine. Additional Stremio features
 * are folded into the same Master manifest so users do not need a pile of
 * separately-installed addons.
 */
export class MasterSourcePackPreset extends Preset {
  static override get METADATA() {
    const options: Option[] = [
      {
        id: 'includeGeneral',
        name: 'General sources',
        description: 'Enable the self-hosted Master native movie/TV source engine.',
        type: 'boolean',
        default: true,
      },
      {
        id: 'includeLibrary',
        name: 'Real-Debrid library',
        description: 'Expose your configured debrid library through Master.',
        type: 'boolean',
        default: true,
      },
      {
        id: 'includeAnime',
        name: 'Anime sources',
        description: 'Enable anime source adapters.',
        type: 'boolean',
        default: true,
      },
      {
        id: 'includeNekoBt',
        name: 'nekoBT',
        description: 'Include nekoBT. Its API key is optional.',
        type: 'boolean',
        default: true,
      },
      {
        id: 'nekoBtApiKey',
        name: 'nekoBT API Key',
        description: 'Optional nekoBT API key.',
        type: 'password',
        required: false,
        showInSimpleMode: false,
      },
      {
        id: 'includeLiveTv',
        name: 'Live TV',
        description: 'Add live television catalogs and direct channel streams to Master.',
        type: 'boolean',
        default: true,
      },
      {
        id: 'includeArgentinaTv',
        name: 'Argentina TV',
        description: 'Include the Argentina live television catalog in addition to USA TV.',
        type: 'boolean',
        default: true,
        showInSimpleMode: false,
      },
      {
        id: 'includeStreamingCatalogs',
        name: 'Streaming service catalogs',
        description: 'Add discovery rows for major streaming services to the Master catalog.',
        type: 'boolean',
        default: true,
      },
      {
        id: 'includeSubtitles',
        name: 'Subtitles',
        description: 'Include OpenSubtitles results through the Master manifest.',
        type: 'boolean',
        default: true,
      },
    ];
    const supportedResources: Resource[] = [
      constants.STREAM_RESOURCE,
      constants.CATALOG_RESOURCE,
      constants.META_RESOURCE,
      constants.SUBTITLES_RESOURCE,
    ];

    return {
      ID: 'master-source-pack',
      NAME: 'Master Source Pack',
      LOGO: '/assets/logo.png',
      URL: [],
      TIMEOUT: 7000,
      USER_AGENT: 'Master-Addon',
      SUPPORTED_SERVICES: MasterNativePreset.METADATA.SUPPORTED_SERVICES,
      DESCRIPTION:
        'Master source layer for movies, TV, anime, adult, live TV, streaming catalogs, subtitles and debrid-library streams.',
      OPTIONS: options,
      SUPPORTED_STREAM_TYPES: [
        constants.DEBRID_STREAM_TYPE,
        constants.LIVE_STREAM_TYPE,
      ],
      SUPPORTED_RESOURCES: supportedResources,
      BUILTIN: true,
    };
  }

  static async generateAddons(
    userData: UserData,
    options: Record<string, any>
  ): Promise<Addon[]> {
    const addons: Addon[] = [];
    const general = options.includeGeneral ?? true;
    const includeLibrary = options.includeLibrary ?? true;
    const anime = options.includeAnime ?? true;
    const includeNekoBt = options.includeNekoBt ?? true;
    const includeLiveTv = options.includeLiveTv ?? true;
    const includeArgentinaTv = options.includeArgentinaTv ?? true;
    const includeStreamingCatalogs = options.includeStreamingCatalogs ?? true;
    const includeSubtitles = options.includeSubtitles ?? true;

    if (general) {
      addons.push(
        ...(await MasterNativePreset.generateAddons(userData, {
          name: 'Master',
          timeout: 7000,
        }))
      );
    }

    if (includeLibrary) {
      addons.push(
        ...(await LibraryPreset.generateAddons(userData, {
          name: 'Master',
          resources: [constants.STREAM_RESOURCE],
          mediaTypes: [],
          sources: ['torrent'],
          showRefreshActions: [],
          skipProcessing: false,
          hideStreams: false,
          useMultipleInstances: false,
        }))
      );
    }

    if (anime) {
      const generated = await Promise.all([
        AnimeToshoPreset.generateAddons(userData, {
          name: 'Master',
          mediaTypes: ['anime'],
          useMultipleInstances: false,
        }),
        SeaDexPreset.generateAddons(userData, {
          name: 'Master',
          mediaTypes: ['anime'],
        }),
      ]);
      generated.forEach((group) => addons.push(...group));

      if (includeNekoBt) {
        addons.push(
          ...(await NekoBtPreset.generateAddons(userData, {
            name: 'Master',
            mediaTypes: ['anime'],
            apiKey: options.nekoBtApiKey || undefined,
            searchMode: 'both',
            useMultipleInstances: false,
            leaveAutoTitleTagsInFilename: false,
          }))
        );
      }
    }

    if (includeLiveTv) {
      addons.push(
        ...(await USATVNextPreset.generateAddons(userData, {
          name: 'Master • Live TV',
          resources: [
            constants.CATALOG_RESOURCE,
            constants.META_RESOURCE,
            constants.STREAM_RESOURCE,
          ],
        }))
      );

      if (includeArgentinaTv) {
        addons.push(
          ...(await ArgentinaTVPreset.generateAddons(userData, {
            name: 'Master • Argentina TV',
            resources: [
              constants.CATALOG_RESOURCE,
              constants.META_RESOURCE,
              constants.STREAM_RESOURCE,
            ],
          }))
        );
      }
    }

    if (includeStreamingCatalogs) {
      addons.push(
        ...(await StreamingCatalogsPreset.generateAddons(userData, {
          name: 'Master • Streaming',
          resources: [constants.CATALOG_RESOURCE],
          catalogs: [
            'nfx',
            'hbm',
            'dnp',
            'amp',
            'atp',
            'pmp',
            'pcp',
            'hlu',
            'cru',
            'stz',
            'dpe',
            'mbi',
          ],
        }))
      );
    }

    if (includeSubtitles) {
      addons.push(
        ...(await OpenSubtitlesPreset.generateAddons(userData, {
          name: 'Master • Subtitles',
          resources: [constants.SUBTITLES_RESOURCE],
        }))
      );
    }

    return addons;
  }
}
