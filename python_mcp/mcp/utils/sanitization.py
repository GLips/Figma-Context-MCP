from typing import Optional, Dict, Any
from pydantic import BaseModel, Field

# Pydantic models for sanitized Figma data

class SimplifiedComponentDefinition(BaseModel):
    """
    A simplified representation of a Figma Component.
    """
    id: str
    key: str  # The unique key for this component
    name: str
    component_set_id: Optional[str] = Field(default=None, alias="componentSetId") # Maps from componentSetId

    class Config:
        allow_population_by_field_name = True # Allow using componentSetId as input

class SimplifiedComponentSetDefinition(BaseModel):
    """
    A simplified representation of a Figma Component Set.
    """
    id: str
    key: str  # The unique key for this component set
    name: str
    description: Optional[str] = None


# Raw Figma API types (conceptual, as input to sanitizers)
# These would typically be more complex Pydantic models if fully parsing API responses.
FigmaComponent = Dict[str, Any] # Represents a raw Component object from Figma API
FigmaComponentSet = Dict[str, Any] # Represents a raw ComponentSet object from Figma API


def sanitize_components(
    aggregated_components: Dict[str, FigmaComponent]
) -> Dict[str, SimplifiedComponentDefinition]:
    """
    Sanitizes a dictionary of raw Figma Component objects into a dictionary of
    SimplifiedComponentDefinition Pydantic models.
    """
    sanitized_components: Dict[str, SimplifiedComponentDefinition] = {}
    for comp_id, comp_data in aggregated_components.items():
        if not isinstance(comp_data, dict):
            # Handle cases where comp_data might not be a dict as expected
            # Depending on strictness, could raise error or log a warning
            continue 
            
        sanitized_components[comp_id] = SimplifiedComponentDefinition(
            id=comp_id, # Use the key from the input dict as the ID
            key=comp_data.get("key", ""), # Ensure key exists, default to empty string if not
            name=comp_data.get("name", "Unnamed Component"), # Default name
            componentSetId=comp_data.get("componentSetId") # Optional, defaults to None if not present
        )
    return sanitized_components


def sanitize_component_sets(
    aggregated_component_sets: Dict[str, FigmaComponentSet]
) -> Dict[str, SimplifiedComponentSetDefinition]:
    """
    Sanitizes a dictionary of raw Figma ComponentSet objects into a dictionary of
    SimplifiedComponentSetDefinition Pydantic models.
    """
    sanitized_sets: Dict[str, SimplifiedComponentSetDefinition] = {}
    for set_id, set_data in aggregated_component_sets.items():
        if not isinstance(set_data, dict):
            # Handle cases where set_data might not be a dict
            continue

        sanitized_sets[set_id] = SimplifiedComponentSetDefinition(
            id=set_id, # Use the key from the input dict as the ID
            key=set_data.get("key", ""), # Ensure key exists, default to empty string if not
            name=set_data.get("name", "Unnamed Component Set"), # Default name
            description=set_data.get("description") # Optional, defaults to None if not present
        )
    return sanitized_sets

# Example Usage (for testing purposes, typically removed or in a test file)
if __name__ == "__main__":
    # Mock raw Figma API data
    mock_figma_components: Dict[str, FigmaComponent] = {
        "comp1": {"key": "key_comp1", "name": "Button Primary", "componentSetId": "set1"},
        "comp2": {"key": "key_comp2", "name": "Card Default"},
        "comp3": {"key": "key_comp3", "name": "Input Field", "componentSetId": "set2"},
        "comp_invalid": "not_a_dict" # type: ignore
    }

    mock_figma_component_sets: Dict[str, FigmaComponentSet] = {
        "set1": {"key": "key_set1", "name": "Buttons", "description": "All button components"},
        "set2": {"key": "key_set2", "name": "Forms"},
        "set_invalid": "not_a_dict" # type: ignore
    }

    # Sanitize the data
    sanitized_components_result = sanitize_components(mock_figma_components)
    sanitized_component_sets_result = sanitize_component_sets(mock_figma_component_sets)

    # Print results
    print("Sanitized Components:")
    for comp_id, comp_def in sanitized_components_result.items():
        print(f"  ID: {comp_id}, Definition: {comp_def.json(indent=2, by_alias=True)}")

    print("\nSanitized Component Sets:")
    for set_id, set_def in sanitized_component_sets_result.items():
        print(f"  ID: {set_id}, Definition: {set_def.json(indent=2)}")

    # Test Pydantic validation
    try:
        SimplifiedComponentDefinition(id="test", key="k", name="n", componentSetId="cs_id", non_existent_field="test") # type: ignore
    except Exception as e:
        print(f"\nPydantic validation error (expected): {e}")

    # Test alias for componentSetId
    comp_with_alias = SimplifiedComponentDefinition(id="c1",key="k1",name="n1", componentSetId="set_id_value")
    print(f"\nComponent with componentSetId alias: {comp_with_alias.json(indent=2, by_alias=True)}")
    print(f"Accessing component_set_id: {comp_with_alias.component_set_id}")

    comp_without_alias_field = SimplifiedComponentDefinition(id="c2",key="k2",name="n2", component_set_id="set_id_value_2")
    print(f"\nComponent with component_set_id field: {comp_without_alias_field.json(indent=2, by_alias=True)}")
    print(f"Accessing component_set_id: {comp_without_alias_field.component_set_id}")

    comp_none_set_id = SimplifiedComponentDefinition(id="c3",key="k3",name="n3")
    print(f"\nComponent with no componentSetId: {comp_none_set_id.json(indent=2, by_alias=True)}")
    print(f"Accessing component_set_id: {comp_none_set_id.component_set_id}")
