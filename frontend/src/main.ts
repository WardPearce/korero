import "@fontsource-variable/dm-sans";
import "@fontsource-variable/manrope";
import "./app.css";

import { mount } from "svelte";
import App from "./App.svelte";

const target = document.getElementById("app");
if (target) mount(App, { target });
