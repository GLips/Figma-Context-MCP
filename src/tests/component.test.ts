import { describe, expect, it } from "vitest";
import * as __testedFile from "../transformers/component.js";

const agNoComponentSetId = {
  1: {
    key: "abc123def456",
    name: "IconButton",
    description: "A simple icon button",
    documentationLinks: [],
    remote: false,
  },
};

const scNoComponentSetIdResponse = {
  "1": {
    key: "abc123def456",
    name: "IconButton",
    id: "1",
    componentSetId: undefined,
  },
};

const agComponent = {
  1: {
    key: "abc123def456",
    name: "IconButton",
    description: "A simple icon button",
    documentationLinks: [],
    remote: false,
    componentSetId: "csid",
  },
};

const scComponentSetIdResponse = {
  "1": {
    key: "abc123def456",
    name: "IconButton",
    id: "1",
    componentSetId: "csid",
  },
};

const agNoDescription = {
  1: {
    key: "abc123def456",
    name: "IconButton",
    description: "",
    documentationLinks: [],
    remote: false,
    componentSetId: "csid",
  },
};

const scNoDescriptionResponse = {
  "1": {
    key: "abc123def456",
    name: "IconButton",
    id: "1",
    description: "",
  },
};

const scDescriptionResponse = {
  "1": {
    key: "abc123def456",
    name: "IconButton",
    id: "1",
    description: "A simple icon button",
  },
};

describe("src/transformers/component.ts", () => {
  describe("simplifyComponents", () => {
    const { simplifyComponents } = __testedFile;
    // aggregatedComponents: Record<string, Component>

    it("With set ID", () => {
      const aggregatedComponents: Parameters<typeof simplifyComponents>[0] = agComponent;
      const __expectedResult: ReturnType<typeof simplifyComponents> = scComponentSetIdResponse;
      expect(simplifyComponents(aggregatedComponents)).toEqual(__expectedResult);
    });

    it("No set ID", () => {
      const aggregatedComponents: Parameters<typeof simplifyComponents>[0] = agNoComponentSetId;
      const __expectedResult: ReturnType<typeof simplifyComponents> = scNoComponentSetIdResponse;
      expect(simplifyComponents(aggregatedComponents)).toEqual(__expectedResult);
    });

    it("should test simplifyComponents( mock-parameters.aggregatedComponents 3 )", () => {
      const aggregatedComponents: Parameters<typeof simplifyComponents>[0] = {};
      const __expectedResult: ReturnType<typeof simplifyComponents> = {};
      expect(simplifyComponents(aggregatedComponents)).toEqual(__expectedResult);
    });
  });

  describe("simplifyComponentSets", () => {
    const { simplifyComponentSets } = __testedFile;
    // aggregatedComponentSets: Record<string, ComponentSet>

    it("With description", () => {
      const aggregatedComponentSets: Parameters<typeof simplifyComponentSets>[0] = agComponent;
      const __expectedResult: ReturnType<typeof simplifyComponentSets> = scDescriptionResponse;
      expect(simplifyComponentSets(aggregatedComponentSets)).toEqual(__expectedResult);
    });

    it("No description", () => {
      const aggregatedComponentSets: Parameters<typeof simplifyComponentSets>[0] = agNoDescription;
      const __expectedResult: ReturnType<typeof simplifyComponentSets> = scNoDescriptionResponse;
      expect(simplifyComponentSets(aggregatedComponentSets)).toEqual(__expectedResult);
    });

    it("should test simplifyComponentSets( mock-parameters.aggregatedComponentSets 3 )", () => {
      const aggregatedComponentSets: Parameters<typeof simplifyComponentSets>[0] = {};
      const __expectedResult: ReturnType<typeof simplifyComponentSets> = {};
      expect(simplifyComponentSets(aggregatedComponentSets)).toEqual(__expectedResult);
    });
  });
});

// 3TG (https://3tg.dev) created 6 tests in 2697 ms (449.500 ms per generated test) @ 2026-04-02T06:29:41.603Z
