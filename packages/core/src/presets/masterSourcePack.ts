import { Addon, Option, UserData } from '../db/index.js';
import { constants } from '../utils/index.js';
import { Preset } from './preset.js';
import { KnabenPreset } from './knaben.js';
import { EztvPreset } from './eztv.js';
import { TheRARBGPreset } from './therarbg.js';
import { TorrentGalaxyPreset } from './torrentGalaxy.js';
import { AnimeToshoPreset } from './animetosho.js';
import { NekoBtPreset } from './nekoBt.js';

/**
 * Master Source Pack
 *
 * A single configuration preset that expands into AIOStreams' own built-in
 * source adapters. These adapters run through this AIOStreams instance and do
 * not require the corresponding third-party Stremio addons to be installed in
 * Stremio. Real-Debrid (or another supported service) is supplied from the
 * user's configured AIOStreams services.
 */
export class MasterSourcePackPreset extends Preset {
  static override get METADATA() {
    const options: Option[] = [
      {
        id: 'includeGeneral',
        name: 'General sources',
        description: 'Enable the built-in general movie/TV source adapters.',
        type: 'boolean',
        default: true,
      },
      {
        id: 'includeAnime',
        name: 'Anime sources',
        description: 'Enable the built-in anime source adapters.',
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
      USER_AGENT: 'AIOStreams-Master-Addon',
      SUPPORTED_SERVICES: KnabenPreset.METADATA.SUPPORTED_SERVICES,
      DESCRIPTION:
        'One preset that enables this server\'s built-in source adapters for broad movie, TV and anime coverage.',
      OPTIONS: options,
      SUPPORTED_STREAM_TYPES: [constants.DEBRID_STREAM_TYPE],
      SUPPORTED_RESOURCES: [constants.STREAM_RESOURCE],
      BUILTIN: true,
    };
  }

  static async generateAddons(
    userData: UserData,
    options: Record<string, any>
  ): Promise<Addon[]> {
    const addons: Addon[] = [];
    const general = options.includeGeneral ?? true;
    const anime = options.includeAnime ?? true;
    const includeNekoBt = options.includeNekoBt ?? true;

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
      addons.push(
        ...(await AnimeToshoPreset.generateAddons(userData, {
          name: 'Master | AnimeTosho',
          mediaTypes: ['anime'],
          useMultipleInstances: false,
        }))
      );

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

    // Keep the child preset metadata intact. AIOStreams will use each child's
    // parser and built-in endpoint, while the user only has to add this one
    // preset to their Master Add-On configuration.
    return addons;
  }
}
