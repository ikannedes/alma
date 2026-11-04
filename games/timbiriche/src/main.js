// Punto de entrada de Timbiriche (Jugar con Alma).
import { createApp } from "./app.js";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("no se encontró el elemento root");
createApp(root);
