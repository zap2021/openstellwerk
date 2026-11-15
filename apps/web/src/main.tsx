import { createRoot } from "react-dom/client";
import { App } from "./App";
import "@fontsource/barlow/latin-400.css";
import "@fontsource/barlow/latin-500.css";
import "@fontsource/barlow/latin-600.css";
import "@fontsource/barlow-condensed/latin-500.css";
import "@fontsource/barlow-condensed/latin-600.css";
import "./styles.css";
import { applyTheme, migrateStorage, storedTheme } from "./theme";

migrateStorage();
applyTheme(storedTheme());

createRoot(document.getElementById("root")!).render(<App />);
