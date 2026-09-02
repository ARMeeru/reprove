import { chromium } from "playwright-core";

const TARGET_URL = process.env.TARGET_URL!;
const CDP_ENDPOINT = process.env.SOLARI_CDP_ENDPOINT!;

const browser = await chromium.connectOverCDP(CDP_ENDPOINT);

try {
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());

  // Navigate to contact page via UI
  await page.goto(new URL("/", TARGET_URL).toString());
  const contactNavLink = page.locator('[data-test="nav-contact"]');
  await contactNavLink.waitFor({ state: "visible" });
  await contactNavLink.click();

  await page.waitForURL(new URL("/contact", TARGET_URL).toString());

  const nameField = page.locator('[data-test="contact-name"]');
  const emailField = page.locator('[data-test="contact-email"]');
  const messageField = page.locator('[data-test="contact-message"]');
  const submitButton = page.locator('[data-test="contact-submit"]');

  await nameField.waitFor({ state: "visible" });
  await nameField.fill("Jane Doe");

  await emailField.waitFor({ state: "visible" });
  await emailField.fill("jane.doe@example.com");

  await messageField.waitFor({ state: "visible" });
  await messageField.fill("Hello, I have a question about my order.");

  await submitButton.waitFor({ state: "visible" });
  await submitButton.click();

  // Postcondition: visible acknowledgement text matching thank/received/confirm
  const ackLocator = page.getByText(/thank|received|confirm/i).first();
  await ackLocator.waitFor({ state: "visible", timeout: 10000 });

  const ackText = await ackLocator.innerText();
  if (!/thank|received|confirm/i.test(ackText)) {
    throw new Error(
      `Expected acknowledgement text matching /thank|received|confirm/i, got: "${ackText}"`
    );
  }

  console.log("PASS: Contact form submitted successfully with acknowledgement:", ackText.trim());
} catch (error) {
  console.error("FAIL:", error);
  throw error;
} finally {
  await browser.close();
}
