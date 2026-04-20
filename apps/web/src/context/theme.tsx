import type { ReactNode } from "react";
import { createContext, useContext } from "react";

export type Theme = "light" | "dark";
export type ThemePreference = Theme | "system";

const ThemeContext = createContext<Theme>("light");

export function ThemeProvider(props: { theme: Theme; children: ReactNode }) {
  return <ThemeContext.Provider value={props.theme}>{props.children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  return useContext(ThemeContext);
}
