import { chromium } from "playwright-core";

const TARGET_URL = process.env.TARGET_URL!;
const SOLARI_CDP_ENDPOINT = process.env.SOLARI_CDP_ENDPOINT!;

const browser = await chromium.connectOverCDP(SOLARI_CDP_ENDPOINT);

try {
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());

  // Navigate to home page first, then add an item to cart via UI so cart is non-empty.
  const homeUrl = new URL("/", TARGET_URL).toString();
  await page.goto(homeUrl);

  const addToCart = page.locator('[data-test="add-to-cart-tshirt"]');
  await addToCart.waitFor({ state: "visible" });
  await addToCart.click();

  const cartLink = page.locator('[data-test="nav-cart"]');
  await cartLink.waitFor({ state: "visible" });

  // Go to the cart page via UI navigation.
  await cartLink.click();
  await page.waitForURL(/\/cart/);

  const checkoutButton = page.locator('[data-test="checkout"]');
  await checkoutButton.waitFor({ state: "visible" });

  // Capture the current URL before clicking, to verify the bug: no navigation occurs.
  const urlBeforeClick = page.url();

  await checkoutButton.click();

  // Give any potential navigation a chance to occur by waiting for a stable state,
  // but do not use sleep/waitForTimeout. Instead, verify the URL remains unchanged
  // and the cart page's own content (continue shopping link) is still present.
  const continueShopping = page.locator('[data-test="continue-shopping"]');
  await continueShopping.waitFor({ state: "visible" });

  const urlAfterClick = page.url();

  if (urlAfterClick !== urlBeforeClick) {
    throw new Error(
      `Expected Checkout button to NOT navigate away from the cart page (bug), but URL changed from ${urlBeforeClick} to ${urlAfterClick}`
    );
  }

  if (!/\/cart(\?.*)?$/.test(urlAfterClick)) {
    throw new Error(
      `Expected to remain on the /cart page after clicking Checkout, but was at ${urlAfterClick}`
    );
  }

  console.log(
    "PASS: Checkout button on cart page does not navigate to checkout (bug surfaced), remained at",
    urlAfterClick
  );
} finally {
  await browser.close();
}
