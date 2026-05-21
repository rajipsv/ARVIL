import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{js,ts,jsx,tsx}", "./components/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        arvil: {
          bg: "#0c0f14",
          panel: "#141a24",
          border: "#243044",
          accent: "#e85d04",
          muted: "#8b9cb3",
        },
      },
      fontFamily: {
        mono: ["ui-monospace", "Consolas", "monospace"],
      },
    },
  },
  plugins: [],
};
export default config;
