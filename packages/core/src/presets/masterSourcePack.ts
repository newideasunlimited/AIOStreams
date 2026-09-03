import { Addon, Option, UserData } from '../db/index.js';
import { constants } from '../utils/index.js';
import { Preset } from './preset.js';
import { KnabenPreset } from './knaben.js';
import { EztvPreset } from './eztv.js';
import { TheRARBGPreset } from './therarbg.js';
import { TorrentGalaxyPreset } from './torrentGalaxy.js';
import { AnimeToshoPreset } from './animetosho.js';
import { NekoBtPreset } from './nekoBt.js';
import { SeaDexPreset } from './seadex.js';
import { LibraryPreset } from './library.js';

/**
 * Master Source Pack
 *
 * A single native source layer for the Master Add-On. The child adapters are
 * all hosted by this same AIOStreams instance. Stremio only sees the Master
 * Add-On manifest; it does not need the child addons installed separately.
 */
export class MasterSourcePackPreset extends Preset {
  static override get METADATA() {
    const options: Option[] = [
      {
        id: 'includeGeneral',
        name: 'General sources',
        description: 'Enable built-in movie and TV source adapters.',
        type: 'boolean',
        default: true,
      },
      {
        id: 'includeLibrary',
        name: 'Real-Debrid library',
        description:
          'Expose your configured debrid library as native Master Add-On catalogs, metadata and streams.',
        type: 'boolean',
        default: true,
      },
      {
        id: 'includeAnime',
        name: 'Anime sources',
        description: 'Enable built-in anime source adapters.',
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
    ];

    return {
      ID: 'master-source-pack',
      NAME: 'Master Source Pack',
      LOGO: '/assets/logo.png',
      URL: [],
      TIMEOUT: 15000,
      USER_AGENT: 'Master-Addon',
      SUPPORTED_SERVICES: KnabenPreset.METADATA.SUPPORTED_SERVICES,
      DESCRIPTION:
        'Native Master Add-On source layer for movie, TV, anime, debrid-library catalogs, metadata and streams.',
      OPTIONS: options,
      SUPPORTED_STREAM_TYPES: [constants.DEBRID_STREAM_TYPE],
      SUPPORTED_RESOURCES: [
        constants.STREAM_RESOURCE,
        constants.CATALOG_RESOURCE,
        constants.META_RESOURCE,
      ],
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

    if (includeLibrary) {
      addons.push(
        ...(await LibraryPreset.generateAddons(userData, {
          name: 'Master | Library',
          resources: [
            constants.STREAM_RESOURCE,
            constants.CATALOG_RESOURCE,
            constants.META_RESOURCE,
          ],
          mediaTypes: [],
          sources: ['torrent'],
          showRefreshActions: ['catalog'],
          skipProcessing: false,
          hideStreams: false,
          useMultipleInstances: false,
        }))
      );
    }

    if (general) {
      const generated = await Promise.all([
        KnabenPreset.generateAddons(userData, {
          name: 'Master | Knaben',
          mediaTypes: [],
          useMultipleInstances: false,
        }),
        TheRARBGPreset.generateAddons(userData, {
          name: 'Master | TheRARBG',
          mediaTypes: [],
          useMultipleInstances: false,
        }),
        TorrentGalaxyPreset.generateAddons(userData, {
          name: 'Master | TorrentGalaxy',
          mediaTypes: [],
          useMultipleInstances: false,
        }),
        EztvPreset.generateAddons(userData, {
          name: 'Master | EZTV',
          mediaTypes: ['series'],
          useMultipleInstances: false,
        }),
      ]);
      generated.forEach((group) => addons.push(...group));
    }

    if (anime) {
      const generated = await Promise.all([
        AnimeToshoPreset.generateAddons(userData, {
          name: 'Master | AnimeTosho',
          mediaTypes: ['anime'],
          useMultipleInstances: false,
        }),
        SeaDexPreset.generateAddons(userData, {
          name: 'Master | SeaDex',
          mediaTypes: ['anime'],
        }),
      ]);
      generated.forEach((group) => addons.push(...group));

      if (includeNekoBt) {
        addons.push(
          ...(await NekoBtPreset.generateAddons(userData, {
            name: 'Master | nekoBT',
            mediaTypes: ['anime'],
            apiKey: options.nekoBtApiKey || undefined,
            searchMode: 'both',
            useMultipleInstances: false,
            leaveAutoTitleTagsInFilename: false,
          }))
        );
      }
    }

    return addons;
  }
}
