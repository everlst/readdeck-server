// Chapters stay local: scanning/reading them never makes them AI metadata inputs.
function isMetadataResource(resource) {
  return resource?.contentType !== 'chapter' && resource?.detectedNumberType !== 'chapter';
}
module.exports = { isMetadataResource };
