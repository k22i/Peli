import { describe, expect, it } from "vite-plus/test";

import { standardPicture } from "./picture";
import { withSection } from "./title-adjustments";

describe("withSection", () => {
  it("replaces a section, and gives null once none is left", () => {
    const vivid = { ...standardPicture, preset: "vivid", saturation: 18 };
    const kept = withSection(null, "picture", vivid, 5);
    expect(kept).toEqual({ picture: vivid, changedAt: 5 });
    expect(withSection(kept, "picture", undefined, 6)).toBeNull();
  });
});
