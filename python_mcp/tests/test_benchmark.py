import yaml
import json
import pytest # Pytest is commonly used for structuring tests

# Sample data for serialization
SAMPLE_DATA = {
    "name": "John Doe",
    "age": 30,
    "email": "john.doe@example.com",
    "isStudent": False,
    "courses": [
        {"title": "History 101", "credits": 3},
        {"title": "Math 202", "credits": 4}
    ]
}

def test_yaml_token_efficiency():
    """
    Tests if YAML serialization is more concise (shorter string length)
    than JSON serialization for a sample data structure.
    This is a proxy for "token efficiency" in terms of string length.
    """
    # Serialize to YAML
    # default_flow_style=False makes it block style, which is usually more readable and can be shorter
    # sort_keys=False is used to maintain order for comparison, though not strictly necessary for length.
    yaml_result = yaml.dump(SAMPLE_DATA, sort_keys=False, default_flow_style=False)
    
    # Serialize to JSON
    # indent=None ensures the most compact JSON representation (no newlines or spaces for formatting)
    # sort_keys=False to match YAML's default key ordering for this comparison.
    # separators=(',', ':') ensures the most compact JSON by removing unnecessary whitespace.
    json_result = json.dumps(SAMPLE_DATA, sort_keys=False, indent=None, separators=(',', ':'))

    # Print results for visibility during testing or direct execution
    print(f"\nYAML Output (length: {len(yaml_result)}):\n{yaml_result}")
    print(f"JSON Output (length: {len(json_result)}):\n{json_result}")

    # Assertion: YAML string length should be less than JSON string length for this data structure and settings.
    # This assumption holds for typical structured data when YAML is in block style and JSON is minimal.
    assert len(yaml_result) < len(json_result), \
        f"Expected YAML to be shorter. YAML length: {len(yaml_result)}, JSON length: {len(json_result)}"

# This block allows running the test directly with `python tests/test_benchmark.py`
# while still being discoverable by pytest.
if __name__ == "__main__":
    print("Running YAML token efficiency test directly...")
    # Manually call the test function.
    # In a real scenario with pytest, pytest would discover and run this.
    # For direct run, we can mimic a simple test execution.
    try:
        # If using pytest fixtures or specific configurations, direct run might not work as expected.
        # This example is simple enough.
        test_yaml_token_efficiency()
        print("Test passed: YAML is more concise than JSON for the sample data with current settings.")
    except AssertionError as e:
        print(f"Test failed: {e}")
    except Exception as e:
        print(f"An error occurred during the test: {e}")

# To run with pytest:
# 1. Ensure pytest and PyYAML are installed (`pip install pytest pyyaml`).
# 2. Navigate to the `python_mcp` directory (or the project root).
# 3. Run the command `pytest`.
# Pytest will automatically discover `tests/test_benchmark.py` and run functions starting with `test_`.
