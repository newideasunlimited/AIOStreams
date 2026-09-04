import express, { Router } from 'express';
import libraryRouter from './library.js';
import masterCatalogRouter from './master-catalog.js';

export { default as gdrive } from './gdrive.js';
export { default as torboxSearch } from './torbox-search.js';
export { default as torznab } from './torznab.js';
export { default as newznab } from './newznab.js';
export { default as prowlarr } from './prowlarr.js';
export { default as knaben } from './knaben.js';
export { default as eztv } from './eztv.js';
export { default as therarbg } from './therarbg.js';
export { default as torrentGalaxy } from './torrent-galaxy.js';
export { default as seadex } from './seadex.js';
export { default as easynews } from './easynews.js';
export { default as masterNative } from './master-native.js';

const library: Router = express.Router();
library.use('/master-catalog', masterCatalogRouter);
library.use('/', libraryRouter);

export { library };
