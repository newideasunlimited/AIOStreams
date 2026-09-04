import { Addon, Option, UserData } from '../db/index.js';
import { appConfig, constants } from '../utils/index.js';
import { StremThruPreset } from './stremthru.js';
import { BuiltinAddonPreset } from './builtin.js';

export class MasterNativePreset extends BuiltinAddonPreset {
  static override get METADATA() {
    const options: Option[] = [
      {
        id: 'name',
        name: 'Name',
        description: 'Internal Master source engine name.',
        type: 'string',
        required: true,
        default: 'Master',
      },
      {
        id: 'timeout',
        name: 'Timeout (ms)',
        description: 'Maximum time Master waits for its native source engine.',
        type: 'number',
        required: true,
        default: 7000,
        constraints: {
          min: appConfig.userLimits.timeouts.minTimeout,
          max: appConfig.userLimits.timeouts.maxTimeout,
          forceInUi: false,
        },
      },
    ];

    return {
      ID: 'master-native',
      NAME: 'Master Native',
      LOGO: '/assets/logo.png',
      URL: [`${appConfig.bootstrap.internalUrl}/builtins/master-native`],
      TIMEOUT: 7000,
      USER_AGENT: 'Master-Addon',
      SUPPORTED_SERVICES: StremThruPreset.supportedServices,
      DESCRIPTION:
        'Self-hosted movie, TV, anime and adult source engine owned by Master Add-On.',
      OPTIONS: options,
      SUPPORTED_STREAM_TYPES: [constants.DEBRID_STREAM_TYPE],
      SUPPORTED_RESOURCES: [constants.STREAM_RESOURCE, 'catalog', 'meta'],
      BUILTIN: true,
    };
  }

  static async generateAddons(
    userData: UserData,
    options: Record<string, any>
  ): Promise<Addon[]> {
    const usableServices = this.getUsableServices(
      userData,
      options.services,
      options.name
    );
    if (!usableServices || usableServices.length === 0) {
      throw new Error('Master Native requires at least one usable debrid service.');
    }

    const config = this.getBaseConfig(
      userData,
      usableServices.map((service) => service.id)
    );

    return [
      {
        name: options.name || 'Master',
        manifestUrl: `${appConfig.bootstrap.internalUrl}/builtins/master-native/${this.base64EncodeJSON(config, 'urlSafe')}/manifest.json`,
        identifier: 'native',
        displayIdentifier: 'Native',
        enabled: true,
        library: false,
        resources: [constants.STREAM_RESOURCE, 'catalog', 'meta'],
        mediaTypes: [],
        timeout: options.timeout || 7000,
        preset: {
          id: '',
          type: 'master-source-pack',
          options,
        },
        headers: {
          'User-Agent': 'Master-Addon',
        },
      },
    ];
  }
}
