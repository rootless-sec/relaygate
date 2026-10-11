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
    },
  },
  plugins: [],
}
