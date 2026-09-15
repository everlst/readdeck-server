const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT_DIR, 'data'));
const CACHE_DIR = path.join(DATA_DIR, 'cache');
module.exports = {
  ROOT_DIR, DATA_DIR,
  LIBRARY_DIR: path.join(ROOT_DIR, 'library'),
  CONFIG_DIR: path.join(DATA_DIR, 'config'),
  METADATA_DIR: path.join(DATA_DIR, 'metadata'),
  ARCHIVE_DIR: path.join(DATA_DIR, 'archive'),
  CACHE_DIR,
  READER_CACHE_DIR: path.join(CACHE_DIR, 'reader'),
  PDF_CACHE_DIR: path.join(CACHE_DIR, 'pdf'),
  THUMBNAIL_CACHE_DIR: path.join(CACHE_DIR, 'thumbnails'),
};
