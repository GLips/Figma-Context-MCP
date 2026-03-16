import type { Config } from 'tailwindcss'

export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
        mono: [
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'Monaco',
          'Consolas',
          'Liberation Mono',
          'Courier New',
          'monospace',
        ],
      },
      colors: {
        bgMain: '#111019',
        bgSurface: '#1a1924',
        textPrimary: '#ffffff',
        textSecondary: '#8b8b9b',
        borderMain: '#2d2c3a',
        accentPurple: '#9f7aea',
        accentGreen: '#48bb78',
        accentRed: '#f56565',
      },
    },
  },
  plugins: [],
} satisfies Config

