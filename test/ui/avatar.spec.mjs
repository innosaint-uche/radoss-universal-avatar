import { expect, test } from "@playwright/test";

test("offline Avatar creation, profile persistence, approved memory, deletion and pause", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page
    .getByRole("button", { name: "Set up on this device only" })
    .click();
  await expect(page.locator("#last-action")).toContainText(
    "Local setup configured",
  );
  await page.locator("#profile-name").fill("Jamie Example");
  await page.locator("#profile-description").fill("I write and teach.");
  await page.locator("#profile-tone").fill("Warm and direct");
  await page.locator("#profile-structure").fill("Clear paragraphs");
  await page.locator("#profile-verbosity").fill("Detailed when needed");
  await page
    .locator("#profile-rules")
    .fill("Ask before publishing.\nShow evidence for completed work.");
  await page.getByRole("button", { name: "Save my Avatar profile" }).click();
  await expect(page.locator("#profile-save-status")).toContainText(
    "Saved locally",
  );
  await page.reload();
  await expect(page.locator("#profile-name")).toHaveValue("Jamie Example");
  await expect(page.locator("#profile-structure")).toHaveValue(
    "Clear paragraphs",
  );

  await page
    .locator("#memory-note")
    .fill("I prefer Tuesday planning sessions.");
  await page.getByRole("button", { name: "Approve and save locally" }).click();
  await expect(page.locator("#last-action")).toContainText(
    "Approved memory saved locally",
  );
  await page.locator("#memory-query").fill("Tuesday");
  await page
    .getByRole("button", { name: "Search memory", exact: true })
    .click();
  await expect(page.locator("#memory-results")).toContainText(
    "Tuesday planning sessions",
  );
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .locator("#memory-results")
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(page.locator("#last-action")).toContainText("Memory deleted");
  await page
    .getByRole("button", { name: "Search memory", exact: true })
    .click();
  await expect(page.locator("#memory-results")).toContainText(
    "No approved memories",
  );

  await page.locator("#privacy-mode").selectOption("paused");
  await page.getByRole("button", { name: "Save privacy choice" }).click();
  await expect(page.locator("#privacy-mode")).toHaveValue("paused");
  await page.getByRole("button", { name: "Save my Avatar profile" }).click();
  await expect(page.locator("#profile-save-status")).toContainText("paused");
  await page.locator("#privacy-mode").selectOption("local_only");
  await page.getByRole("button", { name: "Save privacy choice" }).click();
  await page.screenshot({
    path: "test-results/avatar-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("#profile-name")).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: "test-results/avatar-mobile.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
