/** @type {import('tailwindcss').Config} */
module.exports = {
    darkMode: 'class',
    future: {
        respectDefaultRingColorOpacity: false,
    },
  content: [
    "./src/renderer/**/*.{js,ts,jsx,tsx}",
    "./src/renderer/index.html",
  ],
  theme: {
    extend: {
        /* ========================================
         * Spacing System — 4px base unit
         * tight=4, snug=8, normal=12, relaxed=16, loose=24, xl=32, 2xl=48
         * ======================================== */
        spacing: {
            'tight': '4px',
            'snug': '8px',
            'normal': '12px',
            'relaxed': '16px',
            'loose': '24px',
            'spacious': '32px',
            'airy': '48px',
        },

        /* ========================================
         * Layout Tokens — Consistent dimensions
         * ======================================== */
        width: {
            'sidebar': '256px',
            'sidebar-collapsed': '52px',
            'panel': '288px',
            'panel-collapsed': '0px',
        },

        height: {
            'titlebar': '40px',
            'menubar': '36px',
            'input-area': 'auto',
        },

        /* ========================================
         * Color System — Brand + Semantic
         * ======================================== */
      colors: {
        brand: {
          50:  '#edfcf6',
          100: '#cbf7e6',
          200: '#9aedd4',
          300: '#63e1bf',
          400: '#36d2aa',
          500: '#1ac094',
          600: '#0da47a',
          700: '#01795d',
          800: '#035244',
          900: '#012f2e',
        },
          // Semantic surface colors
          surface: {
              DEFAULT: 'var(--surface)',
              muted: 'var(--surface-muted)',
              elevated: 'var(--surface-elevated)',
          },
          // Semantic text colors
          text: {
              primary: 'var(--text-primary)',
              secondary: 'var(--text-secondary)',
              muted: 'var(--text-muted)',
              inverse: 'var(--text-inverse)',
          },
          // Semantic border colors
          border: {
              DEFAULT: 'var(--border)',
              muted: 'var(--border-muted)',
              emphasis: 'var(--border-emphasis)',
          },
      },

        /* ========================================
         * Typography Scale — Fluid & Harmonious
         * ======================================== */
        fontSize: {
            '2xs': ['10px', {lineHeight: '14px', letterSpacing: '0.01em'}],
            'xs': ['12px', {lineHeight: '16px', letterSpacing: '0'}],
            'sm': ['14px', {lineHeight: '20px', letterSpacing: '-0.01em'}],
            'base': ['16px', {lineHeight: '24px', letterSpacing: '-0.01em'}],
            'lg': ['18px', {lineHeight: '28px', letterSpacing: '-0.02em'}],
        },

      fontFamily: {
        /* DM Sans: geometric, professional, distinctive from Inter monoculture */
        sans: ['DM Sans', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },

        /* ========================================
         * Shadow Scale — Subtle elevation
         * ======================================== */
        boxShadow: {
            'subtle': '0 1px 2px rgba(0, 0, 0, 0.04)',
            'soft': '0 2px 8px rgba(0, 0, 0, 0.06)',
            'medium': '0 4px 16px rgba(0, 0, 0, 0.08)',
            'elevated': '0 8px 32px rgba(0, 0, 0, 0.12)',
            'card': '0 1px 3px rgba(0, 0, 0, 0.05), 0 1px 2px rgba(0, 0, 0, 0.03)',
            'dropdown': '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)',
        },

        /* ========================================
         * Border Radius — Extended scale
         * ======================================== */
        borderRadius: {
            '2xl': '16px',
            '3xl': '24px',
        },

        /* ========================================
         * Animation — Smooth & Intentional
         * ======================================== */
        transitionDuration: {
            'fast': '100ms',
            'normal': '200ms',
            'slow': '300ms',
        },
        transitionTimingFunction: {
            'smooth': 'cubic-bezier(0.4, 0, 0.2, 1)',
            'bounce': 'cubic-bezier(0.34, 1.56, 0.64, 1)',
        },

        /* ========================================
         * Z-index Scale — Semantic layers
         * ======================================== */
        zIndex: {
            'dropdown': '100',
            'sticky': '200',
            'overlay': '300',
            'modal': '400',
            'toast': '500',
            'tooltip': '600',
        },
    },
  },
  plugins: [],
}
