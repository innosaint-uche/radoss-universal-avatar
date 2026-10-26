import { expect, test } from "@playwright/test";
test.use({ video: "on", trace: "on" });

test("MemU semantic recall and deletion through the browser UI", async ({ page }) => {
  test.skip(!process.env.NAAVOS_MEMU_BROWSER_PYTHON, "Real MemU browser fixture requires the pinned Python SDK");
  await page.goto("/");
  await page.locator("#memory-note").fill("I commute by bicycle.");
  await page.getByRole("button", { name: "Approve and save locally" }).click();
  await expect(page.locator("#last-action")).toContainText("Approved memory saved locally");
  await page.locator("#memory-query").fill("How do I cycle to the office?");
  await page.getByRole("button", { name: "Search memory", exact: true }).click();
  await expect(page.locator("#memory-results")).toContainText("I commute by bicycle.");
  page.once("dialog", dialog => dialog.accept());
  await page.locator("#memory-results").getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.locator("#last-action")).toContainText("Memory deleted");
  await page.getByRole("button", { name: "Search memory", exact: true }).click();
  await expect(page.locator("#memory-results")).toContainText("No approved memories");
});
