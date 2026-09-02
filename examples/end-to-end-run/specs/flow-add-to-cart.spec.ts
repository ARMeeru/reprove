import { chromium } from "playwright-core";

const SOLARI_CDP_ENDPOINT = process.env.SOLARI_CDP_ENDPOINT!;
const TARGET_URL = process.env.TARGET_URL!;

const browser = await chromium.connectOverCDP(SOLARI_CDP_ENDPOINT);

try {
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());

  const homeUrl = new URL("/", TARGET_URL).toString();
  await page.goto(homeUrl, { waitUntil: "domcontentloaded" });

  const tshirtBtn = page.locator('[data-test="add-to-cart-tshirt"]');
  await tshirtBtn.waitFor({ state: "visible" });
  await tshirtBtn.click();

  const navCart = page.locator('[data-test="nav-cart"]');
  await navCart.waitFor({ state: "visible" });
  // wait for badge to reflect 1 item after first add
  await navCart.getByText(/Cart \(1\)/).waitFor({ state: "visible" });

  const mugBtn = page.locator('[data-test="add-to-cart-mug"]');
  await mugBtn.waitFor({ state: "visible" });
  await mugBtn.click();

  // wait for badge to reflect 2 items after second add
  await navCart.getByText(/Cart \(2\)/).waitFor({ state: "visible" });

  await navCart.click();

  await page.waitForURL(/\/cart$/);

  const checkoutBtn = page.locator('[data-test="checkout"]');
  await checkoutBtn.waitFor({ state: "visible" });

  // Verify cart badge reflects the number of items actually in the cart list
  const cartBadgeText = await navCart.textContent();
  const badgeMatch = cartBadgeText?.match(/Cart \((\d+)\)/);
  if (!badgeMatch) {
    throw new Error(`Could not parse cart badge text: "${cartBadgeText}"`);
  }
  const badgeCount = parseInt(badgeMatch[1], 10);

  if (badgeCount !== 2) {
    throw new Error(`Expected cart badge to show 2 items, but got ${badgeCount}`);
  }

  // Verify cart page shows both added products by name
  const cartItemsSection = page.locator('[data-test="checkout"]').locator("..");
  const tshirtInCart = page.getByText(/t-shirt/i).first();
  const mugInCart = page.getByText(/mug/i).first();

  await tshirtInCart.waitFor({ state: "visible" });
  await mugInCart.waitFor({ state: "visible" });

  const tshirtVisible = await tshirtInCart.isVisible();
  const mugVisible = await mugInCart.isVisible();

  if (!tshirtVisible || !mugVisible) {
    throw new Error("Expected both T-shirt and Mug to be visible in the cart");
  }

  console.log("PASS add-to-cart: cart badge and contents correctly reflect 2 added items (T-shirt, Mug)");
} finally {
  await browser.close();
}
