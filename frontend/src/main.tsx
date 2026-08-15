import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
// Imported for its side effect, and imported first: i18next has to be
// initialised before any component renders, because the login screen is drawn
// before the session store hydrates and it must already be in the right
// language rather than flashing English and correcting itself.
import "./i18n";
import "./styles/app.css";

const container = document.getElementById("root");
if (!container) throw new Error("#root not found");

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>
);
