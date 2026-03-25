import { describe, expect, test } from "bun:test";

import {
  assertMediaUploadSizeAllowed,
  formatByteSize,
  resolveMediaUploadLimitBytes,
} from "./wechat-transport.ts";

describe("wechat upload limits", () => {
  test("uses the default per-media upload limits", () => {
    expect(resolveMediaUploadLimitBytes("image", {})).toBe(20 * 1024 * 1024);
    expect(resolveMediaUploadLimitBytes("file", {})).toBe(50 * 1024 * 1024);
    expect(resolveMediaUploadLimitBytes("voice", {})).toBe(20 * 1024 * 1024);
    expect(resolveMediaUploadLimitBytes("video", {})).toBe(100 * 1024 * 1024);
  });

  test("allows env overrides and ignores invalid values", () => {
    expect(
      resolveMediaUploadLimitBytes("video", {
        WECHAT_MAX_VIDEO_MB: "64",
      } as NodeJS.ProcessEnv),
    ).toBe(64 * 1024 * 1024);

    expect(
      resolveMediaUploadLimitBytes("video", {
        WECHAT_MAX_VIDEO_MB: "not-a-number",
      } as NodeJS.ProcessEnv),
    ).toBe(100 * 1024 * 1024);
  });

  test("throws a clear error when a file exceeds the configured limit", () => {
    expect(() =>
      assertMediaUploadSizeAllowed(
        "video",
        377_800_000,
        {} as NodeJS.ProcessEnv,
      ),
    ).toThrow(
      "Video too large: 360 MB exceeds 100 MB limit. Set WECHAT_MAX_VIDEO_MB to override.",
    );
  });

  test("formats byte sizes consistently", () => {
    expect(formatByteSize(512)).toBe("512 B");
    expect(formatByteSize(1_536)).toBe("1.5 KB");
    expect(formatByteSize(20 * 1024 * 1024)).toBe("20.0 MB");
  });
});
