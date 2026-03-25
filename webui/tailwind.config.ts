import type { Config } from 'tailwindcss';

export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0c0f16',
        surface: '#141821',
        'surface-2': '#1c2030',
        border: '#232839',
        'border-bright': '#2e3450',
        text: '#cdd2dc',
        'text-dim': '#636a7e',
        'text-bright': '#ebeef5',
        accent: '#818cf8',
        'accent-hover': '#a5b4fc',
        green: '#34d399',
        yellow: '#fbbf24',
        red: '#f87171',
        blue: '#60a5fa',
        cyan: '#22d3ee',
      },
      fontFamily: {
        mono: [
          'JetBrains Mono',
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'Monaco',
          'Consolas',
          'monospace',
        ],
      },
      width: {
        sidebar: '380px',
      },
      minWidth: {
        sidebar: '200px',
      },
      maxWidth: {
        sidebar: '600px',
      },
    },
  },
  plugins: [],
} satisfies Config;
