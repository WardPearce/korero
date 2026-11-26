import { mount } from "svelte";
import "./styles.css";
import BrowserMedia from "./BrowserMedia.svelte";

mount(BrowserMedia, { target: document.getElementById("app")! });
