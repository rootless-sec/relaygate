/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        bg: '#fafafa',
        surface: '#ffffff',
        border: '#e4e4e7',
        text: '#18181b',
        muted: '#71717a',
        hover: '#f4f4f5',
      },
      boxShadow: {
        '2xs': '0 1px 2px 0 rgb(0 0 0 / 0.03)',
        'xs': '0 1px 2px 0 rgb(0 0 0 / 0.05)',
      },
      backdropBlur: {
        '2xs': '2px',
        'xs': '4px',
      },
    },
  },
  plugins: [],
}
