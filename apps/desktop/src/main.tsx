// Inter is the only UI font; scope to the latin + latin-ext subsets the app
// actually renders. The default `400.css`/`500.css` pull cyrillic, greek and
// vietnamese subsets too — those files (and their @font-face rules) ship in the
// dist and inflate the CSS for scripts the UI never uses.
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-ext-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-ext-500.css";
import { StrictMode } from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
