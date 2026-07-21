import { describe, expect, it } from "vitest";
import { normalizeUiTreeOutput } from "./ui-tree-output";

const root = {
  packageName: "com.reddit.frontpage",
  className: "android.widget.FrameLayout",
  resourceId: "com.reddit.frontpage:id/root",
  children: [],
};

describe("normalizeUiTreeOutput", () => {
  it("parses the current Android output.uiTree JSON envelope", () => {
    expect(normalizeUiTreeOutput({ uiTree: JSON.stringify(root) })).toEqual([root]);
  });

  it("keeps legacy tree and array envelopes compatible", () => {
    expect(normalizeUiTreeOutput({ tree: [root] })).toEqual([root]);
    expect(normalizeUiTreeOutput({ tree: JSON.stringify({ nodes: [root] }) })).toEqual([root]);
    expect(normalizeUiTreeOutput([root])).toEqual([root]);
  });

  it("fails closed on malformed output", () => {
    expect(normalizeUiTreeOutput({ uiTree: "not-json" })).toEqual([]);
    expect(normalizeUiTreeOutput({})).toEqual([]);
  });
});
