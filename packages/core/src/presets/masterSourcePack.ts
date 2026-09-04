import { Addon, Option, UserData } from '../db/index.js';
import { constants } from '../utils/index.js';
import { Preset } from './preset.js';
import { MasterNativePreset } from './masterNative.js';
import { AnimeToshoPreset } from './animetosho.js';
import { NekoBtPreset } from './nekoBt.js';
import { SeaDexPreset } from './seadex.js';
import { LibraryPreset } from './library.js';

/**
 * Master Source Pack
 *
 * Stremio installs one Master Add-On manifest. General movie/TV scraping is
 * handled by the self-hosted Master Native engine, which talks directly to
 * source indexes instead of chaining to hosted Stremio addons.
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
        'Self-hosted Master Add-On source layer for movie, TV, anime and debrid-library streams.',
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
    const includeLibrary = options.includeLibrary ?? true;
    const anime = options.includeAnime ?? true;
    const includeNekoBt = options.includeNekoBt ?? true;

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

    return addons;
  }
}
