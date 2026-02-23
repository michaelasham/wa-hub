/**
 * Sync-lite: request interception during login/sync to reduce resource spike.
 * Block images, media, fonts (and optionally styles) for the syncing instance only.
 * Env: SYNC_LITE_BLOCK_IMAGES=1, SYNC_LITE_BLOCK_MEDIA=1, SYNC_LITE_BLOCK_FONTS=1, SYNC_LITE_BLOCK_STYLES=0.
 */

const config = require('../config');

function enableSyncLiteInterception(client, instanceId) {
  if (!client || !client.pupPage) return;
  const page = client.pupPage;
  const blockImages = config.syncLiteBlockImages;
  const blockMedia = config.syncLiteBlockMedia;
  const blockFonts = config.syncLiteBlockFonts;
  const blockStyles = config.syncLiteBlockStyles;
  if (!blockImages && !blockMedia && !blockFonts && !blockStyles) return;

  page.setRequestInterception(true).catch((err) => {
    console.warn(`[${instanceId}] [SyncLite] setRequestInterception failed:`, err.message);
  });
  page.on('request', (request) => {
    const resourceType = (request.resourceType && request.resourceType()) || '';
    let abort = false;
    if (blockImages && resourceType === 'image') abort = true;
    if (blockMedia && (resourceType === 'media' || resourceType === 'xhr' && request.url().match(/\.(mp4|webm|ogg|m4a|mp3)(\?|$)/i))) abort = true;
    if (blockFonts && resourceType === 'font') abort = true;
    if (blockStyles && resourceType === 'stylesheet') abort = true;
    if (abort) request.abort().catch(() => {});
    else request.continue().catch(() => {});
  });
  console.log(`[${instanceId}] [SyncLite] interception enabled (images=${!!blockImages}, media=${!!blockMedia}, fonts=${!!blockFonts}, styles=${!!blockStyles})`);
}

module.exports = { enableSyncLiteInterception };
