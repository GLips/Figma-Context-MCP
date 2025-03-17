import yaml from "js-yaml";

describe("Benchmarks", () => {
  const data = {
    name: "John Doe",
    age: 30,
    email: "john.doe@example.com",
  };

  it("YAML should be token efficient", () => {
    const yamlResult = yaml.dump(data);
    const jsonResult = JSON.stringify(data);

    expect(yamlResult.length).toBeLessThan(jsonResult.length);
  });
});
