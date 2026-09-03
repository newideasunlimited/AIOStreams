import { Router } from 'express';
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

// app.ts already mounts `library` at /builtins/library. Keep that stable and
// hang the Master Add-On's native TMDB catalog router underneath it so the
// fork gains a self-hosted catalog endpoint without adding another top-level
// mount point.
const library = Router();
library.use('/master-catalog', masterCatalogRouter);
library.use('/', libraryRouter);

export { library };
