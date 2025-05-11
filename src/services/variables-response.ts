export type VariableValue =
  | { r: number; g: number; b: number; a: number } // COLOR
  | number                                         // FLOAT
  | boolean                                        // BOOLEAN
  | string;                                        // STRING

export interface Variable {
  id: string;
  name: string;
  resolvedType: 'COLOR' | 'FLOAT' | 'BOOLEAN' | 'STRING';
  valuesByMode: Record<string, VariableValue>;
}

export interface VariablesResponse {
  variables: Variable[];
}
