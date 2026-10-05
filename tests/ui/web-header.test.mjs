// The web tracker bar (the web app's version of the desktop header): the
// project menu that drops out of it is fully visible, and the bar's background
// spans the window. Runs against the real backend on a throwaway database.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { findChrome, isFullyOnTop, launchBrowser, pixel, startBackend, startVite } from "./helpers.mjs";

const skip = findChrome() ? false : "No Chrome or Chromium found (set CHROME_PATH).";

describe("web tracker bar", { skip }, () => {
    let backend, vite, browser;
    before(async () => {
        backend = await startBackend();
        vite = await startVite("website", 3000); // the dev server proxies /api to the backend
        browser = await launchBrowser();
    });
    after(async () => { await browser?.close(); vite?.stop(); backend?.stop(); });

    async function openTracker({ width = 1280, height = 800 } = {}) {
        const page = await browser.newPage({ viewport: { width, height } });
        // A fresh URL, not a hash change: the dev-only sign-in route reads the session from it.
        await page.goto(`${vite.url}/?ui-test=1${backend.loginHash}`);
        await page.waitForSelector(".tracker-bar #project-chip");
        await page.waitForSelector(".tl-block");
        return page;
    }

    for (const tab of ["dashboard", "statistics"]) {
        test(`project menu is fully visible on the ${tab} tab`, async () => {
            const page = await openTracker();
            await page.locator(`.tab-link[data-target="${tab}"]`).click();
            await page.locator("#project-chip").click();
            await page.waitForSelector("#project-menu:not([hidden])");
            assert.ok(await isFullyOnTop(page, "#project-menu"), "the open project menu is clipped or covered");
            await page.close();
        });
    }

    test("project menu is fully visible after scrolling down", async () => {
        const page = await openTracker({ height: 500 });
        await page.evaluate(() => window.scrollTo(0, 300));
        await page.locator("#project-chip").click();
        await page.waitForSelector("#project-menu:not([hidden])");
        assert.ok(await isFullyOnTop(page, "#project-menu"), "the open project menu is clipped or covered");
        await page.close();
    });

    test("the bar's background spans the full window width when scrolled", async () => {
        const page = await openTracker({ width: 1600, height: 500 });
        await page.evaluate(() => window.scrollTo(0, 300));
        const box = await page.evaluate(() => {
            const b = document.querySelector(".tracker-bar").getBoundingClientRect();
            const tabs = document.querySelector(".tracker-bar .tabs-nav").getBoundingClientRect();
            return { left: b.left, top: b.top, bottom: b.bottom, height: b.height, gapX: tabs.right + 30 };
        });
        const y = box.top + box.height / 2;
        assert.ok(box.left > 40, "the window must be wider than the bar for this check");
        // Same colour beside the bar as in the empty stretch between its tabs and buttons.
        const inside = await pixel(page, box.gapX, y);
        assert.equal(await pixel(page, 10, y), inside, "left of the bar shows the page, not the bar's background");
        assert.equal(await pixel(page, 1590, y), inside, "right of the bar shows the page, not the bar's background");
        // The line under the bar runs across the whole window too.
        const line = await pixel(page, box.gapX, box.bottom - 1);
        assert.notEqual(line, inside, "the line under the bar is missing");
        assert.equal(await pixel(page, 10, box.bottom - 1), line, "the line under the bar stops at the bar's edge");
        await page.close();
    });
});
