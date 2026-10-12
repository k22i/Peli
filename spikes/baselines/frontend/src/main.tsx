import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { scriptStart } from "./marks";
import "./style.css";

scriptStart();
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
