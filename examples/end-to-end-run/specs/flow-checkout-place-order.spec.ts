import { chromium } from "playwright-core";

const TARGET_URL = process.env.TARGET_URL!;
const CDP_ENDPOINT = process.env.SOLARI_CDP_ENDPOINT!;

const browser = await chromium.connectOverCDP(CDP_ENDPOINT);

try {
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());

  // Ensure there's an item in the cart before checkout, since the flow relies on
  // an existing cart (checkout page evidence shows Cart (2) in nav after order).
  await page.goto(new URL("/", TARGET_URL).toString());
  const addToCartBtn = page.locator('[data-test="add-to-cart-tshirt"]');
  await addToCartBtn.waitFor({ state: "visible" });
  await addToCartBtn.click();

  const cartNav = page.locator('[data-test="nav-cart"]');
  await cartNav.waitFor({ state: "visible" });
  await cartNav.getByText(/Cart \(\d+\)/).waitFor({ state: "visible" }).catch(() => {});

  // Navigate to checkout via UI (cart page -> checkout button)
  await cartNav.click();
  await page.waitForURL(new URL("/cart", TARGET_URL).toString());

  const checkoutBtn = page.locator('[data-test="checkout"]');
  await checkoutBtn.waitFor({ state: "visible" });
  await checkoutBtn.click();

  await page.waitForURL(new URL("/checkout", TARGET_URL).toString());

  // Fill checkout form
  const nameInput = page.locator('[data-test="name"]');
  const addressInput = page.locator('[data-test="address"]');
  const emailInput = page.locator('[data-test="email"]');

  await nameInput.waitFor({ state: "visible" });
  await nameInput.fill("Jane Doe");

  await addressInput.waitFor({ state: "visible" });
  await addressInput.fill("123 Main St, Springfield");

  await emailInput.waitFor({ state: "visible" });
  await emailInput.fill("jane.doe@example.com");

  // Before placing order, verify the page's own arithmetic: total = subtotal + tax
  const subtotalLocator = page.locator('[data-test="subtotal"]');
  const taxLocator = page.locator('[data-test="tax"]');
  const totalLocator = page.locator('[data-test="total"]');

  const parseAmount = (text: string): number => {
    const match = text.match(/\$[\d.,]+/);
    if (!match) {
      throw new Error(`No currency amount found in text: "${text}"`);
    }
    return parseFloat(match[0].replace(/[^\d.]/g, ""));
  };

  if (await subtotalLocator.count() > 0 && await taxLocator.count() > 0 && await totalLocator.count() > 0) {
    await subtotalLocator.waitFor({ state: "visible" });
    await taxLocator.waitFor({ state: "visible" });
    await totalLocator.waitFor({ state: "visible" });

    const subtotalText = await subtotalLocator.innerText();
    const taxText = await taxLocator.innerText();
    const totalText = await totalLocator.innerText();

    const subtotal = parseAmount(subtotalText);
    const tax = parseAmount(taxText);
    const total = parseAmount(totalText);

    const expectedTotal = Math.round((subtotal + tax) * 100) / 100;
    const actualTotal = Math.round(total * 100) / 100;

    if (Math.abs(expectedTotal - actualTotal) > 0.01) {
      throw new Error(
        `Checkout arithmetic mismatch: subtotal (${subtotal}) + tax (${tax}) = ${expectedTotal}, but displayed total is ${actualTotal}`
      );
    }
  }

  // Place the order
  const placeOrderBtn = page.locator('[data-test="place-order"]');
  await placeOrderBtn.waitFor({ state: "visible" });
  await placeOrderBtn.click();

  // Wait for navigation to order confirmation page
  await page.waitForURL(new URL("/order", TARGET_URL).toString());

  // Verify visible confirmation acknowledgement text
  const confirmationHeading = page.getByRole("heading", { name: /thank|received|confirm/i }).first();
  const confirmationText = page.getByText(/thank|received|confirm/i).first();

  const headingVisible = await confirmationHeading.isVisible().catch(() => false);
  if (headingVisible) {
    await confirmationHeading.waitFor({ state: "visible" });
  } else {
    await confirmationText.waitFor({ state: "visible" });
  }

  // Verify cart badge reset to 0 after order placed
  const cartNavAfterOrder = page.locator('[data-test="nav-cart"]');
  await cartNavAfterOrder.waitFor({ state: "visible" });
  const cartText = await cartNavAfterOrder.innerText();
  if (!/Cart \(0\)/.test(cartText)) {
    throw new Error(`Expected cart to be empty after order, but found: "${cartText}"`);
  }

  console.log("PASS: Checkout flow completed successfully with order confirmation and empty cart.");
} finally {
  await browser.close();
}
