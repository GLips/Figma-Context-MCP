import { z } from "zod";
import { Logger } from "~/utils/logger.js";

const parameters = {
  clientLanguages: z
    .string()
    .describe(
      'Comma-separated list of programming languages used in the project (e.g., "typescript,javascript" or "typescript")',
    ),
  clientFrameworks: z
    .string()
    .describe(
      'Primary frontend framework used in the project. Options: "react", "vue", "svelte", "angular", or "unknown"',
    ),
};

const parametersSchema = z.object(parameters);
export type CreateDesignSystemRulesParams = z.infer<typeof parametersSchema>;

function generateTemplate(languages: string, framework: string): string {
  const isTypeScript = languages.toLowerCase().includes("typescript");
  const langDisplay = isTypeScript ? "TypeScript" : "JavaScript";

  // Framework-specific configurations
  const frameworkConfigs: Record<
    string,
    { componentExt: string; styleApproach: string; importExample: string }
  > = {
    react: {
      componentExt: isTypeScript ? ".tsx" : ".jsx",
      styleApproach: "CSS Modules, Tailwind CSS, or styled-components",
      importExample: `import { Button } from '@/components/Button';`,
    },
    vue: {
      componentExt: ".vue",
      styleApproach: "Scoped styles in Single File Components (SFC)",
      importExample: `import Button from '@/components/Button.vue';`,
    },
    svelte: {
      componentExt: ".svelte",
      styleApproach: "Scoped styles in Svelte components",
      importExample: `import Button from '$lib/components/Button.svelte';`,
    },
    angular: {
      componentExt: isTypeScript ? ".component.ts" : ".component.js",
      styleApproach: "Component-scoped SCSS or CSS",
      importExample: `import { ButtonComponent } from './components/button/button.component';`,
    },
    unknown: {
      componentExt: isTypeScript ? ".ts" : ".js",
      styleApproach: "CSS Modules or global stylesheets",
      importExample: `import { Button } from './components/Button';`,
    },
  };

  const config = frameworkConfigs[framework.toLowerCase()] || frameworkConfigs.unknown;

  return `# Design System Rules for ${framework.charAt(0).toUpperCase() + framework.slice(1)} + ${langDisplay}

## Project Configuration

- **Languages**: ${languages}
- **Framework**: ${framework}
- **Component Extension**: \`${config.componentExt}\`
- **Styling Approach**: ${config.styleApproach}

---

## 1. Component Organization

### File Structure
\`\`\`
src/
├── components/
│   ├── Button/
│   │   ├── Button${config.componentExt}
│   │   ├── Button.module.css (if using CSS Modules)
│   │   └── index${isTypeScript ? ".ts" : ".js"}
│   ├── Card/
│   └── ...
├── styles/
│   ├── tokens.css          # Design tokens from Figma
│   ├── globals.css         # Global styles
│   └── utilities.css       # Utility classes
└── assets/
    └── images/             # Downloaded Figma images
\`\`\`

### Naming Conventions
- **Components**: PascalCase (e.g., \`Button\`, \`CardHeader\`)
- **Files**: Match component name (e.g., \`Button${config.componentExt}\`)
- **CSS Classes**: kebab-case (e.g., \`button-primary\`, \`card-header\`)
- **Design Tokens**: kebab-case with prefixes (e.g., \`--color-primary\`, \`--spacing-md\`)

---

## 2. Design Tokens

### Token Mapping Strategy
Always map Figma design tokens to CSS custom properties. **Never hardcode hex values or pixel measurements.**

#### Color Tokens
\`\`\`css
/* tokens.css - Generated from Figma variables */
:root {
  /* Primary Colors */
  --color-primary: #0066FF;
  --color-primary-hover: #0052CC;
  --color-primary-active: #003D99;
  
  /* Semantic Colors */
  --color-success: #00875A;
  --color-error: #DE350B;
  --color-warning: #FF991F;
  
  /* Neutral Colors */
  --color-text-primary: #172B4D;
  --color-text-secondary: #6B778C;
  --color-background: #FFFFFF;
  --color-surface: #F4F5F7;
}
\`\`\`

#### Spacing Tokens
\`\`\`css
:root {
  --spacing-xs: 4px;
  --spacing-sm: 8px;
  --spacing-md: 16px;
  --spacing-lg: 24px;
  --spacing-xl: 32px;
  --spacing-2xl: 48px;
}
\`\`\`

#### Typography Tokens
\`\`\`css
:root {
  --font-family-primary: 'Inter', -apple-system, sans-serif;
  --font-family-mono: 'Fira Code', monospace;
  
  --font-size-xs: 12px;
  --font-size-sm: 14px;
  --font-size-md: 16px;
  --font-size-lg: 20px;
  --font-size-xl: 24px;
  
  --font-weight-regular: 400;
  --font-weight-medium: 500;
  --font-weight-semibold: 600;
  --font-weight-bold: 700;
  
  --line-height-tight: 1.2;
  --line-height-normal: 1.5;
  --line-height-relaxed: 1.75;
}
\`\`\`

---

## 3. Figma MCP Integration Workflow

### Step-by-Step Implementation Process

#### Step 1: Extract Design Context
Use \`get_design_context\` to fetch structured design data:
\`\`\`
Tool: get_design_context
Parameters:
  - fileKey: <from Figma URL>
  - nodeId: <specific component or frame>
\`\`\`

#### Step 2: Visual Verification
Use \`get_screenshot\` to capture visual reference:
\`\`\`
Tool: get_screenshot
Parameters:
  - fileKey: <from Figma URL>
  - nodeId: <component to screenshot>
\`\`\`

#### Step 3: Extract Design Tokens
Use \`get_variable_defs\` to get all design tokens:
\`\`\`
Tool: get_variable_defs
Parameters:
  - fileKey: <from Figma URL>
\`\`\`

#### Step 4: Download Assets
Use \`download_figma_images\` for icons, illustrations, and images:
\`\`\`
Tool: download_figma_images
Parameters:
  - fileKey: <from Figma URL>
  - nodeIds: [<image node IDs>]
  - outputPath: "./src/assets/images"
\`\`\`

#### Step 5: Implement Component
Create component using extracted design data and tokens.

#### Step 6: Validate Implementation
Compare implementation with screenshot for visual accuracy.

---

## 4. Styling Rules

### ${framework.charAt(0).toUpperCase() + framework.slice(1)}-Specific Guidelines

${
  framework.toLowerCase() === "react"
    ? `
#### React + Tailwind CSS (Recommended)
\`\`\`tsx
// Use Tailwind utility classes with design tokens
export function Button({ variant = 'primary', children }) {
  return (
    <button className="px-[var(--spacing-md)] py-[var(--spacing-sm)] bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] rounded-md">
      {children}
    </button>
  );
}
\`\`\`

#### React + CSS Modules
\`\`\`tsx
import styles from './Button.module.css';

export function Button({ variant = 'primary', children }) {
  return <button className={styles.button}>{children}</button>;
}
\`\`\`

\`\`\`css
/* Button.module.css */
.button {
  padding: var(--spacing-sm) var(--spacing-md);
  background-color: var(--color-primary);
  color: var(--color-text-on-primary);
  border-radius: var(--radius-md);
}

.button:hover {
  background-color: var(--color-primary-hover);
}
\`\`\`
`
    : ""
}

${
  framework.toLowerCase() === "vue"
    ? `
#### Vue 3 + Scoped Styles
\`\`\`vue
<template>
  <button :class="['button', \`button--\${variant}\`]">
    <slot />
  </button>
</template>

<script setup lang="ts">
defineProps<{
  variant?: 'primary' | 'secondary';
}>();
</script>

<style scoped>
.button {
  padding: var(--spacing-sm) var(--spacing-md);
  background-color: var(--color-primary);
  color: var(--color-text-on-primary);
  border-radius: var(--radius-md);
  transition: background-color 0.2s;
}

.button:hover {
  background-color: var(--color-primary-hover);
}

.button--secondary {
  background-color: var(--color-secondary);
}
</style>
\`\`\`
`
    : ""
}

${
  framework.toLowerCase() === "svelte"
    ? `
#### Svelte + Scoped Styles
\`\`\`svelte
<script lang="ts">
  export let variant: 'primary' | 'secondary' = 'primary';
</script>

<button class="button button--{variant}">
  <slot />
</button>

<style>
  .button {
    padding: var(--spacing-sm) var(--spacing-md);
    background-color: var(--color-primary);
    color: var(--color-text-on-primary);
    border-radius: var(--radius-md);
    transition: background-color 0.2s;
  }

  .button:hover {
    background-color: var(--color-primary-hover);
  }

  .button--secondary {
    background-color: var(--color-secondary);
  }
</style>
\`\`\`
`
    : ""
}

${
  framework.toLowerCase() === "angular"
    ? `
#### Angular + Component Styles
\`\`\`typescript
// button.component.ts
import { Component, Input } from '@angular/core';

@Component({
  selector: 'app-button',
  template: \`
    <button [class]="'button button--' + variant">
      <ng-content></ng-content>
    </button>
  \`,
  styleUrls: ['./button.component.scss']
})
export class ButtonComponent {
  @Input() variant: 'primary' | 'secondary' = 'primary';
}
\`\`\`

\`\`\`scss
// button.component.scss
.button {
  padding: var(--spacing-sm) var(--spacing-md);
  background-color: var(--color-primary);
  color: var(--color-text-on-primary);
  border-radius: var(--radius-md);
  transition: background-color 0.2s;

  &:hover {
    background-color: var(--color-primary-hover);
  }

  &--secondary {
    background-color: var(--color-secondary);
  }
}
\`\`\`
`
    : ""
}

### Universal Styling Principles

1. **Use Design Tokens**: Always reference CSS custom properties, never hardcode values
2. **Responsive Design**: Use Figma's responsive constraints to inform breakpoints
3. **Accessibility**: Maintain WCAG 2.1 AA compliance (contrast ratios, focus states)
4. **Performance**: Optimize images, use CSS containment, lazy-load when appropriate

---

## 5. Asset Handling

### Image Download Strategy
\`\`\`typescript
// Download all images from a Figma frame
await downloadFigmaImages({
  fileKey: 'abc123',
  nodeIds: ['1:234', '1:235', '1:236'],
  outputPath: './src/assets/images',
  format: 'png', // or 'svg' for icons
  scale: 2 // for retina displays
});
\`\`\`

### Image Optimization
- **Icons**: Use SVG format for scalability
- **Photos/Illustrations**: Use PNG at 2x scale, optimize with tools like ImageOptim
- **Backgrounds**: Consider WebP format for better compression
- **Lazy Loading**: Implement for below-the-fold images

---

## 6. Project-Specific Conventions

### Component Props Interface
${
  isTypeScript
    ? `
\`\`\`typescript
// Define strict prop types
interface ButtonProps {
  variant?: 'primary' | 'secondary' | 'tertiary';
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
}
\`\`\`
`
    : `
\`\`\`javascript
// Use JSDoc for prop documentation
/**
 * @typedef {Object} ButtonProps
 * @property {'primary' | 'secondary' | 'tertiary'} [variant='primary']
 * @property {'sm' | 'md' | 'lg'} [size='md']
 * @property {boolean} [disabled=false]
 * @property {() => void} [onClick]
 * @property {React.ReactNode} children
 */
\`\`\`
`
}

### Import Paths
\`\`\`${isTypeScript ? "typescript" : "javascript"}
${config.importExample}
\`\`\`

### Testing Requirements
- Unit tests for component logic
- Visual regression tests for UI consistency
- Accessibility tests (axe-core)

---

## 7. Maintenance Guidelines

### Syncing with Figma
1. Run \`get_variable_defs\` monthly to update design tokens
2. Use \`get_design_context\` when implementing new components
3. Verify visual accuracy with \`get_screenshot\` after major updates

### Version Control
- Commit design token updates separately from component changes
- Document Figma file version in commit messages
- Tag releases when syncing major design system updates

---

## 8. Quick Reference

### Common MCP Tool Usage

| Tool | Purpose | When to Use |
|------|---------|-------------|
| \`get_design_context\` | Extract design specs | Implementing new components |
| \`get_screenshot\` | Visual reference | Verifying implementation accuracy |
| \`get_variable_defs\` | Design tokens | Setting up or updating theme |
| \`download_figma_images\` | Asset extraction | Adding icons, images, illustrations |
| \`whoami\` | Auth verification | Troubleshooting API access |

### Design Token Naming Convention
\`\`\`
--{category}-{property}-{variant}-{state}

Examples:
--color-primary           # Base primary color
--color-primary-hover     # Hover state
--spacing-md              # Medium spacing
--font-size-lg            # Large font size
--radius-sm               # Small border radius
\`\`\`

---

**Generated for**: ${framework.charAt(0).toUpperCase() + framework.slice(1)} + ${langDisplay}  
**Last Updated**: ${new Date().toISOString().split("T")[0]}  
**Figma MCP Version**: 1.0.0

---

## Next Steps

1. ✅ Save this file as \`DESIGN_SYSTEM_RULES.md\` in your project root
2. ✅ Run \`get_variable_defs\` to extract design tokens from your Figma file
3. ✅ Create \`src/styles/tokens.css\` with extracted tokens
4. ✅ Set up component structure following the guidelines above
5. ✅ Use \`get_design_context\` + \`get_screenshot\` workflow for each new component

**Remember**: These rules are a starting point. Customize them based on your team's specific needs and project requirements.
`;
}

async function createDesignSystemRules(params: CreateDesignSystemRulesParams) {
  try {
    const { clientLanguages, clientFrameworks } = parametersSchema.parse(params);

    Logger.log(`Generating design system rules for ${clientFrameworks} with ${clientLanguages}`);

    const template = generateTemplate(clientLanguages, clientFrameworks);

    Logger.log("Successfully generated design system rules template");

    return {
      content: [{ type: "text" as const, text: template }],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : JSON.stringify(error);
    Logger.error("Error generating design system rules:", message);
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `Error generating design system rules: ${message}`,
        },
      ],
    };
  }
}

export const createDesignSystemRulesTool = {
  name: "create_design_system_rules",
  description:
    "Generate a comprehensive design system rules template tailored to your project's programming languages and frontend framework. Returns a detailed markdown document covering component organization, design token usage, Figma MCP integration workflow, styling conventions, asset handling, and project-specific guidelines. Use this to establish consistent design-to-code practices for your team.",
  parametersSchema,
  handler: createDesignSystemRules,
} as const;
