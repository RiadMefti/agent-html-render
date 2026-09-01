import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function luminance(hex: string): number {
  const channels = hex.match(/[a-f0-9]{2}/giu)?.map((channel) => Number.parseInt(channel, 16) / 255) ?? [];
  const linear = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  );
  return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0);
}

function contrast(left: string, right: string): number {
  const leftLuminance = luminance(left);
  const rightLuminance = luminance(right);
  return (Math.max(leftLuminance, rightLuminance) + 0.05) /
    (Math.min(leftLuminance, rightLuminance) + 0.05);
}

describe("review shell accessibility", () => {
  it("keeps secondary text above WCAG normal-text contrast", async () => {
    const css = await readFile(resolve("src/ui/styles.css"), "utf8");
    const token = (name: string): string => {
      const value = css.match(new RegExp(`--${name}:\\s*#([a-f0-9]{6})`, "iu"))?.[1];
      if (!value) throw new Error(`Missing --${name} color token.`);
      return value;
    };
    const background = token("background");

    expect(contrast(token("muted"), background)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token("quiet"), background)).toBeGreaterThanOrEqual(4.5);
    expect(css).not.toContain("font-size: 9px");
  });
});
