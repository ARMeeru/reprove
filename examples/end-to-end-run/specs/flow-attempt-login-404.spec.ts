import { chromium } from "playwright-core";

const TARGET_URL = process.env.TARGET_URL!;
const CDP_ENDPOINT = process.env.SOLARI_CDP_ENDPOINT!;

const browser = await chromium.connectOverCDP(CDP_ENDPOINT);

try {
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());

  // Navigate to home first (per rules, never deep-link directly for session-dependent routes;
  // although /login requires no session, we still drive via UI from TARGET_URL to reach it).
  const homeUrl = new URL("/", TARGET_URL).toString();
  const response = await page.goto(homeUrl, { waitUntil: "domcontentloaded" });
  if (!response || !response.ok()) {
    throw new Error(`Failed to load home page, status: ${response?.status()}`);
  }

  // Wait for home page to be visible.
  const navHome = page.locator('[data-test="nav-home"]');
  await navHome.waitFor({ state: "visible" });

  // Now attempt to navigate to the /login route directly via the browser's address bar equivalent
  // (goto), since there's no in-page link to a login page in the discovered inventory.
  const loginUrl = new URL("/login", TARGET_URL).toString();
  const loginResponse = await page.goto(loginUrl, { waitUntil: "domcontentloaded" });

  // Assert the flow intent: no login route exists -> expect a 404 status.
  const status = loginResponse?.status();
  if (status !== 404) {
    throw new Error(
      `Expected HTTP 404 when navigating to /login, but got status: ${status}`
    );
  }

  // Corroborate with visible text indicating a not-found page, scoped to a single heading
  // to avoid strict-mode ambiguity between h1/h2 on Next.js error pages.
  const notFoundHeading = page.getByRole("heading", { name: /404|not found/i }).first();
  await notFoundHeading.waitFor({ state: "visible" });

  const headingText = await notFoundHeading.textContent();
  if (!headingText || !/404|not found/i.test(headingText)) {
    throw new Error(`Expected 404/Not Found heading text, got: "${headingText}"`);
  }

  console.log("PASS: /login route returns 404 as expected, confirming no login route exists.");
} finally {
  await browser.close();
}
