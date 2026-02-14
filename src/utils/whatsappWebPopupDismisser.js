/**
 * Auto-dismiss "A fresh look for WhatsApp Web" popup
 *
 * WhatsApp sometimes shows a modal that blocks the session until "Continue" is clicked.
 * This utility monitors the page and auto-clicks to avoid session stalls and ban risks.
 *
 * Standalone integration with whatsapp-web.js:
 *
 *   const { Client } = require('whatsapp-web.js');
 *   const { startPopupDismisser } = require('./utils/whatsappWebPopupDismisser');
 *
 *   const client = new Client({
 *     puppeteer: {
 *       headless: true,
 *       args: ['--no-sandbox', '--disable-setuid-sandbox'],
 *     },
 *   });
 *
 *   // Start popup dismisser before initialize (runs in parallel)
 *   startPopupDismisser(client, '[my-instance]');
 *
 *   await client.initialize();
 */

const RETRY_INTERVAL_MS = 1500; // 1.5 seconds between attempts
const MAX_DURATION_MS = 30000;  // Give up after 30 seconds
const PAGE_POLL_INTERVAL_MS = 500; // Poll for pupPage every 500ms

/**
 * Attempt to find and click the Continue button.
 * @param {import('puppeteer').Page} page
 * @param {string} logPrefix - e.g. "[WASP-test]"
 * @returns {Promise<boolean>} true if clicked, false otherwise
 */
async function tryDismissPopup(page, logPrefix = '[wa-hub]') {
  if (!page || page.isClosed()) return false;

  try {
    // Use page.evaluate to search in browser context (avoids serialization issues)
    const clicked = await page.evaluate((signatures) => {
      // Find button by text content (resilient to class changes)
      const allButtons = Array.from(document.querySelectorAll('button, [role="button"], div[class*="button"]'));
      const continueBtn = allButtons.find((btn) => {
        const text = (btn.textContent || btn.innerText || '').trim();
        return signatures.some((s) => text.toLowerCase().includes(s.toLowerCase()));
      });

      if (continueBtn) {
        continueBtn.click();
        return true;
      }

      // Fallback: find by containing "Continue" text anywhere in modal
      const continueSpans = Array.from(document.querySelectorAll('span, div')).filter(
        (el) => (el.textContent || '').trim().toLowerCase().includes('continue')
      );
      for (const span of continueSpans) {
        // Prefer elements that look like buttons (small text, in modal)
        const parent = span.closest('button, [role="button"]') || span.parentElement;
        if (parent && (parent.tagName === 'BUTTON' || parent.getAttribute('role') === 'button')) {
          parent.click();
          return true;
        }
      }
      return false;
    }, ['Continue', 'continue']);

    if (clicked) {
      console.log(`${logPrefix} [PopupDismisser] Clicked "Continue" button`);
      return true;
    }

    // XPath fallback (page.$x was removed in Puppeteer 22+, use evaluate)
    const xpathClicked = await page.evaluate(() => {
      const expr = '//button[contains(translate(., "CONTINUE", "continue"), "continue")] | //*[@role="button" and contains(translate(., "CONTINUE", "continue"), "continue")]';
      const result = document.evaluate(expr, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      const node = result.singleNodeValue;
      if (node) {
        node.click();
        return true;
      }
      return false;
    });
    if (xpathClicked) {
      console.log(`${logPrefix} [PopupDismisser] Clicked "Continue" (XPath)`);
      return true;
    }
  } catch (err) {
    // Don't crash - log and return false
    if (!err.message?.includes('Target closed') && !err.message?.includes('Execution context was destroyed')) {
      console.warn(`${logPrefix} [PopupDismisser] Error during dismiss attempt:`, err.message);
    }
  }
  return false;
}

/**
 * Run the dismiss loop: retry every RETRY_INTERVAL_MS for up to MAX_DURATION_MS.
 * @param {import('puppeteer').Page} page
 * @param {string} logPrefix
 */
async function runDismissLoop(page, logPrefix = '[wa-hub]') {
  const start = Date.now();
  let attempts = 0;

  while (Date.now() - start < MAX_DURATION_MS) {
    attempts++;
    const clicked = await tryDismissPopup(page, logPrefix);
    if (clicked) return;
    if (!page || page.isClosed()) return;
    await new Promise((r) => setTimeout(r, RETRY_INTERVAL_MS));
  }

  if (attempts > 1) {
    console.log(`${logPrefix} [PopupDismisser] No popup found after ${attempts} attempts (${MAX_DURATION_MS}ms)`);
  }
}

/**
 * Wait for client.pupPage to exist, then run dismiss loop.
 * Call this right after creating the client, in parallel with initialize().
 *
 * @param {object} client - whatsapp-web.js Client (must have pupPage when ready)
 * @param {string} logPrefix - e.g. "[WASP-test]"
 */
async function dismissPopupWhenReady(client, logPrefix = '[wa-hub]') {
  // Wait for pupPage to exist (it's set during initialize)
  const deadline = Date.now() + MAX_DURATION_MS + 10000; // Extra 10s to wait for page
  while (Date.now() < deadline) {
    if (client.pupPage && !client.pupPage.isClosed?.()) {
      await runDismissLoop(client.pupPage, logPrefix);
      return;
    }
    await new Promise((r) => setTimeout(r, PAGE_POLL_INTERVAL_MS));
  }
}

/**
 * Start popup dismisser in background. Does not block.
 * Use this when you create a whatsapp-web.js Client - call before or right after initialize().
 *
 * @param {object} client - whatsapp-web.js Client
 * @param {string} logPrefix - e.g. "[WASP-test]"
 */
function startPopupDismisser(client, logPrefix = '[wa-hub]') {
  void dismissPopupWhenReady(client, logPrefix).catch((err) => {
    if (!err.message?.includes('Target closed')) {
      console.warn(`${logPrefix} [PopupDismisser] Fatal error:`, err.message);
    }
  });
}

module.exports = {
  tryDismissPopup,
  runDismissLoop,
  dismissPopupWhenReady,
  startPopupDismisser,
};
