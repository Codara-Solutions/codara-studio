import React from "react";
import { createRoot } from "react-dom/client";
import "../src/styles.css";
import "./settings.css";
import { ThemeProvider } from "../src/theme/ThemeProvider";
import SettingsApp from "./SettingsApp";

const container = document.getElementById("settings-root");
if (!container) throw new Error("#settings-root not found");

createRoot(container).render(
  <React.StrictMode>
    <ThemeProvider>
      <SettingsApp />
    </ThemeProvider>
  </React.StrictMode>,
);
