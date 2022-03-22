import { exec } from 'child_process';
import store from '../store';
import { machineId as _machineId } from 'node-machine-id';
import extractZip from 'extract-zip';
import axios from 'axios';
import { platform, arch } from 'os';
import { join } from 'path';
import { stat } from 'fs/promises';
import { remote } from 'electron';
import settings from 'electron-settings';
import { updateActivity } from './discord';
import constants from '../constants';

import { downloadAndSaveFile } from './downloader';
import { downloadLunarAssets } from './assets';

import Logger from './logger';
const logger = new Logger('launcher');

import fs from './fs';

/**
 * Checks if the `.lunarclient` directory is valid
 */
export async function setupLunarClientDirectory() {
  logger.info('Checking .lunarclient directory');

  store.commit('setLaunchingState', {
    title: 'LAUNCHING...',
    message: 'CHECKING LC FOLDER...',
    icon: 'fa-solid fa-folder',
  });

  const folders = ['licenses', 'offline', 'jre'];

  if (!(await fs.exists(constants.DOTLUNARCLIENT))) {
    logger.debug('Creating .lunarclient directory...');
    await fs
      .mkdir(constants.DOTLUNARCLIENT)
      .then(() => {
        logger.debug('Created .lunarclient directory');
      })
      .catch((error) => {
        logger.error("Can't create .lunarclient directory", error);
      });
  }

  logger.debug('Checking .lunarclient subdirectories');

  for (const index in folders) {
    const folder = folders[index];

    // Launch state
    store.commit('setLaunchingState', {
      title: 'LAUNCHING...',
      message: `CHECKING SUBFOLDERS ${parseInt(index) + 1}/${folders.length}`,
      icon: 'fa-solid fa-folder',
    });

    if (!(await fs.exists(join(constants.DOTLUNARCLIENT, folder)))) {
      logger.debug(`Creating ${folder} subdirectory...`);
      await fs
        .mkdir(join(constants.DOTLUNARCLIENT, folder))
        .then(() => {
          logger.debug(`Created ${folder} subdirectory`);
        })
        .catch((error) => {
          logger.error(`Can't create ${folder} subdirectory`, error);
        });
    }
  }
}

/**
 * Fetches metadata from Lunar's API
 * @param {boolean} [skipLaunchingState=false] Skip or not the launching state
 * @returns {Promise<Object>}
 */
export async function fetchMetadata(skipLaunchingState = false) {
  if (!skipLaunchingState) {
    // Launch state
    store.commit('setLaunchingState', {
      title: 'LAUNCHING...',
      message: 'FETCHING METADATA...',
      icon: 'fa-solid fa-download',
    });
  }

  // Fetch metadata
  logger.info('Fetching metadata...');
  const machineId = await _machineId();
  const version = await settings.get('version');
  return new Promise((resolve, reject) => {
    axios
      .post(
        constants.links.LC_METADATA_ENDPOINT,
        {
          hwid: machineId,
          os: platform(),
          arch: arch(),
          version: version,
          branch: 'master',
          launch_type: 'OFFLINE',
          classifier: 'optifine',
        },
        { 'Content-Type': 'application/json', 'User-Agent': 'SolarTweaks' }
      )
      .then((response) => {
        logger.debug('Fetched metadata');
        resolve(response.data);
      })
      .catch((error) => {
        logger.error('Failed to fetch metadata', error);
        reject(error);
      });
  });
}

/**
 * Checks license (and downloads if needed)
 * @param {Object} metadata Metadata from Lunar's API
 * @returns {Promise<void>}
 */
export async function checkLicenses(metadata) {
  logger.info('Checking licenses...');
  store.commit('setLaunchingState', {
    title: 'LAUNCHING...',
    message: `CHECKING ${metadata.licenses.length} LICENSES ...`,
    icon: 'fa-solid fa-gavel',
  });
  for (const index in metadata.licenses) {
    const license = metadata.licenses[index];
    logger.debug(
      `Checking license ${parseInt(index) + 1}/${metadata.licenses.length}`
    );
    const licensePath = join(
      constants.DOTLUNARCLIENT,
      'licenses',
      license.file
    );

    if (!(await fs.exists(licensePath))) {
      await downloadAndSaveFile(
        license.url,
        join(constants.DOTLUNARCLIENT, 'licenses', license.file),
        'text',
        license.sha1,
        'sha1'
      ).catch((error) => {
        logger.error(`Failed to download ${license.file}`, error);
      });
    }
  }
}

/**
 * Checks the game files (and downloads if needed)
 * @param {Object} metadata Metadata from Lunar's API
 * @returns {Promise<void>}
 */
export async function checkGameFiles(metadata) {
  logger.info(`Checking game files (MC ${await settings.get('version')})...`);
  store.commit('setLaunchingState', {
    title: 'LAUNCHING...',
    message: `CHECKING GAMEFILES (${metadata.launchTypeData.artifacts.length})...`,
    icon: 'fa-solid fa-file',
  });

  if (
    !(await fs.exists(
      join(constants.DOTLUNARCLIENT, 'offline', await settings.get('version'))
    ))
  ) {
    await fs
      .mkdir(
        join(constants.DOTLUNARCLIENT, 'offline', await settings.get('version'))
      )
      .catch((error) => {
        logger.error('Failed to create version folder', error);
      });
  }

  for (const index in metadata.launchTypeData.artifacts) {
    const artifact = metadata.launchTypeData.artifacts[index];
    const gameFilePath = join(
      constants.DOTLUNARCLIENT,
      'offline',
      await settings.get('version'),
      artifact.name
    );
    logger.debug(
      `Checking game file ${parseInt(index) + 1}/${
        metadata.launchTypeData.artifacts.length
      }`
    );

    if (!(await fs.exists(gameFilePath))) {
      await downloadAndSaveFile(
        artifact.url,
        join(
          constants.DOTLUNARCLIENT,
          'offline',
          await settings.get('version'),
          artifact.name
        ),
        'blob',
        artifact.sha1,
        'sha1'
      ).catch((error) => {
        logger.error(`Failed to download ${artifact.name}`, error);
      });
    }
  }
}

/**
 * Checks natives (and extract if needed)
 * @param {object} metadata Metadata from Lunar's API
 * @returns {Promise<void>}
 */
export async function checkNatives(metadata) {
  logger.info('Checking natives...');

  store.commit('setLaunchingState', {
    title: 'LAUNCHING...',
    message: 'CHECKING NATIVES...',
    icon: 'fa-solid fa-file',
  });

  const artifact = metadata.launchTypeData.artifacts.find(
    (artifact) => artifact.type === 'NATIVES'
  );
  if (
    await fs.exists(
      join(
        constants.DOTLUNARCLIENT,
        'offline',
        await settings.get('version'),
        artifact.name
      )
    )
  ) {
    if (
      !(await fs.exists(
        join(
          constants.DOTLUNARCLIENT,
          'offline',
          await settings.get('version'),
          'natives'
        )
      ))
    ) {
      await extractZip(
        join(
          constants.DOTLUNARCLIENT,
          'offline',
          await settings.get('version'),
          artifact.name
        ),
        {
          dir: join(
            constants.DOTLUNARCLIENT,
            'offline',
            await settings.get('version'),
            'natives'
          ),
        }
      )
        .then(() => {
          logger.debug('Extracted natives');
        })
        .catch((error) => {
          logger.error(`Failed to extract natives`, error);
        });
    } else {
      logger.debug('Natives already extracted');
    }
  } else {
    logger.error('Natives not found, this should not happen');
  }
}

/**
 * Check patcher (and download if needed)
 * @returns {Promise<void>}
 */
export async function checkPatcher() {
  logger.info('Checking patcher...');

  store.commit('setLaunchingState', {
    title: 'LAUNCHING...',
    message: 'CHECKING PATCHER...',
    icon: 'fa-solid fa-file',
  });

  const release = await axios
    .get(`${constants.SOLAR_PATCHER_GITHUB_API}/releases?per_page=1`)
    .catch((reason) => {
      logger.error('Failed to fetch patcher metadata', reason);
    });
  const updaterFile = release.data[0].assets.find(
    (asset) => asset.name === constants.patcher.UPDATER
  );

  await downloadAndSaveFile(
    updaterFile.browser_download_url,
    join(constants.DOTLUNARCLIENT, 'solartweaks', 'updater-patcher.json'),
    'blob'
  ).catch((reason) => {
    logger.error('Failed to download patcher', reason);
  });

  const updater = JSON.parse(
    await fs
      .readFile(
        join(constants.DOTLUNARCLIENT, 'solartweaks', 'updater-patcher.json')
      )
      .catch((reason) => {
        logger.error('Failed to read patcher file', reason);
      })
  );

  if (await settings.has('patcherVersion')) {
    if (updater.version === (await settings.get('patcherVersion'))) {
      logger.debug('Patcher is up to date');
      return;
    }
  }

  const patcherFile = release.data[0].assets.find(
    (asset) => asset.name === updater.fileName
  );

  await downloadAndSaveFile(
    patcherFile.browser_download_url,
    join(constants.DOTLUNARCLIENT, 'solartweaks', constants.patcher.PATCHER),
    'blob',
    updater.sha1,
    'sha1'
  ).catch((reason) => {
    logger.error('Failed to download patcher', reason);
  });

  await settings.set('patcherVersion', updater.version);
}

/**
 * Edit the `config.json` file for the Java Agent
 * @returns {Promise<void>}
 */
export async function patchGame() {
  logger.info('Patching game...');

  store.commit('setLaunchingState', {
    title: 'LAUNCHING...',
    message: 'PATCHING GAME...',
    icon: 'fa-solid fa-cog',
  });

  const filePath = join(
    constants.DOTLUNARCLIENT,
    'solartweaks',
    constants.patcher.CONFIG
  );

  logger.debug(`Reading ${filePath}`);
  const configRaw = await fs.readFile(filePath).catch((reason) => {
    logger.error('Failed to read config.json', reason);
  });
  if (!configRaw) return;

  const config = JSON.parse(configRaw);
  const customizations = await settings.get('customizations');

  config.metadata.removeCalls = [];
  config.metadata.isEnabled = true;

  customizations.forEach((customization) => {
    // Privacy module
    if (Object.prototype.hasOwnProperty.call(customization, 'privacyModules')) {
      customization.privacyModules.forEach((module) => {
        if (!Object.prototype.hasOwnProperty.call(config, module)) return;
        config[module].enabled = customization.enabled;
      });
      return;
    }

    if (!Object.keys(config).includes(customization.internal)) return;

    // Metadata module
    if (customization.internal === 'metadata') {
      config.metadata.removeCalls.push(customization.call);
      return;
    }

    config[customization.internal].isEnabled = customization.enabled;
    if (Object.prototype.hasOwnProperty.call(customization, 'values')) {
      for (const key in customization.values) {
        config[customization.internal][key] = customization.values[key];
      }
    }
  });

  logger.debug(`Writing ${filePath}`);
  await fs
    .writeFile(filePath, JSON.stringify(config, null, 2))
    .then(() => {
      logger.debug('Successfully wrote config.json');
    })
    .catch((reason) => {
      logger.error('Failed to write config.json', reason);
    });
}

/**
 * Get the Java arguments to launch the game
 * @param {Object} metadata Metadata from Lunar's API
 * @param {string} [serverIp=null] Server IP to connect to
 * @param {string} [overrideVersion=null] Version to use (overrides settings)
 */
export async function getJavaArguments(
  metadata,
  serverIp = null,
  overrideVersion = null
) {
  const natives = join(
    constants.DOTLUNARCLIENT,
    'offline',
    await settings.get('version'),
    'natives'
  );

  const args = metadata.jre.extraArguments;

  const nativesArgument = args.findIndex((value) => value.includes('natives'));
  args[nativesArgument] = args[nativesArgument].replace(
    'natives',
    `"${natives}"`
  );

  let version = await settings.get('version');
  if (overrideVersion) version = overrideVersion;

  const lunarJarFile = async (filename) =>
    `"${join(constants.DOTLUNARCLIENT, 'offline', version, filename)}"`;

  const gameDir = (await settings.get('launchDirectories')).find(
    (directory) => directory.version === version
  ).path;

  const resolution = await settings.get('resolution');
  const patcherPath = join(
    constants.DOTLUNARCLIENT,
    'solartweaks',
    constants.patcher.PATCHER
  );

  // Make sure the patcher exists, or else the game will crash (jvm init error)
  stat(patcherPath)
    .then(() =>
      args.push(
        `-javaagent:"${patcherPath}"="${join(
          constants.DOTLUNARCLIENT,
          'solartweaks',
          constants.patcher.CONFIG
        )}"`
      )
    )
    .catch((e) =>
      logger.warn(
        `Launching the game without patcher; ${patcherPath} does not exist! ${e}`
      )
    );

  args.push(
    await settings.get('jvmArguments'),
    `-Xmx${await settings.get('ram')}m`,
    `-Djava.library.path="${natives}"`,
    `-cp ${await lunarJarFile(
      'lunar-assets-prod-1-optifine.jar'
    )};${await lunarJarFile(
      'lunar-assets-prod-2-optifine.jar'
    )};${await lunarJarFile(
      'lunar-assets-prod-3-optifine.jar'
    )};${await lunarJarFile('lunar-libs.jar')};${await lunarJarFile(
      'lunar-prod-optifine.jar'
    )};${await lunarJarFile('OptiFine.jar')};${await lunarJarFile(
      'vpatcher-prod.jar'
    )}`,
    metadata.launchTypeData.mainClass,
    '--version',
    version,
    '--accessToken',
    '0',
    '--assetIndex',
    version === '1.7' ? '1.7.10' : version,
    '--userProperties',
    '{}',
    '--gameDir',
    `"${gameDir}"`,
    // '--assetsDir',
    // `"${join(gameDir, 'assets')}"`,
    '--texturesDir',
    `"${join(constants.DOTLUNARCLIENT, 'textures')}"`,
    '--width',
    resolution.width,
    '--height',
    resolution.height
  );

  if (serverIp) args.push('--server', `"${serverIp}"`);

  return args;
}

/**
 * Launch the game
 * @param {Object} metadata Metadata from Lunar's API
 * @param {string} [serverIp=null] Server IP to connect to
 */
export async function launchGame(metadata, serverIp = null) {
  store.commit('setLaunchingState', {
    title: 'LAUNCHING...',
    message: 'STARTING JVM...',
    icon: 'fa-solid fa-gamepad',
  });

  updateActivity('In the launcher', 'Launching game');

  const args = await getJavaArguments(metadata, serverIp);

  logger.debug(`Launching game with args: ${args.join(' ')}`);

  const process = await exec(
    `"${join(await settings.get('jrePath'), 'javaw')}" ${args.join(' ')}`,
    {
      cwd: join(
        constants.DOTLUNARCLIENT,
        'offline',
        await settings.get('version')
      ),
    }
  );

  process.on('error', (error) => {
    logger.error(error);
  });

  process.stdout.on('error', (error) => {
    logger.error('Failed to launch game', error);
  });

  process.stderr.on('error', (error) => {
    logger.error('Failed to launch game', error);
  });

  process.stdout.once('end', () => {
    remote.getCurrentWindow().show();
  });

  process.stdout.once('data', async (/* data */) => {
    switch (await settings.get('actionAfterLaunch')) {
      case 'close':
      default:
        remote.getCurrentWindow().close();
        break;
      case 'hide':
        remote.getCurrentWindow().hide();
        break;
      case 'keep':
        break;
    }
    setTimeout(async () => {
      updateActivity('In the launcher');
      store.commit('setLaunchingState', {
        title: `LAUNCH ${await settings.get('version')}`,
        message: 'READY TO LAUNCH',
        icon: 'fa-solid fa-gamepad',
      });
      store.commit('setLaunching', false);
    }, 3500);
  });
}

/**
 * Run all the checks and launch the game
 * @param {string} [serverIp=null] Server IP to connect to
 */
// eslint-disable-next-line no-unused-vars
export async function checkAndLaunch(serverIp = null) {
  store.commit('setLaunching', true);

  // Fetching metadata
  const metadata = await fetchMetadata().catch((error) => {
    store.commit('setLaunchingState', {
      title: 'Error',
      message: error.message,
      icon: 'fa-solid fa-exclamation-triangle',
    });
  });

  if (!(await settings.get('skipChecks'))) {
    // Check game directory
    await setupLunarClientDirectory();

    // Check licenses
    await checkLicenses(metadata);

    // Check game files
    await checkGameFiles(metadata);

    // Check natives
    await checkNatives(metadata);

    // Check LC assets
    await downloadLunarAssets(metadata);

    // Check patcher
    await checkPatcher().catch(() => {
      logger.error(
        'Failed to check patcher, is GitHub down? Have we messed up while publishing the release? Skipping patcher check.'
      );
    });
  }

  // Update patcher config file
  await patchGame();

  // Launch game
  await launchGame(metadata, serverIp);
}