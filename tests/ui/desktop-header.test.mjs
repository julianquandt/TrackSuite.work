// The desktop header: always one row, and the project menu that drops out of
// it is fully visible. Both broke once after release (0.10.0 and 0.10.2).
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { findChrome, isFullyOnTop, launchBrowser, openDesktop, pixel, startVite, useWideFont } from "./helpers.mjs";

const skip = findChrome() ? false : "No Chrome or Chromium found (set CHROME_PATH).";

describe("desktop header", { skip }, () => {
    let vite, browser;
    before(async () => { vite = await startVite("desktop", 5199); browser = await launchBrowser(); });
    after(async () => { await browser?.close(); vite?.stop(); });

    // Everything the header can hold at once: Reports tab (full mode), project
    // chip, sync dot, focus timer and a running clock.
    const crowded = { seed: { syncResult: "synced" }, localStorage: { "tracksuite.focus.settings": JSON.stringify({ enabled: true }) } };

    for (const width of [1024, 1280, 1440]) {
        test(`stays on one row at ${width}px, also with a wider font`, async () => {
            const { page, errors } = await openDesktop(browser, vite.url, { width, ...crowded });
            await useWideFont(page);
            await page.locator("#clock-btn-wrap button").click();
            await page.waitForFunction(() => !document.getElementById("sync-dot").hidden);
            const rows = await page.evaluate(() => {
                const mid = (sel) => { const b = document.querySelector(sel).getBoundingClientRect(); return b.top + b.height / 2; };
                return { title: mid(".dash-header h1"), tabs: mid(".tab-bar"), actions: mid(".header-actions"), height: document.querySelector(".dash-header").getBoundingClientRect().height };
            });
            assert.ok(Math.abs(rows.tabs - rows.actions) < 8, `tabs and actions are on different rows: ${JSON.stringify(rows)}`);
            assert.ok(Math.abs(rows.title - rows.actions) < 12, `title and actions are on different rows: ${JSON.stringify(rows)}`);
            assert.ok(rows.height < 90, `header is taller than one row: ${rows.height}px`);
            assert.deepEqual(errors, []);
            await page.close();
        });
    }

    for (const tab of ["dashboard", "statistics"]) {
        test(`project menu is fully visible on the ${tab} tab`, async () => {
            const { page } = await openDesktop(browser, vite.url, crowded);
            await page.locator(`.tab-btn[data-tab="${tab}"]`).click();
            await page.locator("#project-chip").click();
            await page.waitForSelector("#project-menu:not([hidden])");
            assert.ok(await isFullyOnTop(page, "#project-menu"), "the open project menu is clipped or covered");
            await page.close();
        });
    }

    test("project menu is fully visible after scrolling down", async () => {
        const { page } = await openDesktop(browser, vite.url, { height: 500, ...crowded });
        await page.evaluate(() => window.scrollTo(0, 300));
        await page.locator("#project-chip").click();
        await page.waitForSelector("#project-menu:not([hidden])");
        assert.ok(await isFullyOnTop(page, "#project-menu"), "the open project menu is clipped or covered");
        await page.close();
    });

    test("the header background spans the full window width when scrolled", async () => {
        const { page } = await openDesktop(browser, vite.url, { height: 500, ...crowded });
        await page.evaluate(() => window.scrollTo(0, 300));
        const box = await page.evaluate(() => { const b = document.querySelector(".dash-header").getBoundingClientRect(); return { left: b.left, top: b.top, height: b.height }; });
        const y = box.top + box.height / 2;
        assert.ok(box.left > 40, "the window must be wider than the header for this check");
        // Same colour beside the header as inside it, on its far left and far right.
        const inside = await pixel(page, box.left + 2, y);
        assert.equal(await pixel(page, 10, y), inside, "left of the header shows the page, not the header background");
        assert.equal(await pixel(page, 1270, y), inside, "right of the header shows the page, not the header background");
        await page.close();
    });
});
